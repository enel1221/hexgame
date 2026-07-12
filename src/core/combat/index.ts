import { BALANCE } from "../../shared/balance";
import type { BattleParticipant, BattleState, GameState, TileState } from "../../shared/types";
import { isStructureOperational, seizeStructure, structureIntegrityPermille } from "../buildings";
import { emitEvent } from "../engine/events";
import { axialKey, neighbors } from "../hex";
import { checkAndRewardElimination, grantCaptureReward } from "../rewards";

export const BATTLE_CONTROL_MIN = 0;
export const BATTLE_CONTROL_MAX = 10_000;
export const BATTLE_CONTROL_START = 5_000;
export const BATTLE_WARMUP_TICKS = 8;

const PRESSURE_SCALE = 1_000;

export interface BattleParticipantPresentation {
  playerId: number | null;
  troops: number;
  effectivePower: number;
  sharePermyriad: number;
  turretSupportCount: number;
  incumbent: boolean;
}

function compareNullablePlayerIds(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left - right;
}

export function compareBattleParticipants(
  left: Pick<BattleParticipant, "playerId">,
  right: Pick<BattleParticipant, "playerId">,
): number {
  return compareNullablePlayerIds(left.playerId, right.playerId);
}

function compareTileIds(state: GameState, left: string, right: string): number {
  const leftTile = state.map.tiles[left];
  const rightTile = state.map.tiles[right];
  if (leftTile && rightTile) return leftTile.q - rightTile.q || leftTile.r - rightTile.r;
  return left < right ? -1 : left > right ? 1 : 0;
}

function terrainDefensePermille(tile: TileState): number {
  if (tile.terrain === "forest") return 1000 + BALANCE.forestDefensePermille;
  if (tile.terrain === "hills") return 1000 + BALANCE.hillsDefensePermille;
  return 1000;
}

export function attackerEffectivePower(troops: number): number {
  return Math.max(0, troops) * 1000;
}

function operationalTurret(tile: TileState): NonNullable<TileState["structure"]> | null {
  const structure = tile.structure;
  if (
    structure?.type !== "turret" ||
    structure.completedCount <= 0 ||
    !isStructureOperational(structure)
  ) {
    return null;
  }
  return structure;
}

/**
 * Home defense keeps virtual defenders outside the percentage multiplier.
 * Ordinary terrain applies afterward to the whole defensive formation.
 */
export function defenderEffectivePower(tile: TileState, troops: number): number {
  const organicPower = attackerEffectivePower(troops);
  if (organicPower <= 0) return 0;

  const turret = operationalTurret(tile);
  const integrity = structureIntegrityPermille(turret);
  const completedCount = turret?.completedCount ?? 0;
  const fullBonus =
    completedCount <= 0
      ? 0
      : Math.min(
          BALANCE.turret.maxDefensePermille,
          BALANCE.turret.baseDefensePermille +
            Math.max(0, completedCount - 1) * BALANCE.turret.additionalDefensePermille,
        );
  const integrityScaledBonus = Math.floor((fullBonus * integrity) / BALANCE.fullIntegrity);
  const boostedOrganic = Math.floor(
    (organicPower * (BALANCE.fullIntegrity + integrityScaledBonus)) / BALANCE.fullIntegrity,
  );
  const virtualPower = Math.floor(
    (completedCount * BALANCE.turret.virtualDefendersPerCopy * 1000 * integrity) /
      BALANCE.fullIntegrity,
  );
  return Math.floor(
    ((boostedOrganic + virtualPower) * terrainDefensePermille(tile)) / BALANCE.fullIntegrity,
  );
}

export function getBattleParticipant(
  battle: BattleState,
  playerId: number | null,
): BattleParticipant | undefined {
  return battle.participants.find((participant) => participant.playerId === playerId);
}

export function participantEffectivePower(
  state: GameState,
  battle: BattleState,
  participant: BattleParticipant,
): number {
  const tile = state.map.tiles[battle.tileId];
  if (!tile || participant.troops <= 0) return 0;
  return participant.playerId === battle.incumbentOwner
    ? defenderEffectivePower(tile, participant.troops)
    : attackerEffectivePower(participant.troops);
}

export function battleControlDelta(ownPower: number, opposingPower: number): number {
  const total = Math.max(1, ownPower + opposingPower);
  const advantagePermille = Math.floor((Math.abs(ownPower - opposingPower) * 1000) / total);
  return (
    BALANCE.battleBaseControlPerRound +
    Math.floor((BALANCE.battleAdvantageControlPerRound * advantagePermille) / 1000)
  );
}

function recordTroopLoss(state: GameState, playerId: number | null, amount: number): void {
  if (playerId === null || amount <= 0) return;
  const player = state.players[playerId];
  if (player) player.stats.troopsLost += amount;
}

function allocateByWeight<K>(
  total: number,
  entries: readonly { key: K; weight: number }[],
  compareKeys: (left: K, right: K) => number,
): Map<K, number> {
  const result = new Map<K, number>();
  if (total <= 0 || entries.length === 0) return result;
  const positive = entries.filter((entry) => entry.weight > 0);
  const weighted =
    positive.length > 0 ? positive : entries.map((entry) => ({ ...entry, weight: 1 }));
  const weightTotal = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let assigned = 0;
  const remainders: Array<{ key: K; remainder: number }> = [];

  for (const entry of weighted) {
    const numerator = total * entry.weight;
    const allocation = Math.floor(numerator / weightTotal);
    result.set(entry.key, allocation);
    assigned += allocation;
    remainders.push({ key: entry.key, remainder: numerator % weightTotal });
  }
  remainders.sort(
    (left, right) => right.remainder - left.remainder || compareKeys(left.key, right.key),
  );
  for (let index = 0; assigned < total; index += 1, assigned += 1) {
    const entry = remainders[index % remainders.length]!;
    result.set(entry.key, (result.get(entry.key) ?? 0) + 1);
  }
  return result;
}

function battleSupportsTurretAt(
  state: GameState,
  battle: BattleState,
  sourceTile: TileState,
  owner: number,
): boolean {
  const ownerParticipant = getBattleParticipant(battle, owner);
  if (!ownerParticipant || ownerParticipant.troops <= 0) return false;
  if (
    !battle.participants.some(
      (participant) => participant.playerId !== owner && participant.troops > 0,
    )
  ) {
    return false;
  }
  const ownBattle = state.battles.find((candidate) => candidate.tileId === sourceTile.id);
  if (ownBattle) return ownBattle.id === battle.id;
  return neighbors(sourceTile).some((neighbor) => axialKey(neighbor) === battle.tileId);
}

function supportingTurretCounts(state: GameState, battle: BattleState): Map<number, number> {
  const counts = new Map<number, number>();
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    const turret = operationalTurret(tile);
    const owner = tile.owner;
    if (!turret || owner === null) continue;
    if (!battleSupportsTurretAt(state, battle, tile, owner)) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + turret.completedCount);
  }
  return counts;
}

export function supportingTurretCount(
  state: GameState,
  battle: BattleState,
  playerId: number | null,
): number {
  if (playerId === null) return 0;
  return supportingTurretCounts(state, battle).get(playerId) ?? 0;
}

/** Pure authoritative-to-presentation projection shared by AI and the renderer. */
export function battlePresentation(
  state: GameState,
  battle: BattleState,
): BattleParticipantPresentation[] {
  const participants = [...battle.participants].sort(compareBattleParticipants);
  const powers = participants.map((participant) => ({
    participant,
    power: participantEffectivePower(state, battle, participant),
  }));
  const shares = allocateByWeight(
    BATTLE_CONTROL_MAX,
    powers.map(({ participant, power }) => ({ key: participant.playerId, weight: power })),
    compareNullablePlayerIds,
  );
  const turretCounts = supportingTurretCounts(state, battle);
  return powers.map(({ participant, power }) => ({
    playerId: participant.playerId,
    troops: participant.troops,
    effectivePower: power,
    sharePermyriad: shares.get(participant.playerId) ?? 0,
    turretSupportCount:
      participant.playerId === null ? 0 : (turretCounts.get(participant.playerId) ?? 0),
    incumbent: participant.playerId === battle.incumbentOwner,
  }));
}

function addReinforcement(
  state: GameState,
  battle: BattleState,
  participant: BattleParticipant,
  troops: number,
): void {
  participant.troops += troops;
  participant.control = Math.min(
    BATTLE_CONTROL_MAX,
    participant.control + Math.min(800, troops * 20),
  );
  participant.lastReinforcementTick = state.tick;
  participant.reinforcementAmount = troops;
  emitEvent(state, {
    type: "reinforcement",
    playerId: participant.playerId ?? undefined,
    tileId: battle.tileId,
    amount: troops,
    message: `${troops} troops reinforced ${
      participant.playerId === null
        ? "the neutral defenders"
        : (state.players[participant.playerId]?.name ?? "an army")
    }`,
  });
}

export function startBattle(
  state: GameState,
  tile: TileState,
  attacker: number,
  troops: number,
  entryFrom: string,
): BattleState {
  const battle: BattleState = {
    id: state.nextEntityId,
    tileId: tile.id,
    incumbentOwner: tile.owner,
    participants: [
      {
        playerId: tile.owner,
        troops: tile.troops,
        control: BATTLE_CONTROL_START,
        casualtyProgressMilli: 0,
        entryFrom: tile.id,
        joinedTick: state.tick,
        lastReinforcementTick: -1,
        reinforcementAmount: 0,
      },
      {
        playerId: attacker,
        troops,
        control: BATTLE_CONTROL_START,
        casualtyProgressMilli: 0,
        entryFrom,
        joinedTick: state.tick,
        lastReinforcementTick: -1,
        reinforcementAmount: 0,
      },
    ].sort(compareBattleParticipants),
    ageTicks: 0,
    roundAccumulator: 0,
  };
  state.nextEntityId += 1;
  tile.troops = 0;
  state.battles.push(battle);
  state.battles.sort(
    (left, right) => compareTileIds(state, left.tileId, right.tileId) || left.id - right.id,
  );
  emitEvent(state, {
    type: "battle-started",
    playerId: attacker,
    tileId: tile.id,
    message: `${state.players[attacker]?.name ?? "An army"} attacked ${tile.id}`,
  });
  return battle;
}

/** Resolves a stack reaching a tile into a merge, reinforcement, or immediate new faction. */
export function handleStackArrival(
  state: GameState,
  owner: number,
  troops: number,
  tileId: string,
  entryFrom: string,
): void {
  const tile = state.map.tiles[tileId];
  if (!tile || troops <= 0) return;
  const battle = state.battles.find((candidate) => candidate.tileId === tileId);
  if (battle) {
    const participant = getBattleParticipant(battle, owner);
    if (participant) addReinforcement(state, battle, participant, troops);
    else {
      battle.participants.push({
        playerId: owner,
        troops,
        control: BATTLE_CONTROL_START,
        casualtyProgressMilli: 0,
        entryFrom,
        joinedTick: state.tick,
        lastReinforcementTick: -1,
        reinforcementAmount: 0,
      });
      battle.participants.sort(compareBattleParticipants);
      emitEvent(state, {
        type: "reinforcement",
        playerId: owner,
        tileId,
        amount: troops,
        message: `${state.players[owner]?.name ?? "An army"} entered the battle with ${troops}`,
      });
    }
    return;
  }

  if (tile.owner === owner) {
    tile.troops += troops;
    return;
  }
  startBattle(state, tile, owner, troops, entryFrom);
}

interface TurretVolley {
  sourceTileId: string;
  targetBattleId: number;
  owner: number;
  shots: number;
}

function applyTurretFire(state: GameState): Map<number, Map<number | null, number>> {
  const battles = [...state.battles].sort(
    (left, right) => compareTileIds(state, left.tileId, right.tileId) || left.id - right.id,
  );
  const preShotPower = new Map<number, Map<number | null, number>>();
  const preShotTroops = new Map<number, Map<number | null, number>>();
  for (const battle of battles) {
    const troopMap = new Map<number | null, number>();
    const powerMap = new Map<number | null, number>();
    for (const participant of [...battle.participants].sort(compareBattleParticipants)) {
      troopMap.set(participant.playerId, participant.troops);
      powerMap.set(participant.playerId, participantEffectivePower(state, battle, participant));
    }
    preShotTroops.set(battle.id, troopMap);
    preShotPower.set(battle.id, powerMap);
  }

  const threshold = BALANCE.turret.shotTicks * BALANCE.fullIntegrity;
  const volleys: TurretVolley[] = [];
  const turretTileIds = state.map.landIds
    .filter((tileId) => operationalTurret(state.map.tiles[tileId]!))
    .sort((left, right) => compareTileIds(state, left, right));
  for (const sourceTileId of turretTileIds) {
    const sourceTile = state.map.tiles[sourceTileId]!;
    const turret = operationalTurret(sourceTile)!;
    const owner = sourceTile.owner;
    if (owner === null || state.players[owner]?.eliminated) continue;

    const ownBattle = battles.find((battle) => battle.tileId === sourceTileId);
    const eligible = (
      ownBattle
        ? battleSupportsTurretAt(state, ownBattle, sourceTile, owner)
          ? [ownBattle]
          : []
        : battles.filter((battle) => battleSupportsTurretAt(state, battle, sourceTile, owner))
    ).sort((left, right) => compareTileIds(state, left.tileId, right.tileId) || left.id - right.id);
    if (eligible.length === 0) continue;

    turret.turretShotProgressMilli += turret.completedCount * turret.integrity;
    const shots = Math.floor(turret.turretShotProgressMilli / threshold);
    turret.turretShotProgressMilli %= threshold;
    if (shots <= 0) continue;

    const quotas = allocateByWeight(
      shots,
      eligible.map((battle) => ({ key: battle.id, weight: 1 })),
      (left, right) => {
        const leftBattle = eligible.find((battle) => battle.id === left)!;
        const rightBattle = eligible.find((battle) => battle.id === right)!;
        const rotation =
          (Math.floor(state.tick / BALANCE.turret.shotTicks) + sourceTile.decorationSeed) %
          eligible.length;
        const leftIndex = eligible.indexOf(leftBattle);
        const rightIndex = eligible.indexOf(rightBattle);
        const leftRank = (leftIndex - rotation + eligible.length) % eligible.length;
        const rightRank = (rightIndex - rotation + eligible.length) % eligible.length;
        return leftRank - rightRank || leftBattle.id - rightBattle.id;
      },
    );
    for (const battle of eligible) {
      const quota = quotas.get(battle.id) ?? 0;
      if (quota > 0) volleys.push({ sourceTileId, targetBattleId: battle.id, owner, shots: quota });
    }
  }

  const losses = new Map<string, number>();
  const keyFor = (battleId: number, playerId: number | null): string =>
    `${battleId}:${playerId === null ? "neutral" : playerId}`;
  for (const volley of volleys) {
    const battle = battles.find((candidate) => candidate.id === volley.targetBattleId);
    const troopMap = preShotTroops.get(volley.targetBattleId);
    if (!battle || !troopMap) continue;
    const targets = [...battle.participants]
      .filter((participant) => participant.playerId !== volley.owner)
      .sort(compareBattleParticipants)
      .map((participant) => ({
        key: participant.playerId,
        weight: troopMap.get(participant.playerId) ?? 0,
      }));
    const allocations = allocateByWeight(volley.shots, targets, compareNullablePlayerIds);
    for (const [playerId, amount] of allocations) {
      const key = keyFor(battle.id, playerId);
      losses.set(key, (losses.get(key) ?? 0) + amount);
    }
  }

  for (const battle of battles) {
    for (const participant of battle.participants) {
      const intended = losses.get(keyFor(battle.id, participant.playerId)) ?? 0;
      const actual = Math.min(participant.troops, intended);
      if (actual <= 0) continue;
      participant.troops -= actual;
      recordTroopLoss(state, participant.playerId, actual);
    }
  }
  for (const volley of volleys) {
    const battle = battles.find((candidate) => candidate.id === volley.targetBattleId);
    if (!battle) continue;
    emitEvent(state, {
      type: "turret-volley",
      playerId: volley.owner,
      tileId: battle.tileId,
      sourceTileId: volley.sourceTileId,
      amount: volley.shots,
      message: `${volley.shots} aggregated Turret shot${volley.shots === 1 ? "" : "s"} supported ${battle.tileId}`,
    });
  }
  return preShotPower;
}

function tickBattleRound(state: GameState, battle: BattleState): Map<number | null, number> {
  const participants = [...battle.participants].sort(compareBattleParticipants);
  const powers = new Map<number | null, number>();
  const troops = new Map<number | null, number>();
  for (const participant of participants) {
    powers.set(participant.playerId, participantEffectivePower(state, battle, participant));
    troops.set(participant.playerId, participant.troops);
  }
  if (battle.ageTicks <= BATTLE_WARMUP_TICKS) return powers;

  const totalPower = [...powers.values()].reduce((sum, power) => sum + power, 0);
  const controlChanges = new Map<number | null, number>();
  const incomingPressure = new Map<number | null, number>();
  for (const participant of participants) {
    const ownPower = powers.get(participant.playerId) ?? 0;
    const opposingPower = Math.max(0, totalPower - ownPower);
    const delta = battleControlDelta(ownPower, opposingPower);
    const winsTie = ownPower === opposingPower && participant.playerId === battle.incumbentOwner;
    controlChanges.set(participant.playerId, ownPower > opposingPower || winsTie ? delta : -delta);

    // Outgoing pressure uses the same snapshotted effective power as control.
    // Home terrain/Turret defense therefore belongs only to its own faction;
    // adjacent Turrets remain separately represented by their real shot budget.
    const pressure = Math.floor(ownPower / BALANCE.combatPressurePowerDivisor);
    const targets = participants
      .filter((target) => target.playerId !== participant.playerId)
      .map((target) => ({ key: target.playerId, weight: troops.get(target.playerId) ?? 0 }));
    const allocated = allocateByWeight(pressure, targets, compareNullablePlayerIds);
    for (const [targetId, amount] of allocated) {
      incomingPressure.set(targetId, (incomingPressure.get(targetId) ?? 0) + amount);
    }
  }

  // Control and casualties are both applied only after every faction used the
  // same pre-round snapshot.
  for (const participant of participants) {
    participant.control = Math.max(
      BATTLE_CONTROL_MIN,
      Math.min(
        BATTLE_CONTROL_MAX,
        participant.control + (controlChanges.get(participant.playerId) ?? 0),
      ),
    );
    const progress =
      participant.casualtyProgressMilli + (incomingPressure.get(participant.playerId) ?? 0);
    const intendedLoss = Math.floor(progress / PRESSURE_SCALE);
    participant.casualtyProgressMilli = progress % PRESSURE_SCALE;
    const actualLoss = Math.min(participant.troops, intendedLoss);
    participant.troops -= actualLoss;
    recordTroopLoss(state, participant.playerId, actualLoss);
  }
  return powers;
}

function survivorOrder(
  battle: BattleState,
  powers: ReadonlyMap<number | null, number>,
  left: BattleParticipant,
  right: BattleParticipant,
): number {
  const byPower = (powers.get(right.playerId) ?? 0) - (powers.get(left.playerId) ?? 0);
  if (byPower !== 0) return byPower;
  const leftIncumbent = left.playerId === battle.incumbentOwner ? 1 : 0;
  const rightIncumbent = right.playerId === battle.incumbentOwner ? 1 : 0;
  return rightIncumbent - leftIncumbent || compareNullablePlayerIds(left.playerId, right.playerId);
}

function pruneDefeatedParticipants(
  state: GameState,
  battle: BattleState,
  powers: ReadonlyMap<number | null, number>,
): void {
  const ordered = [...battle.participants].sort(compareBattleParticipants);
  let survivors = ordered.filter(
    (participant) => participant.troops > 0 && participant.control > BATTLE_CONTROL_MIN,
  );
  if (survivors.length === 0 && ordered.length > 0) {
    const chosen = [...ordered].sort((left, right) =>
      survivorOrder(battle, powers, left, right),
    )[0]!;
    if (chosen.troops <= 0) {
      chosen.troops = 1;
      if (chosen.playerId !== null) {
        const player = state.players[chosen.playerId];
        if (player) player.stats.troopsLost = Math.max(0, player.stats.troopsLost - 1);
      }
    }
    chosen.control = Math.max(1, chosen.control);
    survivors = [chosen];
  }

  const survivorSet = new Set(survivors);
  for (const participant of ordered) {
    if (survivorSet.has(participant)) continue;
    if (participant.troops > 0) {
      recordTroopLoss(state, participant.playerId, participant.troops);
      participant.troops = 0;
    }
  }
  battle.participants = survivors.sort(compareBattleParticipants);
}

function resolveBattle(state: GameState, battle: BattleState, winner: BattleParticipant): void {
  const tile = state.map.tiles[battle.tileId];
  if (!tile) return;
  for (const participant of battle.participants) {
    if (participant === winner) continue;
    recordTroopLoss(state, participant.playerId, participant.troops);
  }
  state.battles = state.battles.filter((candidate) => candidate.id !== battle.id);

  const previousOwner = battle.incumbentOwner;
  if (winner.playerId === previousOwner) {
    tile.troops = Math.max(1, winner.troops);
    return;
  }
  if (winner.playerId === null) {
    tile.owner = null;
    tile.troops = Math.max(1, winner.troops);
    return;
  }

  const capturedStructure =
    tile.structure && tile.structure.completedCount > 0
      ? { type: tile.structure.type, completedCount: tile.structure.completedCount }
      : null;
  seizeStructure(tile);
  grantCaptureReward(state, winner.playerId, tile, previousOwner, capturedStructure);
  tile.owner = winner.playerId;
  tile.troops = Math.max(1, winner.troops);
  tile.controlledSinceTick = state.tick;
  const player = state.players[winner.playerId];
  if (player) player.stats.tilesCaptured += 1;
  emitEvent(state, {
    type: "capture",
    playerId: winner.playerId,
    tileId: tile.id,
    message: `${player?.name ?? "Attacker"} captured ${tile.id}`,
  });
  if (capturedStructure) {
    emitEvent(state, {
      type: "structure-seized",
      playerId: winner.playerId,
      tileId: tile.id,
      amount: capturedStructure.completedCount,
      message: `${capturedStructure.type} x${capturedStructure.completedCount} seized at 40% integrity`,
    });
  }
  checkAndRewardElimination(state, previousOwner, winner.playerId);
}

function settleBattle(
  state: GameState,
  battle: BattleState,
  powers: ReadonlyMap<number | null, number>,
): void {
  pruneDefeatedParticipants(state, battle, powers);
  if (battle.ageTicks < BALANCE.minimumBattleTicks || battle.participants.length === 0) return;
  const endpoint = battle.participants.filter(
    (participant) => participant.control >= BATTLE_CONTROL_MAX,
  );
  if (battle.participants.length > 1 && endpoint.length === 0) return;
  const candidates = endpoint.length > 0 ? endpoint : battle.participants;
  const winner = [...candidates].sort((left, right) =>
    survivorOrder(battle, powers, left, right),
  )[0];
  if (winner) resolveBattle(state, battle, winner);
}

export function tickCombat(state: GameState): void {
  for (const battle of state.battles) battle.participants.sort(compareBattleParticipants);
  state.battles.sort(
    (left, right) => compareTileIds(state, left.tileId, right.tileId) || left.id - right.id,
  );
  const turretPowerSnapshots = applyTurretFire(state);
  const activeAtStart = [...state.battles];
  for (const battle of activeAtStart) {
    if (!state.battles.some((candidate) => candidate.id === battle.id)) continue;
    battle.ageTicks += 1;
    battle.roundAccumulator += 1;
    let powers =
      turretPowerSnapshots.get(battle.id) ??
      new Map(
        battle.participants.map((participant) => [
          participant.playerId,
          participantEffectivePower(state, battle, participant),
        ]),
      );
    while (battle.roundAccumulator >= BALANCE.combatRoundTicks) {
      battle.roundAccumulator -= BALANCE.combatRoundTicks;
      powers = tickBattleRound(state, battle);
    }
    settleBattle(state, battle, powers);
  }
}

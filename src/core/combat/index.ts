import { BALANCE } from "../../shared/balance";
import type {
  BattleParticipant,
  BattleState,
  GameState,
  StructureState,
  TileState,
  UnitCounts,
  UnitType,
} from "../../shared/types";
import { isStructureOperational, seizeStructure } from "../buildings";
import { emitEvent } from "../engine/events";
import { axialKey, neighbors } from "../hex";
import { checkAndRewardElimination, grantCaptureReward } from "../rewards";
import {
  addUnits,
  emptyUnits,
  matchupPermille,
  sumUnits,
  totalUnits,
  UNIT_TYPES,
  unitTypeForStructure,
  unitsOf,
} from "../units";

export const BATTLE_CONTROL_MIN = 0;
export const BATTLE_CONTROL_MAX = 10_000;
export const BATTLE_CONTROL_START = 5_000;
export const BATTLE_WARMUP_TICKS = 8;

const PRESSURE_SCALE = 1_000;

export interface BattleParticipantPresentation {
  playerId: number | null;
  units: UnitCounts;
  /** Derived convenience total; authoritative state stores only the composition. */
  troops: number;
  basePowerByType: UnitCounts;
  effectivePowerByType: UnitCounts;
  localSupportPower: UnitCounts;
  adjacentSupportPower: UnitCounts;
  basePower: number;
  effectivePower: number;
  rpsMultiplierPermille: number;
  sharePermyriad: number;
  incumbent: boolean;
}

interface ParticipantPowerSnapshot {
  participant: BattleParticipant;
  basePowerByType: UnitCounts;
  effectivePowerByType: UnitCounts;
  localSupportPower: UnitCounts;
  adjacentSupportPower: UnitCounts;
  basePower: number;
  effectivePower: number;
  rpsMultiplierPermille: number;
}

type BattleSupport = Map<number, Map<number, UnitCounts>>;

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

function powerFromUnits(units: UnitCounts): UnitCounts {
  return {
    melee: units.melee * 1000,
    ranged: units.ranged * 1000,
    wizard: units.wizard * 1000,
  };
}

function scalePower(power: UnitCounts, permille: number): UnitCounts {
  return {
    melee: Math.floor((power.melee * permille) / 1000),
    ranged: Math.floor((power.ranged * permille) / 1000),
    wizard: Math.floor((power.wizard * permille) / 1000),
  };
}

function adjustPowerForMatchup(base: UnitCounts, opposition: UnitCounts): UnitCounts {
  const oppositionTotal = totalUnits(opposition);
  if (oppositionTotal <= 0) return { ...base };
  const result = emptyUnits();
  for (const sourceType of UNIT_TYPES) {
    let weightedMatchup = 0;
    for (const targetType of UNIT_TYPES) {
      weightedMatchup += opposition[targetType] * matchupPermille(sourceType, targetType);
    }
    result[sourceType] = Math.floor(
      (base[sourceType] * weightedMatchup) / (oppositionTotal * 1000),
    );
  }
  return result;
}

export function effectivePowerFromBase(
  basePowerByType: UnitCounts,
  oppositionPowerByType: UnitCounts,
): number {
  return totalUnits(adjustPowerForMatchup(basePowerByType, oppositionPowerByType));
}

export function attackerEffectivePower(units: UnitCounts, opposition = emptyUnits()): number {
  return effectivePowerFromBase(powerFromUnits(units), powerFromUnits(opposition));
}

function localSupportPower(structure: StructureState | null): UnitCounts {
  if (!structure || !isStructureOperational(structure)) return emptyUnits();
  const fullPower = Math.min(
    BALANCE.localSupportCapMilli,
    structure.completedCount * BALANCE.localSupportPerCopyMilli,
  );
  const power = Math.floor((fullPower * structure.integrity) / BALANCE.fullIntegrity);
  return unitsOf(unitTypeForStructure(structure.type), power);
}

/** Local typed support is terrain-scaled with the incumbent's actual formation. */
export function defenderEffectivePower(
  tile: TileState,
  units: UnitCounts,
  opposition = emptyUnits(),
): number {
  if (totalUnits(units) <= 0) return 0;
  const local = localSupportPower(tile.structure);
  const base = scalePower(addUnits(powerFromUnits(units), local), terrainDefensePermille(tile));
  return totalUnits(adjustPowerForMatchup(base, powerFromUnits(opposition)));
}

export function getBattleParticipant(
  battle: BattleState,
  playerId: number | null,
): BattleParticipant | undefined {
  return battle.participants.find((participant) => participant.playerId === playerId);
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
  if (positive.length === 0) return result;
  const weightTotal = positive.reduce((sum, entry) => sum + entry.weight, 0);
  let assigned = 0;
  const remainders: Array<{ key: K; remainder: number }> = [];
  for (const entry of positive) {
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
    const key = remainders[index % remainders.length]!.key;
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function battleHasActiveOwner(battle: BattleState, owner: number): boolean {
  const participant = getBattleParticipant(battle, owner);
  return Boolean(participant && totalUnits(participant.units) > 0);
}

function battleHasHostileParticipant(battle: BattleState, owner: number): boolean {
  return battle.participants.some(
    (participant) => participant.playerId !== owner && totalUnits(participant.units) > 0,
  );
}

function supportEligible(battle: BattleState, sourceTile: TileState, owner: number): boolean {
  return (
    battleHasActiveOwner(battle, owner) &&
    battleHasHostileParticipant(battle, owner) &&
    neighbors(sourceTile).some((neighbor) => axialKey(neighbor) === battle.tileId)
  );
}

function capSupportByType(power: UnitCounts, cap: number): UnitCounts {
  const total = totalUnits(power);
  if (total <= cap) return power;
  const allocations = allocateByWeight(
    cap,
    UNIT_TYPES.map((type) => ({ key: type, weight: power[type] })),
    (left, right) => UNIT_TYPES.indexOf(left) - UNIT_TYPES.indexOf(right),
  );
  return {
    melee: allocations.get("melee") ?? 0,
    ranged: allocations.get("ranged") ?? 0,
    wizard: allocations.get("wizard") ?? 0,
  };
}

/** One aggregate, own-tile-prioritized support budget per structure stack. */
function adjacentSupportAssignments(state: GameState): BattleSupport {
  const output: BattleSupport = new Map();
  const battles = [...state.battles].sort(
    (left, right) => compareTileIds(state, left.tileId, right.tileId) || left.id - right.id,
  );
  const sourceIds = [...state.map.landIds].sort((left, right) =>
    compareTileIds(state, left, right),
  );
  for (const sourceId of sourceIds) {
    const source = state.map.tiles[sourceId]!;
    const structure = source.structure;
    const owner = source.owner;
    if (owner === null || !structure || !isStructureOperational(structure)) continue;
    const ownBattle = battles.find((battle) => battle.tileId === sourceId);
    if (ownBattle) continue;
    const eligible = battles.filter((battle) => supportEligible(battle, source, owner));
    if (eligible.length === 0) continue;
    const fullBudget = Math.min(
      BALANCE.adjacentSupportSourceCapMilli,
      structure.completedCount * BALANCE.adjacentSupportPerCopyMilli,
    );
    const budget = Math.floor((fullBudget * structure.integrity) / BALANCE.fullIntegrity);
    const allocations = allocateByWeight(
      budget,
      eligible.map((battle) => ({ key: battle.id, weight: 1 })),
      (left, right) => {
        const leftBattle = eligible.find((battle) => battle.id === left)!;
        const rightBattle = eligible.find((battle) => battle.id === right)!;
        return (
          compareTileIds(state, leftBattle.tileId, rightBattle.tileId) ||
          leftBattle.id - rightBattle.id
        );
      },
    );
    const type = unitTypeForStructure(structure.type);
    for (const battle of eligible) {
      const amount = allocations.get(battle.id) ?? 0;
      if (amount <= 0) continue;
      const byPlayer = output.get(battle.id) ?? new Map<number, UnitCounts>();
      byPlayer.set(owner, addUnits(byPlayer.get(owner) ?? emptyUnits(), unitsOf(type, amount)));
      output.set(battle.id, byPlayer);
    }
  }
  for (const byPlayer of output.values()) {
    for (const [playerId, power] of byPlayer) {
      byPlayer.set(playerId, capSupportByType(power, BALANCE.adjacentSupportBattleCapMilli));
    }
  }
  return output;
}

function battlePowerSnapshots(
  state: GameState,
  battle: BattleState,
  allSupport = adjacentSupportAssignments(state),
): ParticipantPowerSnapshot[] {
  const tile = state.map.tiles[battle.tileId]!;
  const support = allSupport.get(battle.id);
  const bases = [...battle.participants].sort(compareBattleParticipants).map((participant) => {
    const actual = powerFromUnits(participant.units);
    const local =
      participant.playerId === battle.incumbentOwner && totalUnits(participant.units) > 0
        ? localSupportPower(tile.structure)
        : emptyUnits();
    const home =
      participant.playerId === battle.incumbentOwner
        ? scalePower(addUnits(actual, local), terrainDefensePermille(tile))
        : actual;
    const adjacent =
      participant.playerId === null
        ? emptyUnits()
        : (support?.get(participant.playerId) ?? emptyUnits());
    return { participant, basePowerByType: addUnits(home, adjacent), local, adjacent };
  });
  return bases.map(({ participant, basePowerByType, local, adjacent }) => {
    const opposition = sumUnits(
      bases
        .filter((candidate) => candidate.participant.playerId !== participant.playerId)
        .map((candidate) => candidate.basePowerByType),
    );
    const effectivePowerByType = adjustPowerForMatchup(basePowerByType, opposition);
    const basePower = totalUnits(basePowerByType);
    const effectivePower = totalUnits(effectivePowerByType);
    return {
      participant,
      basePowerByType,
      effectivePowerByType,
      localSupportPower: local,
      adjacentSupportPower: adjacent,
      basePower,
      effectivePower,
      rpsMultiplierPermille:
        basePower <= 0 ? 1000 : Math.floor((effectivePower * 1000) / basePower),
    };
  });
}

export function participantEffectivePower(
  state: GameState,
  battle: BattleState,
  participant: BattleParticipant,
): number {
  return (
    battlePowerSnapshots(state, battle).find(
      (snapshot) => snapshot.participant.playerId === participant.playerId,
    )?.effectivePower ?? 0
  );
}

/** Pure authoritative-to-presentation projection shared by AI and renderer. */
export function battlePresentation(
  state: GameState,
  battle: BattleState,
): BattleParticipantPresentation[] {
  const snapshots = battlePowerSnapshots(state, battle);
  const shares = allocateByWeight(
    BATTLE_CONTROL_MAX,
    snapshots.map(({ participant, effectivePower }) => ({
      key: participant.playerId,
      weight: effectivePower,
    })),
    compareNullablePlayerIds,
  );
  return snapshots.map((snapshot) => ({
    playerId: snapshot.participant.playerId,
    units: { ...snapshot.participant.units },
    troops: totalUnits(snapshot.participant.units),
    basePowerByType: snapshot.basePowerByType,
    effectivePowerByType: snapshot.effectivePowerByType,
    localSupportPower: snapshot.localSupportPower,
    adjacentSupportPower: snapshot.adjacentSupportPower,
    basePower: snapshot.basePower,
    effectivePower: snapshot.effectivePower,
    rpsMultiplierPermille: snapshot.rpsMultiplierPermille,
    sharePermyriad: shares.get(snapshot.participant.playerId) ?? 0,
    incumbent: snapshot.participant.playerId === battle.incumbentOwner,
  }));
}

function addReinforcement(
  state: GameState,
  battle: BattleState,
  participant: BattleParticipant,
  units: UnitCounts,
): void {
  const amount = totalUnits(units);
  participant.units = addUnits(participant.units, units);
  participant.control = Math.min(
    BATTLE_CONTROL_MAX,
    participant.control + Math.min(800, amount * 20),
  );
  participant.lastReinforcementTick = state.tick;
  participant.reinforcementAmount = amount;
  emitEvent(state, {
    type: "reinforcement",
    playerId: participant.playerId ?? undefined,
    tileId: battle.tileId,
    amount,
    message: `${amount} troops reinforced ${
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
  units: UnitCounts,
  entryFrom: string,
): BattleState {
  const battle: BattleState = {
    id: state.nextEntityId++,
    tileId: tile.id,
    incumbentOwner: tile.owner,
    participants: [
      {
        playerId: tile.owner,
        units: { ...tile.units },
        control: BATTLE_CONTROL_START,
        casualtyProgressMilli: emptyUnits(),
        entryFrom: tile.id,
        joinedTick: state.tick,
        lastReinforcementTick: -1,
        reinforcementAmount: 0,
      },
      {
        playerId: attacker,
        units: { ...units },
        control: BATTLE_CONTROL_START,
        casualtyProgressMilli: emptyUnits(),
        entryFrom,
        joinedTick: state.tick,
        lastReinforcementTick: -1,
        reinforcementAmount: 0,
      },
    ].sort(compareBattleParticipants),
    ageTicks: 0,
    roundAccumulator: 0,
  };
  tile.units = emptyUnits();
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

/** Resolves a stack reaching a tile into a merge, reinforcement, or new faction. */
export function handleStackArrival(
  state: GameState,
  owner: number,
  units: UnitCounts,
  tileId: string,
  entryFrom: string,
): void {
  const tile = state.map.tiles[tileId];
  const amount = totalUnits(units);
  if (!tile || amount <= 0) return;
  const battle = state.battles.find((candidate) => candidate.tileId === tileId);
  if (battle) {
    const participant = getBattleParticipant(battle, owner);
    if (participant) addReinforcement(state, battle, participant, units);
    else {
      battle.participants.push({
        playerId: owner,
        units: { ...units },
        control: BATTLE_CONTROL_START,
        casualtyProgressMilli: emptyUnits(),
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
        amount,
        message: `${state.players[owner]?.name ?? "An army"} entered the battle with ${amount}`,
      });
    }
    return;
  }
  if (tile.owner === owner) {
    tile.units = addUnits(tile.units, units);
    return;
  }
  startBattle(state, tile, owner, units, entryFrom);
}

interface CasualtyTarget {
  key: string;
  playerId: number | null;
  type: UnitType;
  count: number;
}

function casualtyKey(playerId: number | null, type: UnitType): string {
  return `${playerId === null ? "neutral" : playerId}:${type}`;
}

function compareCasualtyKeys(left: string, right: string): number {
  const [leftPlayer, leftType] = left.split(":") as [string, UnitType];
  const [rightPlayer, rightType] = right.split(":") as [string, UnitType];
  const leftId = leftPlayer === "neutral" ? -1 : Number(leftPlayer);
  const rightId = rightPlayer === "neutral" ? -1 : Number(rightPlayer);
  return leftId - rightId || UNIT_TYPES.indexOf(leftType) - UNIT_TYPES.indexOf(rightType);
}

function tickBattleRound(
  state: GameState,
  battle: BattleState,
  support: BattleSupport,
): Map<number | null, number> {
  const snapshots = battlePowerSnapshots(state, battle, support);
  const powers = new Map(
    snapshots.map((snapshot) => [snapshot.participant.playerId, snapshot.effectivePower]),
  );
  if (battle.ageTicks <= BATTLE_WARMUP_TICKS) return powers;
  const totalPower = snapshots.reduce((sum, snapshot) => sum + snapshot.effectivePower, 0);
  const controlChanges = new Map<number | null, number>();
  const incoming = new Map<string, number>();
  const targets: CasualtyTarget[] = snapshots.flatMap(({ participant }) =>
    UNIT_TYPES.filter((type) => participant.units[type] > 0).map((type) => ({
      key: casualtyKey(participant.playerId, type),
      playerId: participant.playerId,
      type,
      count: participant.units[type],
    })),
  );

  for (const snapshot of snapshots) {
    const ownPower = snapshot.effectivePower;
    const opposingPower = Math.max(0, totalPower - ownPower);
    const delta = battleControlDelta(ownPower, opposingPower);
    const winsTie =
      ownPower === opposingPower && snapshot.participant.playerId === battle.incumbentOwner;
    controlChanges.set(
      snapshot.participant.playerId,
      ownPower > opposingPower || winsTie ? delta : -delta,
    );
    for (const sourceType of UNIT_TYPES) {
      const pressure = Math.floor(
        snapshot.effectivePowerByType[sourceType] / BALANCE.combatPressurePowerDivisor,
      );
      const hostileTargets = targets
        .filter((target) => target.playerId !== snapshot.participant.playerId)
        .map((target) => ({
          key: target.key,
          weight: target.count * matchupPermille(sourceType, target.type),
        }));
      const allocation = allocateByWeight(pressure, hostileTargets, compareCasualtyKeys);
      for (const [key, amount] of allocation) incoming.set(key, (incoming.get(key) ?? 0) + amount);
    }
  }

  for (const snapshot of snapshots) {
    const participant = snapshot.participant;
    participant.control = Math.max(
      BATTLE_CONTROL_MIN,
      Math.min(
        BATTLE_CONTROL_MAX,
        participant.control + (controlChanges.get(participant.playerId) ?? 0),
      ),
    );
    for (const type of UNIT_TYPES) {
      const progress =
        participant.casualtyProgressMilli[type] +
        (incoming.get(casualtyKey(participant.playerId, type)) ?? 0);
      const intendedLoss = Math.floor(progress / PRESSURE_SCALE);
      participant.casualtyProgressMilli[type] = progress % PRESSURE_SCALE;
      const actualLoss = Math.min(participant.units[type], intendedLoss);
      participant.units[type] -= actualLoss;
      recordTroopLoss(state, participant.playerId, actualLoss);
    }
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
    (participant) => totalUnits(participant.units) > 0 && participant.control > BATTLE_CONTROL_MIN,
  );
  if (survivors.length === 0 && ordered.length > 0) {
    const chosen = [...ordered].sort((left, right) =>
      survivorOrder(battle, powers, left, right),
    )[0]!;
    if (totalUnits(chosen.units) <= 0) {
      chosen.units = unitsOf("melee", 1);
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
    const remaining = totalUnits(participant.units);
    if (remaining > 0) {
      recordTroopLoss(state, participant.playerId, remaining);
      participant.units = emptyUnits();
    }
  }
  battle.participants = survivors.sort(compareBattleParticipants);
}

function resolveBattle(state: GameState, battle: BattleState, winner: BattleParticipant): void {
  const tile = state.map.tiles[battle.tileId];
  if (!tile) return;
  for (const participant of battle.participants) {
    if (participant !== winner)
      recordTroopLoss(state, participant.playerId, totalUnits(participant.units));
  }
  state.battles = state.battles.filter((candidate) => candidate.id !== battle.id);
  const previousOwner = battle.incumbentOwner;
  if (winner.playerId === previousOwner) {
    tile.units = totalUnits(winner.units) > 0 ? { ...winner.units } : unitsOf("melee", 1);
    return;
  }
  if (winner.playerId === null) {
    tile.owner = null;
    tile.units = totalUnits(winner.units) > 0 ? { ...winner.units } : unitsOf("melee", 1);
    return;
  }
  const capturedStructure =
    tile.structure && tile.structure.completedCount > 0
      ? { type: tile.structure.type, completedCount: tile.structure.completedCount }
      : null;
  seizeStructure(tile);
  grantCaptureReward(state, winner.playerId, tile, previousOwner, capturedStructure);
  tile.owner = winner.playerId;
  tile.units = totalUnits(winner.units) > 0 ? { ...winner.units } : unitsOf("melee", 1);
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
  const support = adjacentSupportAssignments(state);
  const activeAtStart = [...state.battles];
  for (const battle of activeAtStart) {
    if (!state.battles.some((candidate) => candidate.id === battle.id)) continue;
    battle.ageTicks += 1;
    battle.roundAccumulator += 1;
    let powers = new Map(
      battlePowerSnapshots(state, battle, support).map((snapshot) => [
        snapshot.participant.playerId,
        snapshot.effectivePower,
      ]),
    );
    while (battle.roundAccumulator >= BALANCE.combatRoundTicks) {
      battle.roundAccumulator -= BALANCE.combatRoundTicks;
      powers = tickBattleRound(state, battle, support);
    }
    settleBattle(state, battle, powers);
  }
}

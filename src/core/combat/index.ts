import { BALANCE } from "../../shared/balance";
import type { BattleState, GameState, TileState, WaitingChallenger } from "../../shared/types";
import { seizeStructure, structureIntegrityPermille } from "../buildings";
import { emitEvent } from "../engine/events";
import { checkAndRewardElimination, grantCaptureReward } from "../rewards";

export const BATTLE_CONTROL_MIN = 0;
export const BATTLE_CONTROL_MAX = 10_000;
export const BATTLE_CONTROL_START = 5_000;
export const BATTLE_WARMUP_TICKS = 8;

function terrainDefensePermille(tile: TileState): number {
  if (tile.terrain === "forest") return 1000 + BALANCE.forestDefensePermille;
  if (tile.terrain === "hills") return 1000 + BALANCE.hillsDefensePermille;
  return 1000;
}

export function attackerEffectivePower(troops: number): number {
  return Math.max(0, troops) * 1000;
}

export function defenderEffectivePower(tile: TileState, troops: number): number {
  const turret = tile.structure?.type === "turret" ? tile.structure : null;
  const integrity = structureIntegrityPermille(turret);
  const virtualDefenders = Math.floor((BALANCE.turret.virtualDefenders * integrity) / 1000);
  const turretDefenseBonus = Math.floor((BALANCE.turret.defensePermille * integrity) / 1000);
  const basePower = (Math.max(0, troops) + virtualDefenders) * 1000;
  const terrainAdjusted = Math.floor((basePower * terrainDefensePermille(tile)) / 1000);
  return Math.floor((terrainAdjusted * (1000 + turretDefenseBonus)) / 1000);
}

export function battleControlDelta(attackerPower: number, defenderPower: number): number {
  const total = Math.max(1, attackerPower + defenderPower);
  const advantagePermille = Math.floor((Math.abs(attackerPower - defenderPower) * 1000) / total);
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

function addReinforcement(
  state: GameState,
  battle: BattleState,
  side: "attacker" | "defender",
  troops: number,
): void {
  if (side === "attacker") battle.attackerTroops += troops;
  else battle.defenderTroops += troops;

  const controlImpact = Math.min(800, troops * 20);
  battle.control = Math.max(
    BATTLE_CONTROL_MIN,
    Math.min(
      BATTLE_CONTROL_MAX,
      battle.control + (side === "attacker" ? controlImpact : -controlImpact),
    ),
  );
  battle.lastReinforcementTick = state.tick;
  battle.reinforcementSide = side;
  battle.reinforcementAmount = troops;
  emitEvent(state, {
    type: "reinforcement",
    playerId: side === "attacker" ? battle.attacker : (battle.defender ?? undefined),
    tileId: battle.tileId,
    amount: troops,
    message: `${troops} troops reinforced the ${side}`,
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
    defender: tile.owner,
    attacker,
    defenderTroops: tile.troops,
    attackerTroops: troops,
    control: BATTLE_CONTROL_START,
    ageTicks: 0,
    roundAccumulator: 0,
    entryFrom,
    waiting: [],
    lastReinforcementTick: -1,
    reinforcementSide: null,
    reinforcementAmount: 0,
  };
  state.nextEntityId += 1;
  tile.troops = 0;
  state.battles.push(battle);
  emitEvent(state, {
    type: "battle-started",
    playerId: attacker,
    tileId: tile.id,
    message: `${state.players[attacker]?.name ?? "An army"} attacked ${tile.id}`,
  });
  return battle;
}

function queueChallenger(
  battle: BattleState,
  owner: number,
  troops: number,
  entryFrom: string,
  tick: number,
): void {
  const existing = battle.waiting.find((entry) => entry.owner === owner);
  if (existing) {
    existing.troops += troops;
    return;
  }
  battle.waiting.push({ owner, troops, entryFrom, queuedTick: tick });
}

/** Resolves a stack reaching a tile into a merge, reinforcement, or challenge. */
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
    if (battle.attacker === owner) addReinforcement(state, battle, "attacker", troops);
    else if (battle.defender === owner) addReinforcement(state, battle, "defender", troops);
    else queueChallenger(battle, owner, troops, entryFrom, state.tick);
    return;
  }

  if (tile.owner === owner) {
    tile.troops += troops;
    return;
  }
  startBattle(state, tile, owner, troops, entryFrom);
}

function applyCasualties(state: GameState, battle: BattleState): void {
  if (battle.ageTicks <= BATTLE_WARMUP_TICKS || battle.ageTicks % 20 !== 0) return;
  const attackerBefore = battle.attackerTroops;
  const defenderBefore = battle.defenderTroops;

  if (defenderBefore > 1) {
    const defenderLoss = Math.min(defenderBefore - 1, Math.max(1, Math.floor(attackerBefore / 15)));
    battle.defenderTroops -= defenderLoss;
    recordTroopLoss(state, battle.defender, defenderLoss);
  }
  // Attackers take slower attrition. Small assaults remain readable without a
  // lone defender deleting one troop every combat second.
  if (battle.ageTicks % 60 === 0 && attackerBefore > 2 && defenderBefore > 0) {
    const attackerLoss = Math.min(attackerBefore - 2, Math.max(1, Math.floor(defenderBefore / 15)));
    battle.attackerTroops -= attackerLoss;
    recordTroopLoss(state, battle.attacker, attackerLoss);
  }
}

function enqueueAfterResolution(
  state: GameState,
  tile: TileState,
  waiting: WaitingChallenger[],
): void {
  let nextBattle: BattleState | null = null;
  for (const challenger of waiting) {
    if (challenger.owner === tile.owner) {
      if (nextBattle?.defender === challenger.owner) {
        addReinforcement(state, nextBattle, "defender", challenger.troops);
      } else {
        tile.troops += challenger.troops;
      }
      continue;
    }
    if (!nextBattle) {
      nextBattle = startBattle(
        state,
        tile,
        challenger.owner,
        challenger.troops,
        challenger.entryFrom,
      );
    } else if (nextBattle.attacker === challenger.owner) {
      addReinforcement(state, nextBattle, "attacker", challenger.troops);
    } else {
      queueChallenger(
        nextBattle,
        challenger.owner,
        challenger.troops,
        challenger.entryFrom,
        challenger.queuedTick,
      );
    }
  }
}

function resolveBattle(state: GameState, battle: BattleState, attackerWon: boolean): void {
  const tile = state.map.tiles[battle.tileId];
  if (!tile) return;
  const waiting = battle.waiting.map((entry) => ({ ...entry }));
  const previousOwner = battle.defender;
  const battleIndex = state.battles.findIndex((candidate) => candidate.id === battle.id);
  if (battleIndex >= 0) state.battles.splice(battleIndex, 1);

  if (attackerWon) {
    recordTroopLoss(state, battle.defender, battle.defenderTroops);
    const capturedStructure = seizeStructure(tile);
    grantCaptureReward(state, battle.attacker, tile, previousOwner, capturedStructure);
    tile.owner = battle.attacker;
    tile.troops = Math.max(1, battle.attackerTroops);
    tile.controlledSinceTick = state.tick;
    const attacker = state.players[battle.attacker];
    if (attacker) attacker.stats.tilesCaptured += 1;
    emitEvent(state, {
      type: "capture",
      playerId: battle.attacker,
      tileId: tile.id,
      message: `${attacker?.name ?? "Attacker"} captured ${tile.id}`,
    });
    if (capturedStructure) {
      emitEvent(state, {
        type: "structure-seized",
        playerId: battle.attacker,
        tileId: tile.id,
        message: `${capturedStructure} seized at 40% integrity`,
      });
    }
    checkAndRewardElimination(state, previousOwner, battle.attacker);
  } else {
    recordTroopLoss(state, battle.attacker, battle.attackerTroops);
    tile.troops = Math.max(1, battle.defenderTroops);
  }

  enqueueAfterResolution(state, tile, waiting);
}

function tickBattleRound(state: GameState, battle: BattleState): void {
  const tile = state.map.tiles[battle.tileId];
  if (!tile) return;
  if (battle.ageTicks <= BATTLE_WARMUP_TICKS) return;

  const attackerPower = attackerEffectivePower(battle.attackerTroops);
  const defenderPower = defenderEffectivePower(tile, battle.defenderTroops);
  const delta = battleControlDelta(attackerPower, defenderPower);
  // Exact ties lean toward the defender, ensuring every battle terminates.
  if (attackerPower > defenderPower) {
    battle.control = Math.min(BATTLE_CONTROL_MAX, battle.control + delta);
  } else {
    battle.control = Math.max(BATTLE_CONTROL_MIN, battle.control - delta);
  }
}

export function tickCombat(state: GameState): void {
  const activeAtStart = [...state.battles];
  for (const battle of activeAtStart) {
    if (!state.battles.some((candidate) => candidate.id === battle.id)) continue;
    battle.ageTicks += 1;
    battle.roundAccumulator += 1;
    while (battle.roundAccumulator >= BALANCE.combatRoundTicks) {
      battle.roundAccumulator -= BALANCE.combatRoundTicks;
      tickBattleRound(state, battle);
    }
    applyCasualties(state, battle);

    if (battle.ageTicks < BALANCE.minimumBattleTicks) continue;
    if (battle.control >= BATTLE_CONTROL_MAX) resolveBattle(state, battle, true);
    else if (battle.control <= BATTLE_CONTROL_MIN) resolveBattle(state, battle, false);
  }
}

import { BALANCE, TICKS_PER_SECOND } from "../shared/balance";
import type {
  BattleState,
  DebugScenario,
  GameState,
  StructureState,
  StructureType,
} from "../shared/types";
import { handleStackArrival } from "./combat";
import { createInitialState, refreshPlayerAggregates } from "./engine";
import { emitEvent } from "./engine/events";
import { cloneDeterministic, hashGameState } from "./hash";
import { axialKey, distance, neighbors, parseAxialKey } from "./hex";
import { checkAndRewardElimination } from "./rewards";

export const DEBUG_SCENARIOS = [
  "structures",
  "battle",
  "battle-minimum",
  "reinforcement",
  "capture-before",
  "capture",
  "developed-capture",
  "elimination",
  "interior-build",
  "victory",
  "defeat",
] as const satisfies readonly DebugScenario[];

interface ScenarioLocation {
  targetId: string;
  entryFrom: string;
}

function localPlayerId(state: GameState): number {
  const configured = state.config.localPlayerId ?? 0;
  return state.players[configured] ? configured : 0;
}

function opponentId(state: GameState, localId: number): number {
  const opponent = state.players.find((player) => player.id !== localId);
  if (!opponent) throw new Error("Debug scenarios require at least two players");
  return opponent.id;
}

/**
 * Recreate the deterministic opening position while retaining monotonic tick
 * and entity IDs. This makes every fixture independent of prior live play,
 * while sequential battle -> reinforcement -> capture requests still animate.
 */
function createScenarioBase(previous: GameState): GameState {
  const next = cloneDeterministic(createInitialState(previous.config));
  next.tick = previous.tick + 1;
  next.nextEntityId = Math.max(1, previous.nextEntityId);
  next.paused = true;
  next.stacks = [];
  next.battles = [];
  next.events = [];
  next.victory = { leaderId: null, holdTicks: 0, winnerId: null, reason: null };
  return next;
}

function findScenarioLocation(state: GameState, playerId: number): ScenarioLocation {
  const cluster = state.map.spawnClusters[playerId];
  const centerId = state.map.spawnCenters[playerId];
  if (!cluster || !centerId) throw new Error(`Player ${playerId} has no spawn cluster`);

  const clusterSet = new Set(cluster);
  const candidates = new Set<string>();
  for (const sourceId of cluster) {
    const source = state.map.tiles[sourceId]!;
    for (const adjacent of neighbors(source)) {
      const id = axialKey(adjacent);
      const tile = state.map.tiles[id];
      if (tile && tile.terrain !== "water" && !clusterSet.has(id)) candidates.add(id);
    }
  }

  const targetId = [...candidates].sort((left, right) => {
    const byDistance =
      distance(parseAxialKey(left), parseAxialKey(centerId)) -
      distance(parseAxialKey(right), parseAxialKey(centerId));
    return byDistance || left.localeCompare(right);
  })[0];
  if (!targetId) throw new Error(`Player ${playerId} has no adjacent scenario tile`);

  const target = state.map.tiles[targetId]!;
  const entryFrom = cluster.find((id) =>
    neighbors(target).some((adjacent) => axialKey(adjacent) === id),
  );
  if (!entryFrom) throw new Error(`Scenario tile ${targetId} has no spawn-cluster entry`);
  return { targetId, entryFrom };
}

function activeStructure(type: StructureType): StructureState {
  return {
    type,
    status: "active",
    integrity: BALANCE.fullIntegrity,
    progressTicks: 0,
    seizedTicks: 0,
    productionPaused: false,
  };
}

function existingBattleId(previous: GameState, tileId: string): number | null {
  return previous.battles.find((battle) => battle.tileId === tileId)?.id ?? null;
}

function installBattle(
  state: GameState,
  previous: GameState,
  location: ScenarioLocation,
  attacker: number,
  defender: number,
  options: {
    attackerTroops: number;
    defenderTroops: number;
    control: number;
    ageTicks: number;
    roundAccumulator?: number;
  },
): BattleState {
  const target = state.map.tiles[location.targetId]!;
  const entry = state.map.tiles[location.entryFrom]!;
  target.owner = defender;
  target.troops = 0;
  target.structure = null;
  entry.owner = attacker;
  entry.troops = Math.max(entry.troops, 72);

  const retainedId = existingBattleId(previous, location.targetId);
  const id = retainedId ?? state.nextEntityId++;
  state.nextEntityId = Math.max(state.nextEntityId, id + 1);
  const battle: BattleState = {
    id,
    tileId: target.id,
    defender,
    attacker,
    defenderTroops: options.defenderTroops,
    attackerTroops: options.attackerTroops,
    control: options.control,
    ageTicks: options.ageTicks,
    roundAccumulator: options.roundAccumulator ?? 0,
    entryFrom: entry.id,
    waiting: [],
    lastReinforcementTick: -1,
    reinforcementSide: null,
    reinforcementAmount: 0,
  };
  state.battles = [battle];
  return battle;
}

function addStructures(state: GameState, playerId: number): void {
  const cluster = state.map.spawnClusters[playerId];
  if (!cluster || cluster.length < 3) throw new Error("Structure scenario needs a spawn cluster");
  const musterId = cluster.find((id) => state.map.tiles[id]!.terrain === "muster");
  const meadowId = cluster.find((id) => state.map.tiles[id]!.terrain === "meadow");
  const turretId = cluster.find((id) => id !== musterId && id !== meadowId);
  if (!musterId || !meadowId || !turretId) {
    throw new Error("Structure scenario needs nearby Muster and Meadow terrain");
  }

  for (const id of cluster) {
    const tile = state.map.tiles[id]!;
    tile.owner = playerId;
    tile.structure = null;
    tile.troops = Math.max(tile.troops, 18);
  }
  state.map.tiles[musterId]!.structure = activeStructure("barracks");
  state.map.tiles[meadowId]!.structure = activeStructure("farm");
  state.map.tiles[turretId]!.structure = activeStructure("turret");
  const player = state.players[playerId]!;
  player.supplyMilli = Math.max(player.supplyMilli, 500 * 1000);
  player.stats.structuresBuilt = Math.max(player.stats.structuresBuilt, 3);
}

function addBattle(
  state: GameState,
  previous: GameState,
  reinforced: boolean,
  captureReady: boolean,
): void {
  const localId = localPlayerId(state);
  const enemyId = opponentId(state, localId);
  const location = findScenarioLocation(state, localId);
  const battle = installBattle(state, previous, location, localId, enemyId, {
    attackerTroops: captureReady ? 96 : 56,
    defenderTroops: captureReady ? 24 : 56,
    control: captureReady ? 9_900 : 5_000,
    ageTicks: captureReady ? BALANCE.minimumBattleTicks - 1 : 0,
    roundAccumulator: captureReady ? BALANCE.combatRoundTicks - 1 : 0,
  });

  if (reinforced) {
    handleStackArrival(state, localId, 40, battle.tileId, location.entryFrom);
  } else {
    emitEvent(state, {
      type: "battle-started",
      playerId: localId,
      tileId: battle.tileId,
      message: captureReady
        ? "Debug assault is one combat round from capture"
        : "Debug forces meet at exact parity",
    });
  }
}

function addMinimumDurationBattle(state: GameState, previous: GameState): void {
  const localId = localPlayerId(state);
  const enemyId = opponentId(state, localId);
  for (const player of state.players) {
    if (player.id === localId) continue;
    player.supplyMilli = 0;
    for (const tileId of state.map.landIds) {
      const tile = state.map.tiles[tileId]!;
      if (tile.owner !== player.id) continue;
      tile.troops = 1;
      tile.structure = null;
    }
  }
  const location = findScenarioLocation(state, localId);
  const battle = installBattle(state, previous, location, localId, enemyId, {
    attackerTroops: 96,
    defenderTroops: 1,
    control: 9_900,
    ageTicks: 0,
    roundAccumulator: BALANCE.combatRoundTicks - 1,
  });
  emitEvent(state, {
    type: "battle-started",
    playerId: localId,
    tileId: battle.tileId,
    message: "Debug assault is control-ready but must honor minimum battle time",
  });
}

function addDevelopedCapture(state: GameState, previous: GameState): void {
  const localId = localPlayerId(state);
  const enemyId = opponentId(state, localId);
  const location = findScenarioLocation(state, localId);
  state.tick = Math.max(state.tick, BALANCE.minimumOwnershipRewardTicks);
  // The capture resolves on the next tick. Align the frozen fixture to a
  // settlement boundary so that tick cannot also add ordinary land income;
  // browser acceptance can then assert the reward amount exactly even when a
  // heavily loaded runner took many live ticks before requesting the fixture.
  state.tick = Math.ceil(state.tick / TICKS_PER_SECOND) * TICKS_PER_SECOND;
  const battle = installBattle(state, previous, location, localId, enemyId, {
    attackerTroops: 96,
    defenderTroops: 24,
    control: 9_900,
    ageTicks: BALANCE.minimumBattleTicks - 1,
    roundAccumulator: BALANCE.combatRoundTicks - 1,
  });
  const target = state.map.tiles[battle.tileId]!;
  target.terrain = "meadow";
  target.structure = activeStructure("farm");
  target.controlledSinceTick = 0;
  target.lastRewardTick = 0;
  emitEvent(state, {
    type: "battle-started",
    playerId: localId,
    tileId: battle.tileId,
    message: "Debug assault is one combat round from seizing a developed tile",
  });
}

function addElimination(state: GameState): void {
  const localId = localPlayerId(state);
  const enemyId = opponentId(state, localId);
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    if (tile.owner === enemyId) {
      tile.owner = null;
      tile.troops = 1;
      tile.structure = null;
    }
  }
  state.players[enemyId]!.supplyMilli = 1_000_000;
  checkAndRewardElimination(state, enemyId, localId);
}

function addInteriorBuildTile(state: GameState, playerId: number): void {
  const cluster = state.map.spawnClusters[playerId];
  const centerId = state.map.spawnCenters[playerId];
  if (!cluster || !centerId) throw new Error("Interior-build scenario needs a spawn cluster");
  const clusterSet = new Set(cluster);
  const center = state.map.tiles[centerId]!;
  for (const id of cluster) {
    const tile = state.map.tiles[id]!;
    tile.owner = playerId;
    tile.troops = Math.max(tile.troops, 18);
  }
  const enclosed = neighbors(center).every((adjacent) => clusterSet.has(axialKey(adjacent)));
  if (!enclosed) throw new Error("Spawn center is not enclosed by owned land");
  center.structure = null;
  state.players[playerId]!.supplyMilli = Math.max(state.players[playerId]!.supplyMilli, 500 * 1000);
}

function addCapturedTile(state: GameState): void {
  const localId = localPlayerId(state);
  const { targetId } = findScenarioLocation(state, localId);
  const tile = state.map.tiles[targetId]!;
  tile.owner = localId;
  tile.troops = 72;
  tile.structure = null;
  tile.controlledSinceTick = state.tick;
  tile.lastRewardTick = state.tick;
  const player = state.players[localId]!;
  player.supplyMilli += BALANCE.captureRewardMilli;
  player.stats.tilesCaptured = Math.max(1, player.stats.tilesCaptured);
  player.stats.supplyEarnedMilli += BALANCE.captureRewardMilli;
  emitEvent(state, {
    type: "capture",
    playerId: localId,
    tileId: targetId,
    message: `${player.name} captured ${targetId}`,
  });
  emitEvent(state, {
    type: "reward",
    playerId: localId,
    tileId: targetId,
    amount: BALANCE.captureRewardMilli,
    message: `+${BALANCE.captureRewardMilli / 1000} Supply for hostile capture`,
  });
}

function addCompletedMatch(state: GameState, winnerId: number): void {
  const winner = state.players[winnerId]!;
  state.tick = Math.max(state.tick, 1_834);
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    if (tile.owner !== winnerId) {
      tile.owner = null;
      tile.troops = 1;
      tile.structure = null;
    }
  }
  for (const player of state.players) {
    const won = player.id === winnerId;
    player.eliminated = !won;
    player.eliminatedBy = won ? null : winnerId;
    if (!won) player.supplyMilli = 0;
  }
  winner.stats.tilesCaptured = Math.max(winner.stats.tilesCaptured, 42);
  winner.stats.enemiesEliminated = state.players.length - 1;
  winner.stats.troopsTrained = Math.max(winner.stats.troopsTrained, 64);
  state.victory = {
    leaderId: winnerId,
    holdTicks: 0,
    winnerId,
    reason: "sole-survivor",
  };
  emitEvent(state, {
    type: "victory",
    playerId: winnerId,
    message: `${winner.name} wins by elimination`,
  });
}

/**
 * Builds a frozen, deterministic browser-acceptance fixture without modifying
 * the supplied authoritative state. Both this function and the worker protocol
 * reject production matches where `config.debug` is false.
 */
export function createDebugScenario(state: GameState, scenario: DebugScenario): GameState {
  if (!state.config.debug) throw new Error("Debug scenarios require a debug match");
  if (!DEBUG_SCENARIOS.includes(scenario)) {
    throw new Error(`Unknown debug scenario: ${String(scenario)}`);
  }

  const next = createScenarioBase(state);
  const localId = localPlayerId(next);
  switch (scenario) {
    case "structures":
      addStructures(next, localId);
      break;
    case "battle":
      addBattle(next, state, false, false);
      break;
    case "battle-minimum":
      addMinimumDurationBattle(next, state);
      break;
    case "reinforcement":
      addBattle(next, state, true, false);
      break;
    case "capture-before":
      addBattle(next, state, false, true);
      break;
    case "capture":
      addCapturedTile(next);
      break;
    case "developed-capture":
      addDevelopedCapture(next, state);
      break;
    case "elimination":
      addElimination(next);
      break;
    case "interior-build":
      addInteriorBuildTile(next, localId);
      break;
    case "victory":
      addCompletedMatch(next, localId);
      break;
    case "defeat":
      addCompletedMatch(next, opponentId(next, localId));
      break;
  }

  refreshPlayerAggregates(next);
  next.stateHash = hashGameState(next);
  return next;
}

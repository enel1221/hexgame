import { BALANCE } from "../../shared/balance";
import type { GameState, StructureState, StructureType, TileState } from "../../shared/types";
import { emitEvent } from "../engine/events";
import { findPath } from "../hex/pathfinding";
import { dispatchExactMovingStack } from "../movement";

export interface BuildingRule {
  costMilli: number;
  buildTicks: number;
}

export const BUILDING_RULES: Record<StructureType, BuildingRule> = {
  farm: { costMilli: BALANCE.farm.costMilli, buildTicks: BALANCE.farm.buildTicks },
  barracks: {
    costMilli: BALANCE.barracks.costMilli,
    buildTicks: BALANCE.barracks.buildTicks,
  },
  turret: {
    costMilli: BALANCE.turret.costMilli,
    buildTicks: BALANCE.turret.buildTicks,
  },
};

export interface PlacementResult {
  ok: boolean;
  reason?: string;
}

export interface CapturedStructure {
  type: StructureType;
  completedCount: number;
}

export function createEmptyStructureStack(type: StructureType): StructureState {
  return {
    type,
    completedCount: 0,
    status: null,
    integrity: 0,
    pendingProgressTicks: 0,
    seizedTicks: 0,
    productionPaused: false,
    barracksProgressMilli: 0,
    rallyTargetId: null,
    rallyQueuedTroops: 0,
    turretShotProgressMilli: 0,
  };
}

export function canPlaceStructure(
  state: GameState,
  playerId: number,
  tileId: string,
  type: StructureType,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const player = state.players[playerId];
  const tile = state.map.tiles[tileId];
  if (!player || player.eliminated) return { ok: false, reason: "Player is eliminated" };
  if (!tile || tile.terrain === "water") return { ok: false, reason: "Tile is not playable land" };
  if (tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (state.battles.some((battle) => battle.tileId === tileId)) {
    return { ok: false, reason: "Cannot build on a contested tile" };
  }
  const structure = tile.structure;
  if (structure) {
    if (structure.type !== type)
      return { ok: false, reason: "Tile has a different structure type" };
    if (structure.pendingProgressTicks !== null) {
      return { ok: false, reason: "A structure copy is already under construction" };
    }
    if (structure.completedCount >= BALANCE.maxStructureCount) {
      return { ok: false, reason: `Structure stack is capped at ${BALANCE.maxStructureCount}` };
    }
    if (structure.status === "seized") {
      return { ok: false, reason: "Seized structures must reactivate before expanding" };
    }
  }
  if (type === "farm" && tile.terrain !== "meadow") {
    return { ok: false, reason: "Farms require Fertile Meadow" };
  }
  if (type === "barracks" && tile.terrain !== "muster") {
    return { ok: false, reason: "Barracks require Muster Ground" };
  }
  if (player.supplyMilli < BUILDING_RULES[type].costMilli) {
    return { ok: false, reason: "Not enough Supply" };
  }
  return { ok: true };
}

export function startConstruction(
  state: GameState,
  playerId: number,
  tileId: string,
  type: StructureType,
): PlacementResult {
  const validation = canPlaceStructure(state, playerId, tileId, type);
  if (!validation.ok) return validation;

  state.players[playerId]!.supplyMilli -= BUILDING_RULES[type].costMilli;
  const tile = state.map.tiles[tileId]!;
  if (tile.structure) tile.structure.pendingProgressTicks = 0;
  else tile.structure = createEmptyStructureStack(type);
  emitEvent(state, {
    type: "construction-started",
    playerId,
    tileId,
    message: `${state.players[playerId]!.name} began ${type} x${tile.structure.completedCount + 1}`,
  });
  return { ok: true };
}

export function cancelConstruction(
  state: GameState,
  playerId: number,
  tileId: string,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure || tile.structure.pendingProgressTicks === null) {
    return { ok: false, reason: "No construction to cancel" };
  }
  if (state.battles.some((battle) => battle.tileId === tileId)) {
    return { ok: false, reason: "Construction is paused while contested" };
  }

  const refund = Math.floor(
    (BUILDING_RULES[tile.structure.type].costMilli * BALANCE.cancelRefundPermille) / 1000,
  );
  state.players[playerId]!.supplyMilli += refund;
  if (tile.structure.completedCount === 0) tile.structure = null;
  else tile.structure.pendingProgressTicks = null;
  return { ok: true };
}

export function toggleBarracksProduction(
  state: GameState,
  playerId: number,
  tileId: string,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure || tile.structure.type !== "barracks") {
    return { ok: false, reason: "Tile has no Barracks" };
  }
  if (!isStructureOperational(tile.structure)) {
    return { ok: false, reason: "Barracks is not operational" };
  }
  tile.structure.productionPaused = !tile.structure.productionPaused;
  return { ok: true };
}

export function canSetBarracksRally(
  state: GameState,
  playerId: number,
  tileId: string,
  destinationId: string,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  const destination = state.map.tiles[destinationId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (
    !tile.structure ||
    tile.structure.type !== "barracks" ||
    !isStructureOperational(tile.structure)
  ) {
    return { ok: false, reason: "Tile has no operational Barracks" };
  }
  if (!destination || destination.terrain === "water" || destinationId === tileId) {
    return { ok: false, reason: "Rally destination is not playable land" };
  }
  if (!findPath(state.map, tileId, destinationId, playerId, true)) {
    return { ok: false, reason: "Rally destination is unreachable" };
  }
  return { ok: true };
}

export function setBarracksRally(
  state: GameState,
  playerId: number,
  tileId: string,
  destinationId: string,
): PlacementResult {
  const validation = canSetBarracksRally(state, playerId, tileId, destinationId);
  if (!validation.ok) return validation;
  const tile = state.map.tiles[tileId]!;
  tile.structure!.rallyTargetId = destinationId;
  emitEvent(state, {
    type: "rally-set",
    playerId,
    tileId,
    message: `Barracks rally set to ${destinationId}`,
  });
  return { ok: true };
}

export function clearBarracksRally(
  state: GameState,
  playerId: number,
  tileId: string,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure || tile.structure.type !== "barracks") {
    return { ok: false, reason: "Tile has no Barracks" };
  }
  tile.structure.rallyTargetId = null;
  tile.structure.rallyQueuedTroops = 0;
  emitEvent(state, {
    type: "rally-cleared",
    playerId,
    tileId,
    message: "Barracks rally cleared",
  });
  return { ok: true };
}

export function isStructureOperational(structure: StructureState | null): boolean {
  return Boolean(
    structure &&
    structure.completedCount > 0 &&
    (structure.status === "active" || structure.status === "repairing"),
  );
}

export function structureIntegrityPermille(structure: StructureState | null): number {
  return isStructureOperational(structure) ? structure!.integrity : 0;
}

/** Applies capture damage, destroying only the pending copy. */
export function seizeStructure(tile: TileState): CapturedStructure | null {
  const structure = tile.structure;
  if (!structure) return null;
  structure.pendingProgressTicks = null;
  if (structure.completedCount === 0) {
    tile.structure = null;
    return null;
  }

  const captured = { type: structure.type, completedCount: structure.completedCount };
  structure.status = "seized";
  structure.integrity = BALANCE.seizedIntegrity;
  structure.seizedTicks = 0;
  structure.productionPaused = false;
  structure.barracksProgressMilli = 0;
  structure.rallyTargetId = null;
  structure.rallyQueuedTroops = 0;
  structure.turretShotProgressMilli = 0;
  return captured;
}

function tickConstruction(state: GameState, tile: TileState, structure: StructureState): void {
  if (structure.pendingProgressTicks === null) return;
  if (state.battles.some((battle) => battle.tileId === tile.id)) return;
  structure.pendingProgressTicks += 1;
  const required = BUILDING_RULES[structure.type].buildTicks;
  if (structure.pendingProgressTicks < required) return;

  structure.completedCount += 1;
  structure.pendingProgressTicks = null;
  if (structure.status === null) {
    structure.status = "active";
    structure.integrity = BALANCE.fullIntegrity;
  }
  emitEvent(state, {
    type: "construction-complete",
    playerId: tile.owner ?? undefined,
    tileId: tile.id,
    message: `${structure.type} x${structure.completedCount} completed`,
  });
  const owner = tile.owner === null ? undefined : state.players[tile.owner];
  if (owner) owner.stats.structuresBuilt += 1;
}

function tickSeizure(structure: StructureState): void {
  structure.seizedTicks += 1;
  if (structure.seizedTicks < BALANCE.seizedTicks) return;
  structure.status = "repairing";
  structure.seizedTicks = 0;
}

function tickRepair(structure: StructureState): void {
  structure.seizedTicks += 1;
  const repairRange = BALANCE.fullIntegrity - BALANCE.seizedIntegrity;
  structure.integrity = Math.min(
    BALANCE.fullIntegrity,
    BALANCE.seizedIntegrity +
      Math.floor((repairRange * structure.seizedTicks) / BALANCE.repairTicks),
  );
  if (structure.seizedTicks < BALANCE.repairTicks) return;
  structure.status = "active";
  structure.integrity = BALANCE.fullIntegrity;
  structure.seizedTicks = 0;
}

export function barracksRallyPath(
  state: GameState,
  tile: TileState,
  structure: StructureState,
): string[] | null {
  if (tile.owner === null || !structure.rallyTargetId) return null;
  return findPath(state.map, tile.id, structure.rallyTargetId, tile.owner, true);
}

export function isBarracksRallyBlocked(
  state: GameState,
  tile: TileState,
  structure: StructureState,
): boolean {
  return structure.rallyTargetId !== null && barracksRallyPath(state, tile, structure) === null;
}

function tickBarracks(state: GameState, tile: TileState, structure: StructureState): void {
  if (tile.owner === null) return;
  structure.rallyQueuedTroops = Math.min(structure.rallyQueuedTroops, tile.troops);
  if (state.battles.some((battle) => battle.tileId === tile.id)) return;
  const player = state.players[tile.owner];
  if (!player) return;
  const rallyPath = barracksRallyPath(state, tile, structure);
  const hasRally = structure.rallyTargetId !== null;
  if (rallyPath && structure.rallyTargetId && structure.rallyQueuedTroops > 0) {
    const queued = structure.rallyQueuedTroops;
    tile.troops -= queued;
    structure.rallyQueuedTroops = 0;
    dispatchExactMovingStack(
      state,
      tile.owner,
      tile.id,
      structure.rallyTargetId,
      queued,
      rallyPath,
    );
    return;
  }
  if (structure.productionPaused) return;
  if (!hasRally && tile.troops >= BALANCE.barracks.localTarget) {
    structure.barracksProgressMilli = 0;
    return;
  }

  structure.barracksProgressMilli += structure.integrity;
  const cycle = BALANCE.barracks.trainTicks * BALANCE.fullIntegrity;
  if (structure.barracksProgressMilli < cycle) return;

  const affordable = Math.floor(player.supplyMilli / BALANCE.barracks.troopCostMilli);
  const localSpace = Math.max(0, BALANCE.barracks.localTarget - tile.troops);
  const capacity = rallyPath
    ? structure.completedCount
    : Math.min(structure.completedCount, localSpace);
  const trained = Math.min(capacity, affordable);
  if (trained <= 0) {
    structure.barracksProgressMilli = cycle;
    return;
  }

  structure.barracksProgressMilli -= cycle;
  player.supplyMilli -= trained * BALANCE.barracks.troopCostMilli;
  player.stats.troopsTrained += trained;
  if (rallyPath && structure.rallyTargetId) {
    dispatchExactMovingStack(
      state,
      tile.owner,
      tile.id,
      structure.rallyTargetId,
      trained,
      rallyPath,
    );
  } else {
    tile.troops += trained;
    if (hasRally) structure.rallyQueuedTroops += trained;
  }
}

export function tickStructures(state: GameState): void {
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    const structure = tile.structure;
    if (!structure) continue;

    tickConstruction(state, tile, structure);
    if (structure.status === "seized") {
      tickSeizure(structure);
      continue;
    }
    if (structure.status === "repairing") tickRepair(structure);
    if (structure.type === "barracks" && isStructureOperational(structure)) {
      tickBarracks(state, tile, structure);
    }
  }
}

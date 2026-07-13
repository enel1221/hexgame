import { BALANCE } from "../../shared/balance";
import type { GameState, StructureState, StructureType, TileState } from "../../shared/types";
import { emitEvent } from "../engine/events";
import { findPath } from "../hex/pathfinding";
import { dispatchExactMovingStack } from "../movement";
import {
  addUnits,
  emptyUnits,
  subtractUnits,
  totalUnits,
  unitTypeForStructure,
  unitsOf,
} from "../units";

export interface BuildingRule {
  costMilli: number;
  buildTicks: number;
  trainTicks: number;
  troopCostMilli: number;
  localTarget: number;
}

export const BUILDING_RULES: Record<StructureType, BuildingRule> = {
  barracks: {
    costMilli: BALANCE.barracks.costMilli,
    buildTicks: BALANCE.barracks.buildTicks,
    trainTicks: BALANCE.barracks.trainTicks,
    troopCostMilli: BALANCE.barracks.troopCostMilli,
    localTarget: BALANCE.barracks.localTarget,
  },
  "archery-range": {
    costMilli: BALANCE.archeryRange.costMilli,
    buildTicks: BALANCE.archeryRange.buildTicks,
    trainTicks: BALANCE.archeryRange.trainTicks,
    troopCostMilli: BALANCE.archeryRange.troopCostMilli,
    localTarget: BALANCE.archeryRange.localTarget,
  },
  "wizard-tower": {
    costMilli: BALANCE.wizardTower.costMilli,
    buildTicks: BALANCE.wizardTower.buildTicks,
    trainTicks: BALANCE.wizardTower.trainTicks,
    troopCostMilli: BALANCE.wizardTower.troopCostMilli,
    localTarget: BALANCE.wizardTower.localTarget,
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
    trainingProgressMilli: 0,
    rallyTargetId: null,
    rallyQueuedUnits: emptyUnits(),
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
  if (type === "archery-range" && tile.terrain !== "meadow") {
    return { ok: false, reason: "Archery Ranges require Fertile Meadow" };
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

export function toggleProduction(
  state: GameState,
  playerId: number,
  tileId: string,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure) return { ok: false, reason: "Tile has no production structure" };
  if (!isStructureOperational(tile.structure)) {
    return { ok: false, reason: "Production structure is not operational" };
  }
  tile.structure.productionPaused = !tile.structure.productionPaused;
  return { ok: true };
}

export function canSetRally(
  state: GameState,
  playerId: number,
  tileId: string,
  destinationId: string,
): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  const destination = state.map.tiles[destinationId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure || !isStructureOperational(tile.structure)) {
    return { ok: false, reason: "Tile has no operational production structure" };
  }
  if (!destination || destination.terrain === "water" || destinationId === tileId) {
    return { ok: false, reason: "Rally destination is not playable land" };
  }
  if (!findPath(state.map, tileId, destinationId, playerId, true)) {
    return { ok: false, reason: "Rally destination is unreachable" };
  }
  return { ok: true };
}

export function setRally(
  state: GameState,
  playerId: number,
  tileId: string,
  destinationId: string,
): PlacementResult {
  const validation = canSetRally(state, playerId, tileId, destinationId);
  if (!validation.ok) return validation;
  const tile = state.map.tiles[tileId]!;
  tile.structure!.rallyTargetId = destinationId;
  emitEvent(state, {
    type: "rally-set",
    playerId,
    tileId,
    message: `Production rally set to ${destinationId}`,
  });
  return { ok: true };
}

export function clearRally(state: GameState, playerId: number, tileId: string): PlacementResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure) return { ok: false, reason: "Tile has no production structure" };
  tile.structure.rallyTargetId = null;
  tile.structure.rallyQueuedUnits = emptyUnits();
  emitEvent(state, {
    type: "rally-cleared",
    playerId,
    tileId,
    message: "Production rally cleared",
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
  structure.trainingProgressMilli = 0;
  structure.rallyTargetId = null;
  structure.rallyQueuedUnits = emptyUnits();
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

export function rallyPath(
  state: GameState,
  tile: TileState,
  structure: StructureState,
): string[] | null {
  if (tile.owner === null || !structure.rallyTargetId) return null;
  return findPath(state.map, tile.id, structure.rallyTargetId, tile.owner, true);
}

export function isRallyBlocked(
  state: GameState,
  tile: TileState,
  structure: StructureState,
): boolean {
  return structure.rallyTargetId !== null && rallyPath(state, tile, structure) === null;
}

function tickProduction(state: GameState, tile: TileState, structure: StructureState): void {
  if (tile.owner === null) return;
  const unitType = unitTypeForStructure(structure.type);
  structure.rallyQueuedUnits = unitsOf(
    unitType,
    Math.min(structure.rallyQueuedUnits[unitType], tile.units[unitType]),
  );
  if (state.battles.some((battle) => battle.tileId === tile.id)) return;
  const player = state.players[tile.owner];
  if (!player) return;
  const route = rallyPath(state, tile, structure);
  const hasRally = structure.rallyTargetId !== null;
  if (route && structure.rallyTargetId && totalUnits(structure.rallyQueuedUnits) > 0) {
    const queued = structure.rallyQueuedUnits;
    tile.units = subtractUnits(tile.units, queued);
    structure.rallyQueuedUnits = emptyUnits();
    dispatchExactMovingStack(state, tile.owner, tile.id, structure.rallyTargetId, queued, route);
    return;
  }
  const rules = BUILDING_RULES[structure.type];
  if (structure.productionPaused) return;
  if (!hasRally && totalUnits(tile.units) >= rules.localTarget) {
    structure.trainingProgressMilli = 0;
    return;
  }

  structure.trainingProgressMilli += structure.integrity;
  const cycle = rules.trainTicks * BALANCE.fullIntegrity;
  if (structure.trainingProgressMilli < cycle) return;

  const affordable = Math.floor(player.supplyMilli / rules.troopCostMilli);
  const localSpace = Math.max(0, rules.localTarget - totalUnits(tile.units));
  const capacity = route
    ? structure.completedCount
    : Math.min(structure.completedCount, localSpace);
  const trained = Math.min(capacity, affordable);
  if (trained <= 0) {
    structure.trainingProgressMilli = cycle;
    return;
  }

  structure.trainingProgressMilli -= cycle;
  player.supplyMilli -= trained * rules.troopCostMilli;
  player.stats.troopsTrained += trained;
  const trainedUnits = unitsOf(unitType, trained);
  if (route && structure.rallyTargetId) {
    dispatchExactMovingStack(
      state,
      tile.owner,
      tile.id,
      structure.rallyTargetId,
      trainedUnits,
      route,
    );
  } else {
    tile.units = addUnits(tile.units, trainedUnits);
    if (hasRally) structure.rallyQueuedUnits = addUnits(structure.rallyQueuedUnits, trainedUnits);
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
    if (isStructureOperational(structure)) tickProduction(state, tile, structure);
  }
}

// Source-compatible aliases for non-authoritative callers during the UI migration.
export const toggleBarracksProduction = toggleProduction;
export const canSetBarracksRally = canSetRally;
export const setBarracksRally = setRally;
export const clearBarracksRally = clearRally;
export const barracksRallyPath = rallyPath;
export const isBarracksRallyBlocked = isRallyBlocked;

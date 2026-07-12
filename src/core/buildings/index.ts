import { BALANCE } from "../../shared/balance";
import type { GameState, StructureState, StructureType, TileState } from "../../shared/types";
import { emitEvent } from "../engine/events";

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

export function canPlaceStructure(
  state: GameState,
  playerId: number,
  tileId: string,
  type: StructureType,
): PlacementResult {
  const player = state.players[playerId];
  const tile = state.map.tiles[tileId];
  if (!player || player.eliminated) return { ok: false, reason: "Player is eliminated" };
  if (!tile || tile.terrain === "water") return { ok: false, reason: "Tile is not playable land" };
  if (tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (tile.structure) return { ok: false, reason: "Tile already has a structure" };
  if (state.battles.some((battle) => battle.tileId === tileId)) {
    return { ok: false, reason: "Cannot build on a contested tile" };
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
  state.map.tiles[tileId]!.structure = {
    type,
    status: "constructing",
    integrity: 0,
    progressTicks: 0,
    seizedTicks: 0,
    productionPaused: false,
  };
  emitEvent(state, {
    type: "construction-started",
    playerId,
    tileId,
    message: `${state.players[playerId]!.name} began a ${type}`,
  });
  return { ok: true };
}

export function cancelConstruction(
  state: GameState,
  playerId: number,
  tileId: string,
): PlacementResult {
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure || tile.structure.status !== "constructing") {
    return { ok: false, reason: "No construction to cancel" };
  }
  if (state.battles.some((battle) => battle.tileId === tileId)) {
    return { ok: false, reason: "Construction is paused while contested" };
  }

  const refund = Math.floor(
    (BUILDING_RULES[tile.structure.type].costMilli * BALANCE.cancelRefundPermille) / 1000,
  );
  state.players[playerId]!.supplyMilli += refund;
  tile.structure = null;
  return { ok: true };
}

export function toggleBarracksProduction(
  state: GameState,
  playerId: number,
  tileId: string,
): PlacementResult {
  const tile = state.map.tiles[tileId];
  if (!tile || tile.owner !== playerId) return { ok: false, reason: "Tile is not owned by player" };
  if (!tile.structure || tile.structure.type !== "barracks") {
    return { ok: false, reason: "Tile has no Barracks" };
  }
  if (tile.structure.status === "constructing" || tile.structure.status === "seized") {
    return { ok: false, reason: "Barracks is not operational" };
  }
  tile.structure.productionPaused = !tile.structure.productionPaused;
  return { ok: true };
}

export function isStructureOperational(structure: StructureState | null): boolean {
  return structure?.status === "active" || structure?.status === "repairing";
}

export function structureIntegrityPermille(structure: StructureState | null): number {
  return isStructureOperational(structure) ? structure!.integrity : 0;
}

/** Applies capture damage. Unfinished structures are destroyed without reward. */
export function seizeStructure(tile: TileState): StructureType | null {
  const structure = tile.structure;
  if (!structure) return null;
  if (structure.status === "constructing") {
    tile.structure = null;
    return null;
  }

  structure.status = "seized";
  structure.integrity = BALANCE.seizedIntegrity;
  structure.progressTicks = 0;
  structure.seizedTicks = 0;
  structure.productionPaused = false;
  return structure.type;
}

function tickConstruction(state: GameState, tile: TileState, structure: StructureState): void {
  if (state.battles.some((battle) => battle.tileId === tile.id)) return;
  structure.progressTicks += 1;
  const required = BUILDING_RULES[structure.type].buildTicks;
  structure.integrity = Math.min(
    BALANCE.fullIntegrity,
    Math.floor((structure.progressTicks * BALANCE.fullIntegrity) / required),
  );
  if (structure.progressTicks < required) return;

  structure.status = "active";
  structure.integrity = BALANCE.fullIntegrity;
  structure.progressTicks = 0;
  emitEvent(state, {
    type: "construction-complete",
    playerId: tile.owner ?? undefined,
    tileId: tile.id,
    message: `${structure.type} completed`,
  });
  const owner = tile.owner === null ? undefined : state.players[tile.owner];
  if (owner) owner.stats.structuresBuilt += 1;
}

function tickSeizure(structure: StructureState): void {
  structure.seizedTicks += 1;
  if (structure.seizedTicks < BALANCE.seizedTicks) return;
  structure.status = "repairing";
  structure.progressTicks = 0;
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

function tickBarracks(state: GameState, tile: TileState, structure: StructureState): void {
  if (tile.owner === null || structure.productionPaused) return;
  if (state.battles.some((battle) => battle.tileId === tile.id)) return;
  if (tile.troops >= BALANCE.barracks.localTarget) {
    structure.progressTicks = 0;
    return;
  }
  const player = state.players[tile.owner];
  if (!player || player.supplyMilli < BALANCE.barracks.troopCostMilli) return;

  // Repairing Barracks train in proportion to integrity without fractional state.
  const advances =
    structure.status === "active" ||
    (state.tick * structure.integrity) % BALANCE.fullIntegrity < structure.integrity;
  if (!advances) return;
  structure.progressTicks += 1;
  if (structure.progressTicks < BALANCE.barracks.trainTicks) return;

  structure.progressTicks = 0;
  player.supplyMilli -= BALANCE.barracks.troopCostMilli;
  tile.troops += 1;
  player.stats.troopsTrained += 1;
}

export function tickStructures(state: GameState): void {
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    const structure = tile.structure;
    if (!structure) continue;

    if (structure.status === "constructing") {
      tickConstruction(state, tile, structure);
      continue;
    } else if (structure.status === "seized") {
      tickSeizure(structure);
      continue;
    } else if (structure.status === "repairing") tickRepair(structure);

    if (structure.type === "barracks" && isStructureOperational(structure)) {
      tickBarracks(state, tile, structure);
    }
  }
}

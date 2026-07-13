import type { GameCommand, GameState } from "../../shared/types";
import {
  canPlaceStructure,
  canSetRally,
  cancelConstruction,
  startConstruction,
  clearRally,
  setRally,
  toggleProduction,
} from "../buildings";
import { executeMultiMove, issueMoveOrder, planMultiMove, validateMoveOrder } from "../movement";
import { applyPlacementCommand, validateSpawnChoice } from "../placement";

export interface CommandResult {
  ok: boolean;
  reason?: string;
}

export function validateCommand(state: GameState, command: GameCommand): CommandResult {
  if (state.victory.winnerId !== null) return { ok: false, reason: "Match is complete" };
  if (!Number.isInteger(command.playerId)) return { ok: false, reason: "Invalid player" };

  switch (command.type) {
    case "choose-spawn":
      return validateSpawnChoice(state, command.playerId, command.centerId);
    case "lock-spawn": {
      const placement = state.placement.placements[command.playerId];
      if (state.phase !== "placement") return { ok: false, reason: "Placement is complete" };
      if (!state.players[command.playerId]?.isHuman || !placement) {
        return { ok: false, reason: "Invalid player" };
      }
      if (placement.locked) return { ok: false, reason: "Placement is already locked" };
      return placement.centerId
        ? { ok: true }
        : { ok: false, reason: "Choose a starting center first" };
    }
    case "move":
      return validateMoveOrder(
        state,
        command.playerId,
        command.sourceId,
        command.destinationId,
        command.percent,
      );
    case "multi-move": {
      const plan = planMultiMove(
        state,
        command.playerId,
        command.sourceIds,
        command.destinationIds,
        command.percent,
      );
      return { ok: plan.ok, reason: plan.reason };
    }
    case "build":
      return canPlaceStructure(state, command.playerId, command.tileId, command.structure);
    case "cancel-build": {
      if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
      const tile = state.map.tiles[command.tileId];
      if (!tile || tile.owner !== command.playerId) {
        return { ok: false, reason: "Tile is not owned by player" };
      }
      if (!tile.structure || tile.structure.pendingProgressTicks === null) {
        return { ok: false, reason: "No construction to cancel" };
      }
      if (state.battles.some((battle) => battle.tileId === tile.id)) {
        return { ok: false, reason: "Construction is paused while contested" };
      }
      return { ok: true };
    }
    case "toggle-production": {
      if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
      const tile = state.map.tiles[command.tileId];
      if (!tile || tile.owner !== command.playerId) {
        return { ok: false, reason: "Tile is not owned by player" };
      }
      if (!tile.structure) return { ok: false, reason: "Tile has no production structure" };
      if (tile.structure.completedCount <= 0 || tile.structure.status === "seized") {
        return { ok: false, reason: "Production structure is not operational" };
      }
      return { ok: true };
    }
    case "set-rally": {
      return canSetRally(state, command.playerId, command.tileId, command.destinationId);
    }
    case "clear-rally": {
      if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
      const tile = state.map.tiles[command.tileId];
      return tile?.owner === command.playerId && tile.structure
        ? { ok: true }
        : { ok: false, reason: "Tile has no owned production structure" };
    }
  }
}

/** Mutates state on success; invalid commands leave it untouched. */
export function applyCommand(state: GameState, command: GameCommand): CommandResult {
  const validation = validateCommand(state, command);
  if (!validation.ok) return validation;

  switch (command.type) {
    case "choose-spawn":
    case "lock-spawn":
      return applyPlacementCommand(state, command);
    case "move":
      return issueMoveOrder(
        state,
        command.playerId,
        command.sourceId,
        command.destinationId,
        command.percent,
      );
    case "multi-move":
      return executeMultiMove(
        state,
        command.playerId,
        command.sourceIds,
        command.destinationIds,
        command.percent,
      );
    case "build":
      return startConstruction(state, command.playerId, command.tileId, command.structure);
    case "cancel-build":
      return cancelConstruction(state, command.playerId, command.tileId);
    case "toggle-production":
      return toggleProduction(state, command.playerId, command.tileId);
    case "set-rally":
      return setRally(state, command.playerId, command.tileId, command.destinationId);
    case "clear-rally":
      return clearRally(state, command.playerId, command.tileId);
  }
}

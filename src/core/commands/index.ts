import type { GameCommand, GameState } from "../../shared/types";
import {
  canPlaceStructure,
  cancelConstruction,
  startConstruction,
  toggleBarracksProduction,
} from "../buildings";
import { issueMoveOrder, validateMoveOrder } from "../movement";

export interface CommandResult {
  ok: boolean;
  reason?: string;
}

export function validateCommand(state: GameState, command: GameCommand): CommandResult {
  if (state.victory.winnerId !== null) return { ok: false, reason: "Match is complete" };
  if (!Number.isInteger(command.playerId)) return { ok: false, reason: "Invalid player" };

  switch (command.type) {
    case "move":
      return validateMoveOrder(
        state,
        command.playerId,
        command.sourceId,
        command.destinationId,
        command.percent,
      );
    case "build":
      return canPlaceStructure(state, command.playerId, command.tileId, command.structure);
    case "cancel-build": {
      const tile = state.map.tiles[command.tileId];
      if (!tile || tile.owner !== command.playerId) {
        return { ok: false, reason: "Tile is not owned by player" };
      }
      if (!tile.structure || tile.structure.status !== "constructing") {
        return { ok: false, reason: "No construction to cancel" };
      }
      if (state.battles.some((battle) => battle.tileId === tile.id)) {
        return { ok: false, reason: "Construction is paused while contested" };
      }
      return { ok: true };
    }
    case "toggle-barracks": {
      const tile = state.map.tiles[command.tileId];
      if (!tile || tile.owner !== command.playerId) {
        return { ok: false, reason: "Tile is not owned by player" };
      }
      if (!tile.structure || tile.structure.type !== "barracks") {
        return { ok: false, reason: "Tile has no Barracks" };
      }
      if (tile.structure.status === "constructing" || tile.structure.status === "seized") {
        return { ok: false, reason: "Barracks is not operational" };
      }
      return { ok: true };
    }
  }
}

/** Mutates state on success; invalid commands leave it untouched. */
export function applyCommand(state: GameState, command: GameCommand): CommandResult {
  const validation = validateCommand(state, command);
  if (!validation.ok) return validation;

  switch (command.type) {
    case "move":
      return issueMoveOrder(
        state,
        command.playerId,
        command.sourceId,
        command.destinationId,
        command.percent,
      );
    case "build":
      return startConstruction(state, command.playerId, command.tileId, command.structure);
    case "cancel-build":
      return cancelConstruction(state, command.playerId, command.tileId);
    case "toggle-barracks":
      return toggleBarracksProduction(state, command.playerId, command.tileId);
  }
}

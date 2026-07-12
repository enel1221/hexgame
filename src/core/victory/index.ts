import { BALANCE, TICKS_PER_SECOND } from "../../shared/balance";
import type { GameState } from "../../shared/types";
import { emitEvent } from "../engine/events";

export function controlledLandCount(state: GameState, playerId: number): number {
  let count = 0;
  for (const tileId of state.map.landIds) {
    if (state.map.tiles[tileId]!.owner === playerId) count += 1;
  }
  return count;
}

export function controlPermille(state: GameState, playerId: number): number {
  if (state.map.landCount <= 0) return 0;
  return Math.floor((controlledLandCount(state, playerId) * 1000) / state.map.landCount);
}

function declareVictory(
  state: GameState,
  playerId: number,
  reason: "control" | "sole-survivor",
): void {
  state.victory.winnerId = playerId;
  state.victory.reason = reason;
  emitEvent(state, {
    type: "victory",
    playerId,
    message: `${state.players[playerId]?.name ?? "Player"} wins by ${
      reason === "control" ? "land control" : "elimination"
    }`,
  });
}

export function tickVictory(state: GameState): void {
  if (state.victory.winnerId !== null) return;

  const survivors = state.players.filter((player) => !player.eliminated);
  if (state.players.length > 1 && survivors.length === 1) {
    state.victory.leaderId = survivors[0]!.id;
    declareVictory(state, survivors[0]!.id, "sole-survivor");
    return;
  }

  let thresholdLeader: number | null = null;
  for (const player of survivors) {
    if (controlPermille(state, player.id) >= BALANCE.victoryThresholdPermille) {
      thresholdLeader = player.id;
      break;
    }
  }

  if (thresholdLeader === null) {
    state.victory.leaderId = null;
    state.victory.holdTicks = 0;
    return;
  }

  if (state.victory.leaderId !== thresholdLeader) {
    state.victory.leaderId = thresholdLeader;
    state.victory.holdTicks = 1;
    emitEvent(state, {
      type: "victory-countdown",
      playerId: thresholdLeader,
      amount: BALANCE.victoryHoldTicks,
      message: `${state.players[thresholdLeader]!.name} must hold 80% for ${
        BALANCE.victoryHoldTicks / TICKS_PER_SECOND
      } seconds`,
    });
  } else {
    state.victory.holdTicks += 1;
  }

  if (state.victory.holdTicks >= BALANCE.victoryHoldTicks) {
    declareVictory(state, thresholdLeader, "control");
  }
}

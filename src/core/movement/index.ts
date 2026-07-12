import { BALANCE } from "../../shared/balance";
import type { GameState, MovingStack, SendPercent, TileState } from "../../shared/types";
import { findPath } from "../hex/pathfinding";
import { handleStackArrival } from "../combat";
import { emitEvent } from "../engine/events";

export interface MoveResult {
  ok: boolean;
  reason?: string;
  stack?: MovingStack;
}

export function movementTicksForTile(tile: TileState): number {
  if (tile.terrain === "hills") {
    return Math.ceil((BALANCE.baseMovementTicks * BALANCE.hillsMovementPermille) / 1000);
  }
  return BALANCE.baseMovementTicks;
}

export function troopsForPercent(troops: number, percent: SendPercent): number {
  if (troops <= 1) return 0;
  return Math.min(troops - 1, Math.floor((troops * percent) / 100));
}

export function issueMoveOrder(
  state: GameState,
  playerId: number,
  sourceId: string,
  destinationId: string,
  percent: SendPercent,
): MoveResult {
  const validation = validateMoveOrder(state, playerId, sourceId, destinationId, percent);
  if (!validation.ok) return validation;
  const source = state.map.tiles[sourceId]!;
  const troops = troopsForPercent(source.troops, percent);
  const path = findPath(state.map, sourceId, destinationId, playerId, true)!;

  source.troops -= troops;
  const id = state.nextEntityId;
  state.nextEntityId += 1;
  const stack: MovingStack = {
    id,
    owner: playerId,
    troops,
    path,
    pathIndex: 0,
    segmentProgress: 0,
    segmentDuration: movementTicksForTile(state.map.tiles[path[1]]!),
    originId: sourceId,
    destinationId,
    lane: (id % 3) - 1,
    issuedTick: state.tick,
  };
  state.stacks.push(stack);
  emitEvent(state, {
    type: "order",
    playerId,
    tileId: destinationId,
    amount: troops,
    message: `${troops} troops ordered to ${destinationId}`,
  });
  return { ok: true, stack };
}

export function validateMoveOrder(
  state: GameState,
  playerId: number,
  sourceId: string,
  destinationId: string,
  percent: SendPercent,
): MoveResult {
  const player = state.players[playerId];
  const source = state.map.tiles[sourceId];
  const destination = state.map.tiles[destinationId];
  if (!player || player.eliminated) return { ok: false, reason: "Player is eliminated" };
  if (!source || source.owner !== playerId) {
    return { ok: false, reason: "Source tile is not owned by player" };
  }
  if (!destination || destination.terrain === "water") {
    return { ok: false, reason: "Destination is not playable land" };
  }
  if (sourceId === destinationId) return { ok: false, reason: "Source and destination are equal" };
  const troops = troopsForPercent(source.troops, percent);
  if (troops <= 0) return { ok: false, reason: "At least one troop must remain behind" };

  const path = findPath(state.map, sourceId, destinationId, playerId, true);
  if (!path || path.length < 2) return { ok: false, reason: "Destination is unreachable" };
  return { ok: true };
}

function canEnterNext(state: GameState, stack: MovingStack): boolean {
  const currentId = stack.path[stack.pathIndex];
  if (!currentId || state.map.tiles[currentId]?.owner !== stack.owner) return false;
  const nextIndex = stack.pathIndex + 1;
  const nextId = stack.path[nextIndex];
  if (!nextId) return false;
  const isFinal = nextIndex === stack.path.length - 1;
  return isFinal || state.map.tiles[nextId]?.owner === stack.owner;
}

function lastOwnedPosition(state: GameState, stack: MovingStack): string | null {
  for (let index = stack.pathIndex; index >= 0; index -= 1) {
    const id = stack.path[index]!;
    if (state.map.tiles[id]?.owner === stack.owner) return id;
  }
  return null;
}

export function rerouteInterruptedStack(state: GameState, stack: MovingStack): boolean {
  const currentId = stack.path[stack.pathIndex]!;
  if (state.map.tiles[currentId]?.owner === stack.owner) {
    const rerouted = findPath(state.map, currentId, stack.destinationId, stack.owner, true);
    if (rerouted && rerouted.length >= 2) {
      stack.path = rerouted;
      stack.pathIndex = 0;
      stack.segmentProgress = 0;
      stack.segmentDuration = movementTicksForTile(state.map.tiles[rerouted[1]]!);
      emitEvent(state, {
        type: "route-interrupted",
        playerId: stack.owner,
        tileId: currentId,
        message: `Army ${stack.id} recalculated its route`,
      });
      return true;
    }
  }

  const stopId = lastOwnedPosition(state, stack);
  if (stopId) state.map.tiles[stopId]!.troops += stack.troops;
  emitEvent(state, {
    type: "route-interrupted",
    playerId: stack.owner,
    tileId: stopId ?? currentId,
    message: `Army ${stack.id} stopped after its route was cut`,
  });
  return false;
}

export function tickMovement(state: GameState): void {
  const movingAtStart = [...state.stacks];
  for (const stack of movingAtStart) {
    if (!state.stacks.some((candidate) => candidate.id === stack.id)) continue;
    if (!canEnterNext(state, stack)) {
      if (!rerouteInterruptedStack(state, stack)) {
        state.stacks = state.stacks.filter((candidate) => candidate.id !== stack.id);
      }
      continue;
    }

    stack.segmentProgress += 1;
    if (stack.segmentProgress < stack.segmentDuration) continue;
    stack.pathIndex += 1;
    stack.segmentProgress = 0;
    const reachedId = stack.path[stack.pathIndex]!;

    if (stack.pathIndex >= stack.path.length - 1) {
      state.stacks = state.stacks.filter((candidate) => candidate.id !== stack.id);
      const entryFrom = stack.path[Math.max(0, stack.pathIndex - 1)] ?? stack.originId;
      handleStackArrival(state, stack.owner, stack.troops, reachedId, entryFrom);
      continue;
    }

    const nextId = stack.path[stack.pathIndex + 1]!;
    stack.segmentDuration = movementTicksForTile(state.map.tiles[nextId]!);
  }
}

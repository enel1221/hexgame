import { BALANCE } from "../../shared/balance";
import type { GeneratedMap, TerrainType } from "../../shared/types";
import { distance, neighbors, parseAxialKey } from "./coordinates";

const BASE_COST = 1000;

export function terrainMovementCost(terrain: TerrainType): number {
  if (terrain === "water") return Number.POSITIVE_INFINITY;
  if (terrain === "hills") {
    return Math.ceil((BASE_COST * BALANCE.hillsMovementPermille) / 1000);
  }
  return BASE_COST;
}

interface QueueEntry {
  id: string;
  cost: number;
  estimate: number;
  sequence: number;
}

class MinQueue {
  private readonly values: QueueEntry[] = [];

  get size(): number {
    return this.values.length;
  }

  push(entry: QueueEntry): void {
    this.values.push(entry);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!comesBefore(this.values[index]!, this.values[parent]!)) break;
      [this.values[index], this.values[parent]] = [this.values[parent]!, this.values[index]!];
      index = parent;
    }
  }

  pop(): QueueEntry | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    this.values[0] = last;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.values.length && comesBefore(this.values[left]!, this.values[smallest]!)) {
        smallest = left;
      }
      if (right < this.values.length && comesBefore(this.values[right]!, this.values[smallest]!)) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.values[index], this.values[smallest]] = [this.values[smallest]!, this.values[index]!];
      index = smallest;
    }
    return first;
  }
}

function comesBefore(left: QueueEntry, right: QueueEntry): boolean {
  if (left.estimate !== right.estimate) return left.estimate < right.estimate;
  if (left.cost !== right.cost) return left.cost < right.cost;
  const idComparison = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  if (idComparison !== 0) return idComparison < 0;
  return left.sequence < right.sequence;
}

function reconstructPath(cameFrom: Map<string, string>, destinationId: string): string[] {
  const output = [destinationId];
  let cursor = destinationId;
  while (cameFrom.has(cursor)) {
    cursor = cameFrom.get(cursor)!;
    output.push(cursor);
  }
  output.reverse();
  return output;
}

/**
 * Deterministic A*. Friendly cells may be traversed; when enabled, one hostile
 * or neutral destination is legal only as the final step.
 */
export function findPath(
  map: GeneratedMap,
  startId: string,
  destinationId: string,
  owner: number,
  allowHostileDestination = true,
): string[] | null {
  const start = map.tiles[startId];
  const destination = map.tiles[destinationId];
  if (!start || !destination) return null;
  if (start.terrain === "water" || destination.terrain === "water") return null;
  if (start.owner !== owner) return null;
  if (startId === destinationId) return [startId];
  if (destination.owner !== owner && !allowHostileDestination) return null;

  const destinationHex = { q: destination.q, r: destination.r };
  const frontier = new MinQueue();
  const cameFrom = new Map<string, string>();
  const bestCost = new Map<string, number>([[startId, 0]]);
  let sequence = 0;
  frontier.push({
    id: startId,
    cost: 0,
    estimate: distance(start, destinationHex) * BASE_COST,
    sequence: sequence++,
  });

  while (frontier.size > 0) {
    const current = frontier.pop()!;
    if (current.cost !== bestCost.get(current.id)) continue;
    if (current.id === destinationId) {
      return reconstructPath(cameFrom, destinationId);
    }

    const currentHex = parseAxialKey(current.id);
    for (const nextHex of neighbors(currentHex)) {
      const nextId = `${nextHex.q},${nextHex.r}`;
      const tile = map.tiles[nextId];
      if (!tile || tile.terrain === "water") continue;
      const isDestination = nextId === destinationId;
      if (tile.owner !== owner && !(allowHostileDestination && isDestination)) {
        continue;
      }

      const nextCost = current.cost + terrainMovementCost(tile.terrain);
      const previousCost = bestCost.get(nextId);
      if (previousCost !== undefined && previousCost <= nextCost) continue;

      bestCost.set(nextId, nextCost);
      cameFrom.set(nextId, current.id);
      frontier.push({
        id: nextId,
        cost: nextCost,
        estimate: nextCost + distance(nextHex, destinationHex) * BASE_COST,
        sequence: sequence++,
      });
    }
  }

  return null;
}

export function findFriendlyPath(
  map: GeneratedMap,
  startId: string,
  destinationId: string,
  owner: number,
): string[] | null {
  return findPath(map, startId, destinationId, owner, false);
}

/** Explicit name for orders that may take exactly one final hostile step. */
export function findOwnedPathToTarget(
  map: GeneratedMap,
  startId: string,
  destinationId: string,
  owner: number,
): string[] | null {
  return findPath(map, startId, destinationId, owner, true);
}

export function pathMovementCost(map: GeneratedMap, path: readonly string[]): number {
  let cost = 0;
  for (let index = 1; index < path.length; index += 1) {
    const tile = map.tiles[path[index]!];
    if (!tile) return Number.POSITIVE_INFINITY;
    cost += terrainMovementCost(tile.terrain);
  }
  return cost;
}

export function isLegalPath(
  map: GeneratedMap,
  path: readonly string[],
  owner: number,
  allowHostileDestination = true,
): boolean {
  if (path.length === 0) return false;
  for (let index = 0; index < path.length; index += 1) {
    const id = path[index]!;
    const tile = map.tiles[id];
    if (!tile || tile.terrain === "water") return false;
    if (index > 0) {
      const previous = map.tiles[path[index - 1]!]!;
      if (distance(previous, tile) !== 1) return false;
    }
    const mayBeHostile = allowHostileDestination && index === path.length - 1;
    if (tile.owner !== owner && !mayBeHostile) return false;
  }
  return true;
}

/** Last cell a stack can legally occupy after ownership changes under its route. */
export function lastLegalFriendlyTile(
  map: GeneratedMap,
  path: readonly string[],
  owner: number,
): string | null {
  let last: string | null = null;
  for (const id of path) {
    const tile = map.tiles[id];
    if (!tile || tile.terrain === "water" || tile.owner !== owner) break;
    last = id;
  }
  return last;
}

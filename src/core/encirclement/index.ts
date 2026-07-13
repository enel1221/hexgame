import { BALANCE } from "../../shared/balance";
import type { EnclosureState, GameState, GeneratedMap } from "../../shared/types";
import { seizeStructure } from "../buildings";
import { emitEvent } from "../engine/events";
import { axialKey, neighbors } from "../hex";
import { rerouteInterruptedStack } from "../movement";
import { checkAndRewardElimination, grantCaptureReward } from "../rewards";
import { addUnits, emptyUnits, totalUnits } from "../units";

interface DetectedPocket {
  captorId: number;
  tileIds: string[];
  boundaryIds: string[];
}

interface MapTopology {
  ids: string[];
  indexById: Map<string, number>;
  neighbors: number[][];
  touchesEscape: Uint8Array;
}

const topologyCache = new WeakMap<GeneratedMap, MapTopology>();

function compareTileIds(state: GameState, left: string, right: string): number {
  const leftTile = state.map.tiles[left];
  const rightTile = state.map.tiles[right];
  if (leftTile && rightTile) return leftTile.q - rightTile.q || leftTile.r - rightTile.r;
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapTopology(state: GameState): MapTopology {
  const cached = topologyCache.get(state.map);
  if (cached) return cached;
  const ids = [...state.map.landIds].sort((left, right) => compareTileIds(state, left, right));
  const indexById = new Map(ids.map((id, index) => [id, index]));
  const adjacency: number[][] = Array.from({ length: ids.length }, () => []);
  const touchesEscape = new Uint8Array(ids.length);
  for (let index = 0; index < ids.length; index += 1) {
    const tile = state.map.tiles[ids[index]!]!;
    for (const adjacent of neighbors(tile)) {
      const id = axialKey(adjacent);
      const adjacentIndex = indexById.get(id);
      if (adjacentIndex === undefined) touchesEscape[index] = 1;
      else adjacency[index]!.push(adjacentIndex);
    }
    adjacency[index]!.sort((left, right) => left - right);
  }
  const created = { ids, indexById, neighbors: adjacency, touchesEscape };
  topologyCache.set(state.map, created);
  return created;
}

/**
 * Find every non-captor land component whose complete boundary is one
 * uncontested captor. Water and missing rectangle cells are explicit escapes.
 */
export function detectEnclosedPockets(state: GameState): DetectedPocket[] {
  const topology = mapTopology(state);
  const contested = new Uint8Array(topology.ids.length);
  for (const battle of state.battles) {
    const index = topology.indexById.get(battle.tileId);
    if (index !== undefined) contested[index] = 1;
  }
  const owners = topology.ids.map((id) => state.map.tiles[id]!.owner);
  const output: DetectedPocket[] = [];
  for (const player of [...state.players].sort((left, right) => left.id - right.id)) {
    if (player.eliminated) continue;
    const captorId = player.id;
    const visited = new Uint8Array(topology.ids.length);
    for (let startIndex = 0; startIndex < topology.ids.length; startIndex += 1) {
      if (visited[startIndex] || owners[startIndex] === captorId) continue;
      const component: number[] = [];
      const boundary = new Set<number>();
      const queue = [startIndex];
      visited[startIndex] = 1;
      let touchesEscape = false;
      let boundaryBreached = false;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor]!;
        component.push(index);
        if (topology.touchesEscape[index]) touchesEscape = true;
        for (const neighborIndex of topology.neighbors[index]!) {
          if (owners[neighborIndex] === captorId) {
            boundary.add(neighborIndex);
            if (contested[neighborIndex]) boundaryBreached = true;
            continue;
          }
          if (!visited[neighborIndex]) {
            visited[neighborIndex] = 1;
            queue.push(neighborIndex);
          }
        }
      }
      if (touchesEscape || boundaryBreached || boundary.size === 0) continue;
      component.sort((left, right) => left - right);
      output.push({
        captorId,
        tileIds: component.map((index) => topology.ids[index]!),
        boundaryIds: [...boundary]
          .sort((left, right) => left - right)
          .map((index) => topology.ids[index]!),
      });
    }
  }
  output.sort(
    (left, right) =>
      left.captorId - right.captorId || compareTileIds(state, left.tileIds[0]!, right.tileIds[0]!),
  );
  return output;
}

function overlaps(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.some((id) => right.has(id));
}

function sameTileSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function nextEnclosureRecords(
  state: GameState,
  pockets: readonly DetectedPocket[],
): { active: EnclosureState[]; completing: EnclosureState[] } {
  const previous = [...state.enclosures].sort(
    (left, right) =>
      left.captorId - right.captorId ||
      compareTileIds(state, left.tileIds[0]!, right.tileIds[0]!) ||
      left.id - right.id,
  );
  const retainedIds = new Set<number>();
  const active: EnclosureState[] = [];
  const completing: EnclosureState[] = [];

  for (const pocket of pockets) {
    const tileSet = new Set(pocket.tileIds);
    const matching = previous
      .filter((record) => record.captorId === pocket.captorId && overlaps(record.tileIds, tileSet))
      .sort(
        (left, right) =>
          left.progressTicks - right.progressTicks ||
          compareTileIds(state, left.tileIds[0]!, right.tileIds[0]!) ||
          left.id - right.id,
      );
    const progressTicks = (matching[0]?.progressTicks ?? 0) + 1;
    const retainable = matching
      .filter((record) => !retainedIds.has(record.id) && tileSet.has(record.tileIds[0]!))
      .sort((left, right) => left.id - right.id)[0];
    const fallback = matching
      .filter((record) => !retainedIds.has(record.id))
      .sort((left, right) => left.id - right.id)[0];
    const inherited = retainable ?? fallback;
    const id = inherited?.id ?? state.nextEntityId++;
    retainedIds.add(id);
    const record: EnclosureState = {
      id,
      captorId: pocket.captorId,
      tileIds: pocket.tileIds,
      boundaryIds: pocket.boundaryIds,
      progressTicks,
    };
    if (progressTicks >= BALANCE.encirclementTicks) completing.push(record);
    else active.push(record);
    if (matching.length === 0) {
      emitEvent(state, {
        type: "encirclement-started",
        playerId: pocket.captorId,
        tileId: pocket.tileIds[0],
        tileIds: pocket.tileIds,
        amount: BALANCE.encirclementTicks,
        message: `${state.players[pocket.captorId]?.name ?? "A ruler"} enclosed ${
          pocket.tileIds.length
        } tiles`,
      });
    }
  }
  return { active, completing };
}

function recordTroopLoss(state: GameState, playerId: number | null, troops: number): void {
  if (playerId === null || troops <= 0) return;
  const player = state.players[playerId];
  if (player) player.stats.troopsLost += troops;
}

function stackCurrentTileId(stack: GameState["stacks"][number]): string | null {
  return stack.path[Math.min(stack.pathIndex, stack.path.length - 1)] ?? null;
}

function routeNeedsRefresh(state: GameState, stack: GameState["stacks"][number]): boolean {
  const currentId = stackCurrentTileId(stack);
  if (!currentId || state.map.tiles[currentId]?.owner !== stack.owner) return true;
  const nextIndex = stack.pathIndex + 1;
  const nextId = stack.path[nextIndex];
  if (!nextId) return false;
  const final = nextIndex === stack.path.length - 1;
  return !final && state.map.tiles[nextId]?.owner !== stack.owner;
}

function refreshSurvivingRoutes(state: GameState): void {
  const retained = [];
  for (const stack of [...state.stacks].sort((left, right) => left.id - right.id)) {
    if (!routeNeedsRefresh(state, stack) || rerouteInterruptedStack(state, stack)) {
      retained.push(stack);
    }
  }
  state.stacks = retained;
}

function completeEnclosure(state: GameState, enclosure: EnclosureState): void {
  const captor = state.players[enclosure.captorId];
  if (!captor || captor.eliminated) return;
  const pocket = new Set(enclosure.tileIds);
  const eliminatedCandidates = new Set<number>();
  const captorBattleUnits = new Map<string, ReturnType<typeof emptyUnits>>();

  // A stack's authoritative rule position is path[pathIndex]. Presentation
  // interpolation never decides whether it was trapped.
  const survivingStacks = [];
  for (const stack of [...state.stacks].sort((left, right) => left.id - right.id)) {
    const currentId = stackCurrentTileId(stack);
    if (stack.owner !== enclosure.captorId && currentId && pocket.has(currentId)) {
      recordTroopLoss(state, stack.owner, totalUnits(stack.units));
      continue;
    }
    survivingStacks.push(stack);
  }
  state.stacks = survivingStacks;

  const survivingBattles = [];
  for (const battle of state.battles) {
    if (!pocket.has(battle.tileId)) {
      survivingBattles.push(battle);
      continue;
    }
    for (const participant of battle.participants) {
      if (participant.playerId === enclosure.captorId) {
        captorBattleUnits.set(
          battle.tileId,
          addUnits(captorBattleUnits.get(battle.tileId) ?? emptyUnits(), participant.units),
        );
      } else {
        recordTroopLoss(state, participant.playerId, totalUnits(participant.units));
      }
    }
  }
  state.battles = survivingBattles;

  for (const tileId of enclosure.tileIds) {
    const tile = state.map.tiles[tileId]!;
    const previousOwner = tile.owner;
    if (previousOwner !== null && previousOwner !== enclosure.captorId) {
      eliminatedCandidates.add(previousOwner);
      recordTroopLoss(state, previousOwner, totalUnits(tile.units));
    }
    const capturedStructure =
      tile.structure && tile.structure.completedCount > 0
        ? { type: tile.structure.type, completedCount: tile.structure.completedCount }
        : null;
    seizeStructure(tile);
    grantCaptureReward(state, enclosure.captorId, tile, previousOwner, capturedStructure);
    tile.owner = enclosure.captorId;
    tile.units = captorBattleUnits.get(tileId) ?? emptyUnits();
    tile.controlledSinceTick = state.tick;
    captor.stats.tilesCaptured += 1;
    emitEvent(state, {
      type: "capture",
      playerId: enclosure.captorId,
      tileId,
      message: `${captor.name} consumed enclosed territory at ${tileId}`,
    });
    if (capturedStructure) {
      emitEvent(state, {
        type: "structure-seized",
        playerId: enclosure.captorId,
        tileId,
        amount: capturedStructure.completedCount,
        message: `${capturedStructure.type} x${capturedStructure.completedCount} seized at 40% integrity`,
      });
    }
  }

  refreshSurvivingRoutes(state);
  for (const defeatedId of [...eliminatedCandidates].sort((left, right) => left - right)) {
    checkAndRewardElimination(state, defeatedId, enclosure.captorId);
  }
  emitEvent(state, {
    type: "encirclement-complete",
    playerId: enclosure.captorId,
    tileId: enclosure.tileIds[0],
    tileIds: enclosure.tileIds,
    amount: enclosure.tileIds.length,
    message: `${captor.name} captured ${enclosure.tileIds.length} enclosed tiles`,
  });
}

/** Advance, reset, and atomically complete every authoritative enclosure. */
export function tickEncirclements(state: GameState): void {
  if (state.phase !== "running" || state.victory.winnerId !== null) return;
  const pockets = detectEnclosedPockets(state);
  const { active, completing } = nextEnclosureRecords(state, pockets);
  state.enclosures = active;
  for (const enclosure of completing) {
    // Canonical earlier completions can consume the boundary of a nested or
    // otherwise overlapping pocket. Re-detect against that post-transition
    // state so a stale record cannot capture territory after its ring is gone.
    // Disjoint pockets remain present and still complete in this same tick.
    const currentPocket = detectEnclosedPockets(state).find(
      (pocket) =>
        pocket.captorId === enclosure.captorId && sameTileSet(pocket.tileIds, enclosure.tileIds),
    );
    if (!currentPocket) continue;
    completeEnclosure(state, { ...enclosure, boundaryIds: currentPocket.boundaryIds });
  }
  if (completing.length > 0 && state.enclosures.length > 0) {
    // A completed outer pocket can consume the ring of a still-counting nested
    // pocket. Retain progress only for records that are still the exact same
    // enclosure after every same-tick ownership transition; changed pockets
    // restart from fresh detection on the following tick.
    const currentPockets = detectEnclosedPockets(state);
    state.enclosures = state.enclosures.flatMap((record) => {
      const current = currentPockets.find(
        (pocket) =>
          pocket.captorId === record.captorId && sameTileSet(pocket.tileIds, record.tileIds),
      );
      return current ? [{ ...record, boundaryIds: current.boundaryIds }] : [];
    });
  }
  state.enclosures.sort(
    (left, right) =>
      left.captorId - right.captorId ||
      compareTileIds(state, left.tileIds[0]!, right.tileIds[0]!) ||
      left.id - right.id,
  );
}

import { BALANCE } from "../../shared/balance";
import type {
  GameState,
  MovingStack,
  SendPercent,
  TileState,
  UnitCounts,
} from "../../shared/types";
import { parseAxialKey } from "../hex";
import { findPath, pathMovementCost } from "../hex/pathfinding";
import { handleStackArrival } from "../combat";
import { emitEvent } from "../engine/events";
import {
  addUnits,
  allocateUnitsAcrossTotals,
  subtractUnits,
  takeUnitsProportionally,
  totalUnits,
} from "../units";

export interface MoveResult {
  ok: boolean;
  reason?: string;
  stack?: MovingStack;
}

export interface MultiMoveDispatch {
  sourceId: string;
  destinationId: string;
  troops: number;
  units: UnitCounts;
  path: string[];
}

export interface MultiMovePlan {
  ok: boolean;
  reason?: string;
  pooledTroops: number;
  sourceContributions: Array<{ sourceId: string; troops: number; units: UnitCounts }>;
  destinationQuotas: Array<{ destinationId: string; troops: number }>;
  dispatches: MultiMoveDispatch[];
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

export function unitsForPercent(units: UnitCounts, percent: SendPercent): UnitCounts {
  return takeUnitsProportionally(units, troopsForPercent(totalUnits(units), percent));
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
  const units = unitsForPercent(source.units, percent);
  const path = findPath(state.map, sourceId, destinationId, playerId, true)!;

  source.units = subtractUnits(source.units, units);
  const stack = dispatchExactMovingStack(state, playerId, sourceId, destinationId, units, path);
  return { ok: true, stack };
}

export function dispatchExactMovingStack(
  state: GameState,
  playerId: number,
  sourceId: string,
  destinationId: string,
  units: UnitCounts,
  suppliedPath?: readonly string[],
  emitOrder = true,
): MovingStack {
  const path = suppliedPath
    ? [...suppliedPath]
    : findPath(state.map, sourceId, destinationId, playerId, true);
  const troopCount = totalUnits(units);
  if (!path || path.length < 2 || troopCount <= 0) {
    throw new Error("Invalid exact stack dispatch");
  }
  const id = state.nextEntityId++;
  const stack: MovingStack = {
    id,
    owner: playerId,
    units: { ...units },
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
  if (emitOrder) {
    emitEvent(state, {
      type: "order",
      playerId,
      tileId: destinationId,
      amount: troopCount,
      message: `${troopCount} troops ordered to ${destinationId}`,
    });
  }
  return stack;
}

function compareAxialIds(left: string, right: string): number {
  const leftHex = parseAxialKey(left);
  const rightHex = parseAxialKey(right);
  return leftHex.q - rightHex.q || leftHex.r - rightHex.r;
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
  cost: number;
  initialCapacity: number;
  order: number;
}

function addFlowEdge(
  graph: FlowEdge[][],
  from: number,
  to: number,
  capacity: number,
  cost: number,
  order: number,
): void {
  const forward: FlowEdge = {
    to,
    reverse: graph[to]!.length,
    capacity,
    cost,
    initialCapacity: capacity,
    order,
  };
  const reverse: FlowEdge = {
    to: from,
    reverse: graph[from]!.length,
    capacity: 0,
    cost: -cost,
    initialCapacity: 0,
    order,
  };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
}

function minimumCostAllocation(
  contributions: readonly { sourceId: string; troops: number; units: UnitCounts }[],
  quotas: readonly { destinationId: string; troops: number }[],
  routes: ReadonlyMap<string, { path: string[]; cost: number }>,
): MultiMoveDispatch[] | null {
  const sourceNode = 0;
  const firstSource = 1;
  const firstDestination = firstSource + contributions.length;
  const sinkNode = firstDestination + quotas.length;
  const graph: FlowEdge[][] = Array.from({ length: sinkNode + 1 }, () => []);
  let order = 0;
  contributions.forEach((source, index) =>
    addFlowEdge(graph, sourceNode, firstSource + index, source.troops, 0, order++),
  );
  const routeEdges = new Map<string, FlowEdge>();
  contributions.forEach((source, sourceIndex) => {
    quotas.forEach((destination, destinationIndex) => {
      const key = `${source.sourceId}\u0000${destination.destinationId}`;
      const route = routes.get(key);
      if (!route) return;
      const from = firstSource + sourceIndex;
      const before = graph[from]!.length;
      addFlowEdge(
        graph,
        from,
        firstDestination + destinationIndex,
        source.troops,
        route.cost,
        order++,
      );
      routeEdges.set(key, graph[from]![before]!);
    });
  });
  quotas.forEach((destination, index) =>
    addFlowEdge(graph, firstDestination + index, sinkNode, destination.troops, 0, order++),
  );

  const targetFlow = quotas.reduce((sum, destination) => sum + destination.troops, 0);
  // Successive shortest augmenting paths with Johnson potentials keep every
  // residual edge cost non-negative. This avoids predecessor cycles while
  // retaining a true global minimum-cost transportation plan.
  const potential = new Array<number>(graph.length).fill(0);
  let flow = 0;
  while (flow < targetFlow) {
    const distance = new Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const previousNode = new Array<number>(graph.length).fill(-1);
    const previousEdge = new Array<number>(graph.length).fill(-1);
    const previousOrder = new Array<number>(graph.length).fill(Number.POSITIVE_INFINITY);
    const visited = new Array<boolean>(graph.length).fill(false);
    distance[sourceNode] = 0;
    for (let step = 0; step < graph.length; step += 1) {
      let node = -1;
      for (let candidate = 0; candidate < graph.length; candidate += 1) {
        if (visited[candidate] || !Number.isFinite(distance[candidate]!)) continue;
        if (
          node < 0 ||
          distance[candidate]! < distance[node]! ||
          (distance[candidate] === distance[node] && candidate < node)
        ) {
          node = candidate;
        }
      }
      if (node < 0) break;
      visited[node] = true;
      if (node === sinkNode) break;
      for (let edgeIndex = 0; edgeIndex < graph[node]!.length; edgeIndex += 1) {
        const edge = graph[node]![edgeIndex]!;
        if (edge.capacity <= 0 || visited[edge.to]) continue;
        const reducedCost = edge.cost + potential[node]! - potential[edge.to]!;
        const nextDistance = distance[node]! + reducedCost;
        if (
          nextDistance < distance[edge.to]! ||
          (nextDistance === distance[edge.to]! && edge.order < previousOrder[edge.to]!)
        ) {
          distance[edge.to] = nextDistance;
          previousNode[edge.to] = node;
          previousEdge[edge.to] = edgeIndex;
          previousOrder[edge.to] = edge.order;
        }
      }
    }
    if (previousNode[sinkNode] < 0) return null;
    for (let node = 0; node < graph.length; node += 1) {
      if (Number.isFinite(distance[node]!)) potential[node] += distance[node]!;
    }
    let amount = targetFlow - flow;
    for (let node = sinkNode; node !== sourceNode; node = previousNode[node]!) {
      amount = Math.min(amount, graph[previousNode[node]!]![previousEdge[node]!]!.capacity);
    }
    for (let node = sinkNode; node !== sourceNode; node = previousNode[node]!) {
      const edge = graph[previousNode[node]!]![previousEdge[node]!]!;
      edge.capacity -= amount;
      graph[node]![edge.reverse]!.capacity += amount;
    }
    flow += amount;
  }

  const dispatches: MultiMoveDispatch[] = [];
  for (const source of contributions) {
    for (const destination of quotas) {
      const key = `${source.sourceId}\u0000${destination.destinationId}`;
      const edge = routeEdges.get(key);
      const route = routes.get(key);
      if (!edge || !route) continue;
      const troops = edge.initialCapacity - edge.capacity;
      if (troops > 0) {
        dispatches.push({
          sourceId: source.sourceId,
          destinationId: destination.destinationId,
          troops,
          units: { melee: 0, ranged: 0, wizard: 0 },
          path: route.path,
        });
      }
    }
  }
  return dispatches;
}

/** Shared pure planner used by validation, execution, and UI previews. */
export function planMultiMove(
  state: GameState,
  playerId: number,
  sourceIds: readonly string[],
  destinationIds: readonly string[],
  percent: SendPercent,
): MultiMovePlan {
  const rejected = (reason: string): MultiMovePlan => ({
    ok: false,
    reason,
    pooledTroops: 0,
    sourceContributions: [],
    destinationQuotas: [],
    dispatches: [],
  });
  const player = state.players[playerId];
  if (state.phase !== "running") return rejected("Match is not running");
  if (!player || player.eliminated) return rejected("Player is eliminated");
  if (![25, 50, 75, 100].includes(percent)) return rejected("Invalid movement percentage");
  if (sourceIds.length < 1 || sourceIds.length > BALANCE.maxMultiMoveSources) {
    return rejected("Source count is outside the command limit");
  }
  if (destinationIds.length < 1 || destinationIds.length > BALANCE.maxMultiMoveDestinations) {
    return rejected("Destination count is outside the command limit");
  }
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(destinationIds).size !== destinationIds.length
  ) {
    return rejected("Movement IDs contain duplicates");
  }
  if (sourceIds.some((id) => !state.map.tiles[id] || state.map.tiles[id]!.terrain === "water")) {
    return rejected("Source references non-playable land");
  }
  if (
    destinationIds.some((id) => !state.map.tiles[id] || state.map.tiles[id]!.terrain === "water")
  ) {
    return rejected("Destination references non-playable land");
  }

  const destinations = [...destinationIds].sort(compareAxialIds);
  const destinationSet = new Set(destinations);
  const contributions = [...sourceIds]
    .sort(compareAxialIds)
    .filter((id) => !destinationSet.has(id))
    .map((sourceId) => ({
      sourceId,
      tile: state.map.tiles[sourceId]!,
    }))
    // Scheduled orders deterministically omit sources lost before execution.
    .filter(({ tile }) => tile.owner === playerId && totalUnits(tile.units) > 1)
    .map(({ sourceId, tile }) => {
      const units = unitsForPercent(tile.units, percent);
      return { sourceId, troops: totalUnits(units), units };
    })
    .filter(({ troops }) => troops > 0);
  if (contributions.length === 0) return rejected("No eligible sources remain");
  const pooledTroops = contributions.reduce((sum, source) => sum + source.troops, 0);
  if (pooledTroops < destinations.length) {
    return rejected("Troop pool cannot supply every destination");
  }
  const base = Math.floor(pooledTroops / destinations.length);
  const remainder = pooledTroops % destinations.length;
  const quotas = destinations.map((destinationId, index) => ({
    destinationId,
    troops: base + Number(index < remainder),
  }));
  const routes = new Map<string, { path: string[]; cost: number }>();
  for (const source of contributions) {
    for (const destination of quotas) {
      const path = findPath(state.map, source.sourceId, destination.destinationId, playerId, true);
      if (!path || path.length < 2) continue;
      routes.set(`${source.sourceId}\u0000${destination.destinationId}`, {
        path,
        cost: pathMovementCost(state.map, path),
      });
    }
  }
  const dispatches = minimumCostAllocation(contributions, quotas, routes);
  if (!dispatches) return rejected("Equal destination allocation is infeasible");
  for (const contribution of contributions) {
    const sourceDispatches = dispatches.filter(
      (dispatch) => dispatch.sourceId === contribution.sourceId,
    );
    const unitAllocations = allocateUnitsAcrossTotals(
      contribution.units,
      sourceDispatches.map((dispatch) => dispatch.troops),
    );
    sourceDispatches.forEach((dispatch, index) => {
      dispatch.units = unitAllocations[index]!;
    });
  }
  return {
    ok: true,
    pooledTroops,
    sourceContributions: contributions,
    destinationQuotas: quotas,
    dispatches,
  };
}

export function executeMultiMove(
  state: GameState,
  playerId: number,
  sourceIds: readonly string[],
  destinationIds: readonly string[],
  percent: SendPercent,
): MoveResult {
  const plan = planMultiMove(state, playerId, sourceIds, destinationIds, percent);
  if (!plan.ok) return { ok: false, reason: plan.reason };
  for (const contribution of plan.sourceContributions) {
    const tile = state.map.tiles[contribution.sourceId]!;
    tile.units = subtractUnits(tile.units, contribution.units);
  }
  let last: MovingStack | undefined;
  for (const dispatch of plan.dispatches) {
    last = dispatchExactMovingStack(
      state,
      playerId,
      dispatch.sourceId,
      dispatch.destinationId,
      dispatch.units,
      dispatch.path,
      false,
    );
  }
  emitEvent(state, {
    type: "order",
    playerId,
    amount: plan.pooledTroops,
    message: `${plan.pooledTroops} troops ordered across ${plan.destinationQuotas.length} destinations`,
  });
  return { ok: true, stack: last };
}

export function validateMoveOrder(
  state: GameState,
  playerId: number,
  sourceId: string,
  destinationId: string,
  percent: SendPercent,
): MoveResult {
  if (state.phase !== "running") return { ok: false, reason: "Match is not running" };
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
  const troops = troopsForPercent(totalUnits(source.units), percent);
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
  if (stopId) {
    const tile = state.map.tiles[stopId]!;
    tile.units = addUnits(tile.units, stack.units);
  }
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
      handleStackArrival(state, stack.owner, stack.units, reachedId, entryFrom);
      continue;
    }

    const nextId = stack.path[stack.pathIndex + 1]!;
    stack.segmentDuration = movementTicksForTile(state.map.tiles[nextId]!);
  }
}

import { describe, expect, it } from "vitest";
import {
  axialKey,
  cloneDeterministic,
  executeMultiMove,
  findPath,
  issueMoveOrder,
  movementTicksForTile,
  neighbors,
  tickMovement,
  planMultiMove,
  troopsForPercent,
} from "../../src/core";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

describe("army movement", () => {
  it.each([
    [25, 2],
    [50, 5],
    [75, 7],
    [100, 9],
  ] as const)("sends the exact %i%% amount while leaving one behind", (percent, expected) => {
    expect(troopsForPercent(10, percent)).toBe(expected);
  });

  it("takes longer to cross Hills than ordinary land", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "hill-movement" }).state;
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.terrain = "plains";
    const ordinary = movementTicksForTile(tile);
    tile.terrain = "hills";
    expect(movementTicksForTile(tile)).toBeGreaterThan(ordinary);
  });

  it("always leaves one troop and exposes smooth segment progress", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "movement" }).state;
    const source = state.map.tiles[state.map.spawnCenters[0]!]!;
    const destination = neighbors(source)
      .map((hex) => state.map.tiles[axialKey(hex)])
      .find((tile) => tile?.owner === 0)!;
    const beforeDestination = destination.troops;
    const sent = source.troops - 1;
    const result = issueMoveOrder(state, 0, source.id, destination.id, 100);
    expect(result.ok).toBe(true);
    expect(source.troops).toBe(1);
    expect(result.stack?.troops).toBe(sent);
    tickMovement(state);
    expect(result.stack?.segmentProgress).toBe(1);
    expect(state.stacks).toHaveLength(1);
    while (state.stacks.length > 0) tickMovement(state);
    expect(destination.troops).toBe(beforeDestination + sent);
  });

  it("stops at the last legal friendly tile when a route is completely cut", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "route-cut" }).state;
    const cluster = state.map.spawnClusters[0]!;
    let sourceId = "";
    let destinationId = "";
    for (const source of cluster) {
      for (const destination of cluster) {
        const path = findPath(state.map, source, destination, 0, false);
        if (path && path.length >= 3) {
          sourceId = source;
          destinationId = destination;
          break;
        }
      }
      if (sourceId) break;
    }
    const source = state.map.tiles[sourceId]!;
    source.troops = 10;
    expect(issueMoveOrder(state, 0, sourceId, destinationId, 100).ok).toBe(true);
    for (const id of cluster) {
      if (id !== sourceId && id !== destinationId) state.map.tiles[id]!.owner = 1;
    }
    tickMovement(state);
    expect(state.stacks).toHaveLength(0);
    expect(source.troops).toBe(10);
    expect(state.events.at(-1)?.type).toBe("route-interrupted");
  });

  it("stops when an intermediate tile changes hands after the army reaches it", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "audit-route" }).state;
    const owned = state.map.spawnClusters[0]!;
    const route = owned
      .flatMap((sourceId) =>
        owned.map((destinationId) => findPath(state.map, sourceId, destinationId, 0, false)),
      )
      .find((path) => path && path.length >= 3)!;
    const [sourceId, intermediateId, destinationId] = route;
    const source = state.map.tiles[sourceId!]!;
    source.troops = 10;

    expect(issueMoveOrder(state, 0, sourceId!, destinationId!, 100).ok).toBe(true);
    while (state.stacks[0]?.pathIndex === 0) tickMovement(state);
    expect(state.stacks[0]?.path[1]).toBe(intermediateId);

    state.map.tiles[intermediateId!]!.owner = 1;
    tickMovement(state);

    expect(state.stacks).toHaveLength(0);
    expect(source.troops).toBe(10);
    expect(state.battles).toHaveLength(0);
    expect(state.events.at(-1)?.type).toBe("route-interrupted");
  });

  it("plans one atomic multi-source order with exact even destination quotas", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "multi-even" }).state;
    const [sourceA, sourceB, sourceC, destinationA, destinationB] = state.map.spawnClusters[0]!;
    for (const id of [sourceA, sourceB, sourceC]) state.map.tiles[id!]!.troops = 10;
    const plan = planMultiMove(
      state,
      0,
      [sourceC!, sourceA!, sourceB!],
      [destinationB!, destinationA!],
      100,
    );
    expect(plan.ok).toBe(true);
    expect(plan.pooledTroops).toBe(27);
    expect(plan.destinationQuotas.map(({ troops }) => troops).sort((a, b) => a - b)).toEqual([
      13, 14,
    ]);

    const beforeEntity = state.nextEntityId;
    expect(
      executeMultiMove(
        state,
        0,
        [sourceC!, sourceA!, sourceB!],
        [destinationB!, destinationA!],
        100,
      ).ok,
    ).toBe(true);
    expect(state.map.tiles[sourceA!]!.troops).toBe(1);
    expect(state.map.tiles[sourceB!]!.troops).toBe(1);
    expect(state.map.tiles[sourceC!]!.troops).toBe(1);
    expect(state.stacks.reduce((sum, stack) => sum + stack.troops, 0)).toBe(27);
    expect(state.stacks.map((stack) => stack.id)).toEqual(
      Array.from({ length: state.stacks.length }, (_, index) => beforeEntity + index),
    );
  });

  it("is selection-order invariant and rejects infeasible allocation without mutation", () => {
    const original = createRunningGame({ ...TEST_CONFIG, seed: "multi-atomic" }).state;
    const [sourceA, sourceB, destinationA, destinationB] = original.map.spawnClusters[0]!;
    original.map.tiles[sourceA!]!.troops = 12;
    original.map.tiles[sourceB!]!.troops = 8;
    const left = planMultiMove(
      original,
      0,
      [sourceA!, sourceB!],
      [destinationA!, destinationB!],
      75,
    );
    const right = planMultiMove(
      original,
      0,
      [sourceB!, sourceA!],
      [destinationB!, destinationA!],
      75,
    );
    expect(right).toEqual(left);

    const unreachable = original.map.landIds.find(
      (id) => original.map.tiles[id]!.owner !== 0 && !findPath(original.map, sourceA!, id, 0, true),
    )!;
    const troopsBefore = original.map.tiles[sourceA!]!.troops;
    const stacksBefore = cloneDeterministic(original.stacks);
    expect(executeMultiMove(original, 0, [sourceA!], [unreachable], 100).ok).toBe(false);
    expect(original.map.tiles[sourceA!]!.troops).toBe(troopsBefore);
    expect(original.stacks).toEqual(stacksBefore);
  });

  it("replans from surviving sources and reclassifies a source selected as the destination", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "multi-stale-reclassify" }).state;
    const [sourceA, sourceB, destination] = state.map.spawnClusters[0]!;
    state.map.tiles[sourceA!]!.troops = 11;
    state.map.tiles[sourceB!]!.troops = 9;

    state.map.tiles[sourceA!]!.owner = 1;
    const stale = planMultiMove(state, 0, [sourceA!, sourceB!], [destination!], 100);
    expect(stale.ok).toBe(true);
    expect(stale.sourceContributions).toEqual([{ sourceId: sourceB, troops: 8 }]);

    state.map.tiles[sourceA!]!.owner = 0;
    const sourceATroops = state.map.tiles[sourceA!]!.troops;
    const sourceBTroops = state.map.tiles[sourceB!]!.troops;
    expect(executeMultiMove(state, 0, [sourceA!, sourceB!], [sourceA!], 100).ok).toBe(true);
    expect(state.map.tiles[sourceA!]!.troops).toBe(sourceATroops);
    expect(state.map.tiles[sourceB!]!.troops).toBe(1);
    expect(state.stacks.reduce((sum, stack) => sum + stack.troops, 0)).toBe(sourceBTroops - 1);
  });
});

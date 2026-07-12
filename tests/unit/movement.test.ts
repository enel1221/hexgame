import { describe, expect, it } from "vitest";
import {
  axialKey,
  createGame,
  findPath,
  issueMoveOrder,
  movementTicksForTile,
  neighbors,
  tickMovement,
  troopsForPercent,
} from "../../src/core";
import { TEST_CONFIG } from "./fixtures";

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
    const state = createGame({ ...TEST_CONFIG, seed: "hill-movement" }).state;
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.terrain = "plains";
    const ordinary = movementTicksForTile(tile);
    tile.terrain = "hills";
    expect(movementTicksForTile(tile)).toBeGreaterThan(ordinary);
  });

  it("always leaves one troop and exposes smooth segment progress", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "movement" }).state;
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
    const state = createGame({ ...TEST_CONFIG, seed: "route-cut" }).state;
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
    const state = createGame({ ...TEST_CONFIG, seed: "audit-route" }).state;
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
});

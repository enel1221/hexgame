import { describe, expect, it } from "vitest";
import {
  cloneDeterministic,
  executeMultiMove,
  findPath,
  hashGameState,
  issueMoveOrder,
  planMultiMove,
  stableStringify,
  subtractUnits,
  tickMovement,
  totalUnits,
  troopsForPercent,
  unitsForPercent,
  unitsOf,
} from "../../src/core";
import type { GameState } from "../../src/shared/types";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

function running(seed: string): GameState {
  return createRunningGame({ ...TEST_CONFIG, seed }).state;
}

function friendlyRoute(state: GameState, minimumLength = 2): [string, string] {
  const owned = state.map.landIds.filter((id) => state.map.tiles[id]!.owner === 0);
  for (const sourceId of owned) {
    for (const destinationId of owned) {
      const path = findPath(state.map, sourceId, destinationId, 0, true);
      if (path && path.length >= minimumLength) return [sourceId, destinationId];
    }
  }
  throw new Error("No friendly route");
}

function multiFixture(state: GameState): {
  sources: [string, string, string];
  destinations: [string, string];
} {
  const owned = state.map.spawnClusters[0]!;
  const sources = owned.slice(0, 3) as [string, string, string];
  const destinations = owned.slice(4, 6) as [string, string];
  return { sources, destinations };
}

describe("typed movement", () => {
  it.each([
    [25, 2],
    [50, 5],
    [75, 7],
    [100, 9],
  ] as const)("keeps the scalar %i%% send total at %i", (percent, expected) => {
    expect(troopsForPercent(10, percent)).toBe(expected);
  });

  it("selects an exact proportional composition by canonical largest remainder", () => {
    const units = { melee: 5, ranged: 3, wizard: 2 };
    expect(unitsForPercent(units, 50)).toEqual({ melee: 3, ranged: 1, wizard: 1 });
    expect(unitsForPercent(units, 100)).toEqual({ melee: 4, ranged: 3, wizard: 2 });
  });

  it("moves typed units without loss and leaves one actual unit behind", () => {
    const state = running("typed-single-move");
    const [sourceId, destinationId] = friendlyRoute(state);
    const source = state.map.tiles[sourceId]!;
    const destination = state.map.tiles[destinationId]!;
    source.units = { melee: 5, ranged: 3, wizard: 2 };
    const destinationBefore = { ...destination.units };
    const result = issueMoveOrder(state, 0, sourceId, destinationId, 100);
    expect(result.ok).toBe(true);
    expect(result.stack!.units).toEqual({ melee: 4, ranged: 3, wizard: 2 });
    expect(source.units).toEqual({ melee: 1, ranged: 0, wizard: 0 });
    for (let tick = 0; tick < 100 && state.stacks.length > 0; tick += 1) tickMovement(state);
    expect(destination.units).toEqual({
      melee: destinationBefore.melee + 4,
      ranged: destinationBefore.ranged + 3,
      wizard: destinationBefore.wizard + 2,
    });
  });

  it("rejects an unreachable order without mutating composition", () => {
    const state = running("typed-unreachable");
    const sourceId = state.map.spawnCenters[0]!;
    const source = state.map.tiles[sourceId]!;
    source.units = { melee: 4, ranged: 4, wizard: 4 };
    const target = state.map.landIds.find(
      (id) => id !== sourceId && !findPath(state.map, sourceId, id, 0, true),
    )!;
    const before = cloneDeterministic(source.units);
    expect(issueMoveOrder(state, 0, sourceId, target, 100).ok).toBe(false);
    expect(source.units).toEqual(before);
    expect(state.stacks).toHaveLength(0);
  });

  it("plans equal multi-target totals and conserves every unit type", () => {
    const state = running("typed-multi");
    const { sources, destinations } = multiFixture(state);
    state.map.tiles[sources[0]]!.units = { melee: 6, ranged: 2, wizard: 2 };
    state.map.tiles[sources[1]]!.units = { melee: 2, ranged: 6, wizard: 2 };
    state.map.tiles[sources[2]]!.units = { melee: 2, ranged: 2, wizard: 6 };
    const before = sources.reduce(
      (sum, id) => {
        const units = state.map.tiles[id]!.units;
        return {
          melee: sum.melee + units.melee,
          ranged: sum.ranged + units.ranged,
          wizard: sum.wizard + units.wizard,
        };
      },
      unitsOf("melee", 0),
    );
    const plan = planMultiMove(state, 0, sources, destinations, 100);
    expect(plan.ok).toBe(true);
    expect(plan.pooledTroops).toBe(27);
    expect(plan.destinationQuotas.map((quota) => quota.troops)).toEqual([14, 13]);
    expect(
      plan.dispatches.reduce(
        (sum, dispatch) => ({
          melee: sum.melee + dispatch.units.melee,
          ranged: sum.ranged + dispatch.units.ranged,
          wizard: sum.wizard + dispatch.units.wizard,
        }),
        unitsOf("melee", 0),
      ),
    ).toEqual(subtractUnits(before, { melee: 1, ranged: 1, wizard: 1 }));

    expect(executeMultiMove(state, 0, sources, destinations, 100).ok).toBe(true);
    expect(state.stacks.reduce((sum, stack) => sum + totalUnits(stack.units), 0)).toBe(27);
    expect(sources.every((id) => totalUnits(state.map.tiles[id]!.units) === 1)).toBe(true);
  });

  it("is invariant to source and destination selection order", () => {
    const left = running("multi-order");
    const { sources, destinations } = multiFixture(left);
    sources.forEach((id, index) => {
      left.map.tiles[id]!.units = {
        melee: 3 + index,
        ranged: 4 - index,
        wizard: 3,
      };
    });
    const right = cloneDeterministic(left);
    executeMultiMove(left, 0, sources, destinations, 75);
    executeMultiMove(right, 0, [...sources].reverse(), [...destinations].reverse(), 75);
    left.stateHash = hashGameState(left);
    right.stateHash = hashGameState(right);
    expect(right.stateHash).toBe(left.stateHash);
    expect(stableStringify(right)).toBe(stableStringify(left));
  });

  it("omits a stale source and replans composition atomically", () => {
    const state = running("multi-stale");
    const { sources, destinations } = multiFixture(state);
    state.map.tiles[sources[0]]!.units = { melee: 4, ranged: 4, wizard: 3 };
    state.map.tiles[sources[1]]!.units = { melee: 3, ranged: 3, wizard: 3 };
    state.map.tiles[sources[0]]!.owner = 1;
    const plan = planMultiMove(state, 0, sources.slice(0, 2), destinations, 100);
    expect(plan.ok).toBe(true);
    expect(plan.sourceContributions).toEqual([
      expect.objectContaining({ sourceId: sources[1], troops: 8 }),
    ]);
    expect(executeMultiMove(state, 0, sources.slice(0, 2), destinations, 100).ok).toBe(true);
    expect(totalUnits(state.map.tiles[sources[1]]!.units)).toBe(1);
    expect(state.stacks.reduce((sum, stack) => sum + totalUnits(stack.units), 0)).toBe(8);
  });
});

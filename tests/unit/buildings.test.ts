import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import {
  calculateFarmIncomeMilliPerSecond,
  canPlaceStructure,
  cancelConstruction,
  seizeStructure,
  setBarracksRally,
  startConstruction,
  tickStructures,
  toggleBarracksProduction,
  findPath,
} from "../../src/core";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

function finishPending(state: ReturnType<typeof createRunningGame>["state"], tileId: string): void {
  const structure = state.map.tiles[tileId]!.structure!;
  const required =
    structure.type === "farm"
      ? BALANCE.farm.buildTicks
      : structure.type === "barracks"
        ? BALANCE.barracks.buildTicks
        : BALANCE.turret.buildTicks;
  for (let tick = 0; tick < required; tick += 1) tickStructures(state);
}

describe("aggregate structures", () => {
  it.each(["farm", "barracks", "turret"] as const)(
    "keeps %s x2/x99 aggregate and rejects copy 100",
    (type) => {
      const state = createRunningGame({ ...TEST_CONFIG, seed: `all-stack-${type}` }).state;
      state.players[0]!.supplyMilli = 20_000_000;
      const tile =
        type === "barracks"
          ? state.map.tiles[state.map.spawnCenters[0]!]!
          : Object.values(state.map.tiles).find(
              (candidate) =>
                candidate.owner === 0 &&
                !candidate.structure &&
                (type === "farm" ? candidate.terrain === "meadow" : candidate.terrain !== "water"),
            )!;
      if (!tile.structure) {
        expect(startConstruction(state, 0, tile.id, type).ok).toBe(true);
        finishPending(state, tile.id);
      }
      expect(startConstruction(state, 0, tile.id, type).ok).toBe(true);
      finishPending(state, tile.id);
      expect(tile.structure?.completedCount).toBe(2);
      tile.structure!.completedCount = 99;
      const supplyBefore = state.players[0]!.supplyMilli;
      expect(startConstruction(state, 0, tile.id, type).ok).toBe(false);
      expect(state.players[0]!.supplyMilli).toBe(supplyBefore);
      expect(tile.structure!.pendingProgressTicks).toBeNull();
    },
  );

  it("constructs same-type copies additively and rejects copy 100 atomically", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "building-stack" }).state;
    state.players[0]!.supplyMilli = 20_000_000;
    const meadow = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "meadow" && !tile.structure,
    )!;
    const plains = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "plains" && !tile.structure,
    )!;

    expect(canPlaceStructure(state, 0, plains.id, "farm").ok).toBe(false);
    expect(startConstruction(state, 0, meadow.id, "farm").ok).toBe(true);
    finishPending(state, meadow.id);
    expect(meadow.structure).toMatchObject({ completedCount: 1, pendingProgressTicks: null });
    expect(startConstruction(state, 0, meadow.id, "farm").ok).toBe(true);
    finishPending(state, meadow.id);
    expect(meadow.structure?.completedCount).toBe(2);
    expect(calculateFarmIncomeMilliPerSecond(meadow.structure)).toBe(
      BALANCE.farm.incomeMilliPerSecond * 2,
    );

    meadow.structure!.completedCount = 99;
    const before = state.players[0]!.supplyMilli;
    expect(startConstruction(state, 0, meadow.id, "farm")).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(state.players[0]!.supplyMilli).toBe(before);
    expect(meadow.structure!.pendingProgressTicks).toBeNull();
  });

  it("cancels only a pending addition and seizes every completed copy together", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "stack-cancel-seize" }).state;
    state.players[0]!.supplyMilli = 1_000_000;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    tile.structure!.completedCount = 3;
    expect(startConstruction(state, 0, tile.id, "barracks").ok).toBe(true);
    const afterCost = state.players[0]!.supplyMilli;
    expect(cancelConstruction(state, 0, tile.id).ok).toBe(true);
    expect(tile.structure).toMatchObject({ completedCount: 3, pendingProgressTicks: null });
    expect(state.players[0]!.supplyMilli).toBe(
      afterCost + Math.floor((BALANCE.barracks.costMilli * BALANCE.cancelRefundPermille) / 1000),
    );

    tile.structure!.pendingProgressTicks = 4;
    expect(seizeStructure(tile)).toEqual({ type: "barracks", completedCount: 3 });
    expect(tile.structure).toMatchObject({
      completedCount: 3,
      pendingProgressTicks: null,
      status: "seized",
      integrity: BALANCE.seizedIntegrity,
      rallyTargetId: null,
    });
    for (let tick = 0; tick < BALANCE.seizedTicks + BALANCE.repairTicks; tick += 1) {
      tickStructures(state);
    }
    expect(tile.structure).toMatchObject({ status: "active", integrity: BALANCE.fullIntegrity });
  });

  it("trains one aggregate Barracks batch and dispatches one rally stack", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "barracks-rally-stack" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    const destinationId = state.map.spawnClusters[0]!.find((id) => id !== tile.id)!;
    tile.troops = 5;
    tile.structure!.completedCount = 3;
    expect(setBarracksRally(state, 0, tile.id, destinationId).ok).toBe(true);
    const supplyBefore = state.players[0]!.supplyMilli;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0]).toMatchObject({
      owner: 0,
      troops: 3,
      originId: tile.id,
      destinationId,
    });
    expect(tile.troops).toBe(5);
    expect(state.players[0]!.supplyMilli).toBe(supplyBefore - 3 * BALANCE.barracks.troopCostMilli);
  });

  it("limits aggregate training by affordable Supply and pause state", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "barracks-partial-supply" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    tile.troops = 5;
    tile.structure!.completedCount = 99;
    state.players[0]!.supplyMilli = 2 * BALANCE.barracks.troopCostMilli;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(tile.troops).toBe(7);
    expect(state.players[0]!.supplyMilli).toBe(0);
    expect(state.stacks).toHaveLength(0);

    expect(toggleBarracksProduction(state, 0, tile.id).ok).toBe(true);
    state.players[0]!.supplyMilli = 1_000_000;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks * 2; tick += 1) tickStructures(state);
    expect(tile.troops).toBe(7);
  });

  it("supports hostile rallying and x99 still creates at most one stack per cycle", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "barracks-hostile-x99" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    const targetId = state.map.landIds.find(
      (id) => state.map.tiles[id]!.owner === null && findPath(state.map, tile.id, id, 0, true),
    )!;
    state.map.tiles[targetId]!.owner = 1;
    tile.structure!.completedCount = 99;
    tile.troops = 40;
    state.players[0]!.supplyMilli = 1_000_000;
    expect(setBarracksRally(state, 0, tile.id, targetId).ok).toBe(true);
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0]).toMatchObject({ troops: 99, destinationId: targetId });
  });

  it("retains a blocked rally, trains locally to the cap, and retries after recovery", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "barracks-blocked-recovery" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    const route = state.map.landIds
      .filter((id) => state.map.tiles[id]!.owner === null)
      .map((id) => findPath(state.map, tile.id, id, 0, true))
      .find((path) => path && path.length >= 3)!;
    tile.structure!.completedCount = 3;
    tile.troops = 35;
    state.players[0]!.supplyMilli = 1_000_000;
    expect(setBarracksRally(state, 0, tile.id, route.at(-1)!).ok).toBe(true);
    const blockedId = route[1]!;
    state.map.tiles[blockedId]!.owner = 1;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(tile.troops).toBe(38);
    expect(state.stacks).toHaveLength(0);
    expect(tile.structure!.rallyTargetId).toBe(route.at(-1));
    expect(tile.structure!.rallyQueuedTroops).toBe(3);

    const supplyAfterTraining = state.players[0]!.supplyMilli;
    const trainedAfterBlockedCycle = state.players[0]!.stats.troopsTrained;
    expect(toggleBarracksProduction(state, 0, tile.id).ok).toBe(true);
    state.map.tiles[blockedId]!.owner = 0;
    tickStructures(state);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0]!.troops).toBe(3);
    expect(tile.troops).toBe(35);
    expect(tile.structure!.rallyQueuedTroops).toBe(0);
    expect(state.players[0]!.supplyMilli).toBe(supplyAfterTraining);
    expect(state.players[0]!.stats.troopsTrained).toBe(trainedAfterBlockedCycle);
  });
});

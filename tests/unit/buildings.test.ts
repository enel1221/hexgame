import { describe, expect, it } from "vitest";
import {
  BUILDING_RULES,
  canPlaceStructure,
  cancelConstruction,
  findPath,
  seizeStructure,
  setRally,
  startConstruction,
  tickStructures,
  toggleProduction,
  totalUnits,
  unitsOf,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import type { StructureType, TileState, UnitType } from "../../src/shared/types";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

function finishPending(state: ReturnType<typeof createRunningGame>["state"], tileId: string): void {
  const required = BUILDING_RULES[state.map.tiles[tileId]!.structure!.type].buildTicks;
  for (let tick = 0; tick < required; tick += 1) tickStructures(state);
}

function emptySite(
  state: ReturnType<typeof createRunningGame>["state"],
  type: StructureType,
): TileState {
  const tile = Object.values(state.map.tiles).find(
    (candidate) =>
      candidate.owner === 0 &&
      !candidate.structure &&
      (type === "barracks"
        ? candidate.terrain === "muster"
        : type === "archery-range"
          ? candidate.terrain === "meadow"
          : candidate.terrain !== "water"),
  );
  if (!tile) throw new Error(`No site for ${type}`);
  return tile;
}

describe("aggregate production structures", () => {
  it.each(["barracks", "archery-range", "wizard-tower"] as const)(
    "keeps %s x2/x99 aggregate and rejects copy 100",
    (type) => {
      const state = createRunningGame({ ...TEST_CONFIG, seed: `stack-${type}` }).state;
      state.players[0]!.supplyMilli = 20_000_000;
      const tile =
        type === "barracks" ? state.map.tiles[state.map.spawnCenters[0]!]! : emptySite(state, type);
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

  it("enforces Muster, Meadow, and flexible Tower siting", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "building-terrain" }).state;
    state.players[0]!.supplyMilli = 1_000_000;
    const meadow = emptySite(state, "archery-range");
    const plains = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "plains" && !tile.structure,
    )!;
    expect(canPlaceStructure(state, 0, plains.id, "archery-range").ok).toBe(false);
    expect(canPlaceStructure(state, 0, meadow.id, "barracks").ok).toBe(false);
    expect(canPlaceStructure(state, 0, plains.id, "wizard-tower").ok).toBe(true);
  });

  it("cancels only a pending addition and seizes every completed copy", () => {
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
    tile.structure!.rallyQueuedUnits = unitsOf("melee", 2);
    expect(seizeStructure(tile)).toEqual({ type: "barracks", completedCount: 3 });
    expect(tile.structure).toMatchObject({
      completedCount: 3,
      pendingProgressTicks: null,
      status: "seized",
      integrity: BALANCE.seizedIntegrity,
      rallyTargetId: null,
      rallyQueuedUnits: { melee: 0, ranged: 0, wizard: 0 },
    });
  });

  it.each([
    ["barracks", "melee"],
    ["archery-range", "ranged"],
    ["wizard-tower", "wizard"],
  ] as const)("trains one aggregate %s batch of its own type", (type, unitType) => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: `training-${type}` }).state;
    state.players[0]!.supplyMilli = 1_000_000;
    const tile =
      type === "barracks" ? state.map.tiles[state.map.spawnCenters[0]!]! : emptySite(state, type);
    if (!tile.structure) {
      startConstruction(state, 0, tile.id, type);
      finishPending(state, tile.id);
    }
    tile.structure!.completedCount = 3;
    tile.units = unitsOf("melee", 5);
    const before = { ...tile.units };
    const rules = BUILDING_RULES[type];
    for (let tick = 0; tick < rules.trainTicks; tick += 1) tickStructures(state);
    expect(tile.units[unitType]).toBe(before[unitType] + 3);
    expect(totalUnits(tile.units)).toBe(totalUnits(before) + 3);
  });

  it.each([
    ["barracks", "melee"],
    ["archery-range", "ranged"],
    ["wizard-tower", "wizard"],
  ] as const)("keeps %s production running past 40 local units", (type, unitType) => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: `uncapped-training-${type}` }).state;
    const tile =
      type === "barracks" ? state.map.tiles[state.map.spawnCenters[0]!]! : emptySite(state, type);
    if (!tile.structure) {
      state.players[0]!.supplyMilli = 1_000_000;
      startConstruction(state, 0, tile.id, type);
      finishPending(state, tile.id);
    }
    for (const candidate of Object.values(state.map.tiles)) {
      if (candidate.id !== tile.id && candidate.owner === 0 && candidate.structure) {
        candidate.structure.productionPaused = true;
      }
    }
    tile.structure!.completedCount = 2;
    tile.units = unitsOf(unitType, 40);
    const rules = BUILDING_RULES[type];
    state.players[0]!.supplyMilli = 6 * rules.troopCostMilli;

    for (let tick = 0; tick < rules.trainTicks * 3; tick += 1) tickStructures(state);

    expect(tile.units).toEqual(unitsOf(unitType, 46));
    expect(state.players[0]!.supplyMilli).toBe(0);
  });

  it.each([
    ["barracks", "melee"],
    ["archery-range", "ranged"],
    ["wizard-tower", "wizard"],
  ] as const)("rallies one typed %s batch as one moving stack", (type, unitType) => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: `rally-${type}` }).state;
    state.players[0]!.supplyMilli = 1_000_000;
    const tile =
      type === "barracks" ? state.map.tiles[state.map.spawnCenters[0]!]! : emptySite(state, type);
    if (!tile.structure) {
      startConstruction(state, 0, tile.id, type);
      finishPending(state, tile.id);
    }
    tile.structure!.completedCount = 3;
    const destinationId = state.map.spawnClusters[0]!.find((id) => id !== tile.id)!;
    expect(setRally(state, 0, tile.id, destinationId).ok).toBe(true);
    for (let tick = 0; tick < BUILDING_RULES[type].trainTicks; tick += 1) tickStructures(state);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0]).toMatchObject({
      owner: 0,
      units: unitsOf(unitType as UnitType, 3),
      destinationId,
    });
  });

  it("limits training by Supply and generic pause state", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "partial-supply" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    tile.units = unitsOf("ranged", 5);
    tile.structure!.completedCount = 99;
    state.players[0]!.supplyMilli = 2 * BALANCE.barracks.troopCostMilli;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(tile.units).toEqual({ melee: 2, ranged: 5, wizard: 0 });
    expect(state.players[0]!.supplyMilli).toBe(0);
    expect(toggleProduction(state, 0, tile.id).ok).toBe(true);
    state.players[0]!.supplyMilli = 1_000_000;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks * 2; tick += 1) tickStructures(state);
    expect(tile.units).toEqual({ melee: 2, ranged: 5, wizard: 0 });
  });

  it("retains a blocked typed rally and retries after route recovery", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "blocked-recovery" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    const route = state.map.landIds
      .filter((id) => state.map.tiles[id]!.owner === null)
      .map((id) => findPath(state.map, tile.id, id, 0, true))
      .find((candidate) => candidate && candidate.length >= 3)!;
    tile.structure!.completedCount = 3;
    tile.units = unitsOf("melee", 40);
    state.players[0]!.supplyMilli = 1_000_000;
    expect(setRally(state, 0, tile.id, route.at(-1)!).ok).toBe(true);
    state.map.tiles[route[1]!]!.owner = 1;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks * 2; tick += 1) tickStructures(state);
    expect(tile.units.melee).toBe(46);
    expect(tile.structure!.rallyQueuedUnits).toEqual(unitsOf("melee", 6));
    expect(toggleProduction(state, 0, tile.id).ok).toBe(true);
    state.map.tiles[route[1]!]!.owner = 0;
    tickStructures(state);
    expect(state.stacks).toHaveLength(1);
    expect(state.stacks[0]!.units).toEqual(unitsOf("melee", 6));
    expect(tile.units.melee).toBe(40);
    expect(tile.structure!.rallyQueuedUnits).toEqual(unitsOf("melee", 0));
  });
});

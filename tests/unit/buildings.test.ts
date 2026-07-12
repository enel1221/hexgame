import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import {
  canPlaceStructure,
  calculateIncomeMilliPerSecond,
  cancelConstruction,
  createGame,
  seizeStructure,
  startBattle,
  startConstruction,
  tickStructures,
  toggleBarracksProduction,
} from "../../src/core";
import { TEST_CONFIG } from "./fixtures";

describe("structures", () => {
  it("enforces terrain placement and deterministic build duration", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "building" }).state;
    const meadow = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "meadow" && !tile.structure,
    )!;
    const plains = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "plains" && !tile.structure,
    )!;
    expect(canPlaceStructure(state, 0, plains.id, "farm").ok).toBe(false);
    expect(startConstruction(state, 0, meadow.id, "farm").ok).toBe(true);
    expect(state.players[0]!.supplyMilli).toBe(
      BALANCE.startingSupplyMilli - BALANCE.farm.costMilli,
    );
    for (let tick = 0; tick < BALANCE.farm.buildTicks - 1; tick += 1) tickStructures(state);
    expect(meadow.structure?.status).toBe("constructing");
    tickStructures(state);
    expect(meadow.structure).toEqual(
      expect.objectContaining({ status: "active", integrity: BALANCE.fullIntegrity }),
    );
  });

  it("refunds only the configured fraction when construction is cancelled", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "cancel" }).state;
    const meadow = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "meadow" && !tile.structure,
    )!;
    startConstruction(state, 0, meadow.id, "farm");
    cancelConstruction(state, 0, meadow.id);
    expect(meadow.structure).toBeNull();
    expect(state.players[0]!.supplyMilli).toBe(
      BALANCE.startingSupplyMilli -
        BALANCE.farm.costMilli +
        Math.floor((BALANCE.farm.costMilli * BALANCE.cancelRefundPermille) / 1000),
    );
  });

  it("seizes completed structures, disables them, then repairs to full integrity", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "seizure" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    expect(seizeStructure(tile)).toBe("barracks");
    expect(tile.structure).toEqual(
      expect.objectContaining({ status: "seized", integrity: BALANCE.seizedIntegrity }),
    );
    for (let tick = 0; tick < BALANCE.seizedTicks; tick += 1) tickStructures(state);
    expect(tile.structure?.status).toBe("repairing");
    for (let tick = 0; tick < BALANCE.repairTicks; tick += 1) tickStructures(state);
    expect(tile.structure).toEqual(
      expect.objectContaining({ status: "active", integrity: BALANCE.fullIntegrity }),
    );
  });

  it("pauses construction and Farm income while the tile is contested", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "contested-building" }).state;
    const meadow = Object.values(state.map.tiles).find(
      (tile) => tile.owner === 0 && tile.terrain === "meadow" && !tile.structure,
    )!;
    expect(startConstruction(state, 0, meadow.id, "farm").ok).toBe(true);
    const progressBefore = meadow.structure!.progressTicks;
    startBattle(state, meadow, 1, 12, state.map.spawnCenters[1]!);
    tickStructures(state);
    expect(meadow.structure!.progressTicks).toBe(progressBefore);

    meadow.structure = {
      type: "farm",
      status: "active",
      integrity: BALANCE.fullIntegrity,
      progressTicks: 0,
      seizedTicks: 0,
      productionPaused: false,
    };
    expect(calculateIncomeMilliPerSecond(state, 0)).toBe(
      state.players[0]!.tileCount * BALANCE.tileIncomeMilliPerSecond,
    );
  });

  it("trains locally, consumes Supply, and honors Barracks pause/resume", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "barracks-training" }).state;
    const tile = state.map.tiles[state.map.spawnCenters[0]!]!;
    tile.troops = 5;
    const supplyBefore = state.players[0]!.supplyMilli;
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(tile.troops).toBe(6);
    expect(state.players[0]!.supplyMilli).toBe(supplyBefore - BALANCE.barracks.troopCostMilli);

    expect(toggleBarracksProduction(state, 0, tile.id).ok).toBe(true);
    for (let tick = 0; tick < BALANCE.barracks.trainTicks * 2; tick += 1) tickStructures(state);
    expect(tile.troops).toBe(6);
    expect(toggleBarracksProduction(state, 0, tile.id).ok).toBe(true);
    for (let tick = 0; tick < BALANCE.barracks.trainTicks; tick += 1) tickStructures(state);
    expect(tile.troops).toBe(7);
  });
});

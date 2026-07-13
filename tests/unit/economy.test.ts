import { describe, expect, it } from "vitest";
import { calculateIncomeMilliPerSecond, tickEconomy } from "../../src/core";
import { BALANCE, TICKS_PER_SECOND } from "../../src/shared/balance";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

describe("ruler income", () => {
  it("combines the live-ruler stipend with fixed income per owned tile", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "economy-income" }).state;
    const playerId = 0;
    const ownedTiles = state.map.landIds.filter(
      (tileId) => state.map.tiles[tileId]!.owner === playerId,
    ).length;

    expect(calculateIncomeMilliPerSecond(state, playerId)).toBe(
      BALANCE.passiveIncomeMilliPerSecond + ownedTiles * BALANCE.tileIncomeMilliPerSecond,
    );
  });

  it("settles exact fixed-point income once per second", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "economy-settlement" }).state;
    const player = state.players[0]!;
    const income = calculateIncomeMilliPerSecond(state, player.id);
    const supplyBefore = player.supplyMilli;
    const statsBefore = player.stats.supplyEarnedMilli;

    state.tick = TICKS_PER_SECOND - 1;
    tickEconomy(state);
    expect(player.supplyMilli).toBe(supplyBefore);
    expect(player.stats.supplyEarnedMilli).toBe(statsBefore);

    state.tick = TICKS_PER_SECOND;
    tickEconomy(state);
    expect(player.supplyMilli).toBe(supplyBefore + income);
    expect(player.stats.supplyEarnedMilli).toBe(statsBefore + income);
  });

  it("pays neither passive nor tile income to eliminated rulers", () => {
    const state = createRunningGame({ ...TEST_CONFIG, seed: "economy-eliminated" }).state;
    const player = state.players[0]!;
    const supplyBefore = player.supplyMilli;
    const statsBefore = player.stats.supplyEarnedMilli;
    player.eliminated = true;

    expect(calculateIncomeMilliPerSecond(state, player.id)).toBe(0);
    state.tick = TICKS_PER_SECOND;
    tickEconomy(state);
    expect(player.supplyMilli).toBe(supplyBefore);
    expect(player.stats.supplyEarnedMilli).toBe(statsBefore);
  });
});

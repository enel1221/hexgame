import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import { createGame, tickVictory } from "../../src/core";
import { TEST_CONFIG } from "./fixtures";

describe("victory", () => {
  it("requires continuous 80% control for exactly 15 simulation seconds", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "victory-hold" }).state;
    const required = Math.ceil((state.map.landCount * BALANCE.victoryThresholdPermille) / 1000);
    state.map.landIds.forEach((id, index) => {
      state.map.tiles[id]!.owner = index < required ? 0 : 1;
    });
    for (let tick = 0; tick < BALANCE.victoryHoldTicks - 1; tick += 1) tickVictory(state);
    expect(state.victory.winnerId).toBeNull();
    tickVictory(state);
    expect(state.victory).toEqual(expect.objectContaining({ winnerId: 0, reason: "control" }));
  });

  it("resets immediately below threshold and allows sole-survivor victory", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "victory-reset" }).state;
    const required = Math.ceil((state.map.landCount * BALANCE.victoryThresholdPermille) / 1000);
    state.map.landIds.forEach((id, index) => {
      state.map.tiles[id]!.owner = index < required ? 0 : 1;
    });
    tickVictory(state);
    expect(state.victory.holdTicks).toBe(1);
    state.map.tiles[state.map.landIds[required - 1]!]!.owner = 1;
    tickVictory(state);
    expect(state.victory).toEqual(expect.objectContaining({ leaderId: null, holdTicks: 0 }));

    for (const player of state.players.slice(1)) player.eliminated = true;
    tickVictory(state);
    expect(state.victory).toEqual(
      expect.objectContaining({ winnerId: 0, reason: "sole-survivor" }),
    );
  });
});

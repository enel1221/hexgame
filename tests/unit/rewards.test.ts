import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import { checkAndRewardElimination, createGame, grantCaptureReward } from "../../src/core";
import type { StructureType } from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function rewardState(seed: string) {
  const state = createGame({ ...TEST_CONFIG, seed }).state;
  const tile = state.map.tiles[state.map.spawnClusters[1]![0]!]!;
  tile.owner = 1;
  tile.controlledSinceTick = 0;
  tile.lastRewardTick = 0;
  state.tick = BALANCE.minimumOwnershipRewardTicks;
  return { state, tile };
}

describe("capture and elimination rewards", () => {
  it.each([
    [null, BALANCE.captureRewardMilli],
    ["farm", BALANCE.captureRewardMilli + BALANCE.farmCaptureRewardMilli],
    ["barracks", BALANCE.captureRewardMilli + BALANCE.barracksCaptureRewardMilli],
    ["turret", BALANCE.captureRewardMilli + BALANCE.turretCaptureRewardMilli],
  ] as const)("pays the configured hostile %s capture value", (structure, expected) => {
    const { state, tile } = rewardState(`reward-${structure ?? "plain"}`);
    const supplyBefore = state.players[0]!.supplyMilli;
    expect(grantCaptureReward(state, 0, tile, 1, structure as StructureType | null)).toBe(expected);
    expect(state.players[0]!.supplyMilli).toBe(supplyBefore + expected);
    expect(state.events.at(-1)).toEqual(
      expect.objectContaining({ type: "reward", tileId: tile.id, amount: expected }),
    );
  });

  it("never rewards neutral expansion or captures before minimum ownership", () => {
    const { state, tile } = rewardState("reward-eligibility");
    expect(grantCaptureReward(state, 0, tile, null, null)).toBe(0);
    state.tick = BALANCE.minimumOwnershipRewardTicks - 1;
    expect(grantCaptureReward(state, 0, tile, 1, null)).toBe(0);
  });

  it("prevents reward ping-pong until the full cooldown elapses", () => {
    const { state, tile } = rewardState("reward-cooldown");
    expect(grantCaptureReward(state, 0, tile, 1, null)).toBe(BALANCE.captureRewardMilli);
    state.tick += BALANCE.rewardCooldownTicks - 1;
    expect(grantCaptureReward(state, 0, tile, 1, null)).toBe(0);
    state.tick += 1;
    expect(grantCaptureReward(state, 0, tile, 1, null)).toBe(BALANCE.captureRewardMilli);
  });

  it("attributes elimination and caps the stored-Supply transfer", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "elimination-reward" }).state;
    for (const tileId of state.map.landIds) {
      if (state.map.tiles[tileId]!.owner === 1) state.map.tiles[tileId]!.owner = 0;
    }
    state.players[1]!.supplyMilli = 1_000_000;
    const supplyBefore = state.players[0]!.supplyMilli;
    const expected = BALANCE.eliminationRewardMilli + BALANCE.eliminationTransferCapMilli;

    expect(checkAndRewardElimination(state, 1, 0)).toBe(expected);
    expect(state.players[1]).toEqual(
      expect.objectContaining({ eliminated: true, eliminatedBy: 0, supplyMilli: 0 }),
    );
    expect(state.players[0]!.supplyMilli).toBe(supplyBefore + expected);
    expect(state.players[0]!.stats.enemiesEliminated).toBe(1);
    expect(state.events.at(-1)).toEqual(
      expect.objectContaining({ type: "elimination", playerId: 0, amount: expected }),
    );
  });

  it("does not eliminate a ruler who still owns land", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "not-eliminated" }).state;
    expect(checkAndRewardElimination(state, 1, 0)).toBe(0);
    expect(state.players[1]!.eliminated).toBe(false);
  });
});

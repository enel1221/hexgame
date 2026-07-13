import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import {
  applySpawnAllocations,
  checkAndRewardElimination,
  chooseDefaultSpawnCenters,
  createGame,
  grantCaptureReward,
} from "../../src/core";
import type { StructureType } from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function runningState(seed: string) {
  const state = createGame({ ...TEST_CONFIG, seed }).state;
  const centers = chooseDefaultSpawnCenters(state.map, state.players.length, `${seed}:tests`);
  applySpawnAllocations(state.map, centers, `${seed}:tests`);
  state.config.startingCenters = centers;
  state.phase = "running";
  return state;
}

function rewardState(seed: string) {
  const state = runningState(seed);
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
    ["barracks", BALANCE.captureRewardMilli + BALANCE.barracksCaptureRewardMilli],
    ["archery-range", BALANCE.captureRewardMilli + BALANCE.archeryRangeCaptureRewardMilli],
    ["wizard-tower", BALANCE.captureRewardMilli + BALANCE.wizardTowerCaptureRewardMilli],
  ] as const)("pays the configured hostile %s capture value", (structure, expected) => {
    const { state, tile } = rewardState(`reward-${structure ?? "plain"}`);
    const supplyBefore = state.players[0]!.supplyMilli;
    expect(grantCaptureReward(state, 0, tile, 1, structure as StructureType | null)).toBe(expected);
    expect(state.players[0]!.supplyMilli).toBe(supplyBefore + expected);
    expect(state.events.at(-1)).toEqual(
      expect.objectContaining({ type: "reward", tileId: tile.id, amount: expected }),
    );
  });

  it("pays neutral expansion without applying hostile ownership guards", () => {
    const { state, tile } = rewardState("reward-eligibility");
    state.tick = 1;
    const supplyBefore = state.players[0]!.supplyMilli;
    const statsBefore = state.players[0]!.stats.supplyEarnedMilli;
    expect(grantCaptureReward(state, 0, tile, null, null)).toBe(BALANCE.neutralCaptureRewardMilli);
    expect(state.players[0]!.supplyMilli).toBe(supplyBefore + BALANCE.neutralCaptureRewardMilli);
    expect(state.players[0]!.stats.supplyEarnedMilli).toBe(
      statsBefore + BALANCE.neutralCaptureRewardMilli,
    );
    expect(state.events.at(-1)).toMatchObject({
      type: "reward",
      tileId: tile.id,
      amount: BALANCE.neutralCaptureRewardMilli,
      message: "+2 Supply for neutral capture",
    });
  });

  it("does not pay hostile captures before minimum ownership", () => {
    const { state, tile } = rewardState("reward-hostile-eligibility");
    state.tick = BALANCE.minimumOwnershipRewardTicks - 1;
    expect(grantCaptureReward(state, 0, tile, 1, null)).toBe(0);
  });

  it("multiplies the uncapped structure bonus by every completed captured copy", () => {
    const { state, tile } = rewardState("reward-x99");
    const expected = BALANCE.captureRewardMilli + BALANCE.wizardTowerCaptureRewardMilli * 99;
    expect(
      grantCaptureReward(state, 0, tile, 1, {
        type: "wizard-tower",
        completedCount: 99,
      }),
    ).toBe(expected);
    expect(state.events.at(-1)).toMatchObject({ type: "reward", amount: expected });
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
    const state = runningState("elimination-reward");
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

  it("removes and counts every typed unit belonging to an eliminated ruler", () => {
    const state = runningState("elimination-units");
    for (const tileId of state.map.landIds) {
      if (state.map.tiles[tileId]!.owner === 1) state.map.tiles[tileId]!.owner = 0;
    }
    const battleTile = state.map.tiles[state.map.spawnCenters[0]!]!;
    const route = state.map.landIds.slice(0, 2);
    state.stacks.push({
      id: state.nextEntityId++,
      owner: 1,
      units: { melee: 1, ranged: 2, wizard: 3 },
      path: route,
      pathIndex: 0,
      segmentProgress: 0,
      segmentDuration: 1,
      originId: route[0]!,
      destinationId: route[1]!,
      lane: 0,
      issuedTick: state.tick,
    });
    state.battles.push({
      id: state.nextEntityId++,
      tileId: battleTile.id,
      incumbentOwner: 0,
      participants: [
        {
          playerId: 0,
          units: { melee: 2, ranged: 2, wizard: 2 },
          control: 1000,
          casualtyProgressMilli: { melee: 0, ranged: 0, wizard: 0 },
          entryFrom: battleTile.id,
          joinedTick: state.tick,
          lastReinforcementTick: -1,
          reinforcementAmount: 0,
        },
        {
          playerId: 1,
          units: { melee: 4, ranged: 5, wizard: 6 },
          control: 1000,
          casualtyProgressMilli: { melee: 0, ranged: 0, wizard: 0 },
          entryFrom: route[0]!,
          joinedTick: state.tick,
          lastReinforcementTick: -1,
          reinforcementAmount: 0,
        },
      ],
      ageTicks: 0,
      roundAccumulator: 0,
    });
    battleTile.units = { melee: 0, ranged: 0, wizard: 0 };
    const lossesBefore = state.players[1]!.stats.troopsLost;

    expect(checkAndRewardElimination(state, 1, 0)).toBeGreaterThan(0);
    expect(state.players[1]!.stats.troopsLost).toBe(lossesBefore + 21);
    expect(state.stacks.some((stack) => stack.owner === 1)).toBe(false);
    expect(state.battles).toHaveLength(0);
    expect(battleTile.units).toEqual({ melee: 2, ranged: 2, wizard: 2 });
  });

  it("does not eliminate a ruler who still owns land", () => {
    const state = runningState("not-eliminated");
    expect(checkAndRewardElimination(state, 1, 0)).toBe(0);
    expect(state.players[1]!.eliminated).toBe(false);
  });
});

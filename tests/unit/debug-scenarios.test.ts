import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import type { WorkerResponse } from "../../src/shared/types";
import {
  cloneDeterministic,
  createDebugScenario,
  createGame,
  hashGameState,
  axialKey,
  neighbors,
  stepGame,
} from "../../src/core";
import { SimulationWorkerController } from "../../src/worker";
import { TEST_CONFIG } from "./fixtures";

const DEBUG_CONFIG = { ...TEST_CONFIG, debug: true, seed: "debug-scenario-test" };

function expectValidHash(state: ReturnType<typeof createDebugScenario>): void {
  expect(state.stateHash).toMatch(/^[0-9a-f]{16}$/);
  expect(state.stateHash).toBe(hashGameState(state));
  for (const tileId of state.map.landIds) {
    const owner = state.map.tiles[tileId]!.owner;
    expect(owner === null || state.players[owner] !== undefined).toBe(true);
  }
}

describe("deterministic debug scenarios", () => {
  it("rejects production matches and never mutates its input", () => {
    const production = createGame(TEST_CONFIG).state;
    expect(() => createDebugScenario(production, "battle")).toThrow(/debug match/i);

    const debug = createGame(DEBUG_CONFIG).state;
    const before = cloneDeterministic(debug);
    createDebugScenario(debug, "structures");
    expect(debug).toEqual(before);
  });

  it("places all three active structures on nearby, legal owned terrain", () => {
    const state = createDebugScenario(createGame(DEBUG_CONFIG).state, "structures");
    const structures = state.map.spawnClusters[0]!.map((id) => state.map.tiles[id]!).filter(
      (tile) => tile.structure,
    );

    expect(structures.map((tile) => tile.structure!.type).sort()).toEqual([
      "barracks",
      "farm",
      "turret",
    ]);
    expect(structures.every((tile) => tile.owner === 0)).toBe(true);
    expect(structures.every((tile) => tile.structure!.status === "active")).toBe(true);
    expect(structures.find((tile) => tile.structure!.type === "farm")!.terrain).toBe("meadow");
    expect(structures.find((tile) => tile.structure!.type === "barracks")!.terrain).toBe("muster");
    expect(state.players[0]!.supplyMilli).toBeGreaterThanOrEqual(500_000);
    expectValidHash(state);
  });

  it("creates exact parity combat and a stable reinforcement transition", () => {
    const initial = createGame(DEBUG_CONFIG).state;
    const battleState = createDebugScenario(initial, "battle");
    const battle = battleState.battles[0]!;
    expect(battleState.battles).toHaveLength(1);
    expect(battle.control).toBe(5_000);
    expect(battle.ageTicks).toBe(0);
    expect(battle.attackerTroops).toBe(battle.defenderTroops);
    expect(battleState.map.tiles[battle.tileId]!.troops).toBe(0);
    expectValidHash(battleState);

    const reinforced = createDebugScenario(battleState, "reinforcement");
    const shifted = reinforced.battles[0]!;
    expect(shifted.id).toBe(battle.id);
    expect(shifted.reinforcementSide).toBe("attacker");
    expect(shifted.reinforcementAmount).toBe(40);
    expect(shifted.lastReinforcementTick).toBe(reinforced.tick);
    expect(shifted.control).toBe(5_800);
    expect(shifted.attackerTroops).toBe(96);
    expect(reinforced.events.at(-1)?.type).toBe("reinforcement");
    expectValidHash(reinforced);
  });

  it("creates a control-ready battle that cannot resolve before 35 ticks", () => {
    const prepared = createDebugScenario(createGame(DEBUG_CONFIG).state, "battle-minimum");
    const battle = prepared.battles[0]!;
    expect(battle).toMatchObject({ control: 9_900, ageTicks: 0, attackerTroops: 96 });

    let running = cloneDeterministic(prepared);
    running.paused = false;
    running.stateHash = hashGameState(running);
    const startingTick = running.tick;
    for (let tick = 0; tick < BALANCE.minimumBattleTicks - 1; tick += 1) {
      running = stepGame(running);
    }
    expect(running.tick - startingTick).toBe(34);
    expect(running.battles).toHaveLength(1);
    expect(running.battles[0]!.control).toBe(10_000);

    running = stepGame(running);
    expect(running.tick - startingTick).toBe(BALANCE.minimumBattleTicks);
    expect(running.battles).toHaveLength(0);
    expect(running.map.tiles[battle.tileId]!.owner).toBe(battle.attacker);
    expectValidHash(running);
  });

  it("offers deterministic before and after capture frames", () => {
    const initial = createGame(DEBUG_CONFIG).state;
    const before = createDebugScenario(initial, "capture-before");
    const battle = before.battles[0]!;
    expect(battle.ageTicks).toBe(BALANCE.minimumBattleTicks - 1);
    expect(battle.control).toBe(9_900);

    const advancing = cloneDeterministic(before);
    advancing.paused = false;
    advancing.stateHash = hashGameState(advancing);
    const resolved = stepGame(advancing);
    expect(resolved.battles).toHaveLength(0);
    expect(resolved.map.tiles[battle.tileId]!.owner).toBe(battle.attacker);

    const after = createDebugScenario(before, "capture");
    const capture = after.events.find((event) => event.type === "capture")!;
    expect(after.map.tiles[capture.tileId!]!.owner).toBe(0);
    expect(after.players[0]!.stats.tilesCaptured).toBeGreaterThanOrEqual(1);
    expectValidHash(after);
  });

  it("resolves a developed capture through seizure and structure-inclusive reward rules", () => {
    const live = createGame(DEBUG_CONFIG).state;
    live.tick = 208;
    live.stateHash = hashGameState(live);
    const prepared = createDebugScenario(live, "developed-capture");
    const battle = prepared.battles[0]!;
    const target = prepared.map.tiles[battle.tileId]!;
    const supplyBefore = prepared.players[0]!.supplyMilli;
    expect(prepared.tick).toBe(210);
    expect(target.structure).toMatchObject({ type: "farm", status: "active", integrity: 1_000 });

    const running = cloneDeterministic(prepared);
    running.paused = false;
    running.stateHash = hashGameState(running);
    const resolved = stepGame(running);
    const captured = resolved.map.tiles[battle.tileId]!;
    expect(captured.owner).toBe(0);
    expect(captured.structure).toMatchObject({
      type: "farm",
      status: "seized",
      integrity: BALANCE.seizedIntegrity,
    });
    expect(resolved.players[0]!.supplyMilli).toBe(
      supplyBefore + BALANCE.captureRewardMilli + BALANCE.farmCaptureRewardMilli,
    );
    expect(resolved.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reward",
          amount: BALANCE.captureRewardMilli + BALANCE.farmCaptureRewardMilli,
        }),
        expect.objectContaining({ type: "structure-seized", tileId: battle.tileId }),
      ]),
    );
    expectValidHash(resolved);
  });

  it("creates attributed capped elimination rewards and an enclosed build tile", () => {
    const eliminated = createDebugScenario(createGame(DEBUG_CONFIG).state, "elimination");
    const expectedReward = BALANCE.eliminationRewardMilli + BALANCE.eliminationTransferCapMilli;
    expect(eliminated.players[1]).toMatchObject({
      eliminated: true,
      eliminatedBy: 0,
      supplyMilli: 0,
    });
    expect(eliminated.players[0]).toMatchObject({
      supplyMilli: BALANCE.startingSupplyMilli + expectedReward,
      stats: expect.objectContaining({ enemiesEliminated: 1 }),
    });
    expect(eliminated.events.at(-1)).toMatchObject({
      type: "elimination",
      playerId: 0,
      amount: expectedReward,
    });
    expectValidHash(eliminated);

    const interior = createDebugScenario(createGame(DEBUG_CONFIG).state, "interior-build");
    const centerId = interior.map.spawnCenters[0]!;
    const center = interior.map.tiles[centerId]!;
    expect(center.structure).toBeNull();
    expect(center.owner).toBe(0);
    expect(
      neighbors(center).every((adjacent) => interior.map.tiles[axialKey(adjacent)]?.owner === 0),
    ).toBe(true);
    expect(interior.players[0]!.supplyMilli).toBeGreaterThanOrEqual(500_000);
    expectValidHash(interior);
  });

  it.each([
    ["victory", 0],
    ["defeat", 1],
  ] as const)("creates a valid %s match overlay state", (scenario, expectedWinner) => {
    const state = createDebugScenario(createGame(DEBUG_CONFIG).state, scenario);
    expect(state.victory).toEqual({
      leaderId: expectedWinner,
      holdTicks: 0,
      winnerId: expectedWinner,
      reason: "sole-survivor",
    });
    expect(state.players[expectedWinner]!.eliminated).toBe(false);
    expect(state.players.filter((player) => !player.eliminated)).toHaveLength(1);
    expect(state.players[expectedWinner]!.stats.enemiesEliminated).toBe(state.players.length - 1);
    expectValidHash(state);
  });

  it("guards and serves scenarios through the worker protocol", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(message),
    });

    controller.handle({ type: "start", config: TEST_CONFIG });
    controller.handle({ type: "debug-scenario", scenario: "battle" });
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({ type: "error", message: expect.stringMatching(/debug match/i) }),
    );

    controller.handle({ type: "start", config: DEBUG_CONFIG });
    controller.handle({ type: "debug-scenario", scenario: "structures" });
    controller.dispose();
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({ paused: true, battles: [] }),
      }),
    );
  });
});

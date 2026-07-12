import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import type { WorkerResponse } from "../../src/shared/types";
import {
  DEBUG_SCENARIOS,
  battlePresentation,
  cloneDeterministic,
  createDebugScenario,
  createGame,
  hashGameState,
  axialKey,
  neighbors,
  parseEngineSnapshot,
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
  it.each(DEBUG_SCENARIOS)("produces a strict snapshot-valid %s fixture", (scenario) => {
    const state = createDebugScenario(createGame(DEBUG_CONFIG).state, scenario);
    state.stateHash = hashGameState(state);
    const parsed = parseEngineSnapshot({
      state,
      commandHistory: [],
      pendingCommands: [],
    });
    expect(parsed.state).toEqual(state);
  });

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
    const farm = structures.find((tile) => tile.structure!.type === "farm")!;
    const barracks = structures.find((tile) => tile.structure!.type === "barracks")!;
    const turret = structures.find((tile) => tile.structure!.type === "turret")!;
    expect(farm.terrain).toBe("meadow");
    expect(farm.structure).toMatchObject({
      completedCount: 2,
      pendingProgressTicks: Math.floor(BALANCE.farm.buildTicks / 2),
    });
    expect(barracks.terrain).toBe("muster");
    expect(barracks.structure).toMatchObject({
      completedCount: 3,
      barracksProgressMilli: Math.floor((BALANCE.barracks.trainTicks * BALANCE.fullIntegrity) / 2),
      rallyTargetId: expect.any(String),
    });
    expect(turret.structure).toMatchObject({
      completedCount: 99,
      turretShotProgressMilli: Math.floor(BALANCE.turret.shotTicks / 2) * BALANCE.fullIntegrity,
    });
    expect(state.players[0]!.supplyMilli).toBeGreaterThanOrEqual(500_000);
    expect(state.players[0]!.stats.structuresBuilt).toBeGreaterThanOrEqual(104);
    expectValidHash(state);
  });

  it("creates exact parity combat and a stable reinforcement transition", () => {
    const initial = createGame(DEBUG_CONFIG).state;
    const battleState = createDebugScenario(initial, "battle");
    const battle = battleState.battles[0]!;
    const attacker = battle.participants.find((participant) => participant.playerId === 0)!;
    const defender = battle.participants.find(
      (participant) => participant.playerId === battle.incumbentOwner,
    )!;
    expect(battleState.battles).toHaveLength(1);
    expect(battle.participants).toHaveLength(2);
    expect(attacker.control).toBe(5_000);
    expect(battle.ageTicks).toBe(0);
    expect(attacker.troops).toBe(defender.troops);
    expect(battleState.map.tiles[battle.tileId]!.troops).toBe(0);
    expectValidHash(battleState);

    const reinforced = createDebugScenario(battleState, "reinforcement");
    const shifted = reinforced.battles[0]!;
    const shiftedAttacker = shifted.participants.find((participant) => participant.playerId === 0)!;
    expect(shifted.id).toBe(battle.id);
    expect(shiftedAttacker.reinforcementAmount).toBe(40);
    expect(shiftedAttacker.lastReinforcementTick).toBe(reinforced.tick);
    expect(shiftedAttacker.control).toBe(5_800);
    expect(shiftedAttacker.troops).toBe(96);
    expect(reinforced.events.at(-1)?.type).toBe("reinforcement");
    expectValidHash(reinforced);
  });

  it("creates a control-ready battle that cannot resolve before 35 ticks", () => {
    const prepared = createDebugScenario(createGame(DEBUG_CONFIG).state, "battle-minimum");
    const battle = prepared.battles[0]!;
    const attackerId = battle.participants.find(
      (participant) => participant.playerId !== battle.incumbentOwner,
    )!.playerId;
    expect(battle).toMatchObject({ ageTicks: 0 });
    expect(
      battle.participants.find((participant) => participant.playerId === attackerId),
    ).toMatchObject({
      control: 9_900,
      troops: 96,
    });
    expect(prepared.map.tiles[battle.tileId]!.structure).toMatchObject({
      type: "turret",
      completedCount: 3,
      status: "active",
    });
    expect(
      battlePresentation(prepared, battle).find(
        (participant) => participant.playerId === battle.incumbentOwner,
      ),
    ).toMatchObject({ turretSupportCount: 3, incumbent: true });

    let running = cloneDeterministic(prepared);
    running.paused = false;
    running.stateHash = hashGameState(running);
    const startingTick = running.tick;
    running = stepGame(running);
    expect(running.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "turret-volley",
          sourceTileId: battle.tileId,
          amount: 1,
        }),
      ]),
    );
    for (let tick = 1; tick < BALANCE.minimumBattleTicks - 1; tick += 1) {
      running = stepGame(running);
    }
    expect(running.tick - startingTick).toBe(34);
    expect(running.battles).toHaveLength(1);
    expect(
      running.battles[0]!.participants.find((participant) => participant.playerId === attackerId)!
        .control,
    ).toBe(10_000);

    running = stepGame(running);
    expect(running.tick - startingTick).toBe(BALANCE.minimumBattleTicks);
    expect(running.battles).toHaveLength(0);
    expect(running.map.tiles[battle.tileId]!.owner).toBe(attackerId);
    expectValidHash(running);
  });

  it("offers deterministic before and after capture frames", () => {
    const initial = createGame(DEBUG_CONFIG).state;
    const before = createDebugScenario(initial, "capture-before");
    const battle = before.battles[0]!;
    const attackerId = battle.participants.find(
      (participant) => participant.playerId !== battle.incumbentOwner,
    )!.playerId;
    expect(battle.ageTicks).toBe(BALANCE.minimumBattleTicks - 1);
    expect(
      battle.participants.find((participant) => participant.playerId === attackerId)!.control,
    ).toBe(9_900);

    const advancing = cloneDeterministic(before);
    advancing.paused = false;
    advancing.stateHash = hashGameState(advancing);
    const resolved = stepGame(advancing);
    expect(resolved.battles).toHaveLength(0);
    expect(resolved.map.tiles[battle.tileId]!.owner).toBe(attackerId);

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
    expect(eliminated.battles).toHaveLength(1);
    expect(
      eliminated.battles[0]!.participants.map(({ playerId, troops }) => ({ playerId, troops })),
    ).toEqual([
      { playerId: 0, troops: 6 },
      { playerId: 2, troops: 8 },
      { playerId: 3, troops: 20 },
    ]);
    expect(
      eliminated.battles[0]!.participants.every((participant) => participant.control === 5_000),
    ).toBe(true);
    expectValidHash(eliminated);

    const interior = createDebugScenario(createGame(DEBUG_CONFIG).state, "interior-build");
    const centerId = interior.map.spawnCenters[0]!;
    const center = interior.map.tiles[centerId]!;
    expect(center.structure).toBeNull();
    expect(center.owner).toBe(0);
    expect(
      neighbors(center).every((adjacent) => interior.map.tiles[axialKey(adjacent)]?.owner === 0),
    ).toBe(true);
    expect(interior.enclosures).toHaveLength(1);
    const enclosure = interior.enclosures[0]!;
    expect(enclosure).toMatchObject({
      captorId: 0,
      progressTicks: BALANCE.encirclementTicks - 1,
      tileIds: [expect.any(String)],
    });
    expect(enclosure.boundaryIds).toHaveLength(6);
    expect(enclosure.boundaryIds.every((tileId) => interior.map.tiles[tileId]!.owner === 0)).toBe(
      true,
    );
    const trappedId = enclosure.tileIds[0]!;
    expect(interior.map.tiles[trappedId]).toMatchObject({
      owner: 1,
      troops: 6,
      terrain: "meadow",
      structure: {
        type: "farm",
        completedCount: 2,
        pendingProgressTicks: Math.floor(BALANCE.farm.buildTicks / 2),
      },
    });
    expect(interior.players[0]!.supplyMilli).toBeGreaterThanOrEqual(500_000);
    expectValidHash(interior);

    const completing = cloneDeterministic(interior);
    completing.paused = false;
    completing.stateHash = hashGameState(completing);
    const enclosed = stepGame(completing);
    expect(enclosed.enclosures).toHaveLength(0);
    expect(enclosed.map.tiles[trappedId]).toMatchObject({ owner: 0, troops: 0 });
    expect(enclosed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "encirclement-complete",
          playerId: 0,
          tileIds: [trappedId],
        }),
      ]),
    );
    expectValidHash(enclosed);
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
    controller.handle({ type: "debug-scenario", scenario: "interior-build" });
    controller.dispose();
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({
          paused: true,
          battles: [],
          enclosures: [expect.objectContaining({ captorId: 0 })],
        }),
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import { BALANCE } from "../../src/shared/balance";
import { createGame, stepGame, validateCommand } from "../../src/core";
import type { MatchConfig, WorkerResponse } from "../../src/shared/types";
import { SimulationWorkerController } from "../../src/worker";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

describe("fixed-step game engine", () => {
  it("creates fair initialized players and advances exactly one 10 Hz tick", () => {
    const engine = createRunningGame(TEST_CONFIG);
    expect(engine.state.tick).toBe(0);
    expect(engine.state.players).toHaveLength(4);
    for (const player of engine.state.players) {
      expect(player.tileCount).toBe(BALANCE.startingTiles);
      expect(player.troopCount).toBe(BALANCE.startingTroops);
      expect(player.supplyMilli).toBe(BALANCE.startingSupplyMilli);
    }

    const previous = engine.state;
    const next = stepGame(previous);
    expect(next.tick).toBe(1);
    expect(previous.tick).toBe(0);
    expect(next.stateHash).not.toBe(previous.stateHash);
  });

  it("rejects illegal commands without mutating authoritative state", () => {
    const engine = createRunningGame(TEST_CONFIG);
    const enemyTile = engine.state.map.spawnClusters[1]![0]!;
    const before = engine.state.stateHash;
    const result = validateCommand(engine.state, {
      type: "move",
      playerId: 0,
      sourceId: enemyTile,
      destinationId: engine.state.map.spawnCenters[0]!,
      percent: 100,
    });
    expect(result.ok).toBe(false);
    expect(engine.state.stateHash).toBe(before);
  });

  it("settles fixed-point tile income without floating-point drift", () => {
    const engine = createRunningGame(TEST_CONFIG);
    const startingSupply = engine.state.players[0]!.supplyMilli;
    engine.step(10);
    expect(engine.state.players[0]!.supplyMilli).toBe(
      startingSupply + BALANCE.startingTiles * BALANCE.tileIncomeMilliPerSecond,
    );
  });

  it("supports multiple human seats while AI evaluates only bot seats", () => {
    const engine = createRunningGame({
      ...TEST_CONFIG,
      multiplayer: true,
      aiCount: 2,
      humanSeats: [0, 2],
      playerNames: ["North", "Bot One", "South", "Bot Two"],
      localPlayerId: 2,
    });
    expect(engine.state.players.map((player) => player.isHuman)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    engine.step(80);
    expect(engine.state.players[0]!.aiMode).toBe("human");
    expect(engine.state.players[2]!.aiMode).toBe("human");
  });

  it("runs a deterministic humans-only multiplayer duel", () => {
    const config: MatchConfig = {
      ...TEST_CONFIG,
      multiplayer: true,
      aiCount: 0,
      humanSeats: [0, 1],
      playerNames: ["North", "South"],
    };
    const first = createRunningGame(config);
    const second = createRunningGame(config);

    expect(first.state.players).toHaveLength(2);
    expect(first.state.players.every((player) => player.isHuman)).toBe(true);
    first.step(120);
    second.step(120);
    expect(first.state.stateHash).toBe(second.state.stateHash);
    expect(first.state).toEqual(second.state);
  });

  it("enforces the multiplayer human-seat bounds independently of bot count", () => {
    expect(() =>
      createGame({
        ...TEST_CONFIG,
        multiplayer: true,
        aiCount: 1,
        humanSeats: [0],
      }),
    ).toThrow("between 2 and 8 human participants");
    expect(() =>
      createGame({
        ...TEST_CONFIG,
        multiplayer: true,
        aiCount: 0,
        humanSeats: Array.from({ length: 9 }, (_, id) => id),
      }),
    ).toThrow("between 2 and 8 human participants");
  });

  it("runs the fixed tick through the Web Worker protocol", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(structuredClone(message)),
    });
    const runningConfig = createRunningGame(TEST_CONFIG).state.config;
    controller.handle({ type: "start", config: runningConfig });
    controller.handle({ type: "begin-match" });
    controller.pumpOnce();
    controller.handle({ type: "snapshot" });
    controller.dispose();

    expect(responses[0]).toEqual(expect.objectContaining({ type: "ready" }));
    expect(responses[1]).toEqual(
      expect.objectContaining({ type: "state", state: expect.objectContaining({ tick: 0 }) }),
    );
    expect(responses[2]).toEqual(
      expect.objectContaining({ type: "state", state: expect.objectContaining({ tick: 1 }) }),
    );
    expect(responses[3]).toEqual(expect.objectContaining({ type: "snapshot" }));
  });

  it("fast-forwards a restored multiplayer worker to the relay clock", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(message),
    });
    const runningConfig = createRunningGame(TEST_CONFIG).state.config;
    controller.handle({ type: "start", config: runningConfig });
    controller.handle({ type: "begin-match" });
    controller.handle({ type: "catch-up", targetTick: 25 });
    controller.dispose();

    expect(responses.at(-1)).toEqual(
      expect.objectContaining({ type: "state", state: expect.objectContaining({ tick: 25 }) }),
    );
  });

  it("defers catch-up while the absolute opening handoff is still active", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(message),
    });
    const runningConfig = createRunningGame(TEST_CONFIG).state.config;
    controller.handle({ type: "start", config: runningConfig });
    controller.handle({ type: "catch-up", targetTick: 25 });

    expect(responses.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({ phase: "opening", tick: 0 }),
      }),
    );

    controller.handle({ type: "begin-match" });
    controller.handle({ type: "catch-up", targetTick: 25 });
    controller.dispose();
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({ phase: "running", tick: 25 }),
      }),
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebugScenario } from "../../src/core/debug-scenarios";
import { GameEngine } from "../../src/core/engine";
import { hashGameState } from "../../src/core/hash";
import { BALANCE } from "../../src/shared/balance";
import type {
  EngineSnapshot,
  GameCommand,
  MatchConfig,
  WorkerResponse,
} from "../../src/shared/types";
import { SimulationWorkerController } from "../../src/worker";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

const DUEL_CONFIG: MatchConfig = {
  ...TEST_CONFIG,
  seed: "late-relay-duel",
  multiplayer: true,
  aiCount: 0,
  humanSeats: [0, 1],
  playerNames: ["North", "South"],
};

function runningDuel(): GameEngine {
  return createRunningGame(DUEL_CONFIG);
}

function friendlyOrder(engine: GameEngine, playerId: number, scheduledTick: number): GameCommand {
  const cluster = engine.state.map.spawnClusters[playerId]!;
  return {
    type: "move",
    playerId,
    sourceId: cluster[0]!,
    destinationId: cluster[1]!,
    percent: 50,
    scheduledTick,
  };
}

function atomicFriendlyOrder(
  engine: GameEngine,
  playerId: number,
  scheduledTick: number,
): GameCommand {
  const [sourceA, sourceB, destinationA, destinationB] = engine.state.map.spawnClusters[playerId]!;
  return {
    type: "multi-move",
    playerId,
    sourceIds: [sourceB!, sourceA!],
    destinationIds: [destinationB!, destinationA!],
    percent: 50,
    scheduledTick,
  };
}

function makeController() {
  const responses: WorkerResponse[] = [];
  const controller = new SimulationWorkerController({
    postMessage: (message) => responses.push(structuredClone(message)),
  });
  const fixture = runningDuel();
  controller.handle({ type: "start", config: fixture.state.config });
  controller.handle({ type: "begin-match" });
  responses.length = 0;
  return { controller, fixture, responses };
}

function encirclementCheckpoint(): EngineSnapshot {
  const fixture = createRunningGame({
    ...DUEL_CONFIG,
    seed: "multiplayer-encirclement-checkpoint",
    debug: true,
  });
  const snapshot = fixture.exportSnapshot();
  snapshot.state = createDebugScenario(snapshot.state, "interior-build");
  snapshot.state.paused = false;
  snapshot.state.stateHash = hashGameState(snapshot.state);
  snapshot.pendingCommands = [];
  return snapshot;
}

function latestState(responses: WorkerResponse[]) {
  const response = responses.findLast(
    (message): message is Extract<WorkerResponse, { type: "state" }> => message.type === "state",
  );
  if (!response) throw new Error("Expected a worker state response");
  return response;
}

function latestSnapshot(responses: WorkerResponse[]) {
  const response = responses.findLast(
    (message): message is Extract<WorkerResponse, { type: "snapshot" }> =>
      message.type === "snapshot",
  );
  if (!response) throw new Error("Expected a worker snapshot response");
  return response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("multiplayer relay scheduling", () => {
  it("catches a reconnecting placement Worker up to already-locked deterministic bots", () => {
    vi.useFakeTimers();
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(structuredClone(message)),
    });
    controller.handle({
      type: "start",
      config: {
        ...DUEL_CONFIG,
        seed: "placement-reconnect-clock",
        aiCount: 2,
        playerNames: ["North", "South", "Bot One", "Bot Two"],
      },
    });
    controller.handle({
      type: "catch-up",
      targetTick: BALANCE.aiPlacementLockDeadlineTicks,
    });

    const caughtUp = latestState(responses);
    expect(caughtUp.state).toMatchObject({
      phase: "placement",
      tick: 0,
      placement: { elapsedTicks: BALANCE.aiPlacementLockDeadlineTicks },
    });
    expect(
      caughtUp.state.placement.placements
        .filter((placement) => !caughtUp.state.players[placement.playerId]!.isHuman)
        .every((placement) => placement.locked),
    ).toBe(true);
    expect(
      caughtUp.state.placement.placements
        .filter((placement) => caughtUp.state.players[placement.playerId]!.isHuman)
        .every((placement) => !placement.locked),
    ).toBe(true);
    controller.dispose();
  });

  it("retains relay commands received during the opening handoff", () => {
    vi.useFakeTimers();
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(structuredClone(message)),
    });
    const fixture = runningDuel();
    const command = friendlyOrder(fixture, 0, 5);

    controller.handle({ type: "start", config: fixture.state.config });
    expect(responses.at(-1)).toMatchObject({
      type: "ready",
      state: { phase: "opening" },
      relaySequence: 0,
    });
    controller.handle({ type: "command", command, relaySequence: 1 });
    controller.handle({ type: "begin-match" });
    controller.handle({ type: "catch-up", targetTick: 6 });
    controller.handle({ type: "snapshot" });

    const final = latestSnapshot(responses);
    expect(final.relaySequence).toBe(1);
    expect(final.snapshot.commandHistory).toEqual([command]);
    expect(
      final.snapshot.state.events
        .filter((event) => event.type === "order")
        .map((event) => [event.playerId, event.tick]),
    ).toEqual([[0, 5]]);
    controller.dispose();
  });

  it("replays delayed same-tick commands at their authoritative relay tick", () => {
    vi.useFakeTimers();
    const { controller, fixture, responses } = makeController();

    const prior = friendlyOrder(fixture, 0, 55);
    const north = friendlyOrder(fixture, 0, 64);
    const south = friendlyOrder(fixture, 1, 64);
    controller.handle({ type: "command", command: prior });
    controller.handle({ type: "catch-up", targetTick: 66 });
    controller.handle({ type: "command", command: north });
    controller.handle({ type: "command", command: south });

    const expected = runningDuel();
    expected.submitCommand(prior);
    expected.submitCommand(north);
    expected.submitCommand(south);
    expected.step(66);
    const repaired = responses.at(-1);
    expect(repaired).toMatchObject({ type: "state", state: { tick: 66 } });
    if (!repaired || repaired.type !== "state") throw new Error("Expected repaired state");
    expect(repaired.state.stateHash).toBe(expected.state.stateHash);
    expect(repaired.state).toEqual(expected.state);
    expect(
      repaired.state.events
        .filter((event) => event.type === "order")
        .map((event) => [event.playerId, event.tick]),
    ).toEqual([
      [0, 55],
      [0, 64],
      [1, 64],
    ]);
    controller.dispose();
  });

  it("converges when same-tick relay commands are delivered in reverse sequence order", () => {
    vi.useFakeTimers();
    const forward = makeController();
    const reversed = makeController();
    const north = friendlyOrder(forward.fixture, 0, 64);
    const south = friendlyOrder(forward.fixture, 1, 64);

    forward.controller.handle({ type: "catch-up", targetTick: 66 });
    forward.controller.handle({ type: "command", command: north, relaySequence: 1 });
    forward.controller.handle({ type: "command", command: south, relaySequence: 2 });

    reversed.controller.handle({ type: "catch-up", targetTick: 66 });
    reversed.controller.handle({ type: "command", command: south, relaySequence: 2 });
    // Sequence 2 is buffered: a state/checkpoint cannot include its effect
    // while sequence 1 is still absent.
    reversed.controller.handle({ type: "snapshot" });
    const beforeGapCloses = latestSnapshot(reversed.responses);
    expect(beforeGapCloses.relaySequence).toBe(0);
    expect(beforeGapCloses.snapshot.commandHistory).toEqual([]);
    expect(beforeGapCloses.snapshot.pendingCommands).toEqual([]);

    reversed.controller.handle({ type: "command", command: north, relaySequence: 1 });

    const forwardState = latestState(forward.responses);
    const reversedState = latestState(reversed.responses);
    expect(reversedState.relaySequence).toBe(2);
    expect(reversedState.state).toEqual(forwardState.state);
    expect(reversedState.state.stateHash).toBe(forwardState.state.stateHash);
    expect(
      reversedState.state.events
        .filter((event) => event.type === "order")
        .map((event) => [event.playerId, event.tick]),
    ).toEqual([
      [0, 64],
      [1, 64],
    ]);

    reversed.controller.handle({ type: "snapshot" });
    const repaired = latestSnapshot(reversed.responses);
    expect(repaired.relaySequence).toBe(2);
    expect(repaired.snapshot.commandHistory).toEqual([north, south]);
    expect(repaired.snapshot.commandHistory).toHaveLength(2);
    expect(
      repaired.snapshot.commandHistory.every(
        (command) => !("relaySequence" in (command as unknown as Record<string, unknown>)),
      ),
    ).toBe(true);

    forward.controller.dispose();
    reversed.controller.dispose();
  });

  it("restores a checkpoint sequence base and advances only a contiguous due prefix", () => {
    vi.useFakeTimers();
    const initial = makeController();
    const first = friendlyOrder(initial.fixture, 0, 20);
    const second = friendlyOrder(initial.fixture, 1, 20);
    initial.controller.handle({ type: "command", command: first, relaySequence: 1 });
    initial.controller.handle({ type: "command", command: second, relaySequence: 2 });
    initial.controller.handle({ type: "catch-up", targetTick: 25 });
    initial.controller.handle({ type: "snapshot" });
    const checkpoint = latestSnapshot(initial.responses);
    expect(checkpoint.relaySequence).toBe(2);

    const restoredResponses: WorkerResponse[] = [];
    const restored = new SimulationWorkerController({
      postMessage: (message) => restoredResponses.push(structuredClone(message)),
    });
    restored.handle({
      type: "restore",
      snapshot: checkpoint.snapshot,
      relaySequence: checkpoint.relaySequence,
    });
    expect(restoredResponses.at(-1)).toMatchObject({ type: "ready", relaySequence: 2 });

    const restoredEngine = new GameEngine(checkpoint.snapshot);
    const third = friendlyOrder(restoredEngine, 0, 30);
    const fourth = friendlyOrder(restoredEngine, 1, 30);
    restored.handle({ type: "command", command: fourth, relaySequence: 4 });
    restored.handle({ type: "catch-up", targetTick: 32 });
    expect(latestState(restoredResponses).relaySequence).toBe(2);

    restored.handle({ type: "command", command: third, relaySequence: 3 });
    expect(latestState(restoredResponses)).toMatchObject({
      state: { tick: 32 },
      relaySequence: 4,
    });
    restored.handle({ type: "snapshot" });
    const final = latestSnapshot(restoredResponses);
    expect(final.relaySequence).toBe(4);
    expect(final.snapshot.commandHistory).toEqual([first, second, third, fourth]);

    initial.controller.dispose();
    restored.dispose();
  });

  it("retries a gap-closing relay command after activation cannot precede the checkpoint base", () => {
    vi.useFakeTimers();
    const fixture = runningDuel();
    fixture.step(300);
    const responses: WorkerResponse[] = [];
    const restored = new SimulationWorkerController({
      postMessage: (message) => responses.push(structuredClone(message)),
    });
    restored.handle({ type: "restore", snapshot: fixture.exportSnapshot(), relaySequence: 100 });
    responses.length = 0;

    const sequence101 = friendlyOrder(fixture, 0, 300);
    const sequence102 = friendlyOrder(fixture, 1, 300);
    restored.handle({ type: "command", command: sequence102, relaySequence: 102 });
    expect(responses).toEqual([]);

    restored.handle({ type: "command", command: sequence101, relaySequence: 101 });
    expect(responses.filter((message) => message.type === "error")).toHaveLength(1);
    expect(responses.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringMatching(/predates the recovery base/i),
    });

    restored.handle({ type: "command", command: sequence101, relaySequence: 101 });
    expect(responses.filter((message) => message.type === "error")).toHaveLength(2);
    expect(responses.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringMatching(/predates the recovery base/i),
    });
    restored.dispose();
  });

  it("keeps one atomic multi-move history record across checkpoint replay and deduplication", () => {
    vi.useFakeTimers();
    const initial = makeController();
    const multi = atomicFriendlyOrder(initial.fixture, 0, 20);
    initial.controller.handle({ type: "command", command: multi, relaySequence: 1 });
    initial.controller.handle({ type: "catch-up", targetTick: 25 });
    initial.controller.handle({ type: "snapshot" });
    const checkpoint = latestSnapshot(initial.responses);
    expect(checkpoint.relaySequence).toBe(1);
    expect(checkpoint.snapshot.commandHistory).toEqual([multi]);

    const responses: WorkerResponse[] = [];
    const restored = new SimulationWorkerController({
      postMessage: (message) => responses.push(structuredClone(message)),
    });
    restored.handle({
      type: "restore",
      snapshot: checkpoint.snapshot,
      relaySequence: checkpoint.relaySequence,
    });
    restored.handle({ type: "command", command: multi, relaySequence: 1 });
    restored.handle({ type: "snapshot" });
    const deduplicated = latestSnapshot(responses);
    expect(deduplicated.snapshot.commandHistory).toEqual([multi]);

    const next = friendlyOrder(new GameEngine(checkpoint.snapshot), 1, 30);
    restored.handle({ type: "command", command: next, relaySequence: 2 });
    restored.handle({ type: "catch-up", targetTick: 32 });
    restored.handle({ type: "snapshot" });
    const final = latestSnapshot(responses);
    expect(final.relaySequence).toBe(2);
    expect(final.snapshot.commandHistory).toEqual([multi, next]);
    expect(
      final.snapshot.commandHistory.filter((command) => command.type === "multi-move"),
    ).toHaveLength(1);

    initial.controller.dispose();
    restored.dispose();
  });

  it("rolls a late atomic multi-move back to its relay tick without expanding its history", () => {
    vi.useFakeTimers();
    const eager = makeController();
    const delayed = makeController();
    const multi = atomicFriendlyOrder(eager.fixture, 0, 64);

    eager.controller.handle({ type: "command", command: multi, relaySequence: 1 });
    eager.controller.handle({ type: "catch-up", targetTick: 66 });

    delayed.controller.handle({ type: "catch-up", targetTick: 66 });
    delayed.controller.handle({ type: "command", command: multi, relaySequence: 1 });

    const eagerState = latestState(eager.responses);
    const repairedState = latestState(delayed.responses);
    expect(repairedState).toMatchObject({ state: { tick: 66 }, relaySequence: 1 });
    expect(repairedState.state).toEqual(eagerState.state);
    expect(repairedState.state.stateHash).toBe(eagerState.state.stateHash);

    delayed.controller.handle({ type: "snapshot" });
    const repairedSnapshot = latestSnapshot(delayed.responses);
    expect(repairedSnapshot.snapshot.commandHistory).toEqual([multi]);
    expect(
      repairedSnapshot.snapshot.commandHistory.filter((command) => command.type === "multi-move"),
    ).toHaveLength(1);

    eager.controller.dispose();
    delayed.controller.dispose();
  });

  it("converges encirclement completion after a multiplayer checkpoint restore", () => {
    vi.useFakeTimers();
    const checkpoint = encirclementCheckpoint();
    const enclosure = checkpoint.state.enclosures[0]!;
    const pocketId = enclosure.tileIds[0]!;
    const targetTick = checkpoint.state.tick + 1;
    const catchUpResponses: WorkerResponse[] = [];
    const pumpResponses: WorkerResponse[] = [];
    const catchUp = new SimulationWorkerController({
      postMessage: (message) => catchUpResponses.push(structuredClone(message)),
    });
    const pump = new SimulationWorkerController({
      postMessage: (message) => pumpResponses.push(structuredClone(message)),
    });

    catchUp.handle({ type: "restore", snapshot: checkpoint, relaySequence: 7 });
    pump.handle({ type: "restore", snapshot: structuredClone(checkpoint), relaySequence: 7 });
    catchUp.handle({ type: "catch-up", targetTick });
    pump.pumpOnce();

    const caughtUp = latestState(catchUpResponses);
    const pumped = latestState(pumpResponses);
    expect(caughtUp).toMatchObject({ state: { tick: targetTick }, relaySequence: 7 });
    expect(caughtUp.state).toEqual(pumped.state);
    expect(caughtUp.state.stateHash).toBe(pumped.state.stateHash);
    expect(caughtUp.state.enclosures).toEqual([]);
    expect(caughtUp.state.map.tiles[pocketId]).toMatchObject({ owner: enclosure.captorId });

    catchUp.dispose();
    pump.dispose();
  });
});

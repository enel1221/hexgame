import { afterEach, describe, expect, it, vi } from "vitest";
import { createGame } from "../../src/core";
import type { GameCommand, MatchConfig, WorkerResponse } from "../../src/shared/types";
import { SimulationWorkerController } from "../../src/worker";
import { TEST_CONFIG } from "./fixtures";

function stateMessages(responses: WorkerResponse[]) {
  return responses.filter(
    (message): message is Extract<WorkerResponse, { type: "state" }> => message.type === "state",
  );
}

function makeController(config: MatchConfig = TEST_CONFIG) {
  const responses: WorkerResponse[] = [];
  const controller = new SimulationWorkerController({
    // A real Worker structured-clones every publication. Mirror that boundary
    // so prior publications do not retain the mutable engine state reference.
    postMessage: (message) => responses.push(structuredClone(message)),
  });
  controller.handle({ type: "start", config });
  return { controller, responses };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("batched fixed-step Worker scheduling", () => {
  it.each([1, 2, 4] as const)(
    "publishes exactly 10 states per wall-clock second at %s×",
    (speed) => {
      vi.useFakeTimers();
      const { controller, responses } = makeController({
        ...TEST_CONFIG,
        seed: `publication-cadence-${speed}`,
      });
      controller.handle({ type: "speed", speed });

      vi.advanceTimersByTime(1_000);
      const states = stateMessages(responses);
      expect(states).toHaveLength(10);
      expect(states.map((message) => message.state.tick)).toEqual(
        Array.from({ length: 10 }, (_, index) => (index + 1) * speed),
      );
      expect(states.every((message) => message.simulationMs >= 0 && message.aiMs >= 0)).toBe(true);
      controller.dispose();
    },
  );

  it("changes batch size without changing the 10 Hz publication timer", () => {
    vi.useFakeTimers();
    const { controller, responses } = makeController({
      ...TEST_CONFIG,
      seed: "speed-switch-cadence",
    });
    vi.advanceTimersByTime(500);
    controller.handle({ type: "speed", speed: 4 });
    vi.advanceTimersByTime(500);

    const states = stateMessages(responses);
    expect(states).toHaveLength(10);
    expect(states.slice(0, 5).map((message) => message.state.tick)).toEqual([1, 2, 3, 4, 5]);
    expect(states.slice(5).map((message) => message.state.tick)).toEqual([9, 13, 17, 21, 25]);
    controller.dispose();
  });

  it("retains one-tick pumpOnce behavior even when speed is 4×", () => {
    vi.useFakeTimers();
    const { controller, responses } = makeController({
      ...TEST_CONFIG,
      seed: "one-tick-pump",
    });
    controller.handle({ type: "speed", speed: 4 });
    controller.pumpOnce();

    expect(stateMessages(responses).at(-1)?.state.tick).toBe(1);
    controller.dispose();
  });

  it("matches direct-core hashes after ten 4-tick publication batches", () => {
    vi.useFakeTimers();
    const config = { ...TEST_CONFIG, seed: "batched-worker-determinism" };
    const direct = createGame(config);
    direct.step(40);
    const { controller, responses } = makeController(config);
    controller.handle({ type: "speed", speed: 4 });
    for (let batch = 0; batch < 10; batch += 1) controller.pumpScheduledOnce();

    const final = stateMessages(responses).at(-1)!.state;
    expect(stateMessages(responses)).toHaveLength(10);
    expect(final.tick).toBe(40);
    expect(final.stateHash).toBe(direct.state.stateHash);
    expect(final).toEqual(direct.state);
    controller.dispose();
  });

  it("applies a received command on the first tick of the next batch", () => {
    vi.useFakeTimers();
    const config = { ...TEST_CONFIG, seed: "batched-command-timing" };
    const direct = createGame(config);
    const sourceId = direct.state.map.spawnClusters[0]![0]!;
    const destinationId = direct.state.map.spawnClusters[0]![1]!;
    const command: GameCommand = {
      type: "move",
      playerId: 0,
      sourceId,
      destinationId,
      percent: 25,
    };
    expect(direct.submitCommand(command).ok).toBe(true);
    direct.step(4);

    const { controller, responses } = makeController(config);
    controller.handle({ type: "speed", speed: 4 });
    controller.handle({ type: "command", command });
    controller.pumpScheduledOnce();
    controller.handle({ type: "snapshot" });

    const final = stateMessages(responses).at(-1)!.state;
    const snapshot = responses.find(
      (message): message is Extract<WorkerResponse, { type: "snapshot" }> =>
        message.type === "snapshot",
    )!.snapshot;
    expect(final.stateHash).toBe(direct.state.stateHash);
    expect(snapshot.commandHistory).toEqual([
      expect.objectContaining({ ...command, scheduledTick: 1 }),
    ]);
    controller.dispose();
  });

  it("does not advance or publish scheduled batches while paused", () => {
    vi.useFakeTimers();
    const { controller, responses } = makeController({
      ...TEST_CONFIG,
      seed: "batched-pause",
    });
    controller.handle({ type: "speed", speed: 4 });
    controller.pumpScheduledOnce();
    controller.handle({ type: "pause", paused: true });
    const publicationsWhilePaused = stateMessages(responses).length;
    controller.pumpScheduledOnce();
    expect(stateMessages(responses)).toHaveLength(publicationsWhilePaused);
    expect(stateMessages(responses).at(-1)?.state.tick).toBe(4);

    controller.handle({ type: "pause", paused: false });
    controller.pumpScheduledOnce();
    expect(stateMessages(responses).at(-1)?.state.tick).toBe(8);
    controller.dispose();
  });

  it("rejects acceleration and advances one tick per publication in multiplayer", () => {
    vi.useFakeTimers();
    const config: MatchConfig = {
      ...TEST_CONFIG,
      seed: "multiplayer-speed-lock",
      multiplayer: true,
      aiCount: 0,
      humanSeats: [0, 1],
      playerNames: ["North", "South"],
    };
    const { controller, responses } = makeController(config);
    controller.handle({ type: "speed", speed: 4 });
    controller.pumpScheduledOnce();

    expect(responses).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringMatching(/locked to 1/i) }),
    );
    expect(stateMessages(responses).at(-1)?.state.tick).toBe(1);
    controller.dispose();
  });
});

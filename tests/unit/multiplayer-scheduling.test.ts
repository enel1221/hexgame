import { describe, expect, it } from "vitest";
import { GameEngine } from "../../src/core/engine";
import type { GameCommand, MatchConfig, WorkerResponse } from "../../src/shared/types";
import { SimulationWorkerController } from "../../src/worker";
import { TEST_CONFIG } from "./fixtures";

const DUEL_CONFIG: MatchConfig = {
  ...TEST_CONFIG,
  seed: "late-relay-duel",
  multiplayer: true,
  aiCount: 0,
  humanSeats: [0, 1],
  playerNames: ["North", "South"],
};

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

describe("multiplayer relay scheduling", () => {
  it("replays delayed same-tick commands at their authoritative relay tick", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(message),
    });
    controller.handle({ type: "start", config: DUEL_CONFIG });

    const fixture = new GameEngine(DUEL_CONFIG);
    const prior = friendlyOrder(fixture, 0, 55);
    const north = friendlyOrder(fixture, 0, 64);
    const south = friendlyOrder(fixture, 1, 64);
    controller.handle({ type: "command", command: prior });
    controller.handle({ type: "catch-up", targetTick: 66 });
    controller.handle({ type: "command", command: north });
    controller.handle({ type: "command", command: south });

    const expected = new GameEngine(DUEL_CONFIG);
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
});

import { describe, expect, it } from "vitest";
import type { EngineSnapshot, WorkerResponse } from "../../src/shared/types";
import {
  cloneDeterministic,
  createGame,
  importSnapshot,
  parseEngineSnapshot,
  SnapshotValidationError,
} from "../../src/core";
import { SimulationWorkerController } from "../../src/worker";
import { TEST_CONFIG } from "./fixtures";

function validSnapshot(): EngineSnapshot {
  const engine = createGame({ ...TEST_CONFIG, seed: "snapshot-runtime-validation" });
  engine.step(90);
  return engine.exportSnapshot();
}

describe("runtime EngineSnapshot validation", () => {
  it("accepts and restores a complete version-1 snapshot", () => {
    const snapshot = validSnapshot();
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);
    const restored = importSnapshot(snapshot);
    expect(restored.state.stateHash).toBe(snapshot.state.stateHash);
    expect(restored.state.tick).toBe(snapshot.state.tick);
  });

  it("accepts a multiplayer checkpoint with multiple configured human seats", () => {
    const snapshot = createGame({
      ...TEST_CONFIG,
      seed: "multiplayer-snapshot-validation",
      multiplayer: true,
      aiCount: 2,
      humanSeats: [0, 2],
      playerNames: ["North", "Bot", "South", "Bot Two"],
      localPlayerId: 2,
    }).exportSnapshot();
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);
  });

  it.each([
    [
      "missing state fields",
      (snapshot: Record<string, unknown>) => {
        snapshot.state = { version: 1 };
      },
    ],
    [
      "invalid owner reference",
      (snapshot: Record<string, unknown>) => {
        const state = (snapshot as unknown as EngineSnapshot).state;
        state.map.tiles[state.map.landIds[0]!]!.owner = 999;
      },
    ],
    [
      "invalid command percentage",
      (snapshot: Record<string, unknown>) => {
        const typed = snapshot as unknown as EngineSnapshot;
        typed.commandHistory.push({
          type: "move",
          playerId: 0,
          sourceId: typed.state.map.landIds[0]!,
          destinationId: typed.state.map.landIds[1]!,
          percent: 30,
        } as never);
      },
    ],
    [
      "mismatched tile record",
      (snapshot: Record<string, unknown>) => {
        const typed = snapshot as unknown as EngineSnapshot;
        const tileId = typed.state.map.tileIds[0]!;
        delete typed.state.map.tiles[tileId];
      },
    ],
  ])("rejects malformed version-1 data: %s", (_label, mutate) => {
    const malformed = cloneDeterministic(validSnapshot()) as unknown as Record<string, unknown>;
    mutate(malformed);
    expect(() => parseEngineSnapshot(malformed)).toThrow(SnapshotValidationError);
  });

  it("rejects unsupported versions explicitly", () => {
    const malformed = cloneDeterministic(validSnapshot()) as unknown as {
      state: { version: number };
    };
    malformed.state.version = 2;
    expect(() => parseEngineSnapshot(malformed)).toThrow("Unsupported snapshot version");
  });

  it("rejects a shape-valid snapshot whose deterministic payload was altered", () => {
    const tampered = cloneDeterministic(validSnapshot());
    tampered.state.tick += 1;
    expect(() => parseEngineSnapshot(tampered)).toThrow(/stateHash.*does not match/i);
  });

  it("keeps an existing engine unchanged when import validation fails", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "atomic-import" });
    engine.step(25);
    const stateBefore = cloneDeterministic(engine.state);
    const historyBefore = cloneDeterministic(engine.commandHistory);
    const malformed = cloneDeterministic(engine.exportSnapshot());
    malformed.state.players[0]!.name = "";

    expect(() => engine.importSnapshot(malformed)).toThrow(SnapshotValidationError);
    expect(engine.state).toEqual(stateBefore);
    expect(engine.commandHistory).toEqual(historyBefore);
  });

  it("rejects a bad network restore while the live worker keeps advancing", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(message),
    });
    controller.handle({ type: "start", config: { ...TEST_CONFIG, seed: "worker-recovery" } });
    const malformed = cloneDeterministic(validSnapshot());
    malformed.state.map.landCount += 1;
    controller.handle({ type: "restore", snapshot: malformed });
    controller.pumpOnce();
    controller.dispose();

    expect(responses.some((message) => message.type === "error")).toBe(true);
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({
          tick: 1,
          config: expect.objectContaining({ seed: "worker-recovery" }),
        }),
      }),
    );
  });
});

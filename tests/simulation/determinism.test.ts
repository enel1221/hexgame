import { describe, expect, it } from "vitest";
import type { MatchConfig } from "../../src/shared/types";
import {
  axialKey,
  createGame,
  importSnapshot,
  neighbors,
  replayCommands,
  stableStringify,
} from "../../src/core";

const CONFIG: MatchConfig = {
  seed: "determinism-suite",
  archetype: "highland-basin",
  aiCount: 3,
  difficulty: "hard",
  playerName: "Replay",
  graphics: "low",
  sound: false,
  colorPatterns: true,
  debug: false,
};

function queueOpeningMove(engine: ReturnType<typeof createGame>): void {
  const source = engine.state.map.tiles[engine.state.map.spawnCenters[0]!]!;
  const neutral = neighbors(source)
    .map((hex) => engine.state.map.tiles[axialKey(hex)])
    .find((tile) => tile && tile.owner === null);
  const friendly = engine.state.map.spawnClusters[0]!.map((id) => engine.state.map.tiles[id]!).find(
    (tile) => tile.id !== source.id && tile.troops > 1,
  )!;
  engine.submitCommand({
    type: "move",
    playerId: 0,
    sourceId: neutral ? source.id : friendly.id,
    destinationId: neutral?.id ?? source.id,
    percent: 50,
    scheduledTick: 2,
  });
}

describe("deterministic replay and snapshots", () => {
  it("produces byte-equivalent state and hash for equal inputs", () => {
    const left = createGame(CONFIG);
    const right = createGame(CONFIG);
    queueOpeningMove(left);
    queueOpeningMove(right);
    left.step(240);
    right.step(240);
    expect(left.state.stateHash).toBe(right.state.stateHash);
    expect(stableStringify(left.state)).toBe(stableStringify(right.state));
  });

  it("continues identically after snapshot restore and command replay", () => {
    const original = createGame(CONFIG);
    queueOpeningMove(original);
    original.step(120);
    const restored = importSnapshot(original.exportSnapshot());
    original.step(80);
    restored.step(80);
    expect(restored.state.stateHash).toBe(original.state.stateHash);

    const replayed = replayCommands(CONFIG, original.commandHistory, original.state.tick);
    expect(replayed.stateHash).toBe(original.state.stateHash);
  });

  it("preserves accepted future commands in local save snapshots", () => {
    const original = createGame(CONFIG);
    const sourceId = original.state.map.spawnClusters[0]![0]!;
    const destinationId = original.state.map.spawnClusters[0]![1]!;
    expect(
      original.submitCommand({
        type: "move",
        playerId: 0,
        sourceId,
        destinationId,
        percent: 25,
        scheduledTick: 20,
      }).ok,
    ).toBe(true);
    const restored = importSnapshot(original.exportSnapshot());
    original.step(25);
    restored.step(25);
    expect(restored.state.stateHash).toBe(original.state.stateHash);
    expect(restored.commandHistory).toEqual(original.commandHistory);
  });

  it("never consults Math.random in map, AI, or simulation code", () => {
    const previous = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be called");
    };
    try {
      const engine = createGame({ ...CONFIG, seed: "no-random" });
      engine.step(60);
      expect(engine.state.tick).toBe(60);
    } finally {
      Math.random = previous;
    }
  });
});

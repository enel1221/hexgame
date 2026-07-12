import { describe, expect, it } from "vitest";
import {
  decodeCheckpointPayload,
  encodeCheckpoint,
  localizeCheckpointForRecipient,
} from "../../src/client/checkpoints";
import type { EngineSnapshot } from "../../src/shared/types";

describe("compact multiplayer checkpoints", () => {
  it("round-trips a snapshot-shaped payload well above the JSON relay limit", async () => {
    const snapshot = {
      state: {
        version: 2,
        stateHash: "0123456789abcdef",
        // Large maps contain repeated tile/structure keys and compress well.
        fixture: "hex-dominion-tile-state,".repeat(20_000),
      },
      commandHistory: [],
      pendingCommands: [],
    } as unknown as EngineSnapshot;
    expect(JSON.stringify(snapshot).length).toBeGreaterThan(450_000);

    const encoded = await encodeCheckpoint(snapshot);
    expect(encoded.encoding).toBe("gzip-base64");
    expect(encoded.payload.length).toBeLessThan(262_144);
    await expect(decodeCheckpointPayload(encoded.encoding, encoded.payload)).resolves.toEqual(
      snapshot,
    );
  });

  it("retains backward-compatible JSON and base64 decoding", async () => {
    const value = { state: { version: 1 }, commandHistory: [] };
    await expect(decodeCheckpointPayload("json", JSON.stringify(value))).resolves.toEqual(value);
    await expect(
      decodeCheckpointPayload(
        "base64",
        btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))),
      ),
    ).resolves.toEqual(value);
  });

  it("overlays the recipient seat and presentation settings without taking the host seat", () => {
    const snapshot = {
      state: {
        config: {
          seed: "ROOM-SEED",
          archetype: "heartland",
          aiCount: 0,
          difficulty: "normal",
          playerName: "Host",
          graphics: "high",
          sound: true,
          colorPatterns: false,
          fullCounts: false,
          debug: true,
          multiplayer: true,
          humanSeats: [0, 1],
          localPlayerId: 0,
          startingCenters: ["0,0", "8,0"],
        },
      },
      commandHistory: [],
      pendingCommands: [{ type: "move" }],
    } as unknown as EngineSnapshot;

    const localized = localizeCheckpointForRecipient(snapshot, 1, {
      playerName: "Guest",
      graphics: "low",
      sound: false,
      colorPatterns: true,
      fullCounts: true,
      debug: true,
    });

    expect(localized.state.config).toMatchObject({
      seed: "ROOM-SEED",
      startingCenters: ["0,0", "8,0"],
      localPlayerId: 1,
      playerName: "Guest",
      graphics: "low",
      sound: false,
      colorPatterns: true,
      fullCounts: true,
    });
    expect(localized.pendingCommands).toEqual([]);
    expect(snapshot.state.config.localPlayerId).toBe(0);
  });
});

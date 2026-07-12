import { describe, expect, it } from "vitest";
import {
  ClientMessageSchema,
  CreateRoomRequestSchema,
  GameCommandSchema,
  RoomCodeSchema,
  RoomConfigSchema,
  ServerMessageSchema,
} from "../../src/edge/protocol";

describe("multiplayer protocol schemas", () => {
  it("normalizes unambiguous six-character room codes", () => {
    expect(RoomCodeSchema.parse("ab2cd3")).toBe("AB2CD3");
    expect(RoomCodeSchema.safeParse("ABICD3").success).toBe(false);
    expect(RoomCodeSchema.safeParse("ABC1234").success).toBe(false);
  });

  it("allows a two-human room without bots and enforces the 21-participant ceiling", () => {
    expect(
      RoomConfigSchema.safeParse({
        seed: "humans-only",
        archetype: "heartland",
        difficulty: "normal",
        botCount: 0,
        maxHumans: 2,
      }).success,
    ).toBe(true);
    expect(
      RoomConfigSchema.safeParse({
        seed: "valid",
        archetype: "heartland",
        difficulty: "normal",
        botCount: 13,
        maxHumans: 8,
      }).success,
    ).toBe(true);
    expect(
      RoomConfigSchema.safeParse({
        seed: "too-many",
        archetype: "heartland",
        difficulty: "normal",
        botCount: 14,
        maxHumans: 8,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed create requests and game commands", () => {
    expect(
      CreateRoomRequestSchema.safeParse({
        playerName: "",
        config: {},
      }).success,
    ).toBe(false);
    expect(
      GameCommandSchema.safeParse({
        type: "move",
        playerId: 0,
        sourceId: "0,0",
        destinationId: "1,0",
        percent: 33,
      }).success,
    ).toBe(false);
    expect(
      GameCommandSchema.safeParse({
        type: "multi-move",
        playerId: 0,
        sourceIds: ["0,0", "0,0"],
        destinationIds: ["1,0"],
        percent: 50,
      }).success,
    ).toBe(false);
  });

  it("validates placement, rally, and bounded atomic multi-move messages", () => {
    expect(
      GameCommandSchema.parse({
        type: "multi-move",
        playerId: 0,
        sourceIds: Array.from({ length: 64 }, (_, index) => `${index},0`),
        destinationIds: Array.from({ length: 16 }, (_, index) => `${index},1`),
        percent: 75,
      }),
    ).toMatchObject({ type: "multi-move", percent: 75 });
    expect(
      GameCommandSchema.safeParse({
        type: "multi-move",
        playerId: 0,
        sourceIds: Array.from({ length: 65 }, (_, index) => `${index},0`),
        destinationIds: ["0,1"],
        percent: 75,
      }).success,
    ).toBe(false);
    expect(
      GameCommandSchema.safeParse({
        type: "set-rally",
        playerId: 2,
        tileId: "-2,4",
        destinationId: "3,-1",
      }).success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({
        type: "placement-finalize",
        generationAttempt: 1,
        candidateHash: "12345678abcdef00",
        spawnCenters: ["0,0", "6,0"],
      }).success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({
        type: "placement-finalize",
        generationAttempt: 1,
        candidateHash: "12345678abcdef00",
        spawnCenters: ["0,0", "0,0"],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded client batches and rejects nested or oversized batches", () => {
    const ready = { type: "ready", ready: true } as const;
    expect(ClientMessageSchema.safeParse({ type: "batch", messages: [ready] }).success).toBe(true);
    expect(
      ClientMessageSchema.safeParse({
        type: "batch",
        messages: Array.from({ length: 33 }, () => ready),
      }).success,
    ).toBe(false);
    expect(
      ClientMessageSchema.safeParse({
        type: "batch",
        messages: [{ type: "batch", messages: [ready] }],
      }).success,
    ).toBe(false);
  });

  it("validates ordered command batches from the relay", () => {
    const result = ServerMessageSchema.safeParse({
      type: "command-batch",
      commands: [
        {
          sequence: 4,
          targetTick: 27,
          playerId: "player-a",
          playerSeat: 0,
          clientSequence: 2,
          command: {
            type: "build",
            playerId: 0,
            tileId: "2,-1",
            structure: "turret",
            scheduledTick: 27,
          },
        },
      ],
      latestSequence: 4,
      serverTick: 21,
      replay: false,
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });
});

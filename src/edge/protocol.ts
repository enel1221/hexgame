import { z } from "zod";

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const MIN_MATCH_PARTICIPANTS = 2;
export const MIN_PARTICIPANT_CAPACITY_MESSAGE = `Room capacity plus bots must allow at least ${MIN_MATCH_PARTICIPANTS} participants`;
export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(6)
  .refine(
    (code) => [...code].every((character) => ROOM_CODE_ALPHABET.includes(character)),
    "Room code contains an ambiguous or unsupported character",
  );

export const PlayerNameSchema = z.string().trim().min(1).max(24);
export const ReconnectTokenSchema = z.string().min(32).max(128);
export const StateHashSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{8,128}$/i, "Expected a hexadecimal state hash");

export const RoomConfigSchema = z
  .object({
    seed: z.string().trim().min(1).max(64),
    archetype: z.enum(["heartland", "broken-crown", "highland-basin"]),
    difficulty: z.enum(["easy", "normal", "hard"]),
    botCount: z.number().int().min(0).max(19),
    maxHumans: z.number().int().min(2).max(8).default(8),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.botCount + config.maxHumans < MIN_MATCH_PARTICIPANTS) {
      context.addIssue({
        code: "custom",
        message: MIN_PARTICIPANT_CAPACITY_MESSAGE,
        path: ["botCount"],
      });
    }
    if (config.botCount + config.maxHumans > 21) {
      context.addIssue({
        code: "custom",
        message: "Human capacity plus bots cannot exceed 21 participants",
        path: ["botCount"],
      });
    }
  });

export const CreateRoomRequestSchema = z
  .object({
    playerName: PlayerNameSchema,
    config: RoomConfigSchema,
  })
  .strict();

export const JoinRoomRequestSchema = z
  .object({
    playerName: PlayerNameSchema,
    reconnectToken: ReconnectTokenSchema.optional(),
  })
  .strict();

const RequestIdSchema = z.string().trim().min(1).max(64).optional();
const PlayerIdSchema = z.number().int().min(0).max(20);
const ScheduledTickSchema = z.number().int().nonnegative().optional();

export const GameCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      playerId: PlayerIdSchema,
      sourceId: z.string().min(1).max(32),
      destinationId: z.string().min(1).max(32),
      percent: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]),
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("build"),
      playerId: PlayerIdSchema,
      tileId: z.string().min(1).max(32),
      structure: z.enum(["farm", "barracks", "turret"]),
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel-build"),
      playerId: PlayerIdSchema,
      tileId: z.string().min(1).max(32),
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("toggle-barracks"),
      playerId: PlayerIdSchema,
      tileId: z.string().min(1).max(32),
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
]);

export const ReadyMessageSchema = z
  .object({ type: z.literal("ready"), ready: z.boolean(), requestId: RequestIdSchema })
  .strict();
export const StartMessageSchema = z
  .object({ type: z.literal("start"), requestId: RequestIdSchema })
  .strict();
export const CommandMessageSchema = z
  .object({
    type: z.literal("command"),
    clientSequence: z.number().int().positive(),
    command: GameCommandSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const HashMessageSchema = z
  .object({
    type: z.literal("hash"),
    tick: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    hash: StateHashSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const CheckpointMessageSchema = z
  .object({
    type: z.literal("checkpoint"),
    tick: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    hash: StateHashSchema,
    encoding: z.enum(["json", "base64"]),
    payload: z.string().max(262_144),
    requestId: RequestIdSchema,
  })
  .strict();
export const MissingMessageSchema = z
  .object({
    type: z.literal("missing"),
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500).default(500),
    requestId: RequestIdSchema,
  })
  .strict();
export const LeaveMessageSchema = z
  .object({ type: z.literal("leave"), requestId: RequestIdSchema })
  .strict();
export const CompleteMessageSchema = z
  .object({
    type: z.literal("complete"),
    winnerSeat: PlayerIdSchema,
    finalTick: z.number().int().nonnegative(),
    hash: StateHashSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const PingMessageSchema = z
  .object({
    type: z.literal("ping"),
    clientTime: z.number().finite(),
    requestId: RequestIdSchema,
  })
  .strict();

export const AtomicClientMessageSchema = z.discriminatedUnion("type", [
  ReadyMessageSchema,
  StartMessageSchema,
  CommandMessageSchema,
  HashMessageSchema,
  CheckpointMessageSchema,
  MissingMessageSchema,
  LeaveMessageSchema,
  CompleteMessageSchema,
  PingMessageSchema,
]);

export const ClientMessageSchema = z.union([
  AtomicClientMessageSchema,
  z
    .object({
      type: z.literal("batch"),
      messages: z.array(AtomicClientMessageSchema).min(1).max(32),
    })
    .strict(),
]);

export const PlayerSummarySchema = z
  .object({
    id: z.string(),
    seat: PlayerIdSchema,
    name: PlayerNameSchema,
    ready: z.boolean(),
    connected: z.boolean(),
    isHost: z.boolean(),
  })
  .strict();

export const OrderedCommandSchema = z
  .object({
    sequence: z.number().int().positive(),
    targetTick: z.number().int().nonnegative(),
    playerId: z.string(),
    playerSeat: PlayerIdSchema,
    clientSequence: z.number().int().positive(),
    command: GameCommandSchema,
  })
  .strict();

export const CheckpointSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    tick: z.number().int().nonnegative(),
    hash: StateHashSchema,
    encoding: z.enum(["json", "base64"]),
    payload: z.string(),
  })
  .strict();

const LobbySchema = z
  .object({
    type: z.literal("lobby"),
    roomCode: RoomCodeSchema,
    phase: z.enum(["lobby", "started", "complete"]),
    config: RoomConfigSchema,
    players: z.array(PlayerSummarySchema),
    totalParticipants: z.number().int().min(1).max(21),
  })
  .strict();

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("welcome"),
      roomCode: RoomCodeSchema,
      phase: z.enum(["lobby", "started", "complete"]),
      player: PlayerSummarySchema,
      config: RoomConfigSchema,
      latestSequence: z.number().int().nonnegative(),
      nextClientSequence: z.number().int().positive(),
      serverTick: z.number().int().nonnegative(),
    })
    .strict(),
  LobbySchema,
  z
    .object({
      type: z.literal("started"),
      startedAt: z.number().int().positive(),
      startTick: z.literal(0),
      config: RoomConfigSchema,
      players: z.array(PlayerSummarySchema),
    })
    .strict(),
  z
    .object({
      type: z.literal("ack"),
      action: z.enum([
        "ready",
        "start",
        "command",
        "hash",
        "checkpoint",
        "missing",
        "leave",
        "complete",
      ]),
      requestId: z.string().optional(),
      sequence: z.number().int().positive().optional(),
      targetTick: z.number().int().nonnegative().optional(),
      duplicate: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command-batch"),
      commands: z.array(OrderedCommandSchema),
      latestSequence: z.number().int().nonnegative(),
      serverTick: z.number().int().nonnegative(),
      replay: z.boolean().default(false),
      hasMore: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("sync"),
      checkpoint: CheckpointSchema.nullable(),
      commands: z.array(OrderedCommandSchema),
      latestSequence: z.number().int().nonnegative(),
      serverTick: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("desync"),
      tick: z.number().int().nonnegative(),
      sequence: z.number().int().nonnegative(),
      hashes: z.record(z.string(), StateHashSchema),
      majorityHash: StateHashSchema.nullable(),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("complete"),
      winnerSeat: PlayerIdSchema,
      finalTick: z.number().int().nonnegative(),
      hash: StateHashSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pong"),
      clientTime: z.number(),
      serverTime: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.string(),
      message: z.string(),
      requestId: z.string().optional(),
      recoverable: z.boolean(),
    })
    .strict(),
]);

export type RoomConfig = z.infer<typeof RoomConfigSchema>;
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
export type JoinRoomRequest = z.infer<typeof JoinRoomRequestSchema>;
export type GameCommand = z.infer<typeof GameCommandSchema>;
export type AtomicClientMessage = z.infer<typeof AtomicClientMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type OrderedCommand = z.infer<typeof OrderedCommandSchema>;
export type PlayerSummary = z.infer<typeof PlayerSummarySchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;

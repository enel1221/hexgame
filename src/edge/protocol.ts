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

export const RoomPhaseSchema = z.enum(["lobby", "placement", "started", "complete"]);
export const TileIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^-?\d+,-?\d+$/, "Expected an axial-coordinate tile ID");

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
const SendPercentSchema = z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]);

export const GameCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("choose-spawn"),
      playerId: PlayerIdSchema,
      centerId: TileIdSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("lock-spawn"),
      playerId: PlayerIdSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      playerId: PlayerIdSchema,
      sourceId: TileIdSchema,
      destinationId: TileIdSchema,
      percent: SendPercentSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("multi-move"),
      playerId: PlayerIdSchema,
      sourceIds: z.array(TileIdSchema).min(1).max(64),
      destinationIds: z.array(TileIdSchema).min(1).max(16),
      percent: SendPercentSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict()
    .superRefine((command, context) => {
      if (new Set(command.sourceIds).size !== command.sourceIds.length) {
        context.addIssue({
          code: "custom",
          message: "Multi-move source IDs must be unique",
          path: ["sourceIds"],
        });
      }
      if (new Set(command.destinationIds).size !== command.destinationIds.length) {
        context.addIssue({
          code: "custom",
          message: "Multi-move destination IDs must be unique",
          path: ["destinationIds"],
        });
      }
    }),
  z
    .object({
      type: z.literal("build"),
      playerId: PlayerIdSchema,
      tileId: TileIdSchema,
      structure: z.enum(["farm", "barracks", "turret"]),
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel-build"),
      playerId: PlayerIdSchema,
      tileId: TileIdSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("toggle-barracks"),
      playerId: PlayerIdSchema,
      tileId: TileIdSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("set-rally"),
      playerId: PlayerIdSchema,
      tileId: TileIdSchema,
      destinationId: TileIdSchema,
      scheduledTick: ScheduledTickSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("clear-rally"),
      playerId: PlayerIdSchema,
      tileId: TileIdSchema,
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
export const PlacementCandidatesMessageSchema = z
  .object({
    type: z.literal("placement-candidates"),
    generationAttempt: z.number().int().nonnegative(),
    candidateHash: StateHashSchema,
    candidates: z.array(TileIdSchema).min(2).max(2_100),
    requestId: RequestIdSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (new Set(message.candidates).size !== message.candidates.length) {
      context.addIssue({
        code: "custom",
        message: "Placement candidates must be unique",
        path: ["candidates"],
      });
    }
  });
export const PlacementClaimMessageSchema = z
  .object({
    type: z.literal("placement-claim"),
    centerId: TileIdSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const PlacementLockMessageSchema = z
  .object({
    type: z.literal("placement-lock"),
    centerId: TileIdSchema,
    requestId: RequestIdSchema,
  })
  .strict();
export const PlacementFinalizeMessageSchema = z
  .object({
    type: z.literal("placement-finalize"),
    generationAttempt: z.number().int().nonnegative(),
    candidateHash: StateHashSchema,
    spawnCenters: z.array(TileIdSchema).min(2).max(21),
    requestId: RequestIdSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (new Set(message.spawnCenters).size !== message.spawnCenters.length) {
      context.addIssue({
        code: "custom",
        message: "Final placement centers must be unique",
        path: ["spawnCenters"],
      });
    }
  });
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
    encoding: z.enum(["json", "base64", "gzip-base64"]),
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
  PlacementCandidatesMessageSchema,
  PlacementClaimMessageSchema,
  PlacementLockMessageSchema,
  PlacementFinalizeMessageSchema,
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

export const PlacementSelectionSchema = z
  .object({
    seat: PlayerIdSchema,
    centerId: TileIdSchema.nullable(),
    locked: z.boolean(),
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
    encoding: z.enum(["json", "base64", "gzip-base64"]),
    payload: z.string(),
  })
  .strict();

const LobbySchema = z
  .object({
    type: z.literal("lobby"),
    roomCode: RoomCodeSchema,
    phase: RoomPhaseSchema,
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
      phase: RoomPhaseSchema,
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
      type: z.literal("placement"),
      roomCode: RoomCodeSchema,
      startedAt: z.number().int().positive(),
      deadlineAt: z.number().int().positive(),
      config: RoomConfigSchema,
      players: z.array(PlayerSummarySchema),
      selections: z.array(PlacementSelectionSchema).max(8),
      proposedCenters: z.array(TileIdSchema).min(2).max(21).nullable(),
      generationAttempt: z.number().int().nonnegative().nullable(),
      candidateHash: StateHashSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("started"),
      startedAt: z.number().int().positive(),
      startTick: z.literal(0),
      config: RoomConfigSchema,
      players: z.array(PlayerSummarySchema),
      spawnCenters: z.array(TileIdSchema).min(2).max(21),
      generationAttempt: z.number().int().nonnegative(),
      candidateHash: StateHashSchema,
      placementStartedAt: z.number().int().positive(),
      placementDeadlineAt: z.number().int().positive(),
      timedOut: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ack"),
      action: z.enum([
        "ready",
        "start",
        "placement-candidates",
        "placement-claim",
        "placement-lock",
        "placement-finalize",
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

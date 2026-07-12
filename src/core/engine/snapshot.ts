import { z } from "zod";
import type { EngineSnapshot, GameCommand } from "../../shared/types";
import { hashGameState } from "../hash";

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const playerReference = z.number().int().nonnegative();
const optionalTick = z.number().int().nonnegative().optional();

const structureSchema = z
  .object({
    type: z.enum(["farm", "barracks", "turret"]),
    status: z.enum(["constructing", "active", "seized", "repairing"]),
    integrity: z.number().int().min(0).max(1_000),
    progressTicks: nonNegativeInteger,
    seizedTicks: nonNegativeInteger,
    productionPaused: z.boolean(),
  })
  .strict();

const tileSchema = z
  .object({
    id: z.string().min(1),
    q: z.number().int(),
    r: z.number().int(),
    terrain: z.enum(["meadow", "muster", "plains", "forest", "hills", "water"]),
    owner: playerReference.nullable(),
    troops: nonNegativeInteger,
    structure: structureSchema.nullable(),
    controlledSinceTick: z.number().int(),
    lastRewardTick: z.number().int(),
    decorationSeed: nonNegativeInteger,
  })
  .strict();

const mapSchema = z
  .object({
    archetype: z.enum(["heartland", "broken-crown", "highland-basin"]),
    seed: z.string().min(1).max(128),
    width: positiveInteger,
    height: positiveInteger,
    landCount: positiveInteger,
    tiles: z.record(z.string(), tileSchema),
    tileIds: z.array(z.string().min(1)).min(1),
    landIds: z.array(z.string().min(1)).min(1),
    spawnCenters: z.array(z.string().min(1)).min(1),
    spawnClusters: z.array(z.array(z.string().min(1)).min(1)).min(1),
    generationAttempt: nonNegativeInteger,
  })
  .strict();

const playerStatsSchema = z
  .object({
    tilesCaptured: nonNegativeInteger,
    enemiesEliminated: nonNegativeInteger,
    troopsTrained: nonNegativeInteger,
    troopsLost: nonNegativeInteger,
    supplyEarnedMilli: nonNegativeInteger,
    structuresBuilt: nonNegativeInteger,
  })
  .strict();

const playerSchema = z
  .object({
    id: playerReference,
    name: z.string().min(1),
    color: z.number().int().min(0).max(0xffffff),
    accent: z.number().int().min(0).max(0xffffff),
    pattern: nonNegativeInteger,
    supplyMilli: nonNegativeInteger,
    tileCount: nonNegativeInteger,
    troopCount: nonNegativeInteger,
    eliminated: z.boolean(),
    eliminatedBy: playerReference.nullable(),
    isHuman: z.boolean(),
    aiSeed: nonNegativeInteger,
    aiMode: z.string(),
    stats: playerStatsSchema,
  })
  .strict();

const stackSchema = z
  .object({
    id: positiveInteger,
    owner: playerReference,
    troops: positiveInteger,
    path: z.array(z.string().min(1)).min(2),
    pathIndex: nonNegativeInteger,
    segmentProgress: nonNegativeInteger,
    segmentDuration: positiveInteger,
    originId: z.string().min(1),
    destinationId: z.string().min(1),
    lane: z.number().int(),
    issuedTick: nonNegativeInteger,
  })
  .strict();

const waitingSchema = z
  .object({
    owner: playerReference,
    troops: positiveInteger,
    entryFrom: z.string().min(1),
    queuedTick: nonNegativeInteger,
  })
  .strict();

const battleSchema = z
  .object({
    id: positiveInteger,
    tileId: z.string().min(1),
    defender: playerReference.nullable(),
    attacker: playerReference,
    defenderTroops: nonNegativeInteger,
    attackerTroops: positiveInteger,
    control: z.number().int().min(0).max(10_000),
    ageTicks: nonNegativeInteger,
    roundAccumulator: nonNegativeInteger,
    entryFrom: z.string().min(1),
    waiting: z.array(waitingSchema),
    lastReinforcementTick: z.number().int(),
    reinforcementSide: z.enum(["attacker", "defender"]).nullable(),
    reinforcementAmount: nonNegativeInteger,
  })
  .strict();

const eventSchema = z
  .object({
    id: positiveInteger,
    tick: nonNegativeInteger,
    type: z.enum([
      "order",
      "route-interrupted",
      "battle-started",
      "reinforcement",
      "capture",
      "reward",
      "construction-started",
      "construction-complete",
      "structure-seized",
      "elimination",
      "victory-countdown",
      "victory",
    ]),
    playerId: playerReference.optional(),
    tileId: z.string().min(1).optional(),
    amount: z.number().int().optional(),
    message: z.string(),
  })
  .strict();

const configSchema = z
  .object({
    seed: z.string().min(1).max(128),
    archetype: z.enum(["heartland", "broken-crown", "highland-basin"]),
    aiCount: z.number().int().min(0).max(20),
    difficulty: z.enum(["easy", "normal", "hard"]),
    playerName: z.string(),
    graphics: z.enum(["low", "medium", "high"]),
    sound: z.boolean(),
    colorPatterns: z.boolean(),
    fullCounts: z.boolean().optional(),
    debug: z.boolean(),
    multiplayer: z.boolean().optional(),
    humanSeats: z.array(playerReference).optional(),
    playerNames: z.array(z.string()).optional(),
    localPlayerId: playerReference.optional(),
  })
  .strict();

const commandSchema: z.ZodType<GameCommand> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      playerId: playerReference,
      sourceId: z.string().min(1),
      destinationId: z.string().min(1),
      percent: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("build"),
      playerId: playerReference,
      tileId: z.string().min(1),
      structure: z.enum(["farm", "barracks", "turret"]),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("cancel-build"),
      playerId: playerReference,
      tileId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("toggle-barracks"),
      playerId: playerReference,
      tileId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
]);

const gameStateSchema = z
  .object({
    version: z.literal(1),
    config: configSchema,
    tick: nonNegativeInteger,
    map: mapSchema,
    players: z.array(playerSchema).min(2).max(21),
    stacks: z.array(stackSchema),
    battles: z.array(battleSchema),
    events: z.array(eventSchema),
    nextEntityId: positiveInteger,
    victory: z
      .object({
        leaderId: playerReference.nullable(),
        holdTicks: nonNegativeInteger,
        winnerId: playerReference.nullable(),
        reason: z.enum(["control", "sole-survivor"]).nullable(),
      })
      .strict(),
    stateHash: z.string().regex(/^[0-9a-f]{16}$/),
    paused: z.boolean(),
  })
  .strict();

const snapshotSchema = z
  .object({
    state: gameStateSchema,
    commandHistory: z.array(commandSchema),
    pendingCommands: z.array(commandSchema).optional(),
  })
  .strict();

export class SnapshotValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new SnapshotValidationError(`Invalid engine snapshot at ${path}: ${message}`);
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "contains duplicate IDs");
}

function validateReferences(snapshot: EngineSnapshot): void {
  const { state } = snapshot;
  const { map, players } = state;
  const tileIds = new Set(map.tileIds);
  const landIds = new Set(map.landIds);
  unique(map.tileIds, "state.map.tileIds");
  unique(map.landIds, "state.map.landIds");
  if (map.landCount !== map.landIds.length) {
    fail("state.map.landCount", "does not match landIds length");
  }
  const tileRecordIds = Object.keys(map.tiles);
  if (tileRecordIds.length !== map.tileIds.length || tileRecordIds.some((id) => !tileIds.has(id))) {
    fail("state.map.tiles", "does not exactly match tileIds");
  }
  for (const id of map.tileIds) {
    const tile = map.tiles[id];
    if (!tile || tile.id !== id) fail(`state.map.tiles.${id}`, "tile ID does not match its key");
    if (tile.owner !== null && !players[tile.owner]) {
      fail(`state.map.tiles.${id}.owner`, "references a missing player");
    }
    if (landIds.has(id) !== (tile.terrain !== "water")) {
      fail(`state.map.tiles.${id}.terrain`, "does not agree with landIds membership");
    }
  }
  for (const id of map.landIds) {
    if (!tileIds.has(id)) fail("state.map.landIds", `references missing tile ${id}`);
  }
  for (const [index, player] of players.entries()) {
    if (player.id !== index) fail(`state.players.${index}.id`, "must match its array index");
    if (player.eliminatedBy !== null && !players[player.eliminatedBy]) {
      fail(`state.players.${index}.eliminatedBy`, "references a missing player");
    }
  }

  const configPlayers = state.config.multiplayer
    ? (state.config.humanSeats?.length ?? 0) + state.config.aiCount
    : state.config.aiCount + 1;
  if (configPlayers !== players.length) {
    fail("state.config.aiCount", "participant count does not match players");
  }
  const humanSeats = state.config.multiplayer ? (state.config.humanSeats ?? []) : [0];
  if (state.config.multiplayer) {
    if (humanSeats.length < 2 || humanSeats.length > 8) {
      fail("state.config.humanSeats", "must contain between 2 and 8 multiplayer seats");
    }
  } else if (state.config.aiCount < 3) {
    fail("state.config.aiCount", "single-player snapshots require at least 3 AI opponents");
  }
  if (new Set(humanSeats).size !== humanSeats.length) {
    fail("state.config.humanSeats", "contains duplicate seats");
  }
  const humanSeatSet = new Set(humanSeats);
  for (const [index, player] of players.entries()) {
    if (humanSeatSet.has(index) !== player.isHuman) {
      fail(`state.players.${index}.isHuman`, "does not agree with configured human seats");
    }
  }
  if (state.config.localPlayerId !== undefined && !players[state.config.localPlayerId]) {
    fail("state.config.localPlayerId", "references a missing player");
  }
  for (const [index, id] of map.spawnCenters.entries()) {
    if (!landIds.has(id)) fail(`state.map.spawnCenters.${index}`, "references non-land tile");
  }
  if (map.spawnCenters.length !== players.length || map.spawnClusters.length !== players.length) {
    fail("state.map.spawnCenters", "spawn allocation does not match participant count");
  }
  for (const [clusterIndex, cluster] of map.spawnClusters.entries()) {
    for (const [index, id] of cluster.entries()) {
      if (!landIds.has(id)) {
        fail(`state.map.spawnClusters.${clusterIndex}.${index}`, "references non-land tile");
      }
    }
  }

  const entityIds = new Set<number>();
  const recordEntity = (id: number, path: string): void => {
    if (entityIds.has(id)) fail(path, "duplicates an active entity ID");
    entityIds.add(id);
    if (id >= state.nextEntityId) fail(path, "must be lower than nextEntityId");
  };
  for (const [index, stack] of state.stacks.entries()) {
    recordEntity(stack.id, `state.stacks.${index}.id`);
    if (!players[stack.owner]) fail(`state.stacks.${index}.owner`, "references a missing player");
    if (stack.pathIndex >= stack.path.length) {
      fail(`state.stacks.${index}.pathIndex`, "is outside the stack path");
    }
    for (const [pathIndex, id] of stack.path.entries()) {
      if (!landIds.has(id))
        fail(`state.stacks.${index}.path.${pathIndex}`, "references non-land tile");
    }
    if (!landIds.has(stack.originId) || !landIds.has(stack.destinationId)) {
      fail(`state.stacks.${index}`, "origin or destination references non-land tile");
    }
    if (stack.path.at(-1) !== stack.destinationId) {
      fail(`state.stacks.${index}.destinationId`, "does not match the final path tile");
    }
  }
  for (const [index, battle] of state.battles.entries()) {
    recordEntity(battle.id, `state.battles.${index}.id`);
    if (!landIds.has(battle.tileId) || !landIds.has(battle.entryFrom)) {
      fail(`state.battles.${index}`, "tile or entry point references non-land tile");
    }
    if (!players[battle.attacker]) {
      fail(`state.battles.${index}.attacker`, "references a missing player");
    }
    if (battle.defender !== null && !players[battle.defender]) {
      fail(`state.battles.${index}.defender`, "references a missing player");
    }
    for (const [waitingIndex, waiting] of battle.waiting.entries()) {
      if (!players[waiting.owner] || !landIds.has(waiting.entryFrom)) {
        fail(`state.battles.${index}.waiting.${waitingIndex}`, "contains an invalid reference");
      }
    }
  }
  for (const [index, event] of state.events.entries()) {
    recordEntity(event.id, `state.events.${index}.id`);
    if (event.playerId !== undefined && !players[event.playerId]) {
      fail(`state.events.${index}.playerId`, "references a missing player");
    }
    if (event.tileId !== undefined && !tileIds.has(event.tileId)) {
      fail(`state.events.${index}.tileId`, "references a missing tile");
    }
  }
  for (const [key, playerId] of [
    ["leaderId", state.victory.leaderId],
    ["winnerId", state.victory.winnerId],
  ] as const) {
    if (playerId !== null && !players[playerId]) {
      fail(`state.victory.${key}`, "references a missing player");
    }
  }
  if ((state.victory.winnerId === null) !== (state.victory.reason === null)) {
    fail("state.victory.reason", "must be present exactly when winnerId is present");
  }

  const validateCommandReferences = (command: GameCommand, path: string): void => {
    if (!players[command.playerId]) fail(`${path}.playerId`, "references a missing player");
    if (command.type === "move") {
      if (!landIds.has(command.sourceId) || !landIds.has(command.destinationId)) {
        fail(path, "move references a non-land tile");
      }
    } else if (!landIds.has(command.tileId)) {
      fail(path, "building command references a non-land tile");
    }
  };
  snapshot.commandHistory.forEach((command, index) =>
    validateCommandReferences(command, `commandHistory.${index}`),
  );
  snapshot.pendingCommands?.forEach((command, index) =>
    validateCommandReferences(command, `pendingCommands.${index}`),
  );
  if (hashGameState(state) !== state.stateHash) {
    fail("state.stateHash", "does not match the deterministic state payload");
  }
}

/** Parse and cross-check untrusted local-save or network checkpoint data. */
export function parseEngineSnapshot(value: unknown): EngineSnapshot {
  const version =
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    typeof value.state === "object" &&
    value.state !== null &&
    "version" in value.state
      ? value.state.version
      : undefined;
  if (version !== 1) throw new SnapshotValidationError("Unsupported snapshot version");

  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "root";
    throw new SnapshotValidationError(
      `Invalid engine snapshot at ${path}: ${issue?.message ?? "malformed data"}`,
    );
  }
  const snapshot = parsed.data as EngineSnapshot;
  validateReferences(snapshot);
  return snapshot;
}

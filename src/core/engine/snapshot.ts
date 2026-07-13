import { z } from "zod";
import { BALANCE } from "../../shared/balance";
import type { EngineSnapshot, GameCommand, GameState, UnitCounts } from "../../shared/types";
import { hashGameState, stableHash } from "../hash";
import { axialKey, distance, neighbors, parseAxialKey } from "../hex";
import { isEligibleSpawnCenter } from "../map";
import { UNIT_TYPES, totalUnits, unitsContainedBy, unitsOf, unitTypeForStructure } from "../units";

const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const playerReference = z.number().int().min(0).max(20);
const optionalTick = nonNegativeInteger.optional();
const sendPercentSchema = z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]);
const terrainSchema = z.enum(["meadow", "muster", "plains", "forest", "hills", "water"]);
const v2StructureTypeSchema = z.enum(["farm", "barracks", "turret"]);
const structureTypeSchema = z.enum(["barracks", "archery-range", "wizard-tower"]);
const unitCountsSchema = z
  .object({
    melee: nonNegativeInteger,
    ranged: nonNegativeInteger,
    wizard: nonNegativeInteger,
  })
  .strict();
const casualtyRemainderSchema = z
  .object({
    melee: z.number().int().min(0).max(999),
    ranged: z.number().int().min(0).max(999),
    wizard: z.number().int().min(0).max(999),
  })
  .strict();
const combatRoundAccumulatorSchema = z
  .number()
  .int()
  .min(0)
  .max(BALANCE.combatRoundTicks - 1);
const positiveUnitCountsSchema = unitCountsSchema.refine((units) => totalUnits(units) > 0, {
  message: "must contain at least one unit",
});

const configFields = {
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
} as const;

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

const v2StackSchema = z
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

const victorySchema = z
  .object({
    leaderId: playerReference.nullable(),
    holdTicks: nonNegativeInteger,
    winnerId: playerReference.nullable(),
    reason: z.enum(["control", "sole-survivor"]).nullable(),
  })
  .strict();

const legacyStructureSchema = z
  .object({
    type: v2StructureTypeSchema,
    status: z.enum(["constructing", "active", "seized", "repairing"]),
    integrity: z.number().int().min(0).max(1_000),
    progressTicks: nonNegativeInteger,
    seizedTicks: nonNegativeInteger,
    productionPaused: z.boolean(),
  })
  .strict();

const legacyTileSchema = z
  .object({
    id: z.string().min(1),
    q: z.number().int(),
    r: z.number().int(),
    terrain: terrainSchema,
    owner: playerReference.nullable(),
    troops: nonNegativeInteger,
    structure: legacyStructureSchema.nullable(),
    controlledSinceTick: z.number().int(),
    lastRewardTick: z.number().int(),
    decorationSeed: nonNegativeInteger,
  })
  .strict();

const mapFields = <T extends z.ZodTypeAny>(tile: T) => ({
  archetype: z.enum(["heartland", "broken-crown", "highland-basin"]),
  seed: z.string().min(1).max(128),
  width: positiveInteger,
  height: positiveInteger,
  landCount: positiveInteger,
  tiles: z.record(z.string(), tile),
  tileIds: z.array(z.string().min(1)).min(1),
  landIds: z.array(z.string().min(1)).min(1),
  spawnCenters: z.array(z.string().min(1)),
  spawnClusters: z.array(z.array(z.string().min(1)).min(1)),
  generationAttempt: nonNegativeInteger,
});

const legacyWaitingSchema = z
  .object({
    owner: playerReference,
    troops: positiveInteger,
    entryFrom: z.string().min(1),
    queuedTick: nonNegativeInteger,
  })
  .strict();

const legacyBattleSchema = z
  .object({
    id: positiveInteger,
    tileId: z.string().min(1),
    defender: playerReference.nullable(),
    attacker: playerReference,
    defenderTroops: nonNegativeInteger,
    attackerTroops: positiveInteger,
    control: z.number().int().min(0).max(10_000),
    ageTicks: nonNegativeInteger,
    roundAccumulator: combatRoundAccumulatorSchema,
    entryFrom: z.string().min(1),
    waiting: z.array(legacyWaitingSchema),
    lastReinforcementTick: z.number().int().min(-1),
    reinforcementSide: z.enum(["attacker", "defender"]).nullable(),
    reinforcementAmount: nonNegativeInteger,
  })
  .strict();

const legacyEventSchema = z
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

const legacyCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("move"),
      playerId: playerReference,
      sourceId: z.string().min(1),
      destinationId: z.string().min(1),
      percent: sendPercentSchema,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("build"),
      playerId: playerReference,
      tileId: z.string().min(1),
      structure: v2StructureTypeSchema,
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

const legacyStateSchema = z
  .object({
    version: z.literal(1),
    config: z.object(configFields).strict(),
    tick: nonNegativeInteger,
    map: z.object(mapFields(legacyTileSchema)).strict(),
    players: z.array(playerSchema).min(2).max(21),
    stacks: z.array(v2StackSchema),
    battles: z.array(legacyBattleSchema),
    events: z.array(legacyEventSchema),
    nextEntityId: positiveInteger,
    victory: victorySchema,
    stateHash: z.string().regex(/^[0-9a-f]{16}$/),
    paused: z.boolean(),
  })
  .strict();

const legacySnapshotSchema = z
  .object({
    state: legacyStateSchema,
    commandHistory: z.array(legacyCommandSchema),
    pendingCommands: z.array(legacyCommandSchema).optional(),
  })
  .strict();

type LegacySnapshot = z.infer<typeof legacySnapshotSchema>;
type LegacyStructure = z.infer<typeof legacyStructureSchema>;
type LegacyBattle = z.infer<typeof legacyBattleSchema>;

const v2StructureSchema = z
  .object({
    type: v2StructureTypeSchema,
    completedCount: z.number().int().min(0).max(BALANCE.maxStructureCount),
    status: z.enum(["active", "seized", "repairing"]).nullable(),
    integrity: z.number().int().min(0).max(BALANCE.fullIntegrity),
    pendingProgressTicks: nonNegativeInteger.nullable(),
    seizedTicks: nonNegativeInteger,
    productionPaused: z.boolean(),
    barracksProgressMilli: nonNegativeInteger,
    rallyTargetId: z.string().min(1).nullable(),
    rallyQueuedTroops: nonNegativeInteger,
    turretShotProgressMilli: nonNegativeInteger,
  })
  .strict();

const v2TileSchema = z
  .object({
    id: z.string().min(1),
    q: z.number().int(),
    r: z.number().int(),
    terrain: terrainSchema,
    owner: playerReference.nullable(),
    troops: nonNegativeInteger,
    structure: v2StructureSchema.nullable(),
    controlledSinceTick: z.number().int(),
    lastRewardTick: z.number().int(),
    decorationSeed: nonNegativeInteger,
  })
  .strict();

const v2ParticipantSchema = z
  .object({
    playerId: playerReference.nullable(),
    troops: nonNegativeInteger,
    control: z.number().int().min(0).max(10_000),
    casualtyProgressMilli: z.number().int().min(0).max(999),
    entryFrom: z.string().min(1),
    joinedTick: nonNegativeInteger,
    lastReinforcementTick: z.number().int().min(-1),
    reinforcementAmount: nonNegativeInteger,
  })
  .strict();

const v2BattleSchema = z
  .object({
    id: positiveInteger,
    tileId: z.string().min(1),
    incumbentOwner: playerReference.nullable(),
    participants: z.array(v2ParticipantSchema).min(1).max(22),
    ageTicks: nonNegativeInteger,
    roundAccumulator: combatRoundAccumulatorSchema,
  })
  .strict();

const enclosureSchema = z
  .object({
    id: positiveInteger,
    captorId: playerReference,
    tileIds: z.array(z.string().min(1)).min(1),
    boundaryIds: z.array(z.string().min(1)).min(1),
    progressTicks: z
      .number()
      .int()
      .min(1)
      .max(BALANCE.encirclementTicks - 1),
  })
  .strict();

const v2EventTypes = [
  "order",
  "route-interrupted",
  "battle-started",
  "reinforcement",
  "capture",
  "reward",
  "construction-started",
  "construction-complete",
  "structure-seized",
  "spawn-selected",
  "spawn-locked",
  "placement-complete",
  "rally-set",
  "rally-cleared",
  "turret-volley",
  "encirclement-started",
  "encirclement-complete",
  "elimination",
  "victory-countdown",
  "victory",
] as const;

const v2EventSchema = z
  .object({
    id: positiveInteger,
    tick: nonNegativeInteger,
    type: z.enum(v2EventTypes),
    playerId: playerReference.optional(),
    tileId: z.string().min(1).optional(),
    tileIds: z.array(z.string().min(1)).optional(),
    sourceTileId: z.string().min(1).optional(),
    amount: z.number().int().optional(),
    message: z.string(),
  })
  .strict();

const v2GameCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("choose-spawn"),
      playerId: playerReference,
      centerId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("lock-spawn"),
      playerId: playerReference,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      playerId: playerReference,
      sourceId: z.string().min(1),
      destinationId: z.string().min(1),
      percent: sendPercentSchema,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("multi-move"),
      playerId: playerReference,
      sourceIds: z.array(z.string().min(1)).min(1).max(BALANCE.maxMultiMoveSources),
      destinationIds: z.array(z.string().min(1)).min(1).max(BALANCE.maxMultiMoveDestinations),
      percent: sendPercentSchema,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("build"),
      playerId: playerReference,
      tileId: z.string().min(1),
      structure: v2StructureTypeSchema,
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
  z
    .object({
      type: z.literal("set-rally"),
      playerId: playerReference,
      tileId: z.string().min(1),
      destinationId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("clear-rally"),
      playerId: playerReference,
      tileId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
]);

const placementSchema = z
  .object({
    elapsedTicks: nonNegativeInteger,
    maxTicks: nonNegativeInteger.nullable(),
    placements: z.array(
      z
        .object({
          playerId: playerReference,
          centerId: z.string().min(1).nullable(),
          locked: z.boolean(),
          relocationCount: nonNegativeInteger,
          aiTargetRelocations: nonNegativeInteger,
          nextAiActionTick: nonNegativeInteger.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const v2StateSchema = z
  .object({
    version: z.literal(2),
    config: z
      .object({ ...configFields, startingCenters: z.array(z.string().min(1)).optional() })
      .strict(),
    phase: z.enum(["placement", "opening", "running", "complete"]),
    placement: placementSchema,
    tick: nonNegativeInteger,
    map: z.object(mapFields(v2TileSchema)).strict(),
    players: z.array(playerSchema).min(2).max(21),
    stacks: z.array(v2StackSchema),
    battles: z.array(v2BattleSchema),
    enclosures: z.array(enclosureSchema),
    events: z.array(v2EventSchema),
    nextEntityId: positiveInteger,
    victory: victorySchema,
    stateHash: z.string().regex(/^[0-9a-f]{16}$/),
    paused: z.boolean(),
  })
  .strict();

const v2SnapshotSchema = z
  .object({
    state: v2StateSchema,
    commandHistory: z.array(v2GameCommandSchema),
    pendingCommands: z.array(v2GameCommandSchema).optional(),
  })
  .strict();

type V2Snapshot = z.infer<typeof v2SnapshotSchema>;
type V2Structure = z.infer<typeof v2StructureSchema>;
type V2Battle = z.infer<typeof v2BattleSchema>;
type V2Participant = V2Battle["participants"][number];
type V2Command = z.infer<typeof v2GameCommandSchema>;
type CurrentStructure = NonNullable<GameState["map"]["tiles"][string]["structure"]>;

const structureSchema = z
  .object({
    type: structureTypeSchema,
    completedCount: z.number().int().min(0).max(BALANCE.maxStructureCount),
    status: z.enum(["active", "seized", "repairing"]).nullable(),
    integrity: z.number().int().min(0).max(BALANCE.fullIntegrity),
    pendingProgressTicks: nonNegativeInteger.nullable(),
    seizedTicks: nonNegativeInteger,
    productionPaused: z.boolean(),
    trainingProgressMilli: nonNegativeInteger,
    rallyTargetId: z.string().min(1).nullable(),
    rallyQueuedUnits: unitCountsSchema,
  })
  .strict();

const tileSchema = z
  .object({
    id: z.string().min(1),
    q: z.number().int(),
    r: z.number().int(),
    terrain: terrainSchema,
    owner: playerReference.nullable(),
    units: unitCountsSchema,
    structure: structureSchema.nullable(),
    controlledSinceTick: z.number().int(),
    lastRewardTick: z.number().int(),
    decorationSeed: nonNegativeInteger,
  })
  .strict();

const stackSchema = z
  .object({
    id: positiveInteger,
    owner: playerReference,
    units: positiveUnitCountsSchema,
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

const participantSchema = z
  .object({
    playerId: playerReference.nullable(),
    units: unitCountsSchema,
    control: z.number().int().min(0).max(10_000),
    casualtyProgressMilli: casualtyRemainderSchema,
    entryFrom: z.string().min(1),
    joinedTick: nonNegativeInteger,
    lastReinforcementTick: z.number().int().min(-1),
    reinforcementAmount: nonNegativeInteger,
  })
  .strict();

const battleSchema = z
  .object({
    id: positiveInteger,
    tileId: z.string().min(1),
    incumbentOwner: playerReference.nullable(),
    participants: z.array(participantSchema).min(1).max(22),
    ageTicks: nonNegativeInteger,
    roundAccumulator: combatRoundAccumulatorSchema,
  })
  .strict();

const eventTypes = [...v2EventTypes, "typed-support"] as const;
const eventSchema = z
  .object({
    id: positiveInteger,
    tick: nonNegativeInteger,
    type: z.enum(eventTypes),
    playerId: playerReference.optional(),
    tileId: z.string().min(1).optional(),
    tileIds: z.array(z.string().min(1)).optional(),
    sourceTileId: z.string().min(1).optional(),
    amount: z.number().int().optional(),
    message: z.string(),
  })
  .strict();

export const gameCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("choose-spawn"),
      playerId: playerReference,
      centerId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("lock-spawn"),
      playerId: playerReference,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      playerId: playerReference,
      sourceId: z.string().min(1),
      destinationId: z.string().min(1),
      percent: sendPercentSchema,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("multi-move"),
      playerId: playerReference,
      sourceIds: z.array(z.string().min(1)).min(1).max(BALANCE.maxMultiMoveSources),
      destinationIds: z.array(z.string().min(1)).min(1).max(BALANCE.maxMultiMoveDestinations),
      percent: sendPercentSchema,
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("build"),
      playerId: playerReference,
      tileId: z.string().min(1),
      structure: structureTypeSchema,
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
      type: z.literal("toggle-production"),
      playerId: playerReference,
      tileId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("set-rally"),
      playerId: playerReference,
      tileId: z.string().min(1),
      destinationId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
  z
    .object({
      type: z.literal("clear-rally"),
      playerId: playerReference,
      tileId: z.string().min(1),
      scheduledTick: optionalTick,
    })
    .strict(),
]);

const stateSchema = z
  .object({
    version: z.literal(3),
    config: z
      .object({ ...configFields, startingCenters: z.array(z.string().min(1)).optional() })
      .strict(),
    phase: z.enum(["placement", "opening", "running", "complete"]),
    placement: placementSchema,
    tick: nonNegativeInteger,
    map: z.object(mapFields(tileSchema)).strict(),
    players: z.array(playerSchema).min(2).max(21),
    stacks: z.array(stackSchema),
    battles: z.array(battleSchema),
    enclosures: z.array(enclosureSchema),
    events: z.array(eventSchema),
    nextEntityId: positiveInteger,
    victory: victorySchema,
    stateHash: z.string().regex(/^[0-9a-f]{16}$/),
    paused: z.boolean(),
  })
  .strict();

const snapshotSchema = z
  .object({
    state: stateSchema,
    commandHistory: z.array(gameCommandSchema),
    pendingCommands: z.array(gameCommandSchema).optional(),
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

function compareAxialIds(left: string, right: string): number {
  const a = parseAxialKey(left);
  const b = parseAxialKey(right);
  return a.q - b.q || a.r - b.r;
}

function structureTiming(type: CurrentStructure["type"]): {
  buildTicks: number;
  trainTicks: number;
} {
  if (type === "barracks") return BALANCE.barracks;
  if (type === "archery-range") return BALANCE.archeryRange;
  return BALANCE.wizardTower;
}

function validateReferences(snapshot: EngineSnapshot): void {
  const { state } = snapshot;
  const { map, players } = state;
  const tileIds = new Set(map.tileIds);
  const landIds = new Set(map.landIds);
  unique(map.tileIds, "state.map.tileIds");
  unique(map.landIds, "state.map.landIds");
  if (map.landCount !== map.landIds.length) fail("state.map.landCount", "does not match landIds");
  if (
    Object.keys(map.tiles).length !== map.tileIds.length ||
    map.tileIds.some((id) => !map.tiles[id])
  ) {
    fail("state.map.tiles", "does not exactly match tileIds");
  }
  if (map.landIds.some((id) => !tileIds.has(id))) {
    fail("state.map.landIds", "references a tile missing from tileIds");
  }
  for (const id of map.tileIds) {
    const tile = map.tiles[id]!;
    if (tile.id !== id) fail(`state.map.tiles.${id}`, "tile ID does not match key");
    if (axialKey(tile) !== id) fail(`state.map.tiles.${id}`, "coordinates do not match tile ID");
    if (tile.owner !== null && !players[tile.owner])
      fail(`state.map.tiles.${id}.owner`, "missing player");
    if (landIds.has(id) !== (tile.terrain !== "water"))
      fail(`state.map.tiles.${id}.terrain`, "land mismatch");
    const structure = tile.structure;
    if (!structure) continue;
    const timing = structureTiming(structure.type);
    if (
      structure.pendingProgressTicks !== null &&
      structure.pendingProgressTicks >= timing.buildTicks
    )
      fail(
        `state.map.tiles.${id}.structure.pendingProgressTicks`,
        "must remain below the build duration",
      );
    if (structure.trainingProgressMilli > timing.trainTicks * BALANCE.fullIntegrity)
      fail(`state.map.tiles.${id}.structure.trainingProgressMilli`, "exceeds one production cycle");
    const seizedTickLimit =
      structure.status === "seized"
        ? BALANCE.seizedTicks
        : structure.status === "repairing"
          ? BALANCE.repairTicks
          : 0;
    if (
      (seizedTickLimit === 0 && structure.seizedTicks !== 0) ||
      (seizedTickLimit > 0 && structure.seizedTicks >= seizedTickLimit)
    )
      fail(`state.map.tiles.${id}.structure.seizedTicks`, "does not match the structure phase");
    if (structure.completedCount === 0) {
      if (
        structure.status !== null ||
        structure.pendingProgressTicks === null ||
        structure.integrity !== 0
      ) {
        fail(
          `state.map.tiles.${id}.structure`,
          "empty stack must contain only a pending first copy",
        );
      }
    } else if (structure.status === null) {
      fail(`state.map.tiles.${id}.structure.status`, "completed stack requires status");
    }
    if (
      structure.completedCount + Number(structure.pendingProgressTicks !== null) >
      BALANCE.maxStructureCount
    ) {
      fail(`state.map.tiles.${id}.structure`, "exceeds stack cap");
    }
    if (structure.type === "archery-range" && tile.terrain !== "meadow")
      fail(`state.map.tiles.${id}.structure`, "Archery Range terrain mismatch");
    if (structure.type === "barracks" && tile.terrain !== "muster")
      fail(`state.map.tiles.${id}.structure`, "Barracks terrain mismatch");
    if (!unitsContainedBy(structure.rallyQueuedUnits, tile.units))
      fail(`state.map.tiles.${id}.structure.rallyQueuedUnits`, "exceeds retained local units");
    const producedType = unitTypeForStructure(structure.type);
    if (structure.rallyQueuedUnits[producedType] !== totalUnits(structure.rallyQueuedUnits))
      fail(
        `state.map.tiles.${id}.structure.rallyQueuedUnits`,
        "contains units from another producer type",
      );
    if (totalUnits(structure.rallyQueuedUnits) > 0 && structure.rallyTargetId === null)
      fail(`state.map.tiles.${id}.structure.rallyQueuedUnits`, "requires a rally target");
    if (structure.status === "seized" && totalUnits(structure.rallyQueuedUnits) !== 0)
      fail(
        `state.map.tiles.${id}.structure.rallyQueuedUnits`,
        "seized structure cannot queue units",
      );
    if (structure.rallyTargetId !== null && !landIds.has(structure.rallyTargetId))
      fail(`state.map.tiles.${id}.structure.rallyTargetId`, "references non-land");
  }
  players.forEach((player, index) => {
    if (player.id !== index) fail(`state.players.${index}.id`, "must equal array index");
    if (player.eliminatedBy !== null && !players[player.eliminatedBy])
      fail(`state.players.${index}.eliminatedBy`, "missing player");
  });
  const aggregateUnits = players.map(() => 0);
  for (const id of map.landIds) {
    const tile = map.tiles[id]!;
    if (tile.owner !== null) aggregateUnits[tile.owner]! += totalUnits(tile.units);
  }
  for (const stack of state.stacks) aggregateUnits[stack.owner]! += totalUnits(stack.units);
  for (const battle of state.battles)
    for (const participant of battle.participants)
      if (participant.playerId !== null)
        aggregateUnits[participant.playerId]! += totalUnits(participant.units);
  players.forEach((player, index) => {
    if (player.troopCount !== aggregateUnits[index])
      fail(`state.players.${index}.troopCount`, "does not match authoritative unit totals");
  });
  const humanSeats = state.config.multiplayer ? (state.config.humanSeats ?? []) : [0];
  const expectedPlayers = (state.config.multiplayer ? humanSeats.length : 1) + state.config.aiCount;
  if (expectedPlayers !== players.length)
    fail("state.config.aiCount", "participant count mismatch");
  unique(humanSeats.map(String), "state.config.humanSeats");
  if (humanSeats.some((seat) => !players[seat])) {
    fail("state.config.humanSeats", "references a missing player");
  }
  if (state.config.localPlayerId !== undefined && !players[state.config.localPlayerId]) {
    fail("state.config.localPlayerId", "references a missing player");
  }
  players.forEach((player, index) => {
    if (humanSeats.includes(index) !== player.isHuman)
      fail(`state.players.${index}.isHuman`, "human seat mismatch");
  });
  if (state.placement.placements.length !== players.length)
    fail("state.placement.placements", "participant count mismatch");
  state.placement.placements.forEach((placement, index) => {
    if (placement.playerId !== index)
      fail(`state.placement.placements.${index}.playerId`, "must equal index");
    if (placement.locked && placement.centerId === null)
      fail(`state.placement.placements.${index}`, "locked without center");
    if (
      placement.centerId &&
      (state.phase === "placement"
        ? !isEligibleSpawnCenter(map, placement.centerId)
        : !landIds.has(placement.centerId))
    ) {
      fail(`state.placement.placements.${index}.centerId`, "ineligible center");
    }
  });
  const provisional = state.placement.placements.filter((entry) => entry.centerId !== null);
  for (let left = 0; left < provisional.length; left += 1)
    for (let right = left + 1; right < provisional.length; right += 1) {
      if (
        distance(
          parseAxialKey(provisional[left]!.centerId!),
          parseAxialKey(provisional[right]!.centerId!),
        ) < BALANCE.minimumSpawnDistance
      )
        fail("state.placement.placements", "centers conflict");
    }
  if (state.phase === "placement") {
    if (state.tick !== 0 || map.spawnCenters.length || map.spawnClusters.length)
      fail("state.phase", "placement must retain neutral tick-zero map");
    if (
      map.landIds.some((id) => map.tiles[id]!.owner !== null || map.tiles[id]!.structure !== null)
    ) {
      fail("state.phase", "placement map must remain neutral");
    }
  } else {
    if (map.spawnCenters.length !== players.length || map.spawnClusters.length !== players.length)
      fail("state.map.spawnCenters", "final allocation mismatch");
    unique(map.spawnCenters, "state.map.spawnCenters");
    map.spawnCenters.forEach((centerId, index) => {
      if (!landIds.has(centerId)) fail(`state.map.spawnCenters.${index}`, "references non-land");
      const cluster = map.spawnClusters[index]!;
      if (cluster.length !== BALANCE.startingTiles || new Set(cluster).size !== cluster.length)
        fail(`state.map.spawnClusters.${index}`, "must be a unique seven-hex package");
      const expected = new Set([centerId, ...neighbors(parseAxialKey(centerId)).map(axialKey)]);
      if (cluster.some((id) => !landIds.has(id) || !expected.has(id)))
        fail(`state.map.spawnClusters.${index}`, "does not match center plus neighbors");
    });
    if (
      !state.config.startingCenters ||
      state.config.startingCenters.length !== players.length ||
      state.config.startingCenters.some((id, index) => id !== map.spawnCenters[index])
    ) {
      fail("state.config.startingCenters", "does not match map allocation");
    }
  }
  const entityIds = new Set<number>();
  const recordEntity = (id: number, path: string): void => {
    if (entityIds.has(id)) fail(path, "duplicates active entity ID");
    entityIds.add(id);
    if (id >= state.nextEntityId) fail(path, "must be below nextEntityId");
  };
  state.stacks.forEach((stack, index) => {
    recordEntity(stack.id, `state.stacks.${index}.id`);
    if (
      !players[stack.owner] ||
      stack.pathIndex >= stack.path.length ||
      stack.path.some((id) => !landIds.has(id))
    )
      fail(`state.stacks.${index}`, "invalid reference");
    if (stack.path.at(-1) !== stack.destinationId)
      fail(`state.stacks.${index}.destinationId`, "path mismatch");
  });
  state.battles.forEach((battle, index) => {
    recordEntity(battle.id, `state.battles.${index}.id`);
    if (!landIds.has(battle.tileId) || map.tiles[battle.tileId]!.owner !== battle.incumbentOwner)
      fail(`state.battles.${index}`, "incumbent mismatch");
    const keys = battle.participants.map((participant) => participant.playerId);
    if (new Set(keys.map((id) => (id === null ? "neutral" : `p${id}`))).size !== keys.length)
      fail(`state.battles.${index}.participants`, "duplicate factions");
    const sorted = [...battle.participants].sort((a, b) =>
      a.playerId === null ? -1 : b.playerId === null ? 1 : a.playerId - b.playerId,
    );
    if (
      sorted.some(
        (participant, participantIndex) =>
          participant.playerId !== battle.participants[participantIndex]!.playerId,
      )
    )
      fail(`state.battles.${index}.participants`, "not canonical");
    battle.participants.forEach((participant, participantIndex) => {
      if (participant.playerId === null && battle.incumbentOwner !== null) {
        fail(
          `state.battles.${index}.participants.${participantIndex}.playerId`,
          "neutral participant requires neutral incumbent",
        );
      }
      if (participant.playerId !== null && !players[participant.playerId])
        fail(`state.battles.${index}.participants.${participantIndex}.playerId`, "missing player");
      if (!landIds.has(participant.entryFrom) || participant.joinedTick > state.tick)
        fail(`state.battles.${index}.participants.${participantIndex}`, "invalid entry/join tick");
    });
  });
  state.enclosures.forEach((enclosure, index) => {
    recordEntity(enclosure.id, `state.enclosures.${index}.id`);
    if (!players[enclosure.captorId] || players[enclosure.captorId]!.eliminated)
      fail(`state.enclosures.${index}.captorId`, "invalid captor");
    unique(enclosure.tileIds, `state.enclosures.${index}.tileIds`);
    unique(enclosure.boundaryIds, `state.enclosures.${index}.boundaryIds`);
    if (
      enclosure.tileIds.some(
        (id) => !landIds.has(id) || map.tiles[id]!.owner === enclosure.captorId,
      )
    )
      fail(`state.enclosures.${index}.tileIds`, "invalid pocket");
    if (
      enclosure.boundaryIds.some(
        (id) => !landIds.has(id) || map.tiles[id]!.owner !== enclosure.captorId,
      )
    )
      fail(`state.enclosures.${index}.boundaryIds`, "invalid boundary");
    if ([...enclosure.tileIds].sort(compareAxialIds).some((id, i) => id !== enclosure.tileIds[i]))
      fail(`state.enclosures.${index}.tileIds`, "not canonical");
    if (
      [...enclosure.boundaryIds]
        .sort(compareAxialIds)
        .some((id, i) => id !== enclosure.boundaryIds[i])
    )
      fail(`state.enclosures.${index}.boundaryIds`, "not canonical");
  });
  for (let index = 1; index < state.enclosures.length; index += 1) {
    const previous = state.enclosures[index - 1]!;
    const current = state.enclosures[index]!;
    const comparison =
      previous.captorId - current.captorId ||
      compareAxialIds(previous.tileIds[0]!, current.tileIds[0]!) ||
      previous.id - current.id;
    if (comparison > 0) fail("state.enclosures", "records are not canonical");
  }
  const enclosedByCaptor = new Set<string>();
  state.enclosures.forEach((enclosure, index) => {
    for (const tileId of enclosure.tileIds) {
      const key = `${enclosure.captorId}:${tileId}`;
      if (enclosedByCaptor.has(key))
        fail(`state.enclosures.${index}.tileIds`, "duplicates another pocket tile");
      enclosedByCaptor.add(key);
    }
  });
  state.events.forEach((event, index) => {
    recordEntity(event.id, `state.events.${index}.id`);
    if (event.playerId !== undefined && !players[event.playerId])
      fail(`state.events.${index}.playerId`, "missing player");
    for (const id of [event.tileId, event.sourceTileId, ...(event.tileIds ?? [])])
      if (id !== undefined && !tileIds.has(id)) fail(`state.events.${index}`, "missing tile");
  });
  const validateCommand = (command: GameCommand, path: string): void => {
    if (!players[command.playerId]) fail(`${path}.playerId`, "missing player");
    const ids =
      command.type === "choose-spawn"
        ? [command.centerId]
        : command.type === "move"
          ? [command.sourceId, command.destinationId]
          : command.type === "multi-move"
            ? [...command.sourceIds, ...command.destinationIds]
            : command.type === "set-rally"
              ? [command.tileId, command.destinationId]
              : command.type === "lock-spawn"
                ? []
                : [command.tileId];
    if (ids.some((id) => !landIds.has(id))) fail(path, "references non-land tile");
    if (
      command.type === "multi-move" &&
      (new Set(command.sourceIds).size !== command.sourceIds.length ||
        new Set(command.destinationIds).size !== command.destinationIds.length)
    )
      fail(path, "contains duplicate IDs");
  };
  snapshot.commandHistory.forEach((command, index) =>
    validateCommand(command, `commandHistory.${index}`),
  );
  snapshot.pendingCommands?.forEach((command, index) =>
    validateCommand(command, `pendingCommands.${index}`),
  );
  if (state.victory.leaderId !== null && !players[state.victory.leaderId]) {
    fail("state.victory.leaderId", "references a missing player");
  }
  if (state.victory.winnerId !== null && !players[state.victory.winnerId]) {
    fail("state.victory.winnerId", "references a missing player");
  }
  if ((state.victory.winnerId === null) !== (state.victory.reason === null))
    fail("state.victory.reason", "winner/reason mismatch");
  if ((state.phase === "complete") !== (state.victory.winnerId !== null)) {
    fail("state.phase", "complete phase must match victory state");
  }
  if (hashGameState(state) !== state.stateHash)
    fail("state.stateHash", "does not match deterministic payload");
}

function legacyHash(state: LegacySnapshot["state"]): string {
  const rulesConfig: Record<string, unknown> = { ...state.config };
  for (const key of ["graphics", "sound", "colorPatterns", "debug", "localPlayerId", "playerName"])
    delete rulesConfig[key];
  return stableHash({ ...state, stateHash: undefined, config: rulesConfig });
}

function migrateStructure(structure: LegacyStructure | null): V2Structure | null {
  if (!structure) return null;
  if (structure.status === "constructing") {
    return {
      type: structure.type,
      completedCount: 0,
      status: null,
      integrity: 0,
      pendingProgressTicks: structure.progressTicks,
      seizedTicks: 0,
      productionPaused: structure.productionPaused,
      barracksProgressMilli: 0,
      rallyTargetId: null,
      rallyQueuedTroops: 0,
      turretShotProgressMilli: 0,
    };
  }
  const barracksProgressMilli =
    structure.type === "barracks" && structure.status !== "seized"
      ? Math.min(
          structure.progressTicks * BALANCE.fullIntegrity,
          BALANCE.barracks.trainTicks * BALANCE.fullIntegrity - 1,
        )
      : 0;
  return {
    type: structure.type,
    completedCount: 1,
    status: structure.status,
    integrity: structure.integrity,
    pendingProgressTicks: null,
    seizedTicks: structure.seizedTicks,
    productionPaused: structure.productionPaused,
    barracksProgressMilli,
    rallyTargetId: null,
    rallyQueuedTroops: 0,
    turretShotProgressMilli: 0,
  };
}

function migrateBattle(battle: LegacyBattle, stateTick: number): V2Battle {
  const joinedTick = Math.max(0, stateTick - battle.ageTicks);
  const candidates: V2Participant[] = [
    {
      playerId: battle.defender,
      troops: battle.defenderTroops,
      control: 10_000 - battle.control,
      casualtyProgressMilli: 0,
      entryFrom: battle.tileId,
      joinedTick,
      lastReinforcementTick:
        battle.reinforcementSide === "defender" ? battle.lastReinforcementTick : -1,
      reinforcementAmount: battle.reinforcementSide === "defender" ? battle.reinforcementAmount : 0,
    },
    {
      playerId: battle.attacker,
      troops: battle.attackerTroops,
      control: battle.control,
      casualtyProgressMilli: 0,
      entryFrom: battle.entryFrom,
      joinedTick,
      lastReinforcementTick:
        battle.reinforcementSide === "attacker" ? battle.lastReinforcementTick : -1,
      reinforcementAmount: battle.reinforcementSide === "attacker" ? battle.reinforcementAmount : 0,
    },
    ...battle.waiting.map((waiting) => ({
      playerId: waiting.owner,
      troops: waiting.troops,
      control: 5_000,
      casualtyProgressMilli: 0,
      entryFrom: waiting.entryFrom,
      joinedTick: waiting.queuedTick,
      lastReinforcementTick: -1,
      reinforcementAmount: 0,
    })),
  ];
  const grouped = new Map<string, V2Participant>();
  for (const participant of candidates) {
    const key = participant.playerId === null ? "neutral" : `p${participant.playerId}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...participant });
      continue;
    }
    current.troops += participant.troops;
    current.joinedTick = Math.min(current.joinedTick, participant.joinedTick);
    if (compareAxialIds(participant.entryFrom, current.entryFrom) < 0)
      current.entryFrom = participant.entryFrom;
    if (participant.lastReinforcementTick > current.lastReinforcementTick) {
      current.lastReinforcementTick = participant.lastReinforcementTick;
      current.reinforcementAmount = participant.reinforcementAmount;
    } else if (participant.lastReinforcementTick === current.lastReinforcementTick) {
      current.reinforcementAmount += participant.reinforcementAmount;
    }
  }
  return {
    id: battle.id,
    tileId: battle.tileId,
    incumbentOwner: battle.defender,
    participants: [...grouped.values()].sort((a, b) =>
      a.playerId === null ? -1 : b.playerId === null ? 1 : a.playerId - b.playerId,
    ),
    ageTicks: battle.ageTicks,
    roundAccumulator: battle.roundAccumulator,
  };
}

function migrateLegacyToV2(snapshot: LegacySnapshot): V2Snapshot {
  if (legacyHash(snapshot.state) !== snapshot.state.stateHash)
    fail("state.stateHash", "does not match deterministic v1 payload");
  const legacy = snapshot.state;
  const config = { ...legacy.config, startingCenters: [...legacy.map.spawnCenters] };
  const state = {
    ...legacy,
    version: 2 as const,
    config,
    phase: legacy.victory.winnerId === null ? ("running" as const) : ("complete" as const),
    placement: {
      elapsedTicks: 0,
      maxTicks: legacy.config.multiplayer ? BALANCE.multiplayerPlacementTicks : null,
      placements: legacy.players.map((player) => ({
        playerId: player.id,
        centerId: legacy.map.spawnCenters[player.id] ?? null,
        locked: true,
        relocationCount: 0,
        aiTargetRelocations: 0,
        nextAiActionTick: null,
      })),
    },
    map: {
      ...legacy.map,
      tiles: Object.fromEntries(
        Object.entries(legacy.map.tiles).map(([id, tile]) => [
          id,
          { ...tile, structure: migrateStructure(tile.structure) },
        ]),
      ),
    },
    battles: legacy.battles.map((battle) => migrateBattle(battle, legacy.tick)),
    enclosures: [],
    stateHash: "",
  } satisfies V2Snapshot["state"];
  state.stateHash = hashGameState(state as unknown as GameState);
  const migrated: V2Snapshot = {
    state,
    commandHistory: snapshot.commandHistory,
    pendingCommands: snapshot.pendingCommands,
  };
  return migrated;
}

function balancedUnits(count: number): UnitCounts {
  const quotient = Math.floor(count / UNIT_TYPES.length);
  const remainder = count % UNIT_TYPES.length;
  return {
    melee: quotient + Number(remainder >= 1),
    ranged: quotient + Number(remainder >= 2),
    wizard: quotient,
  };
}

function distributeMilli(totalMilli: number, units: UnitCounts): UnitCounts {
  const unitTotal = totalUnits(units);
  if (totalMilli === 0 || unitTotal === 0) return { melee: 0, ranged: 0, wizard: 0 };
  const output: UnitCounts = { melee: 0, ranged: 0, wizard: 0 };
  let assigned = 0;
  const remainders = UNIT_TYPES.map((type, order) => {
    const numerator = totalMilli * units[type];
    const amount = Math.floor(numerator / unitTotal);
    output[type] = amount;
    assigned += amount;
    return { type, order, remainder: numerator % unitTotal };
  }).sort((left, right) => right.remainder - left.remainder || left.order - right.order);
  for (let index = 0; assigned < totalMilli; index += 1, assigned += 1) {
    output[remainders[index % remainders.length]!.type] += 1;
  }
  return output;
}

function migrateStructureType(type: V2Structure["type"]): CurrentStructure["type"] {
  if (type === "farm") return "archery-range";
  if (type === "turret") return "wizard-tower";
  return "barracks";
}

function validateV2MigrationInput(snapshot: V2Snapshot): void {
  const landIds = new Set(snapshot.state.map.landIds);
  for (const [tileId, tile] of Object.entries(snapshot.state.map.tiles)) {
    const structure = tile.structure;
    if (!structure) continue;
    if (
      structure.type !== "barracks" &&
      (structure.rallyTargetId !== null ||
        structure.barracksProgressMilli !== 0 ||
        structure.rallyQueuedTroops !== 0)
    ) {
      fail(`state.map.tiles.${tileId}.structure`, "non-Barracks has Barracks state");
    }
    if (structure.type !== "turret" && structure.turretShotProgressMilli !== 0) {
      fail(`state.map.tiles.${tileId}.structure`, "non-Turret has shot state");
    }
    if (structure.rallyQueuedTroops > tile.troops) {
      fail(
        `state.map.tiles.${tileId}.structure.rallyQueuedTroops`,
        "exceeds retained local troops",
      );
    }
    if (structure.rallyQueuedTroops > 0 && structure.rallyTargetId === null) {
      fail(`state.map.tiles.${tileId}.structure.rallyQueuedTroops`, "requires a rally target");
    }
    if (structure.status === "seized" && structure.rallyQueuedTroops !== 0) {
      fail(
        `state.map.tiles.${tileId}.structure.rallyQueuedTroops`,
        "seized Barracks cannot queue troops",
      );
    }
    if (structure.rallyTargetId !== null && !landIds.has(structure.rallyTargetId)) {
      fail(`state.map.tiles.${tileId}.structure.rallyTargetId`, "references non-land");
    }
    if (structure.barracksProgressMilli > BALANCE.barracks.trainTicks * BALANCE.fullIntegrity) {
      fail(`state.map.tiles.${tileId}.structure.barracksProgressMilli`, "exceeds one cycle");
    }
    if (structure.turretShotProgressMilli >= 30 * BALANCE.fullIntegrity) {
      fail(`state.map.tiles.${tileId}.structure.turretShotProgressMilli`, "exceeds one cycle");
    }
  }
}

function migrateV2TileUnits(tile: V2Snapshot["state"]["map"]["tiles"][string]): UnitCounts {
  const queuedMelee = tile.structure?.type === "barracks" ? tile.structure.rallyQueuedTroops : 0;
  const units = balancedUnits(tile.troops - queuedMelee);
  units.melee += queuedMelee;
  return units;
}

function migrateV2Structure(structure: V2Structure | null): CurrentStructure | null {
  if (!structure) return null;
  const type = migrateStructureType(structure.type);
  const trainTicks =
    type === "barracks"
      ? BALANCE.barracks.trainTicks
      : type === "archery-range"
        ? BALANCE.archeryRange.trainTicks
        : BALANCE.wizardTower.trainTicks;
  const migratedProgress =
    structure.type === "barracks"
      ? structure.barracksProgressMilli
      : structure.type === "turret"
        ? Math.floor((structure.turretShotProgressMilli * trainTicks) / 30)
        : 0;
  const maximumProgress = trainTicks * BALANCE.fullIntegrity;
  const rallyQueuedUnits =
    structure.type === "barracks"
      ? unitsOf("melee", structure.rallyQueuedTroops)
      : { melee: 0, ranged: 0, wizard: 0 };
  return {
    type,
    completedCount: structure.completedCount,
    status: structure.status,
    integrity: structure.integrity,
    pendingProgressTicks: structure.pendingProgressTicks,
    seizedTicks: structure.seizedTicks,
    productionPaused: structure.productionPaused,
    trainingProgressMilli: Math.min(migratedProgress, Math.max(0, maximumProgress)),
    rallyTargetId: structure.rallyTargetId,
    rallyQueuedUnits,
  };
}

function migrateV2Command(command: V2Command): GameCommand {
  if (command.type === "build") {
    return { ...command, structure: migrateStructureType(command.structure) };
  }
  if (command.type === "toggle-barracks") {
    return {
      type: "toggle-production",
      playerId: command.playerId,
      tileId: command.tileId,
      scheduledTick: command.scheduledTick,
    };
  }
  return command;
}

function migrateV2Snapshot(snapshot: V2Snapshot): EngineSnapshot {
  if (hashGameState(snapshot.state as unknown as GameState) !== snapshot.state.stateHash) {
    fail("state.stateHash", "does not match deterministic v2 payload");
  }
  validateV2MigrationInput(snapshot);
  const state = {
    ...snapshot.state,
    version: 3 as const,
    map: {
      ...snapshot.state.map,
      tiles: Object.fromEntries(
        Object.entries(snapshot.state.map.tiles).map(([id, tile]) => {
          const units = migrateV2TileUnits(tile);
          return [
            id,
            {
              id: tile.id,
              q: tile.q,
              r: tile.r,
              terrain: tile.terrain,
              owner: tile.owner,
              units,
              structure: migrateV2Structure(tile.structure),
              controlledSinceTick: tile.controlledSinceTick,
              lastRewardTick: tile.lastRewardTick,
              decorationSeed: tile.decorationSeed,
            },
          ];
        }),
      ),
    },
    stacks: snapshot.state.stacks.map((stack) => {
      const { troops, ...fields } = stack;
      return { ...fields, units: balancedUnits(troops) };
    }),
    battles: snapshot.state.battles.map((battle) => ({
      ...battle,
      participants: battle.participants.map((participant) => {
        const { troops, casualtyProgressMilli, ...fields } = participant;
        const units = balancedUnits(troops);
        return {
          ...fields,
          units,
          casualtyProgressMilli: distributeMilli(casualtyProgressMilli, units),
        };
      }),
    })),
    stateHash: "",
  } satisfies GameState;
  const aggregateUnits = state.players.map(() => 0);
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    if (tile.owner !== null) aggregateUnits[tile.owner]! += totalUnits(tile.units);
  }
  for (const stack of state.stacks) aggregateUnits[stack.owner]! += totalUnits(stack.units);
  for (const battle of state.battles)
    for (const participant of battle.participants)
      if (participant.playerId !== null)
        aggregateUnits[participant.playerId]! += totalUnits(participant.units);
  state.players = state.players.map((player, index) => ({
    ...player,
    troopCount: aggregateUnits[index]!,
  }));
  state.stateHash = hashGameState(state);
  const migrated: EngineSnapshot = {
    state,
    commandHistory: snapshot.commandHistory.map(migrateV2Command),
    pendingCommands: snapshot.pendingCommands?.map(migrateV2Command),
  };
  validateReferences(migrated);
  return migrated;
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "root";
    throw new SnapshotValidationError(
      `Invalid engine snapshot at ${path}: ${issue?.message ?? "malformed data"}`,
    );
  }
  return parsed.data;
}

/** Parse, migrate, and cross-check untrusted local-save or network checkpoint data. */
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
  if (version === 1)
    return migrateV2Snapshot(migrateLegacyToV2(parseWithSchema(legacySnapshotSchema, value)));
  if (version === 2) return migrateV2Snapshot(parseWithSchema(v2SnapshotSchema, value));
  if (version !== 3) throw new SnapshotValidationError("Unsupported snapshot version");
  const parsed = parseWithSchema(snapshotSchema, value) as EngineSnapshot;
  validateReferences(parsed);
  return parsed;
}

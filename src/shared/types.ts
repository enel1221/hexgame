export type TerrainType = "meadow" | "muster" | "plains" | "forest" | "hills" | "water";

export type MapArchetype = "heartland" | "broken-crown" | "highland-basin";
export type Difficulty = "easy" | "normal" | "hard";
export type GraphicsQuality = "low" | "medium" | "high";
export type UnitType = "melee" | "ranged" | "wizard";
export interface UnitCounts {
  melee: number;
  ranged: number;
  wizard: number;
}
export type StructureType = "barracks" | "archery-range" | "wizard-tower";
export type StructureStatus = "active" | "seized" | "repairing";
export type GamePhase = "placement" | "opening" | "running" | "complete";

export interface Axial {
  q: number;
  r: number;
}

export interface StructureState {
  type: StructureType;
  completedCount: number;
  /** Null while the first copy is still pending. */
  status: StructureStatus | null;
  integrity: number;
  /** Null when no additional copy is under construction. */
  pendingProgressTicks: number | null;
  seizedTicks: number;
  productionPaused: boolean;
  /** Fixed-point integrity-ticks toward the next aggregate training cycle. */
  trainingProgressMilli: number;
  rallyTargetId: string | null;
  /** Newly trained units retained locally while the rally route is blocked. */
  rallyQueuedUnits: UnitCounts;
}

export interface TileState extends Axial {
  id: string;
  terrain: TerrainType;
  owner: number | null;
  units: UnitCounts;
  structure: StructureState | null;
  controlledSinceTick: number;
  lastRewardTick: number;
  decorationSeed: number;
}

export interface GeneratedMap {
  archetype: MapArchetype;
  seed: string;
  width: number;
  height: number;
  landCount: number;
  tiles: Record<string, TileState>;
  tileIds: string[];
  landIds: string[];
  spawnCenters: string[];
  spawnClusters: string[][];
  generationAttempt: number;
}

export interface SpawnPlacement {
  playerId: number;
  centerId: string | null;
  locked: boolean;
  relocationCount: number;
  aiTargetRelocations: number;
  nextAiActionTick: number | null;
}

export interface PlacementState {
  elapsedTicks: number;
  maxTicks: number | null;
  placements: SpawnPlacement[];
}

export interface PlayerState {
  id: number;
  name: string;
  color: number;
  accent: number;
  pattern: number;
  supplyMilli: number;
  tileCount: number;
  troopCount: number;
  eliminated: boolean;
  eliminatedBy: number | null;
  isHuman: boolean;
  aiSeed: number;
  aiMode: string;
  stats: PlayerStats;
}

export interface PlayerStats {
  tilesCaptured: number;
  enemiesEliminated: number;
  troopsTrained: number;
  troopsLost: number;
  supplyEarnedMilli: number;
  structuresBuilt: number;
}

export interface MovingStack {
  id: number;
  owner: number;
  units: UnitCounts;
  path: string[];
  pathIndex: number;
  segmentProgress: number;
  segmentDuration: number;
  originId: string;
  destinationId: string;
  lane: number;
  issuedTick: number;
}

export interface BattleParticipant {
  /** Null is reserved for the neutral incumbent. */
  playerId: number | null;
  units: UnitCounts;
  control: number;
  casualtyProgressMilli: UnitCounts;
  entryFrom: string;
  joinedTick: number;
  lastReinforcementTick: number;
  reinforcementAmount: number;
}

export interface BattleState {
  id: number;
  tileId: string;
  incumbentOwner: number | null;
  participants: BattleParticipant[];
  ageTicks: number;
  roundAccumulator: number;
}

export interface EnclosureState {
  id: number;
  captorId: number;
  tileIds: string[];
  boundaryIds: string[];
  progressTicks: number;
}

export interface VictoryState {
  leaderId: number | null;
  holdTicks: number;
  winnerId: number | null;
  reason: "control" | "sole-survivor" | null;
}

export type GameEventType =
  | "order"
  | "route-interrupted"
  | "battle-started"
  | "reinforcement"
  | "capture"
  | "reward"
  | "construction-started"
  | "construction-complete"
  | "structure-seized"
  | "spawn-selected"
  | "spawn-locked"
  | "placement-complete"
  | "rally-set"
  | "rally-cleared"
  /** Retained so migrated recent-event rings remain readable. */
  | "turret-volley"
  | "typed-support"
  | "encirclement-started"
  | "encirclement-complete"
  | "elimination"
  | "victory-countdown"
  | "victory";

export interface GameEvent {
  id: number;
  tick: number;
  type: GameEventType;
  playerId?: number;
  tileId?: string;
  tileIds?: string[];
  sourceTileId?: string;
  amount?: number;
  message: string;
}

export interface MatchConfig {
  seed: string;
  archetype: MapArchetype;
  aiCount: number;
  difficulty: Difficulty;
  playerName: string;
  graphics: GraphicsQuality;
  sound: boolean;
  colorPatterns: boolean;
  fullCounts?: boolean;
  debug: boolean;
  multiplayer?: boolean;
  humanSeats?: number[];
  playerNames?: string[];
  localPlayerId?: number;
  /** Immutable final spawn inputs, populated when placement completes. */
  startingCenters?: string[];
}

export interface GameState {
  version: 3;
  config: MatchConfig;
  phase: GamePhase;
  placement: PlacementState;
  tick: number;
  map: GeneratedMap;
  players: PlayerState[];
  stacks: MovingStack[];
  battles: BattleState[];
  enclosures: EnclosureState[];
  events: GameEvent[];
  nextEntityId: number;
  victory: VictoryState;
  stateHash: string;
  paused: boolean;
}

export type SendPercent = 25 | 50 | 75 | 100;

export type GameCommand =
  | {
      type: "choose-spawn";
      playerId: number;
      centerId: string;
      scheduledTick?: number;
    }
  | {
      type: "lock-spawn";
      playerId: number;
      scheduledTick?: number;
    }
  | {
      type: "move";
      playerId: number;
      sourceId: string;
      destinationId: string;
      percent: SendPercent;
      scheduledTick?: number;
    }
  | {
      type: "multi-move";
      playerId: number;
      sourceIds: string[];
      destinationIds: string[];
      percent: SendPercent;
      scheduledTick?: number;
    }
  | {
      type: "build";
      playerId: number;
      tileId: string;
      structure: StructureType;
      scheduledTick?: number;
    }
  | {
      type: "cancel-build";
      playerId: number;
      tileId: string;
      scheduledTick?: number;
    }
  | {
      type: "toggle-production";
      playerId: number;
      tileId: string;
      scheduledTick?: number;
    }
  | {
      type: "set-rally";
      playerId: number;
      tileId: string;
      destinationId: string;
      scheduledTick?: number;
    }
  | {
      type: "clear-rally";
      playerId: number;
      tileId: string;
      scheduledTick?: number;
    };

export interface EngineSnapshot {
  state: GameState;
  commandHistory: GameCommand[];
  /** Commands accepted by the worker but scheduled after the snapshot tick. */
  pendingCommands?: GameCommand[];
}

/** Deterministic presentation fixtures available only in debug matches. */
export type DebugScenario =
  | "structures"
  | "battle"
  | "battle-minimum"
  | "reinforcement"
  | "capture-before"
  | "capture"
  | "developed-capture"
  | "elimination"
  | "interior-build"
  | "victory"
  | "defeat";

export type WorkerRequest =
  | { type: "start"; config: MatchConfig }
  | {
      type: "command";
      command: GameCommand;
      /** Relay transport order; deliberately kept outside deterministic rules data. */
      relaySequence?: number;
    }
  | { type: "pause"; paused: boolean }
  | { type: "speed"; speed: 1 | 2 | 4 }
  | { type: "catch-up"; targetTick: number }
  | { type: "finalize-placement"; centers: string[] }
  | { type: "begin-match" }
  | { type: "debug-scenario"; scenario: DebugScenario }
  | { type: "snapshot" }
  | {
      type: "restore";
      snapshot: EngineSnapshot;
      /** Sequence already represented by a multiplayer checkpoint. */
      relaySequence?: number;
    }
  | { type: "dispose" };

export type WorkerResponse =
  | { type: "ready"; state: GameState; relaySequence?: number }
  | {
      type: "state";
      state: GameState;
      simulationMs: number;
      aiMs: number;
      relaySequence?: number;
    }
  | { type: "snapshot"; snapshot: EngineSnapshot; relaySequence?: number }
  | { type: "error"; message: string };

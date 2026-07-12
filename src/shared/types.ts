export type TerrainType = "meadow" | "muster" | "plains" | "forest" | "hills" | "water";

export type MapArchetype = "heartland" | "broken-crown" | "highland-basin";
export type Difficulty = "easy" | "normal" | "hard";
export type GraphicsQuality = "low" | "medium" | "high";
export type StructureType = "farm" | "barracks" | "turret";
export type StructureStatus = "constructing" | "active" | "seized" | "repairing";

export interface Axial {
  q: number;
  r: number;
}

export interface StructureState {
  type: StructureType;
  status: StructureStatus;
  integrity: number;
  progressTicks: number;
  seizedTicks: number;
  productionPaused: boolean;
}

export interface TileState extends Axial {
  id: string;
  terrain: TerrainType;
  owner: number | null;
  troops: number;
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
  troops: number;
  path: string[];
  pathIndex: number;
  segmentProgress: number;
  segmentDuration: number;
  originId: string;
  destinationId: string;
  lane: number;
  issuedTick: number;
}

export interface WaitingChallenger {
  owner: number;
  troops: number;
  entryFrom: string;
  queuedTick: number;
}

export interface BattleState {
  id: number;
  tileId: string;
  defender: number | null;
  attacker: number;
  defenderTroops: number;
  attackerTroops: number;
  control: number;
  ageTicks: number;
  roundAccumulator: number;
  entryFrom: string;
  waiting: WaitingChallenger[];
  lastReinforcementTick: number;
  reinforcementSide: "attacker" | "defender" | null;
  reinforcementAmount: number;
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
  | "elimination"
  | "victory-countdown"
  | "victory";

export interface GameEvent {
  id: number;
  tick: number;
  type: GameEventType;
  playerId?: number;
  tileId?: string;
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
}

export interface GameState {
  version: 1;
  config: MatchConfig;
  tick: number;
  map: GeneratedMap;
  players: PlayerState[];
  stacks: MovingStack[];
  battles: BattleState[];
  events: GameEvent[];
  nextEntityId: number;
  victory: VictoryState;
  stateHash: string;
  paused: boolean;
}

export type SendPercent = 25 | 50 | 75 | 100;

export type GameCommand =
  | {
      type: "move";
      playerId: number;
      sourceId: string;
      destinationId: string;
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
      type: "toggle-barracks";
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
  | { type: "command"; command: GameCommand }
  | { type: "pause"; paused: boolean }
  | { type: "speed"; speed: 1 | 2 | 4 }
  | { type: "catch-up"; targetTick: number }
  | { type: "debug-scenario"; scenario: DebugScenario }
  | { type: "snapshot" }
  | { type: "restore"; snapshot: EngineSnapshot }
  | { type: "dispose" };

export type WorkerResponse =
  | { type: "ready"; state: GameState }
  | { type: "state"; state: GameState; simulationMs: number; aiMs: number }
  | { type: "snapshot"; snapshot: EngineSnapshot }
  | { type: "error"; message: string };

import { BALANCE, PLAYER_COLORS } from "../../shared/balance";
import type {
  EngineSnapshot,
  GameCommand,
  GameState,
  MatchConfig,
  PlayerState,
} from "../../shared/types";
import { collectAiCommands } from "../ai";
import { applyCommand, type CommandResult } from "../commands";
import { tickCombat } from "../combat";
import { tickEconomy } from "../economy";
import { cloneDeterministic, hashGameState } from "../hash";
import { generateMap } from "../map";
import { tickMovement } from "../movement";
import { hashSeed } from "../rng";
import { tickStructures } from "../buildings";
import { tickVictory } from "../victory";
import { parseEngineSnapshot } from "./snapshot";

export { SnapshotValidationError, parseEngineSnapshot } from "./snapshot";

const AI_NAMES = [
  "Ash Banner",
  "Moss Guard",
  "Copper Vale",
  "River Crown",
  "Stone Choir",
  "Ember March",
  "Pine Watch",
  "Gold Finch",
  "Cloud Spear",
  "Dusk Harbor",
  "Iron Bloom",
  "Red Willow",
  "Frost Mere",
  "Juniper Host",
  "Sunken Bell",
  "Blue Anvil",
  "Cedar Wing",
  "Moon Field",
  "Wild Thistle",
  "Quartz Legion",
] as const;

function accentColor(color: number): number {
  const red = Math.min(255, ((color >> 16) & 0xff) + 38);
  const green = Math.min(255, ((color >> 8) & 0xff) + 38);
  const blue = Math.min(255, (color & 0xff) + 38);
  return (red << 16) | (green << 8) | blue;
}

function emptyPlayer(
  config: MatchConfig,
  id: number,
  humanSeats: ReadonlySet<number>,
): PlayerState {
  const color = PLAYER_COLORS[id % PLAYER_COLORS.length]!;
  const isHuman = humanSeats.has(id);
  const configuredName = config.playerNames?.[id]?.trim();
  const fallbackHumanName =
    id === (config.localPlayerId ?? 0)
      ? config.playerName.trim() || "Commander"
      : `Commander ${id + 1}`;
  return {
    id,
    name: configuredName || (isHuman ? fallbackHumanName : AI_NAMES[id % AI_NAMES.length]!),
    color,
    accent: accentColor(color),
    pattern: id % 7,
    supplyMilli: BALANCE.startingSupplyMilli,
    tileCount: 0,
    troopCount: 0,
    eliminated: false,
    eliminatedBy: null,
    isHuman,
    aiSeed: hashSeed(`${config.seed}:ai:${id}`),
    aiMode: isHuman ? "human" : "expand",
    stats: {
      tilesCaptured: 0,
      enemiesEliminated: 0,
      troopsTrained: 0,
      troopsLost: 0,
      supplyEarnedMilli: 0,
      structuresBuilt: 0,
    },
  };
}

export function refreshPlayerAggregates(state: GameState): void {
  const tiles = new Array<number>(state.players.length).fill(0);
  const troops = new Array<number>(state.players.length).fill(0);
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    if (tile.owner === null || !state.players[tile.owner]) continue;
    tiles[tile.owner] += 1;
    troops[tile.owner] += tile.troops;
  }
  for (const stack of state.stacks) {
    if (state.players[stack.owner]) troops[stack.owner] += stack.troops;
  }
  for (const battle of state.battles) {
    if (state.players[battle.attacker]) troops[battle.attacker] += battle.attackerTroops;
    if (battle.defender !== null && state.players[battle.defender]) {
      troops[battle.defender] += battle.defenderTroops;
    }
    for (const waiting of battle.waiting) {
      if (state.players[waiting.owner]) troops[waiting.owner] += waiting.troops;
    }
  }
  for (const player of state.players) {
    player.tileCount = player.eliminated ? 0 : (tiles[player.id] ?? 0);
    player.troopCount = player.eliminated ? 0 : (troops[player.id] ?? 0);
  }
}

export function createInitialState(config: MatchConfig): GameState {
  const requestedHumanSeats = config.multiplayer ? (config.humanSeats ?? [0, 1]) : [0];
  const sortedHumanSeats = [...new Set(requestedHumanSeats)].sort((left, right) => left - right);
  const totalPlayers = sortedHumanSeats.length + config.aiCount;
  if (!Number.isInteger(config.aiCount) || config.aiCount < (config.multiplayer ? 0 : 3)) {
    throw new Error(
      config.multiplayer
        ? "aiCount must be a non-negative integer"
        : "aiCount must be an integer from 3 through 20",
    );
  }
  if (config.multiplayer && (sortedHumanSeats.length < 2 || sortedHumanSeats.length > 8)) {
    throw new Error("Multiplayer requires between 2 and 8 human participants");
  }
  const minimumPlayers = config.multiplayer ? 2 : 4;
  if (totalPlayers < minimumPlayers || totalPlayers > 21) {
    throw new Error(
      config.multiplayer
        ? "Multiplayer participants must be between 2 and 21"
        : "Single-player participants must be between 4 and 21",
    );
  }
  if (
    sortedHumanSeats.length === 0 ||
    sortedHumanSeats.some((id) => !Number.isInteger(id) || id < 0 || id >= totalPlayers)
  ) {
    throw new Error("humanSeats must contain valid participant IDs");
  }
  if (!config.seed.trim()) throw new Error("Match seed must not be empty");

  const normalizedConfig = cloneDeterministic({
    ...config,
    ...(config.multiplayer ? { humanSeats: sortedHumanSeats } : {}),
  });
  const map = generateMap({ seed: config.seed, archetype: config.archetype, totalPlayers });
  const humanSeatSet = new Set(sortedHumanSeats);
  const players = Array.from({ length: totalPlayers }, (_, id) =>
    emptyPlayer(normalizedConfig, id, humanSeatSet),
  );
  const state: GameState = {
    version: 1,
    config: normalizedConfig,
    tick: 0,
    map,
    players,
    stacks: [],
    battles: [],
    events: [],
    nextEntityId: 1,
    victory: { leaderId: null, holdTicks: 0, winnerId: null, reason: null },
    stateHash: "",
    paused: false,
  };
  refreshPlayerAggregates(state);
  state.stateHash = hashGameState(state);
  return state;
}

interface AdvanceResult {
  state: GameState;
  acceptedCommands: GameCommand[];
}

export interface TickHooks {
  beforeAi?(): void;
  afterAi?(): void;
}

/** Internal in-place fixed tick, shared by GameEngine and pure stepGame. */
export function advanceGameState(
  state: GameState,
  commands: readonly GameCommand[] = [],
  hooks: TickHooks = {},
): AdvanceResult {
  if (state.paused || state.victory.winnerId !== null) {
    state.stateHash = hashGameState(state);
    return { state, acceptedCommands: [] };
  }

  state.tick += 1;
  const acceptedCommands: GameCommand[] = [];
  for (const command of commands) {
    if (command.scheduledTick !== undefined && command.scheduledTick > state.tick) continue;
    if (applyCommand(state, command).ok) acceptedCommands.push(command);
  }

  hooks.beforeAi?.();
  for (const command of collectAiCommands(state)) applyCommand(state, command);
  hooks.afterAi?.();
  tickMovement(state);
  tickCombat(state);
  tickStructures(state);
  tickEconomy(state);
  refreshPlayerAggregates(state);
  tickVictory(state);
  state.stateHash = hashGameState(state);
  return { state, acceptedCommands };
}

/** Pure convenience API: the input state is never modified. */
export function stepGame(state: GameState, commands: readonly GameCommand[] = []): GameState {
  const next = cloneDeterministic(state);
  return advanceGameState(next, commands).state;
}

export class GameEngine {
  private current: GameState;
  private readonly pendingCommands: GameCommand[] = [];
  private history: GameCommand[];

  constructor(configOrSnapshot: MatchConfig | EngineSnapshot) {
    const snapshotEnvelope =
      typeof configOrSnapshot === "object" &&
      configOrSnapshot !== null &&
      ("state" in configOrSnapshot ||
        "commandHistory" in configOrSnapshot ||
        "pendingCommands" in configOrSnapshot);
    if (snapshotEnvelope) {
      const snapshot = parseEngineSnapshot(configOrSnapshot);
      this.current = cloneDeterministic(snapshot.state);
      this.history = cloneDeterministic(snapshot.commandHistory);
      this.pendingCommands.push(...cloneDeterministic(snapshot.pendingCommands ?? []));
      this.current.stateHash = hashGameState(this.current);
    } else {
      this.current = createInitialState(configOrSnapshot);
      this.history = [];
    }
  }

  get state(): GameState {
    return this.current;
  }

  get commandHistory(): readonly GameCommand[] {
    return this.history;
  }

  submitCommand(command: GameCommand): CommandResult {
    if (!Number.isInteger(command.playerId) || !this.current.players[command.playerId]) {
      return { ok: false, reason: "Invalid player" };
    }
    if (this.current.victory.winnerId !== null) return { ok: false, reason: "Match is complete" };
    const requestedTick = command.scheduledTick;
    if (requestedTick !== undefined && !Number.isInteger(requestedTick)) {
      return { ok: false, reason: "scheduledTick must be an integer" };
    }
    const scheduledTick = Math.max(this.current.tick + 1, requestedTick ?? this.current.tick + 1);
    this.pendingCommands.push({ ...cloneDeterministic(command), scheduledTick });
    return { ok: true };
  }

  tick(hooks: TickHooks = {}): GameState {
    if (this.current.paused || this.current.victory.winnerId !== null) return this.current;
    const targetTick = this.current.tick + 1;
    const due: GameCommand[] = [];
    for (let index = this.pendingCommands.length - 1; index >= 0; index -= 1) {
      const command = this.pendingCommands[index]!;
      if ((command.scheduledTick ?? targetTick) <= targetTick) {
        due.unshift(command);
        this.pendingCommands.splice(index, 1);
      }
    }
    const result = advanceGameState(this.current, due, hooks);
    this.history.push(...cloneDeterministic(result.acceptedCommands));
    return this.current;
  }

  step(ticks = 1): GameState {
    if (!Number.isInteger(ticks) || ticks < 0)
      throw new Error("ticks must be a non-negative integer");
    for (let index = 0; index < ticks; index += 1) this.tick();
    return this.current;
  }

  setPaused(paused: boolean): void {
    this.current.paused = paused;
    this.current.stateHash = hashGameState(this.current);
  }

  exportSnapshot(): EngineSnapshot {
    return {
      state: cloneDeterministic(this.current),
      commandHistory: cloneDeterministic(this.history),
      pendingCommands: cloneDeterministic(this.pendingCommands),
    };
  }

  importSnapshot(snapshot: EngineSnapshot): void {
    const validated = parseEngineSnapshot(snapshot);
    const nextState = cloneDeterministic(validated.state);
    const nextHistory = cloneDeterministic(validated.commandHistory);
    const nextPending = cloneDeterministic(validated.pendingCommands ?? []);
    this.current = nextState;
    this.history = nextHistory;
    this.pendingCommands.splice(0, this.pendingCommands.length, ...nextPending);
    this.current.stateHash = hashGameState(this.current);
  }
}

export function createGame(config: MatchConfig): GameEngine {
  return new GameEngine(config);
}

export function exportSnapshot(engine: GameEngine): EngineSnapshot {
  return engine.exportSnapshot();
}

export function importSnapshot(snapshot: EngineSnapshot): GameEngine {
  return new GameEngine(snapshot);
}

export function replayCommands(
  config: MatchConfig,
  commands: readonly GameCommand[],
  throughTick: number,
): GameState {
  const engine = createGame(config);
  for (const command of commands) engine.submitCommand(command);
  engine.step(throughTick);
  return engine.state;
}

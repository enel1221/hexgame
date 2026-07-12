import { describe, expect, it } from "vitest";
import {
  axialKey,
  aiDecisionInterval,
  cloneDeterministic,
  createGame,
  decideAiCommands,
  neighbors,
  stableStringify,
  validateCommand,
} from "../../src/core";
import type {
  BattleState,
  Difficulty,
  GameCommand,
  GameState,
  StructureType,
  TileState,
} from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function makeState(difficulty: Difficulty = "normal"): GameState {
  return createGame({
    ...TEST_CONFIG,
    difficulty,
    seed: `ai-scenario-${difficulty}`,
  }).state;
}

function landStar(state: GameState, neighborCount: number): [TileState, ...TileState[]] {
  for (const id of state.map.landIds) {
    const center = state.map.tiles[id]!;
    const adjacent = neighbors(center)
      .map((hex) => state.map.tiles[axialKey(hex)])
      .filter((tile): tile is TileState => tile !== undefined && tile.terrain !== "water");
    if (adjacent.length >= neighborCount) return [center, ...adjacent.slice(0, neighborCount)];
  }
  throw new Error(`Map has no land tile with ${neighborCount} land neighbors`);
}

function clearBoard(state: GameState): void {
  state.stacks = [];
  state.battles = [];
  state.events = [];
  state.victory = { leaderId: null, holdTicks: 0, winnerId: null, reason: null };
  for (const id of state.map.landIds) {
    const tile = state.map.tiles[id]!;
    tile.owner = null;
    tile.troops = 1;
    tile.structure = null;
    tile.terrain = "water";
  }
}

function activeStructure(type: StructureType): NonNullable<TileState["structure"]> {
  return {
    type,
    status: "active",
    integrity: 1_000,
    progressTicks: 0,
    seizedTicks: 0,
    productionPaused: false,
  };
}

function moveFrom(commands: GameCommand[]): Extract<GameCommand, { type: "move" }> {
  const move = commands.find(
    (command): command is Extract<GameCommand, { type: "move" }> => command.type === "move",
  );
  if (!move) throw new Error("Expected an AI move command");
  return move;
}

function buildFrom(commands: GameCommand[]): Extract<GameCommand, { type: "build" }> {
  const build = commands.find(
    (command): command is Extract<GameCommand, { type: "build" }> => command.type === "build",
  );
  if (!build) throw new Error("Expected an AI build command");
  return build;
}

describe("deterministic AI", () => {
  it("uses difficulty for legal decision cadence without rule-breaking bonuses", () => {
    expect(aiDecisionInterval("easy")).toBeGreaterThan(aiDecisionInterval("normal"));
    expect(aiDecisionInterval("normal")).toBeGreaterThan(aiDecisionInterval("hard"));
    const state = createGame({ ...TEST_CONFIG, seed: "ai-legal", difficulty: "hard" }).state;
    const supplyBefore = state.players[1]!.supplyMilli;
    const commands = decideAiCommands(state, 1);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(validateCommand(state, command).ok).toBe(true);
    expect(state.players[1]!.supplyMilli).toBe(supplyBefore);
  });

  it.each([
    ["farm", "meadow"],
    ["barracks", "muster"],
  ] as const)("builds a %s only on its required terrain", (structure, terrain) => {
    const state = makeState();
    const [site] = landStar(state, 1);
    clearBoard(state);
    site.terrain = terrain;
    site.owner = 1;
    site.troops = 1;
    state.players[1]!.supplyMilli = 250_000;

    const build = buildFrom(decideAiCommands(state, 1));
    expect(build).toEqual(
      expect.objectContaining({ type: "build", playerId: 1, tileId: site.id, structure }),
    );
    expect(state.map.tiles[build.tileId]!.terrain).toBe(terrain);
    expect(validateCommand(state, build).ok).toBe(true);
  });

  it("builds a Turret on a legal threatened frontier tile", () => {
    const state = makeState();
    const [enemy] = landStar(state, 1);
    for (const id of state.map.landIds) {
      const tile = state.map.tiles[id]!;
      tile.owner = 1;
      tile.troops = 1;
      tile.structure = null;
      tile.terrain = "plains";
    }
    enemy.owner = 0;
    enemy.troops = 40;
    state.players[1]!.supplyMilli = 500_000;

    const build = buildFrom(decideAiCommands(state, 1));
    expect(build.structure).toBe("turret");
    expect(state.map.tiles[build.tileId]!.terrain).not.toBe("water");
    expect(validateCommand(state, build).ok).toBe(true);
  });

  it("expands into a weak neutral tile", () => {
    const state = makeState();
    const [source, neutral] = landStar(state, 1);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 12;
    neutral.terrain = "meadow";
    neutral.owner = null;
    neutral.troops = 1;

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move).toEqual(
      expect.objectContaining({ sourceId: source.id, destinationId: neutral.id }),
    );
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("attacks a weak enemy border and values a captured Barracks", () => {
    const state = makeState("hard");
    const [source, plainTarget, developedTarget] = landStar(state, 2);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 30;
    plainTarget.terrain = "plains";
    plainTarget.owner = 0;
    plainTarget.troops = 2;
    developedTarget.terrain = "muster";
    developedTarget.owner = 0;
    developedTarget.troops = 2;
    developedTarget.structure = activeStructure("barracks");

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move.destinationId).toBe(developedTarget.id);
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("reinforces an ongoing battle only when its side needs recovery", () => {
    const state = makeState();
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 40;
    target.terrain = "plains";
    target.owner = 0;
    target.troops = 0;
    state.tick = 100;
    const battle: BattleState = {
      id: 91,
      tileId: target.id,
      defender: 0,
      attacker: 1,
      defenderTroops: 18,
      attackerTroops: 3,
      control: 3_000,
      ageTicks: 20,
      roundAccumulator: 0,
      entryFrom: source.id,
      waiting: [],
      lastReinforcementTick: -1,
      reinforcementSide: null,
      reinforcementAmount: 0,
    };
    state.battles.push(battle);

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move.destinationId).toBe(target.id);
    expect(state.players[1]!.aiMode).toBe("reinforce");
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("does not bypass reinforcement discipline through a fresh attack order", () => {
    const state = makeState();
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 40;
    target.terrain = "plains";
    target.owner = 0;
    target.troops = 0;
    state.tick = 100;
    state.battles.push({
      id: 92,
      tileId: target.id,
      defender: 0,
      attacker: 1,
      defenderTroops: 3,
      attackerTroops: 24,
      control: 8_000,
      ageTicks: 20,
      roundAccumulator: 0,
      entryFrom: source.id,
      waiting: [],
      lastReinforcementTick: state.tick,
      reinforcementSide: "attacker",
      reinforcementAmount: 8,
    });

    const moves = decideAiCommands(state, 1).filter((command) => command.type === "move");
    expect(moves).toEqual([]);
  });

  it("defends developed territory from an adjacent threat", () => {
    const state = makeState();
    const [developed, source, enemy] = landStar(state, 2);
    clearBoard(state);
    developed.terrain = "meadow";
    developed.owner = 1;
    developed.troops = 2;
    developed.structure = activeStructure("farm");
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 24;
    enemy.terrain = "plains";
    enemy.owner = 0;
    enemy.troops = 12;

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move).toEqual(
      expect.objectContaining({ sourceId: source.id, destinationId: developed.id }),
    );
    expect(state.players[1]!.aiMode).toBe("defend");
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("redirects an equal opportunity toward an opponent on the victory countdown", () => {
    const state = makeState();
    const [source, ordinaryTarget, leaderTarget] = landStar(state, 2);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 30;
    ordinaryTarget.terrain = "plains";
    ordinaryTarget.owner = 0;
    ordinaryTarget.troops = 2;
    leaderTarget.terrain = "plains";
    leaderTarget.owner = 2;
    leaderTarget.troops = 2;
    state.victory.leaderId = 2;
    state.victory.holdTicks = 30;

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move.destinationId).toBe(leaderTarget.id);
  });

  it("focuses the weaker reachable rival once a match matures", () => {
    const state = makeState();
    const [source, strongerTarget, weakerTarget] = landStar(state, 2);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.troops = 30;
    strongerTarget.terrain = "plains";
    strongerTarget.owner = 0;
    strongerTarget.troops = 2;
    weakerTarget.terrain = "plains";
    weakerTarget.owner = 2;
    weakerTarget.troops = 2;
    state.players[0]!.tileCount = 20;
    state.players[2]!.tileCount = 5;
    state.tick = 6_000;

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move.destinationId).toBe(weakerTarget.id);
  });

  it("returns identical decisions from identical state", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "ai-repeat", difficulty: "hard" }).state;
    const left = cloneDeterministic(state);
    const right = cloneDeterministic(state);
    expect(stableStringify(decideAiCommands(left, 2))).toBe(
      stableStringify(decideAiCommands(right, 2)),
    );
  });

  it("does not grant hidden resources, troops, structures, or combat progress", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const) {
      const state = makeState(difficulty);
      const before = cloneDeterministic({
        supply: state.players.map((player) => player.supplyMilli),
        troops: state.map.landIds.map((id) => state.map.tiles[id]!.troops),
        structures: state.map.landIds.map((id) => state.map.tiles[id]!.structure),
        stacks: state.stacks,
        battles: state.battles,
      });
      const commands = decideAiCommands(state, 1);
      expect(commands.every((command) => validateCommand(state, command).ok)).toBe(true);
      expect({
        supply: state.players.map((player) => player.supplyMilli),
        troops: state.map.landIds.map((id) => state.map.tiles[id]!.troops),
        structures: state.map.landIds.map((id) => state.map.tiles[id]!.structure),
        stacks: state.stacks,
        battles: state.battles,
      }).toEqual(before);
    }
  });
});

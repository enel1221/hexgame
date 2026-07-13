import { describe, expect, it } from "vitest";
import {
  aiDecisionInterval,
  applySpawnAllocations,
  axialKey,
  chooseDefaultSpawnCenters,
  cloneDeterministic,
  createGame,
  decideAiCommands,
  emptyUnits,
  neighbors,
  stableStringify,
  totalUnits,
  unitsOf,
  validateCommand,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
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
  const state = createGame({
    ...TEST_CONFIG,
    difficulty,
    seed: `ai-scenario-${difficulty}`,
  }).state;
  const centers = chooseDefaultSpawnCenters(
    state.map,
    state.players.length,
    `${state.config.seed}:tests`,
  );
  applySpawnAllocations(state.map, centers, `${state.config.seed}:tests`);
  state.config.startingCenters = centers;
  state.phase = "running";
  return state;
}

function landStar(state: GameState, neighborCount: number): [TileState, ...TileState[]] {
  for (const id of state.map.landIds) {
    const center = state.map.tiles[id]!;
    const adjacent = neighbors(center)
      .map((hex) => state.map.tiles[axialKey(hex)])
      .filter((tile): tile is TileState => Boolean(tile && tile.terrain !== "water"));
    if (adjacent.length >= neighborCount) return [center, ...adjacent.slice(0, neighborCount)];
  }
  throw new Error("No suitable land star");
}

function clearBoard(state: GameState): void {
  state.stacks = [];
  state.battles = [];
  state.enclosures = [];
  state.events = [];
  state.victory = { leaderId: null, holdTicks: 0, winnerId: null, reason: null };
  for (const id of state.map.landIds) {
    const tile = state.map.tiles[id]!;
    tile.owner = null;
    tile.units = unitsOf("melee", 1);
    tile.structure = null;
    tile.terrain = "water";
  }
}

function activeStructure(type: StructureType): NonNullable<TileState["structure"]> {
  return {
    type,
    completedCount: 1,
    status: "active",
    integrity: BALANCE.fullIntegrity,
    pendingProgressTicks: null,
    seizedTicks: 0,
    productionPaused: false,
    trainingProgressMilli: 0,
    rallyTargetId: null,
    rallyQueuedUnits: emptyUnits(),
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

function participant(playerId: number, type: "melee" | "ranged" | "wizard", count: number) {
  return {
    playerId,
    units: unitsOf(type, count),
    control: 5_000,
    casualtyProgressMilli: emptyUnits(),
    entryFrom: "0,0",
    joinedTick: 0,
    lastReinforcementTick: -1,
    reinforcementAmount: 0,
  };
}

describe("typed deterministic AI", () => {
  it("uses difficulty cadence without mutating authoritative resources", () => {
    expect(aiDecisionInterval("easy")).toBeGreaterThan(aiDecisionInterval("normal"));
    expect(aiDecisionInterval("normal")).toBeGreaterThan(aiDecisionInterval("hard"));
    const state = makeState("hard");
    const supplyBefore = state.players[1]!.supplyMilli;
    const commands = decideAiCommands(state, 1);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => validateCommand(state, command).ok)).toBe(true);
    expect(state.players[1]!.supplyMilli).toBe(supplyBefore);
  });

  it.each([
    ["barracks", "muster"],
    ["archery-range", "meadow"],
    ["wizard-tower", "plains"],
  ] as const)("builds %s on legal %s terrain", (structure, terrain) => {
    const state = makeState();
    const [site] = landStar(state, 1);
    clearBoard(state);
    site.terrain = terrain;
    site.owner = 1;
    site.units = unitsOf("melee", 1);
    state.players[1]!.supplyMilli = 500_000;
    const build = buildFrom(decideAiCommands(state, 1));
    expect(build).toMatchObject({ playerId: 1, tileId: site.id, structure });
    expect(validateCommand(state, build).ok).toBe(true);
  });

  it("expands from a mixed source into a weak neutral tile", () => {
    const state = makeState();
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.units = { melee: 4, ranged: 4, wizard: 4 };
    target.terrain = "meadow";
    target.units = unitsOf("melee", 1);
    const move = moveFrom(decideAiCommands(state, 1));
    expect(move).toMatchObject({ sourceId: source.id, destinationId: target.id });
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("values a developed typed-production target", () => {
    const state = makeState("hard");
    const [source, plain, developed] = landStar(state, 2);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("melee", 30);
    for (const target of [plain, developed]) {
      target.terrain = "plains";
      target.owner = 0;
      target.units = unitsOf("ranged", 2);
    }
    developed.structure = activeStructure("wizard-tower");
    expect(moveFrom(decideAiCommands(state, 1)).destinationId).toBe(developed.id);
  });

  it("credits a pure counter formation when it crosses the attack threshold", () => {
    const state = makeState("hard");
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = target.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("wizard", 9);
    target.owner = 0;
    target.units = unitsOf("melee", 8);

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move).toMatchObject({ sourceId: source.id, destinationId: target.id, percent: 100 });
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("reinforces an underpowered typed participant", () => {
    const state = makeState();
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("wizard", 40);
    target.terrain = "plains";
    target.owner = 0;
    target.units = emptyUnits();
    state.tick = 100;
    const battle: BattleState = {
      id: 91,
      tileId: target.id,
      incumbentOwner: 0,
      participants: [participant(0, "ranged", 18), participant(1, "wizard", 3)],
      ageTicks: 20,
      roundAccumulator: 0,
    };
    battle.participants.forEach((entry) => (entry.entryFrom = target.id));
    state.battles.push(battle);
    const move = moveFrom(decideAiCommands(state, 1));
    expect(move.destinationId).toBe(target.id);
    expect(state.players[1]!.aiMode).toBe("reinforce");
  });

  it("deliberately enters a favorable typed third-party battle", () => {
    const state = makeState("hard");
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("wizard", 40);
    target.terrain = "plains";
    target.owner = 0;
    target.units = emptyUnits();
    state.battles.push({
      id: 92,
      tileId: target.id,
      incumbentOwner: 0,
      participants: [participant(0, "melee", 4), participant(2, "ranged", 3)],
      ageTicks: 10,
      roundAccumulator: 0,
    });
    const move = moveFrom(decideAiCommands(state, 1));
    expect(move.destinationId).toBe(target.id);
    expect(validateCommand(state, move).ok).toBe(true);
  });

  it("rejects a third-party entry when the projected entrant buffs an incumbent counter", () => {
    const state = makeState("hard");
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    source.terrain = target.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("melee", 12);
    target.owner = 0;
    target.units = emptyUnits();
    state.players[1]!.supplyMilli = 0;
    state.battles.push({
      id: 93,
      tileId: target.id,
      incumbentOwner: 0,
      participants: [participant(0, "ranged", 1), participant(2, "wizard", 10)],
      ageTicks: 10,
      roundAccumulator: 0,
    });

    expect(
      decideAiCommands(state, 1).some(
        (command) => command.type === "move" && command.destinationId === target.id,
      ),
    ).toBe(false);
  });

  it("uses the aggressive two-survivor doctrine on Easy", () => {
    const state = makeState("easy");
    const [source, target] = landStar(state, 1);
    clearBoard(state);
    state.players[0]!.eliminated = true;
    state.players[3]!.eliminated = true;
    state.players[1]!.supplyMilli = 0;
    source.terrain = target.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("melee", 11);
    target.owner = 2;
    target.units = unitsOf("melee", 11);

    const move = moveFrom(decideAiCommands(state, 1));
    expect(move).toMatchObject({ sourceId: source.id, destinationId: target.id, percent: 100 });
  });

  it("prioritizes a breakout from a nearly completed enclosure", () => {
    const state = makeState();
    const [source, boundary] = landStar(state, 1);
    clearBoard(state);
    source.terrain = boundary.terrain = "plains";
    source.owner = 1;
    source.units = unitsOf("melee", 30);
    boundary.owner = 0;
    boundary.units = unitsOf("ranged", 3);
    state.enclosures = [
      {
        id: 94,
        captorId: 0,
        tileIds: [source.id],
        boundaryIds: [boundary.id],
        progressTicks: BALANCE.encirclementTicks - 1,
      },
    ];
    const move = moveFrom(decideAiCommands(state, 1));
    expect(move).toMatchObject({ sourceId: source.id, destinationId: boundary.id });
    expect(state.players[1]!.aiMode).toBe("breakout");
  });

  it("returns identical decisions without granting hidden forces", () => {
    const state = makeState("hard");
    const before = cloneDeterministic({
      supply: state.players.map((player) => player.supplyMilli),
      units: state.map.landIds.map((id) => state.map.tiles[id]!.units),
      structures: state.map.landIds.map((id) => state.map.tiles[id]!.structure),
      battles: state.battles,
      stacks: state.stacks,
    });
    const left = cloneDeterministic(state);
    const right = cloneDeterministic(state);
    expect(stableStringify(decideAiCommands(left, 2))).toBe(
      stableStringify(decideAiCommands(right, 2)),
    );
    decideAiCommands(state, 1);
    expect({
      supply: state.players.map((player) => player.supplyMilli),
      units: state.map.landIds.map((id) => state.map.tiles[id]!.units),
      structures: state.map.landIds.map((id) => state.map.tiles[id]!.structure),
      battles: state.battles,
      stacks: state.stacks,
    }).toEqual(before);
    expect(state.map.landIds.every((id) => totalUnits(state.map.tiles[id]!.units) >= 0)).toBe(true);
  });
});

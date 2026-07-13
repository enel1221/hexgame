import { describe, expect, it } from "vitest";
import {
  applySpawnAllocations,
  axialKey,
  battlePresentation,
  chooseDefaultSpawnCenters,
  cloneDeterministic,
  createGame,
  handleStackArrival,
  hashGameState,
  neighbors,
  stableStringify,
  startBattle,
  tickCombat,
  totalUnits,
  unitsOf,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import type {
  GameState,
  StructureState,
  StructureType,
  TileState,
  UnitCounts,
  UnitType,
} from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function runningState(seed: string, aiCount = 3): GameState {
  const state = createGame({ ...TEST_CONFIG, seed, aiCount }).state;
  const centers = chooseDefaultSpawnCenters(state.map, state.players.length, `${seed}:tests`);
  applySpawnAllocations(state.map, centers, `${seed}:tests`);
  state.config.startingCenters = centers;
  state.phase = "running";
  return state;
}

function structure(
  type: StructureType,
  count: number,
  integrity = BALANCE.fullIntegrity,
): StructureState {
  return {
    type,
    completedCount: count,
    status: "active",
    integrity,
    pendingProgressTicks: null,
    seizedTicks: 0,
    productionPaused: false,
    trainingProgressMilli: 0,
    rallyTargetId: null,
    rallyQueuedUnits: unitsOf("melee", 0),
  };
}

function tickCombatFor(state: GameState, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    state.tick += 1;
    tickCombat(state);
  }
}

function battleTile(state: GameState): TileState {
  for (const tileId of state.map.landIds) state.map.tiles[tileId]!.structure = null;
  const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
  tile.terrain = "plains";
  return tile;
}

function runPlainsBattle(attacker: UnitCounts): { ticks: number; owner: number | null } {
  const state = runningState(`combat-${JSON.stringify(attacker)}`);
  const tile = battleTile(state);
  tile.units = unitsOf("melee", 1);
  startBattle(state, tile, 1, attacker, tile.id);
  let ticks = 0;
  while (state.battles.length > 0 && ticks < 400) {
    tickCombatFor(state, 1);
    ticks += 1;
  }
  return { ticks, owner: tile.owner };
}

function ownedLandStar(
  state: GameState,
  owner: number,
  count: number,
): [TileState, ...TileState[]] {
  for (const id of state.map.landIds) {
    const center = state.map.tiles[id]!;
    const adjacent = neighbors(center)
      .map((hex) => state.map.tiles[axialKey(hex)])
      .filter((tile): tile is TileState => Boolean(tile && tile.terrain !== "water"));
    if (adjacent.length < count) continue;
    center.owner = owner;
    center.units = unitsOf("melee", 20);
    center.structure = null;
    for (const tile of adjacent.slice(0, count)) {
      tile.owner = owner;
      tile.units = unitsOf("melee", 20);
      tile.structure = null;
      tile.terrain = "plains";
    }
    return [center, ...adjacent.slice(0, count)];
  }
  throw new Error("No suitable land star");
}

describe("typed deterministic combat", () => {
  it.each([
    [20, 35, 42],
    [5, 45, 55],
    [2, 65, 85],
  ])("preserves the same-type %i versus one timing window", (count, minimum, maximum) => {
    const result = runPlainsBattle(unitsOf("melee", count));
    expect(result.owner).toBe(1);
    expect(result.ticks).toBeGreaterThanOrEqual(minimum);
    expect(result.ticks).toBeLessThanOrEqual(maximum);
  });

  it("gives an exact same-composition tie to the incumbent", () => {
    const result = runPlainsBattle(unitsOf("melee", 1));
    expect(result.owner).toBe(0);
    expect(result.ticks).toBeGreaterThanOrEqual(90);
  });

  it.each([
    ["wizard", "melee"],
    ["ranged", "wizard"],
    ["melee", "ranged"],
  ] as const)("gives %s a visible 1.5x advantage over %s", (winner, loser) => {
    const state = runningState(`rps-${winner}-${loser}`);
    const tile = battleTile(state);
    tile.units = unitsOf(loser, 10);
    const battle = startBattle(state, tile, 1, unitsOf(winner, 10), tile.id);
    const view = battlePresentation(state, battle);
    expect(view.find((entry) => entry.playerId === 1)).toMatchObject({
      effectivePower: 15_000,
      rpsMultiplierPermille: 1_500,
      sharePermyriad: 6_000,
    });
    expect(view.find((entry) => entry.playerId === 0)).toMatchObject({
      effectivePower: 10_000,
      rpsMultiplierPermille: 1_000,
      sharePermyriad: 4_000,
    });
  });

  it("weights a mixed formation against aggregate hostile composition", () => {
    const state = runningState("rps-mixed");
    const tile = battleTile(state);
    tile.units = unitsOf("melee", 10);
    const battle = startBattle(state, tile, 1, { melee: 5, ranged: 0, wizard: 5 }, tile.id);
    const attacker = battlePresentation(state, battle).find((entry) => entry.playerId === 1)!;
    expect(attacker.basePower).toBe(10_000);
    expect(attacker.effectivePowerByType).toEqual({ melee: 5_000, ranged: 0, wizard: 7_500 });
    expect(attacker.rpsMultiplierPermille).toBe(1_250);
  });

  it("runs 6v8v20 immediately as three typed participants and preserves all outgoing pressure", () => {
    const state = runningState("combat-6v8v20");
    const tile = battleTile(state);
    tile.units = unitsOf("melee", 6);
    const battle = startBattle(state, tile, 1, unitsOf("ranged", 8), tile.id);
    handleStackArrival(state, 2, unitsOf("wizard", 20), tile.id, tile.id);
    expect(battle.participants.map(({ playerId, units }) => ({ playerId, units }))).toEqual([
      { playerId: 0, units: unitsOf("melee", 6) },
      { playerId: 1, units: unitsOf("ranged", 8) },
      { playerId: 2, units: unitsOf("wizard", 20) },
    ]);
    tickCombatFor(state, 10);
    expect(battle.participants).toHaveLength(3);
    expect(
      battle.participants.every((participant) => totalUnits(participant.casualtyProgressMilli) > 0),
    ).toBe(true);
    tickCombatFor(state, 260);
    expect(state.battles).toHaveLength(0);
    expect(tile.owner).toBe(2);
  });

  it("normalizes participant insertion order before typed rules and hashing", () => {
    const left = runningState("participant-order");
    const tile = battleTile(left);
    tile.units = unitsOf("melee", 6);
    startBattle(left, tile, 1, unitsOf("ranged", 8), tile.id);
    handleStackArrival(left, 2, unitsOf("wizard", 20), tile.id, tile.id);
    const right = cloneDeterministic(left);
    right.battles[0]!.participants.reverse();
    tickCombatFor(left, 1);
    tickCombatFor(right, 1);
    left.stateHash = hashGameState(left);
    right.stateHash = hashGameState(right);
    expect(right.stateHash).toBe(left.stateHash);
    expect(stableStringify(right)).toBe(stableStringify(left));
  });

  it("projects stable shares totaling exactly 10,000 for all 21 rulers", () => {
    const state = runningState("twenty-one-way", 20);
    const tile = battleTile(state);
    tile.units = unitsOf("melee", 2);
    const battle = startBattle(state, tile, 1, unitsOf("ranged", 2), tile.id);
    const types: UnitType[] = ["melee", "ranged", "wizard"];
    for (let playerId = 2; playerId < 21; playerId += 1) {
      handleStackArrival(
        state,
        playerId,
        unitsOf(types[playerId % types.length]!, playerId + 1),
        tile.id,
        tile.id,
      );
    }
    const presentation = battlePresentation(state, battle);
    expect(presentation).toHaveLength(21);
    expect(presentation.reduce((sum, participant) => sum + participant.sharePermyriad, 0)).toBe(
      10_000,
    );
    expect(presentation.map((participant) => participant.playerId)).toEqual(
      Array.from({ length: 21 }, (_, id) => id),
    );
  });
});

describe("aggregate typed structure support", () => {
  it("adds two local typed equivalents per copy, capped at twelve and integrity-scaled", () => {
    const state = runningState("local-support");
    const tile = battleTile(state);
    tile.units = unitsOf("melee", 1);
    tile.structure = structure("wizard-tower", 3);
    const battle = startBattle(state, tile, 1, unitsOf("melee", 10), tile.id);
    const incumbent = battlePresentation(state, battle).find((entry) => entry.playerId === 0)!;
    expect(incumbent.localSupportPower).toEqual({ melee: 0, ranged: 0, wizard: 6_000 });
    expect(incumbent.effectivePower).toBe(10_000);

    tile.structure!.completedCount = 99;
    tile.structure!.integrity = BALANCE.seizedIntegrity;
    const repaired = battlePresentation(state, battle).find((entry) => entry.playerId === 0)!;
    expect(repaired.localSupportPower.wizard).toBe(4_800);
  });

  it("lets the correct troop type counter typed home support", () => {
    const state = runningState("counter-local-support");
    const tile = battleTile(state);
    tile.units = unitsOf("melee", 1);
    tile.structure = structure("wizard-tower", 3);
    const battle = startBattle(state, tile, 1, unitsOf("ranged", 10), tile.id);
    const view = battlePresentation(state, battle);
    expect(view.find((entry) => entry.playerId === 1)!.effectivePower).toBeGreaterThan(
      view.find((entry) => entry.playerId === 0)!.effectivePower,
    );
  });

  it("caps one adjacent x99 source at six typed equivalents", () => {
    const state = runningState("adjacent-source-cap");
    const [source, target] = ownedLandStar(state, 0, 1);
    source.structure = structure("archery-range", 99);
    target.owner = 1;
    target.units = unitsOf("wizard", 20);
    const battle = startBattle(state, target, 0, unitsOf("melee", 5), source.id);
    const attacker = battlePresentation(state, battle).find((entry) => entry.playerId === 0)!;
    expect(attacker.adjacentSupportPower).toEqual({ melee: 0, ranged: 6_000, wizard: 0 });
  });

  it("caps aggregate adjacent support at twelve per faction and battle", () => {
    const state = runningState("adjacent-global-cap");
    const [target, ...sources] = ownedLandStar(state, 0, 6);
    target.owner = 1;
    target.units = unitsOf("melee", 30);
    const types: StructureType[] = ["barracks", "archery-range", "wizard-tower"];
    for (let index = 0; index < sources.length; index += 1) {
      sources[index]!.structure = structure(types[index % types.length]!, 99);
    }
    const battle = startBattle(state, target, 0, unitsOf("melee", 5), sources[0]!.id);
    const attacker = battlePresentation(state, battle).find((entry) => entry.playerId === 0)!;
    expect(totalUnits(attacker.adjacentSupportPower)).toBe(12_000);
  });

  it("never creates a participant or projects outward while its home tile is contested", () => {
    const state = runningState("support-no-participant");
    const [source, target] = ownedLandStar(state, 0, 1);
    source.structure = structure("wizard-tower", 99);
    source.units = unitsOf("melee", 5);
    target.owner = 1;
    target.units = unitsOf("melee", 10);
    const nearby = startBattle(state, target, 2, unitsOf("ranged", 10), source.id);
    const home = startBattle(state, source, 1, unitsOf("wizard", 10), target.id);
    home.participants = home.participants.filter((participant) => participant.playerId !== 0);
    expect(battlePresentation(state, nearby).some((entry) => entry.playerId === 0)).toBe(false);
    expect(
      battlePresentation(state, nearby).reduce(
        (sum, entry) => sum + totalUnits(entry.adjacentSupportPower),
        0,
      ),
    ).toBe(0);
  });
});

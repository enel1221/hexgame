import { describe, expect, it } from "vitest";
import {
  applySpawnAllocations,
  axialKey,
  battlePresentation,
  chooseDefaultSpawnCenters,
  cloneDeterministic,
  createGame,
  defenderEffectivePower,
  handleStackArrival,
  hashGameState,
  neighbors,
  ring,
  stableStringify,
  startBattle,
  tickCombat,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import type { GameState, StructureState, TileState } from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function runningState(seed: string, aiCount = 3): GameState {
  const state = createGame({ ...TEST_CONFIG, seed, aiCount }).state;
  const centers = chooseDefaultSpawnCenters(state.map, state.players.length, `${seed}:tests`);
  applySpawnAllocations(state.map, centers, `${seed}:tests`);
  state.config.startingCenters = centers;
  state.phase = "running";
  return state;
}

function activeTurrets(count: number, integrity: number = BALANCE.fullIntegrity): StructureState {
  return {
    type: "turret",
    completedCount: count,
    status: "active",
    integrity,
    pendingProgressTicks: null,
    seizedTicks: 0,
    productionPaused: false,
    barracksProgressMilli: 0,
    rallyTargetId: null,
    rallyQueuedTroops: 0,
    turretShotProgressMilli: 0,
  };
}

function runPlainsBattle(attackerTroops: number): { ticks: number; owner: number | null } {
  const state = runningState(`combat-${attackerTroops}`);
  const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
  tile.structure = null;
  tile.terrain = "plains";
  tile.troops = 1;
  startBattle(state, tile, 1, attackerTroops, tile.id);
  let ticks = 0;
  while (state.battles.length > 0 && ticks < 300) {
    state.tick += 1;
    tickCombat(state);
    ticks += 1;
  }
  return { ticks, owner: tile.owner };
}

function tickCombatFor(state: GameState, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    state.tick += 1;
    tickCombat(state);
  }
}

function ownedLandStar(
  state: GameState,
  owner: number,
  neighborCount: number,
): [TileState, ...TileState[]] {
  for (const id of state.map.landIds) {
    const center = state.map.tiles[id]!;
    const adjacent = neighbors(center)
      .map((hex) => state.map.tiles[axialKey(hex)])
      .filter((tile): tile is TileState => Boolean(tile && tile.terrain !== "water"));
    if (adjacent.length < neighborCount) continue;
    center.owner = owner;
    center.troops = 20;
    for (const tile of adjacent.slice(0, neighborCount)) {
      tile.owner = owner;
      tile.troops = 20;
      tile.structure = null;
      tile.terrain = "plains";
    }
    return [center, ...adjacent.slice(0, neighborCount)];
  }
  throw new Error("No suitable land star");
}

function safeTurretSource(state: GameState): TileState {
  const land = new Set(state.map.landIds);
  const id = state.map.landIds.find((candidate) =>
    ring(state.map.tiles[candidate]!, 2)
      .map(axialKey)
      .every((within) => land.has(within)),
  );
  if (!id) throw new Error("No inland Turret source");
  return state.map.tiles[id]!;
}

function ringTwoTarget(state: GameState, source: TileState): TileState {
  const id = ring(source, 2)
    .map(axialKey)
    .find((candidate) => state.map.tiles[candidate]?.terrain !== "water");
  if (!id) throw new Error("No range-two target");
  return state.map.tiles[id]!;
}

describe("deterministic N-faction combat", () => {
  it.each([
    [20, 35, 42],
    [5, 45, 55],
    [2, 65, 85],
  ])("keeps the legacy %i vs 1 timing window", (troops, minimum, maximum) => {
    const result = runPlainsBattle(troops);
    expect(result.owner).toBe(1);
    expect(result.ticks).toBeGreaterThanOrEqual(minimum);
    expect(result.ticks).toBeLessThanOrEqual(maximum);
  });

  it("gives an exact two-faction tie to the incumbent", () => {
    const result = runPlainsBattle(1);
    expect(result.owner).toBe(0);
    expect(result.ticks).toBeGreaterThanOrEqual(90);
  });

  it("runs 6v8v20 immediately as three independent participants and red wins", () => {
    const state = runningState("combat-6v8v20");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.structure = null;
    tile.terrain = "plains";
    tile.troops = 6;
    const battle = startBattle(state, tile, 1, 8, tile.id);
    handleStackArrival(state, 2, 20, tile.id, tile.id);

    expect(battle.participants.map(({ playerId, troops }) => ({ playerId, troops }))).toEqual([
      { playerId: 0, troops: 6 },
      { playerId: 1, troops: 8 },
      { playerId: 2, troops: 20 },
    ]);
    tickCombatFor(state, 10);
    expect(battle.participants).toHaveLength(3);
    expect(battle.participants.every((participant) => participant.casualtyProgressMilli > 0)).toBe(
      true,
    );
    expect(
      battle.participants.find((participant) => participant.playerId === 2)!.control,
    ).toBeGreaterThan(5_000);
    expect(
      battle.participants.find((participant) => participant.playerId === 0)!.control,
    ).toBeLessThan(5_000);

    tickCombatFor(state, 240);
    expect(state.battles).toHaveLength(0);
    expect(tile.owner).toBe(2);
  });

  it("normalizes participant insertion order before rules and hashing", () => {
    const left = runningState("participant-order");
    const tile = left.map.tiles[left.map.spawnClusters[0]![1]!]!;
    tile.structure = null;
    tile.terrain = "plains";
    tile.troops = 6;
    startBattle(left, tile, 1, 8, tile.id);
    handleStackArrival(left, 2, 20, tile.id, tile.id);
    const right = cloneDeterministic(left);
    right.battles[0]!.participants.reverse();
    tickCombatFor(left, 1);
    tickCombatFor(right, 1);
    left.stateHash = hashGameState(left);
    right.stateHash = hashGameState(right);
    expect(right.stateHash).toBe(left.stateHash);
    expect(stableStringify(right)).toBe(stableStringify(left));
  });

  it("breaks a simultaneous all-faction elimination by power, incumbent, then player ID", () => {
    const state = runningState("combat-total-elimination");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.structure = null;
    tile.terrain = "plains";
    tile.troops = 5;
    const battle = startBattle(state, tile, 1, 5, tile.id);
    handleStackArrival(state, 2, 5, tile.id, tile.id);
    battle.ageTicks = BALANCE.minimumBattleTicks - 1;
    battle.roundAccumulator = BALANCE.combatRoundTicks - 1;
    for (const participant of battle.participants) participant.control = 1;
    tickCombatFor(state, 1);
    expect(state.battles).toHaveLength(0);
    expect(tile.owner).toBe(0);
    expect(tile.troops).toBeGreaterThan(0);
  });

  it("merges same-faction arrivals and admits a fourth faction without restarting age", () => {
    const state = runningState("four-factions");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.structure = null;
    tile.troops = 6;
    const battle = startBattle(state, tile, 1, 8, tile.id);
    tickCombatFor(state, 12);
    handleStackArrival(state, 1, 4, tile.id, tile.id);
    handleStackArrival(state, 2, 20, tile.id, tile.id);
    handleStackArrival(state, 3, 7, tile.id, tile.id);
    expect(battle.ageTicks).toBe(12);
    expect(battle.participants).toHaveLength(4);
    expect(battle.participants.find((participant) => participant.playerId === 1)?.troops).toBe(12);
    expect(battle.participants.find((participant) => participant.playerId === 1)).toMatchObject({
      lastReinforcementTick: state.tick,
      reinforcementAmount: 4,
    });
  });

  it("projects exactly 10,000 stable power shares for all 21 rulers", () => {
    const state = runningState("twenty-one-way", 20);
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.structure = null;
    tile.troops = 2;
    const battle = startBattle(state, tile, 1, 2, tile.id);
    for (let playerId = 2; playerId < 21; playerId += 1) {
      handleStackArrival(state, playerId, playerId + 1, tile.id, tile.id);
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

describe("aggregate Turret defense and firing", () => {
  it("makes one defender plus x3 full Turrets approximately ten equivalents", () => {
    const state = runningState("turret-power");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.terrain = "plains";
    tile.troops = 1;
    tile.structure = activeTurrets(3);
    expect(defenderEffectivePower(tile, 1)).toBe(10_220);
    tile.structure.integrity = BALANCE.seizedIntegrity;
    expect(defenderEffectivePower(tile, 1)).toBeGreaterThan(1_000);
    expect(defenderEffectivePower(tile, 1)).toBeLessThan(10_220);
  });

  it("fires x3 as one accumulator for one casualty per ten eligible ticks", () => {
    const state = runningState("turret-cadence");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.terrain = "plains";
    tile.troops = 5;
    tile.structure = activeTurrets(3);
    const battle = startBattle(state, tile, 1, 50, tile.id);
    tickCombatFor(state, 9);
    expect(battle.participants.find((participant) => participant.playerId === 1)?.troops).toBe(50);
    tickCombatFor(state, 1);
    expect(battle.participants.find((participant) => participant.playerId === 1)?.troops).toBe(49);
    tickCombatFor(state, 20);
    expect(battle.participants.find((participant) => participant.playerId === 1)?.troops).toBe(47);
    expect(tile.structure?.turretShotProgressMilli).toBe(0);
  });

  it("does not fire or create a faction after the Turret owner has no troops present", () => {
    const state = runningState("turret-owner-absent");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.terrain = "plains";
    tile.troops = 5;
    tile.structure = activeTurrets(3);
    const battle = startBattle(state, tile, 1, 50, tile.id);
    battle.participants = battle.participants.filter((participant) => participant.playerId !== 0);
    tickCombatFor(state, 10);
    expect(battle.participants).toEqual([expect.objectContaining({ playerId: 1, troops: 50 })]);
    expect(tile.structure.turretShotProgressMilli).toBe(0);
  });

  it("divides one aggregate volley across adjacent battles without duplicating shots", () => {
    const state = runningState("turret-multiple-battles");
    const [source, first, second] = ownedLandStar(state, 0, 2);
    source.structure = activeTurrets(3);
    source.troops = 10;
    first.owner = 1;
    first.troops = 8;
    second.owner = 2;
    second.troops = 8;
    const firstBattle = startBattle(state, first, 0, 8, source.id);
    const secondBattle = startBattle(state, second, 0, 8, source.id);
    tickCombatFor(state, 10);
    const hostileRemaining =
      firstBattle.participants.find((participant) => participant.playerId === 1)!.troops +
      secondBattle.participants.find((participant) => participant.playerId === 2)!.troops;
    expect(hostileRemaining).toBe(15);
    expect(
      state.events.filter(
        (event) => event.type === "turret-volley" && event.sourceTileId === source.id,
      ),
    ).toHaveLength(1);
  });

  it("prioritizes its own contested tile over an adjacent battle", () => {
    const state = runningState("turret-own-priority");
    const [source, adjacent] = ownedLandStar(state, 0, 1);
    source.structure = activeTurrets(3);
    source.troops = 5;
    adjacent.owner = 1;
    adjacent.troops = 8;
    const adjacentBattle = startBattle(state, adjacent, 0, 8, source.id);
    const homeBattle = startBattle(state, source, 2, 50, adjacent.id);
    tickCombatFor(state, 10);
    expect(homeBattle.participants.find((participant) => participant.playerId === 2)?.troops).toBe(
      49,
    );
    expect(
      adjacentBattle.participants.find((participant) => participant.playerId === 1)?.troops,
    ).toBe(8);
  });

  it("scales shot cadence with integrity and never reaches beyond six adjacent hexes", () => {
    const state = runningState("turret-integrity-range");
    const source = safeTurretSource(state);
    source.structure = activeTurrets(3, BALANCE.seizedIntegrity);
    source.owner = 0;
    source.troops = 8;
    const distant = ringTwoTarget(state, source);
    distant.owner = 1;
    distant.troops = 20;
    const distantBattle = startBattle(state, distant, 0, 1, source.id);
    tickCombatFor(state, 30);
    expect(
      distantBattle.participants.find((participant) => participant.playerId === 1)?.troops,
    ).toBe(20);

    const adjacent = neighbors(source)
      .map((hex) => state.map.tiles[axialKey(hex)])
      .find((tile) => tile && tile.terrain !== "water" && tile.id !== distant.id)!;
    adjacent.owner = 1;
    adjacent.troops = 20;
    const adjacentBattle = startBattle(state, adjacent, 0, 1, source.id);
    tickCombatFor(state, 24);
    expect(
      adjacentBattle.participants.find((participant) => participant.playerId === 1)?.troops,
    ).toBe(20);
    tickCombatFor(state, 1);
    expect(
      adjacentBattle.participants.find((participant) => participant.playerId === 1)?.troops,
    ).toBe(19);
  });

  it("targets N-way hostiles proportionally from one x99 stack and creates no per-copy entities", () => {
    const state = runningState("turret-n-way-x99");
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.terrain = "plains";
    tile.troops = 5;
    tile.structure = activeTurrets(99);
    const battle = startBattle(state, tile, 1, 10, tile.id);
    handleStackArrival(state, 2, 20, tile.id, tile.id);
    const entitiesBefore = state.stacks.length + state.battles.length;
    tickCombatFor(state, 1);
    expect(battle.participants.find((participant) => participant.playerId === 1)?.troops).toBe(9);
    expect(battle.participants.find((participant) => participant.playerId === 2)?.troops).toBe(18);
    expect(state.stacks.length + state.battles.length).toBe(entitiesBefore);
    expect(
      state.events.filter(
        (event) => event.type === "turret-volley" && event.sourceTileId === tile.id,
      ),
    ).toEqual([expect.objectContaining({ amount: 3 })]);
  });

  it("cannot fire into or capture a nearby battle without its owner participating", () => {
    const state = runningState("turret-no-participant");
    const [source, target] = ownedLandStar(state, 0, 1);
    source.structure = activeTurrets(99);
    target.owner = 1;
    target.troops = 10;
    const battle = startBattle(state, target, 2, 10, source.id);
    tickCombatFor(state, 1);
    expect(battle.participants.find((participant) => participant.playerId === 1)?.troops).toBe(10);
    expect(battle.participants.find((participant) => participant.playerId === 2)?.troops).toBe(10);
    expect(battle.participants.some((participant) => participant.playerId === 0)).toBe(false);
    expect(
      state.events.some(
        (event) => event.type === "turret-volley" && event.sourceTileId === source.id,
      ),
    ).toBe(false);
  });

  it("keeps x3 Turrets defensible by the requested near-threshold assault", () => {
    const defend = (attackers: number): number | null => {
      const state = runningState(`turret-threshold-${attackers}`);
      const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
      tile.terrain = "plains";
      tile.troops = 1;
      tile.structure = activeTurrets(3);
      startBattle(state, tile, 1, attackers, tile.id);
      tickCombatFor(state, 240);
      return tile.owner;
    };
    expect(defend(10)).toBe(0);
    expect(defend(14)).toBe(1);
  });
});

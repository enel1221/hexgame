import { describe, expect, it } from "vitest";
import {
  createGame,
  defenderEffectivePower,
  handleStackArrival,
  startBattle,
  tickCombat,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import { TEST_CONFIG } from "./fixtures";

function runPlainsBattle(attackerTroops: number): { ticks: number; owner: number | null } {
  const state = createGame({ ...TEST_CONFIG, seed: `combat-${attackerTroops}` }).state;
  const tile = Object.values(state.map.tiles).find(
    (candidate) => candidate.owner === 0 && !candidate.structure,
  )!;
  tile.terrain = "plains";
  tile.troops = 1;
  startBattle(state, tile, 1, attackerTroops, "entry");
  let ticks = 0;
  while (state.battles.length > 0 && ticks < 300) {
    state.tick += 1;
    tickCombat(state);
    ticks += 1;
  }
  return { ticks, owner: tile.owner };
}

describe("deterministic multi-second combat", () => {
  it.each([
    [20, 35, 42],
    [5, 45, 55],
    [2, 65, 85],
  ])("resolves %i vs 1 in its readable timing window", (troops, minimum, maximum) => {
    const result = runPlainsBattle(troops);
    expect(result.owner).toBe(1);
    expect(result.ticks).toBeGreaterThanOrEqual(minimum);
    expect(result.ticks).toBeLessThanOrEqual(maximum);
  });

  it("gives exact ties a terminating defender advantage", () => {
    const result = runPlainsBattle(1);
    expect(result.owner).toBe(0);
    expect(result.ticks).toBeGreaterThanOrEqual(90);
  });

  it("records reinforcement impact and visibly queues a third challenger", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "reinforcement" }).state;
    const tile = Object.values(state.map.tiles).find(
      (candidate) => candidate.owner === 0 && !candidate.structure,
    )!;
    tile.troops = 1;
    const battle = startBattle(state, tile, 1, 20, "west");
    handleStackArrival(state, 1, 4, tile.id, "west");
    expect(battle.attackerTroops).toBe(24);
    expect(battle.reinforcementSide).toBe("attacker");
    expect(battle.reinforcementAmount).toBe(4);

    handleStackArrival(state, 2, 6, tile.id, "east");
    expect(battle.waiting).toEqual([
      expect.objectContaining({ owner: 2, troops: 6, entryFrom: "east" }),
    ]);
    while (state.battles[0]?.id === battle.id) {
      state.tick += 1;
      tickCombat(state);
    }
    expect(state.battles[0]).toEqual(
      expect.objectContaining({ tileId: tile.id, defender: 1, attacker: 2, attackerTroops: 6 }),
    );
  });

  it("scales Forest, Hills, full Turret, and damaged Turret defense", () => {
    const state = createGame({ ...TEST_CONFIG, seed: "defense-scaling" }).state;
    const tile = state.map.tiles[state.map.spawnClusters[0]![1]!]!;
    tile.structure = null;
    tile.terrain = "plains";
    const plains = defenderEffectivePower(tile, 10);
    tile.terrain = "forest";
    const forest = defenderEffectivePower(tile, 10);
    tile.terrain = "hills";
    const hills = defenderEffectivePower(tile, 10);
    tile.terrain = "plains";
    tile.structure = {
      type: "turret",
      status: "active",
      integrity: BALANCE.fullIntegrity,
      progressTicks: 0,
      seizedTicks: 0,
      productionPaused: false,
    };
    const fullTurret = defenderEffectivePower(tile, 10);
    tile.structure.integrity = BALANCE.seizedIntegrity;
    const damagedTurret = defenderEffectivePower(tile, 10);

    expect(plains).toBe(10_000);
    expect(forest).toBeGreaterThan(plains);
    expect(hills).toBeGreaterThan(forest);
    expect(fullTurret).toBeGreaterThan(hills);
    expect(damagedTurret).toBeGreaterThan(plains);
    expect(damagedTurret).toBeLessThan(fullTurret);
  });
});

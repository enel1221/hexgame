import { describe, expect, it } from "vitest";
import { createGame, refreshPlayerAggregates } from "../../src/core";
import type { Difficulty, MapArchetype, MatchConfig } from "../../src/shared/types";

interface SmokeCase {
  label: string;
  seed: string;
  archetype: MapArchetype;
  aiCount: number;
  difficulty: Difficulty;
  maxTicks: number;
}

interface SmokeStats {
  label: string;
  players: number;
  difficulty: Difficulty;
  tick: number;
  winner: number | null;
  eliminated: number;
  captures: number;
  neutral: number;
  uniqueMovingStacks: number;
  maxStacks: number;
  maxBattles: number;
  elapsedMs: number;
}

function configFor(testCase: SmokeCase): MatchConfig {
  return {
    seed: testCase.seed,
    archetype: testCase.archetype,
    aiCount: testCase.aiCount,
    difficulty: testCase.difficulty,
    playerName: "Headless AI",
    graphics: "low",
    sound: false,
    colorPatterns: true,
    debug: false,
  };
}

function runSmoke(testCase: SmokeCase): SmokeStats {
  const engine = createGame(configFor(testCase));
  // A headless all-bot match exercises the same public AI scheduler while
  // retaining the production-supported 4..21-player map configurations.
  engine.state.players[0]!.isHuman = false;
  let maxStacks = 0;
  let maxBattles = 0;
  const movingStackIds = new Set<number>();
  const startedAt = performance.now();

  while (engine.state.tick < testCase.maxTicks && engine.state.victory.winnerId === null) {
    engine.tick();
    for (const stack of engine.state.stacks) movingStackIds.add(stack.id);
    maxStacks = Math.max(maxStacks, engine.state.stacks.length);
    maxBattles = Math.max(maxBattles, engine.state.battles.length);

    if (engine.state.tick % 100 === 0) {
      expect(engine.state.stacks.every((stack) => stack.troops > 0)).toBe(true);
      expect(
        engine.state.battles.every(
          (battle) => battle.attackerTroops > 0 && battle.defenderTroops >= 0,
        ),
      ).toBe(true);
    }
  }

  const players = engine.state.players.length;
  const stats: SmokeStats = {
    label: testCase.label,
    players,
    difficulty: testCase.difficulty,
    tick: engine.state.tick,
    winner: engine.state.victory.winnerId,
    eliminated: engine.state.players.filter((player) => player.eliminated).length,
    captures: engine.state.players.reduce((total, player) => total + player.stats.tilesCaptured, 0),
    neutral: engine.state.map.landIds.filter((id) => engine.state.map.tiles[id]!.owner === null)
      .length,
    uniqueMovingStacks: movingStackIds.size,
    maxStacks,
    maxBattles,
    elapsedMs: Math.round(performance.now() - startedAt),
  };

  // An AI can issue at most a small, cadence-limited batch per evaluation.
  // These generous player-scaled ceilings catch runaway entity creation while
  // allowing normal overlap between long logistics routes and battles.
  expect(maxStacks).toBeLessThanOrEqual(players * 8);
  expect(maxBattles).toBeLessThanOrEqual(players * 8);
  expect(stats.captures).toBeGreaterThan(0);
  expect(engine.state.tick).toBeGreaterThan(0);
  return stats;
}

describe("headless AI smoke simulations", () => {
  it("keeps multiple 4/8-player matches and a 21-player match active and bounded", () => {
    const cases: SmokeCase[] = [
      {
        label: "four-normal-resolution",
        seed: "stalemate-a",
        archetype: "heartland",
        aiCount: 3,
        difficulty: "normal",
        maxTicks: 13_000,
      },
      {
        label: "four-easy-resolution",
        seed: "stalemate-a",
        archetype: "heartland",
        aiCount: 3,
        difficulty: "easy",
        maxTicks: 14_000,
      },
      {
        label: "eight-normal-variety",
        seed: "eight-smoke-a",
        archetype: "highland-basin",
        aiCount: 7,
        difficulty: "normal",
        maxTicks: 1_800,
      },
      {
        label: "eight-hard-variety",
        seed: "eight-smoke-b",
        archetype: "broken-crown",
        aiCount: 7,
        difficulty: "hard",
        maxTicks: 1_800,
      },
      {
        label: "twenty-one-hard-capacity",
        seed: "twenty-one-smoke",
        archetype: "heartland",
        aiCount: 20,
        difficulty: "hard",
        maxTicks: 500,
      },
    ];

    const aggregate = cases.map(runSmoke);
    console.info(`[ai-smoke] ${JSON.stringify(aggregate)}`);
    // These were originally passive 15k-tick stockpiling regressions. Do not
    // pin winner identities; require deterministic natural resolution in the
    // intended mature-match window instead.
    expect(aggregate[0]!.winner).not.toBeNull();
    expect(aggregate[0]!.tick).toBeLessThanOrEqual(9_000);
    expect(aggregate[1]!.winner).not.toBeNull();
    expect(aggregate[1]!.tick).toBeLessThanOrEqual(10_000);
    expect(aggregate.every((entry) => entry.captures > 0)).toBe(true);
    expect(aggregate[4]!.uniqueMovingStacks).toBeGreaterThanOrEqual(100);
  }, 120_000);

  it("identifies an AI ruler as the winner after a stable 80% hold", () => {
    const engine = createGame(
      configFor({
        label: "constructed-ai-victory",
        seed: "constructed-ai-victory",
        archetype: "heartland",
        aiCount: 3,
        difficulty: "normal",
        maxTicks: 150,
      }),
    );
    const threshold = Math.ceil(engine.state.map.landCount * 0.8);
    for (const [index, id] of engine.state.map.landIds.entries()) {
      const tile = engine.state.map.tiles[id]!;
      tile.owner = index < threshold ? 1 : 0;
      tile.troops = 1;
      tile.structure = null;
    }
    engine.state.players[2]!.eliminated = true;
    engine.state.players[3]!.eliminated = true;
    engine.state.victory = { leaderId: null, holdTicks: 0, winnerId: null, reason: null };
    refreshPlayerAggregates(engine.state);

    engine.step(150);
    const winnerId = engine.state.victory.winnerId;
    expect(winnerId).not.toBeNull();
    expect(engine.state.players[winnerId!]!.isHuman).toBe(false);
    expect(engine.state.victory.reason).toBe("control");
  });

  it("lets an AI finish an isolated last territory and eliminate its owner", () => {
    const engine = createGame(
      configFor({
        label: "constructed-ai-elimination",
        seed: "constructed-ai-elimination",
        archetype: "broken-crown",
        aiCount: 3,
        difficulty: "normal",
        maxTicks: 200,
      }),
    );
    const targetId = engine.state.map.spawnCenters[0]!;
    const sourceId = engine.state.map.spawnClusters[0]!.find((id) => id !== targetId)!;
    for (const id of engine.state.map.landIds) {
      const tile = engine.state.map.tiles[id]!;
      tile.owner = 1;
      tile.troops = 1;
      tile.structure = null;
    }
    engine.state.map.tiles[targetId]!.owner = 0;
    engine.state.map.tiles[targetId]!.troops = 1;
    engine.state.map.tiles[sourceId]!.troops = 50;
    engine.state.players[2]!.eliminated = true;
    engine.state.players[3]!.eliminated = true;
    engine.state.victory = { leaderId: null, holdTicks: 0, winnerId: null, reason: null };
    refreshPlayerAggregates(engine.state);

    engine.step(200);
    expect(engine.state.players[0]!.eliminated).toBe(true);
    expect(engine.state.players[0]!.eliminatedBy).toBe(1);
    expect(engine.state.victory.winnerId).toBe(1);
  });
});

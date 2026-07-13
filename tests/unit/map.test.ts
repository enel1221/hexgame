import { describe, expect, it } from "vitest";
import { BALANCE, targetLandCount, TERRAIN_DISTRIBUTION } from "../../src/shared/balance";
import type { GeneratedMap, MapArchetype } from "../../src/shared/types";
import { axialKey, distance, parseAxialKey } from "../../src/core/hex";
import {
  MAP_ARCHETYPES,
  analyzeMapFairness,
  connectedLandIds,
  findControlledChokepoints,
  generateMap,
  minimumChokepointRegionSize,
  targetLandForPlayers,
} from "../../src/core/map";
import { totalUnits, UNIT_TYPES } from "../../src/core/units";

const cache = new Map<string, GeneratedMap>();
function generated(seed: string, archetype: MapArchetype, aiCount: number): GeneratedMap {
  const key = `${seed}:${archetype}:${aiCount}`;
  let map = cache.get(key);
  if (!map) {
    map = generateMap({ seed, archetype, aiCount });
    cache.set(key, map);
  }
  return map;
}

function seamFixture(gateRows: readonly number[]): GeneratedMap {
  const width = 9;
  const height = 7;
  const tiles: GeneratedMap["tiles"] = {};
  const tileIds: string[] = [];
  const landIds: string[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const hex = { q: column - Math.floor(row / 2), r: row };
      const id = axialKey(hex);
      const water = column === 4 && !gateRows.includes(row);
      tileIds.push(id);
      if (!water) landIds.push(id);
      tiles[id] = {
        ...hex,
        id,
        terrain: water ? "water" : "plains",
        owner: null,
        units: { melee: water ? 0 : 1, ranged: 0, wizard: 0 },
        structure: null,
        controlledSinceTick: 0,
        lastRewardTick: 0,
        decorationSeed: 0,
      };
    }
  }
  return {
    archetype: "heartland",
    seed: "topology-fixture",
    width,
    height,
    landCount: landIds.length,
    tiles,
    tileIds,
    landIds,
    spawnCenters: [],
    spawnClusters: [],
    generationAttempt: 0,
  };
}

describe("procedural archetypes", () => {
  it("publishes exactly the three MVP archetypes", () => {
    expect(MAP_ARCHETYPES).toEqual(["heartland", "broken-crown", "highland-basin"]);
  });

  it.each([
    [3, 180],
    [4, 208],
    [5, 260],
    [6, 312],
    [7, 364],
    [8, 416],
    [9, 468],
    [10, 520],
    [11, 572],
    [12, 624],
    [13, 676],
    [14, 728],
    [15, 780],
    [16, 832],
    [17, 884],
    [18, 936],
    [19, 988],
    [20, 1040],
    [21, 1092],
  ])("targets %i players at %i land tiles", (players, expectedLand) => {
    expect(targetLandCount(players)).toBe(expectedLand);
    expect(targetLandForPlayers(players)).toBe(expectedLand);
  });

  for (const archetype of MAP_ARCHETYPES) {
    it(`${archetype} is byte-for-byte deterministic and seed-sensitive`, () => {
      const first = generateMap({ seed: "deterministic-map", archetype, aiCount: 3 });
      const second = generateMap({ seed: "deterministic-map", archetype, aiCount: 3 });
      expect(second).toEqual(first);

      const variation = generated("different-map", archetype, 3);
      const signature = (map: GeneratedMap) =>
        map.tileIds.map((id) => `${id}:${map.tiles[id]!.terrain}`).join("|");
      expect(signature(variation)).not.toBe(signature(first));
    });
  }
});

describe("controlled chokepoint topology", () => {
  it("recognizes a meaningful one-tile water gate", () => {
    const map = seamFixture([3]);
    const gateId = axialKey({ q: 3, r: 3 });
    expect(
      findControlledChokepoints(map).some(
        (gate) => gate.tileIds.length === 1 && gate.tileIds[0] === gateId,
      ),
    ).toBe(true);
  });

  it("recognizes a meaningful two-tile water gate", () => {
    const map = seamFixture([3, 4]);
    const gateIds = [axialKey({ q: 3, r: 3 }), axialKey({ q: 2, r: 4 })].sort();
    expect(
      findControlledChokepoints(map).some(
        (gate) => gate.tileIds.length === 2 && gate.tileIds.every((id) => gateIds.includes(id)),
      ),
    ).toBe(true);
  });
});

describe.each(MAP_ARCHETYPES)("%s generation invariants", (archetype) => {
  it("supports a fair connected two-human duel map", () => {
    const map = generateMap({ seed: "human-duel", archetype, totalPlayers: 2 });
    const report = analyzeMapFairness(map, 2);

    expect(map.spawnCenters).toHaveLength(2);
    expect(map.landCount).toBe(targetLandForPlayers(2));
    expect(report.valid, report.reasons.join("; ")).toBe(true);
  });

  it.each([2, 3, 10, 20])("supports %i AI with fair connected land", (aiCount) => {
    const totalPlayers = aiCount + 1;
    const map = generated("supported-scale", archetype, aiCount);
    const report = analyzeMapFairness(map, totalPlayers);

    expect(map.landCount).toBe(targetLandForPlayers(totalPlayers));
    expect(connectedLandIds(map)).toHaveLength(map.landCount);
    expect(report.valid, report.reasons.join("; ")).toBe(true);
    expect(report.disconnectedLandIds).toEqual([]);
    expect(report.controlledChokepoints.length).toBeGreaterThan(0);
    expect(report.controlledChokepoints.length).toBeLessThanOrEqual(6);
    const expectedGateWidth = archetype === "broken-crown" ? 1 : 2;
    expect(
      report.controlledChokepoints.some((gate) => gate.tileIds.length === expectedGateWidth),
    ).toBe(true);
    expect(
      report.controlledChokepoints.every(
        (gate) =>
          gate.tileIds.length >= 1 &&
          gate.tileIds.length <= 2 &&
          gate.separatedLandCount >= minimumChokepointRegionSize(map.landCount),
      ),
    ).toBe(true);
    for (const centerId of map.spawnCenters) {
      for (const gate of report.controlledChokepoints) {
        expect(
          gate.tileIds.every((id) => distance(parseAxialKey(centerId), parseAxialKey(id)) >= 3),
        ).toBe(true);
      }
    }
    expect(report.landRatioPermille).toBeGreaterThanOrEqual(720);
    expect(report.landRatioPermille).toBeLessThanOrEqual(820);
    expect(map.tileIds.filter((id) => map.tiles[id]!.terrain !== "water")).toEqual(map.landIds);
    expect(map.landIds.every((id) => map.tiles[id]!.terrain !== "water")).toBe(true);
  });

  it("keeps terrain allocation inside centralized tolerances", () => {
    const report = analyzeMapFairness(generated("terrain-allocation", archetype, 10));
    for (const terrain of ["meadow", "muster", "forest", "hills"] as const) {
      const [minimum, maximum] = TERRAIN_DISTRIBUTION[terrain];
      expect(report.terrainPermille[terrain]).toBeGreaterThanOrEqual(minimum - 1);
      expect(report.terrainPermille[terrain]).toBeLessThanOrEqual(maximum + 1);
    }
  });

  it("creates disjoint connected seven-tile starts with all guarantees", () => {
    const map = generated("spawn-guarantees", archetype, 10);
    const used = new Set<string>();
    for (let playerId = 0; playerId < map.spawnCenters.length; playerId += 1) {
      const centerId = map.spawnCenters[playerId]!;
      const center = parseAxialKey(centerId);
      const cluster = map.spawnClusters[playerId]!;
      expect(cluster).toHaveLength(BALANCE.startingTiles);
      expect(new Set(cluster).size).toBe(BALANCE.startingTiles);
      expect(cluster.every((id) => !used.has(id))).toBe(true);
      cluster.forEach((id) => used.add(id));
      expect(cluster.every((id) => map.tiles[id]!.owner === playerId)).toBe(true);
      expect(cluster.reduce((sum, id) => sum + totalUnits(map.tiles[id]!.units), 0)).toBe(
        BALANCE.startingTroops,
      );
      for (const type of UNIT_TYPES) {
        expect(cluster.reduce((sum, id) => sum + map.tiles[id]!.units[type], 0)).toBe(8);
      }
      expect(map.tiles[centerId]!.terrain).toBe("muster");
      expect(map.tiles[centerId]!.structure).toMatchObject({
        type: "barracks",
        status: "active",
        integrity: BALANCE.fullIntegrity,
        completedCount: 1,
        pendingProgressTicks: null,
      });
      const nearbyMeadows = map.landIds.filter(
        (id) => map.tiles[id]!.terrain === "meadow" && distance(center, parseAxialKey(id)) <= 2,
      );
      expect(nearbyMeadows.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("deterministic fairness retries", () => {
  it(
    "supports every integer player count from 3 through 21 across all archetypes",
    { timeout: 45_000 },
    () => {
      for (const archetype of MAP_ARCHETYPES) {
        for (let totalPlayers = 3; totalPlayers <= 21; totalPlayers += 1) {
          const aiCount = totalPlayers - 1;
          const map = generated(`full-matrix-${archetype}-${aiCount}`, archetype, aiCount);
          const report = analyzeMapFairness(map, totalPlayers);
          expect(map.landCount, `${archetype} with ${aiCount} AI land target`).toBe(
            targetLandForPlayers(totalPlayers),
          );
          expect(
            report.valid,
            `${archetype} with ${aiCount} AI: ${report.reasons.join("; ")}`,
          ).toBe(true);
        }
      }
    },
  );

  it("derives a new deterministic attempt after a rejected fair map", () => {
    const attempts: number[] = [];
    const options = {
      seed: "forced-retry",
      archetype: "heartland" as const,
      aiCount: 3,
      fairnessValidator: (
        _report: ReturnType<typeof analyzeMapFairness>,
        _map: GeneratedMap,
        attempt: number,
      ) => {
        attempts.push(attempt);
        return attempt > 0;
      },
    };
    const first = generateMap(options);
    expect(first.generationAttempt).toBeGreaterThan(0);
    expect(attempts[0]).toBe(0);

    const second = generateMap({
      ...options,
      fairnessValidator: (
        _report: ReturnType<typeof analyzeMapFairness>,
        _map: GeneratedMap,
        attempt: number,
      ) => attempt > 0,
    });
    expect(second).toEqual(first);
  });

  it("reports exhausted retries clearly", () => {
    expect(() =>
      generateMap({
        seed: "always-reject",
        archetype: "heartland",
        aiCount: 3,
        maxAttempts: 2,
        fairnessValidator: () => false,
      }),
    ).toThrow(/failed fairness checks after 2 attempts/i);
  });

  it("validates seed and supported player count", () => {
    expect(() => generateMap({ seed: "", archetype: "heartland", aiCount: 3 })).toThrow(/seed/i);
    expect(() => generateMap({ seed: "valid", archetype: "heartland", totalPlayers: 1 })).toThrow(
      /2 through 21/i,
    );
    expect(() => generateMap({ seed: "valid", archetype: "heartland", aiCount: 21 })).toThrow(
      /2 through 21/i,
    );
  });
});

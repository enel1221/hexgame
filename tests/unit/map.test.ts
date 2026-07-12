import { describe, expect, it } from "vitest";
import { BALANCE, TERRAIN_DISTRIBUTION } from "../../src/shared/balance";
import type { GeneratedMap, MapArchetype } from "../../src/shared/types";
import { distance, parseAxialKey } from "../../src/core/hex";
import {
  MAP_ARCHETYPES,
  analyzeMapFairness,
  connectedLandIds,
  generateMap,
  targetLandForPlayers,
} from "../../src/core/map";

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

describe("procedural archetypes", () => {
  it("publishes exactly the three MVP archetypes", () => {
    expect(MAP_ARCHETYPES).toEqual(["heartland", "broken-crown", "highland-basin"]);
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

describe.each(MAP_ARCHETYPES)("%s generation invariants", (archetype) => {
  it("supports a fair connected two-human duel map", () => {
    const map = generateMap({ seed: "human-duel", archetype, totalPlayers: 2 });
    const report = analyzeMapFairness(map, 2);

    expect(map.spawnCenters).toHaveLength(2);
    expect(map.landCount).toBe(targetLandForPlayers(2));
    expect(report.valid, report.reasons.join("; ")).toBe(true);
  });

  it.each([3, 10, 20])("supports %i AI with fair connected land", (aiCount) => {
    const totalPlayers = aiCount + 1;
    const map = generated("supported-scale", archetype, aiCount);
    const report = analyzeMapFairness(map, totalPlayers);

    expect(map.landCount).toBe(targetLandForPlayers(totalPlayers));
    expect(connectedLandIds(map)).toHaveLength(map.landCount);
    expect(report.valid, report.reasons.join("; ")).toBe(true);
    expect(report.disconnectedLandIds).toEqual([]);
    expect(report.criticalChokepoints).toEqual([]);
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
      expect(cluster.reduce((sum, id) => sum + map.tiles[id]!.troops, 0)).toBe(
        BALANCE.startingTroops,
      );
      expect(map.tiles[centerId]!.terrain).toBe("muster");
      expect(map.tiles[centerId]!.structure).toMatchObject({
        type: "barracks",
        status: "active",
        integrity: BALANCE.fullIntegrity,
        progressTicks: 0,
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
    "supports every integer AI count from 3 through 20 across all archetypes",
    { timeout: 45_000 },
    () => {
      for (const archetype of MAP_ARCHETYPES) {
        for (let aiCount = 3; aiCount <= 20; aiCount += 1) {
          const totalPlayers = aiCount + 1;
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

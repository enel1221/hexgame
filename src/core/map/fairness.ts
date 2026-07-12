import { BALANCE, TERRAIN_DISTRIBUTION } from "../../shared/balance";
import type { GeneratedMap, TerrainType } from "../../shared/types";
import { axialKey, distance, neighbors, parseAxialKey } from "../hex/coordinates";

export interface SpawnFairnessMetrics {
  playerId: number;
  centerId: string;
  nearestOpponentDistance: number;
  landWithinSix: number;
  openExpansionTiles: number;
  neutralDefenseWithinThree: number;
  meadowsWithinTwo: number;
  musterWithinTwo: number;
  clusterConnected: boolean;
  clusterOwned: boolean;
  clusterTroops: number;
}

export interface TerrainDistributionReport {
  meadow: number;
  muster: number;
  plains: number;
  forest: number;
  hills: number;
}

export interface MapFairnessReport {
  valid: boolean;
  reasons: string[];
  connectedLandCount: number;
  disconnectedLandIds: string[];
  criticalChokepoints: string[];
  minimumSpawnDistance: number;
  maximumNearestSpawnDistance: number;
  landRatioPermille: number;
  terrainPermille: TerrainDistributionReport;
  spawns: SpawnFairnessMetrics[];
}

function landNeighborIds(
  map: GeneratedMap,
  id: string,
  allowed: ReadonlySet<string> | null = null,
): string[] {
  return neighbors(parseAxialKey(id))
    .map(axialKey)
    .filter((neighborId) => {
      const tile = map.tiles[neighborId];
      return (
        tile !== undefined &&
        tile.terrain !== "water" &&
        (allowed === null || allowed.has(neighborId))
      );
    });
}

export function connectedLandIds(
  map: GeneratedMap,
  startId: string | undefined = map.landIds[0],
): string[] {
  if (!startId || map.tiles[startId]?.terrain === "water") return [];
  const visited = new Set<string>([startId]);
  const queue = [startId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const next of landNeighborIds(map, current)) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return queue;
}

/** Tarjan articulation points: removing any returned tile splits playable land. */
export function findCriticalChokepoints(map: GeneratedMap): string[] {
  const land = new Set(map.landIds);
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string>();
  const articulation = new Set<string>();
  let clock = 0;

  const visit = (id: string): void => {
    discovery.set(id, clock);
    low.set(id, clock);
    clock += 1;
    let children = 0;

    for (const next of landNeighborIds(map, id, land)) {
      if (!discovery.has(next)) {
        parent.set(next, id);
        children += 1;
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));

        if (!parent.has(id) && children > 1) articulation.add(id);
        if (parent.has(id) && low.get(next)! >= discovery.get(id)!) {
          articulation.add(id);
        }
      } else if (parent.get(id) !== next) {
        low.set(id, Math.min(low.get(id)!, discovery.get(next)!));
      }
    }
  };

  for (const id of map.landIds) {
    if (!discovery.has(id)) visit(id);
  }
  return [...articulation].sort();
}

function clusterIsConnected(map: GeneratedMap, cluster: readonly string[]): boolean {
  if (cluster.length === 0) return false;
  const allowed = new Set(cluster);
  const visited = new Set<string>([cluster[0]!]);
  const queue = [cluster[0]!];
  for (let index = 0; index < queue.length; index += 1) {
    for (const next of landNeighborIds(map, queue[index]!, allowed)) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return visited.size === allowed.size;
}

function idsWithinRadius(map: GeneratedMap, centerId: string, radius: number): string[] {
  const center = parseAxialKey(centerId);
  return map.landIds.filter((id) => distance(center, map.tiles[id]!) <= radius);
}

function terrainDistribution(map: GeneratedMap): TerrainDistributionReport {
  const counts: Record<Exclude<TerrainType, "water">, number> = {
    meadow: 0,
    muster: 0,
    plains: 0,
    forest: 0,
    hills: 0,
  };
  for (const id of map.landIds) {
    const terrain = map.tiles[id]!.terrain;
    if (terrain !== "water") counts[terrain] += 1;
  }
  const permille = (count: number): number =>
    map.landCount === 0 ? 0 : Math.round((count * 1000) / map.landCount);
  return {
    meadow: permille(counts.meadow),
    muster: permille(counts.muster),
    plains: permille(counts.plains),
    forest: permille(counts.forest),
    hills: permille(counts.hills),
  };
}

function outsideClusterExpansion(map: GeneratedMap, cluster: readonly string[]): string[] {
  const clusterSet = new Set(cluster);
  const expansion = new Set<string>();
  for (const id of cluster) {
    for (const next of landNeighborIds(map, id)) {
      if (clusterSet.has(next)) continue;
      const tile = map.tiles[next]!;
      if (tile.owner === null && tile.terrain !== "hills") expansion.add(next);
    }
  }
  return [...expansion];
}

export function analyzeMapFairness(
  map: GeneratedMap,
  expectedPlayers = map.spawnCenters.length,
): MapFairnessReport {
  const reasons: string[] = [];
  const connected = connectedLandIds(map);
  const connectedSet = new Set(connected);
  const disconnectedLandIds = map.landIds.filter((id) => !connectedSet.has(id));
  const criticalChokepoints = findCriticalChokepoints(map);
  const terrainPermille = terrainDistribution(map);
  const totalCells = map.tileIds.length;
  const landRatioPermille = totalCells ? Math.round((map.landCount * 1000) / totalCells) : 0;

  if (map.landIds.length !== map.landCount) {
    reasons.push("landCount does not match landIds");
  }
  if (connected.length !== map.landCount) {
    reasons.push(`${map.landCount - connected.length} land tiles are disconnected`);
  }
  if (criticalChokepoints.length > 0) {
    reasons.push("playable land contains a one-tile critical bridge");
  }
  if (landRatioPermille < 720 || landRatioPermille > 820) {
    reasons.push(`land ratio ${landRatioPermille}permille is outside 720-820`);
  }
  if (map.spawnCenters.length !== expectedPlayers) {
    reasons.push(`expected ${expectedPlayers} spawn centers, found ${map.spawnCenters.length}`);
  }
  if (map.spawnClusters.length !== expectedPlayers) {
    reasons.push(`expected ${expectedPlayers} spawn clusters, found ${map.spawnClusters.length}`);
  }

  for (const terrain of ["meadow", "muster", "forest", "hills"] as const) {
    const [minimum, maximum] = TERRAIN_DISTRIBUTION[terrain];
    const actual = terrainPermille[terrain];
    // One tile of rounding slack keeps small supported maps from false failures.
    const slack = Math.ceil(1000 / Math.max(1, map.landCount));
    if (actual < minimum - slack || actual > maximum + slack) {
      reasons.push(`${terrain} distribution ${actual}permille is outside tolerance`);
    }
  }

  const spawnMetrics: SpawnFairnessMetrics[] = [];
  for (let playerId = 0; playerId < map.spawnCenters.length; playerId += 1) {
    const centerId = map.spawnCenters[playerId]!;
    const cluster = map.spawnClusters[playerId] ?? [];
    const withinTwo = idsWithinRadius(map, centerId, 2);
    const withinThree = idsWithinRadius(map, centerId, 3);
    const nearestOpponentDistance = map.spawnCenters.reduce(
      (minimum, otherId, otherPlayerId) =>
        otherPlayerId === playerId
          ? minimum
          : Math.min(minimum, distance(parseAxialKey(centerId), parseAxialKey(otherId))),
      Number.POSITIVE_INFINITY,
    );
    const clusterTroops = cluster.reduce((sum, id) => sum + (map.tiles[id]?.troops ?? 0), 0);
    const metric: SpawnFairnessMetrics = {
      playerId,
      centerId,
      nearestOpponentDistance,
      landWithinSix: idsWithinRadius(map, centerId, 6).length,
      openExpansionTiles: outsideClusterExpansion(map, cluster).length,
      neutralDefenseWithinThree: withinThree.reduce(
        (sum, id) => sum + (map.tiles[id]?.owner === null ? map.tiles[id]!.troops : 0),
        0,
      ),
      meadowsWithinTwo: withinTwo.filter((id) => map.tiles[id]?.terrain === "meadow").length,
      musterWithinTwo: withinTwo.filter((id) => map.tiles[id]?.terrain === "muster").length,
      clusterConnected: clusterIsConnected(map, cluster),
      clusterOwned:
        cluster.length === BALANCE.startingTiles &&
        cluster.every((id) => map.tiles[id]?.owner === playerId),
      clusterTroops,
    };
    spawnMetrics.push(metric);

    if (cluster.length !== BALANCE.startingTiles) {
      reasons.push(`player ${playerId} does not have a seven-tile cluster`);
    }
    if (new Set(cluster).size !== cluster.length) {
      reasons.push(`player ${playerId} spawn cluster contains duplicate tiles`);
    }
    if (!metric.clusterConnected) {
      reasons.push(`player ${playerId} spawn cluster is disconnected`);
    }
    if (!metric.clusterOwned) {
      reasons.push(`player ${playerId} does not own the full spawn cluster`);
    }
    if (clusterTroops !== BALANCE.startingTroops) {
      reasons.push(`player ${playerId} starts with ${clusterTroops} troops`);
    }
    if (metric.meadowsWithinTwo < 2) {
      reasons.push(`player ${playerId} lacks two nearby meadows`);
    }
    if (metric.musterWithinTwo < 1) {
      reasons.push(`player ${playerId} lacks a nearby muster ground`);
    }
    if (map.tiles[centerId]?.structure?.type !== "barracks") {
      reasons.push(`player ${playerId} lacks the free spawn barracks`);
    }
    if (metric.openExpansionTiles < 2) {
      reasons.push(`player ${playerId} lacks a reasonable expansion direction`);
    }
  }

  const finiteNearest = spawnMetrics
    .map((metric) => metric.nearestOpponentDistance)
    .filter(Number.isFinite);
  const minimumSpawnDistance = finiteNearest.length ? Math.min(...finiteNearest) : 0;
  const maximumNearestSpawnDistance = finiteNearest.length ? Math.max(...finiteNearest) : 0;
  if (expectedPlayers > 1 && minimumSpawnDistance < 6) {
    reasons.push(`spawn centers are only ${minimumSpawnDistance} tiles apart`);
  }
  if (minimumSpawnDistance > 0 && maximumNearestSpawnDistance > minimumSpawnDistance * 2) {
    reasons.push("nearest-opponent distances are materially uneven");
  }

  const localAreas = spawnMetrics.map((metric) => metric.landWithinSix);
  // Coastal starts exchange nearby raw area for fewer attack vectors. Treat a
  // start as materially constrained only below half the best local footprint;
  // every start can still reach the entire connected mainland.
  if (localAreas.length > 0 && Math.min(...localAreas) * 100 < Math.max(...localAreas) * 50) {
    reasons.push("a spawn has materially less nearby reachable land");
  }
  const neutralDefense = spawnMetrics.map((metric) => metric.neutralDefenseWithinThree);
  if (
    neutralDefense.length > 0 &&
    Math.min(...neutralDefense) > 0 &&
    Math.max(...neutralDefense) > Math.min(...neutralDefense) * 2
  ) {
    reasons.push("neutral defense around spawns is materially uneven");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    connectedLandCount: connected.length,
    disconnectedLandIds,
    criticalChokepoints,
    minimumSpawnDistance,
    maximumNearestSpawnDistance,
    landRatioPermille,
    terrainPermille,
    spawns: spawnMetrics,
  };
}

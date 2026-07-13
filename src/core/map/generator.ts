import { BALANCE, targetLandCount } from "../../shared/balance";
import type {
  Axial,
  GeneratedMap,
  MapArchetype,
  MatchConfig,
  TerrainType,
  TileState,
} from "../../shared/types";
import { hashSeed, SeededRng } from "../rng";
import { axialKey, distance, neighbors, parseAxialKey, ring, spiral } from "../hex/coordinates";
import { projectSpacedPlacementCenters } from "../placement/projection";
import { emptyUnits, UNIT_TYPES, unitsOf } from "../units";
import {
  analyzeMapFairness,
  findControlledChokepoints,
  minimumChokepointRegionSize,
  type MapFairnessReport,
} from "./fairness";

export const MAP_ARCHETYPES = [
  "heartland",
  "broken-crown",
  "highland-basin",
] as const satisfies readonly MapArchetype[];

interface GenerationCell extends Axial {
  id: string;
  column: number;
  row: number;
  score: number;
}

export interface MapGenerationOptions {
  seed: string;
  archetype: MapArchetype;
  /** Includes every human and AI player. Supported maps have 2 through 21 players. */
  totalPlayers?: number;
  /** Convenience alias for totalPlayers. */
  playerCount?: number;
  /** When supplied, totalPlayers is aiCount + 1. */
  aiCount?: number;
  maxAttempts?: number;
  /** Test/debug hook. Production callers should rely on the built-in report. */
  fairnessValidator?: (report: MapFairnessReport, map: GeneratedMap, attempt: number) => boolean;
}

type MatchMapConfig = Pick<MatchConfig, "seed" | "archetype" | "aiCount">;

interface NormalizedOptions {
  seed: string;
  archetype: MapArchetype;
  totalPlayers: number;
  maxAttempts: number;
  fairnessValidator?: MapGenerationOptions["fairnessValidator"];
}

interface MapDimensions {
  width: number;
  height: number;
}

const ARCHETYPE_LAND_RATIO = {
  heartland: 800,
  "broken-crown": 740,
  "highland-basin": 760,
} as const;

const ARCHETYPE_TERRAIN_PERMILLE = {
  heartland: { meadow: 220, muster: 100, forest: 110, hills: 100 },
  "broken-crown": { meadow: 200, muster: 100, forest: 130, hills: 125 },
  "highland-basin": { meadow: 190, muster: 90, forest: 140, hills: 150 },
} as const;

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function targetLandForPlayers(totalPlayers: number): number {
  return targetLandCount(totalPlayers);
}

export const getTargetLandCount = targetLandForPlayers;

export function dimensionsForLand(targetLand: number, archetype: MapArchetype): MapDimensions {
  if (!Number.isInteger(targetLand) || targetLand <= 0) {
    throw new Error("targetLand must be a positive integer");
  }
  const desiredRatio = ARCHETYPE_LAND_RATIO[archetype];
  let best: (MapDimensions & { score: number }) | null = null;

  for (let height = 8; height <= 96; height += 1) {
    for (let width = 10; width <= 140; width += 1) {
      const cells = width * height;
      if (cells < targetLand) continue;
      const ratio = Math.round((targetLand * 1000) / cells);
      if (ratio < 720 || ratio > 820) continue;

      // Pointy-top odd-row bounds, including half-hex edge extents.
      const pixelAspect = (Math.sqrt(3) * (width + 0.5)) / (1.5 * height + 0.5);
      const ratioPenalty = Math.abs(ratio - desiredRatio) * 20;
      const aspectPenalty = Math.abs(pixelAspect - 1.6) * 1000;
      const areaPenalty = Math.abs(cells - targetLand * (1000 / desiredRatio)) / 10;
      const score = ratioPenalty + aspectPenalty + areaPenalty;
      if (
        best === null ||
        score < best.score ||
        (score === best.score && cells < best.width * best.height)
      ) {
        best = { width, height, score };
      }
    }
  }

  if (!best) throw new Error(`Unable to size a map for ${targetLand} land tiles`);
  return { width: best.width, height: best.height };
}

export function deriveGenerationSeed(seed: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("generation attempt must be a non-negative integer");
  }
  return attempt === 0 ? seed : `${seed}:map-retry:${attempt}`;
}

function normalizeOptions(input: MatchMapConfig | MapGenerationOptions): NormalizedOptions {
  if (typeof input.seed !== "string" || input.seed.trim().length === 0) {
    throw new Error("Map seed must be a non-empty string");
  }
  if (input.seed.length > 128) throw new Error("Map seed must be at most 128 characters");
  if (!MAP_ARCHETYPES.includes(input.archetype)) {
    throw new Error(`Unknown map archetype: ${String(input.archetype)}`);
  }

  const options = input as MapGenerationOptions;
  const explicitlyProvided = [options.totalPlayers, options.playerCount].filter(
    (value): value is number => value !== undefined,
  );
  if (explicitlyProvided.length === 2 && explicitlyProvided[0] !== explicitlyProvided[1]) {
    throw new Error("totalPlayers and playerCount disagree");
  }
  let totalPlayers = explicitlyProvided[0];
  if (totalPlayers === undefined && options.aiCount !== undefined) {
    totalPlayers = options.aiCount + 1;
  }
  if (totalPlayers === undefined) {
    throw new Error("Map generation requires totalPlayers or aiCount");
  }
  if (!Number.isInteger(totalPlayers) || totalPlayers < 2 || totalPlayers > 21) {
    throw new Error("Hex Dominion maps support 2 through 21 total players");
  }
  if (
    options.aiCount !== undefined &&
    explicitlyProvided.length > 0 &&
    options.aiCount + 1 !== totalPlayers
  ) {
    throw new Error("aiCount and totalPlayers disagree");
  }

  const maxAttempts = options.maxAttempts ?? 12;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("maxAttempts must be an integer from 1 through 100");
  }
  return {
    seed: input.seed,
    archetype: input.archetype,
    totalPlayers,
    maxAttempts,
    fairnessValidator: options.fairnessValidator,
  };
}

function axialForOffset(column: number, row: number): Axial {
  return { q: column - Math.floor(row / 2), r: row };
}

function makeCells(width: number, height: number): GenerationCell[] {
  const cells: GenerationCell[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const axial = axialForOffset(column, row);
      cells.push({
        ...axial,
        id: axialKey(axial),
        column,
        row,
        score: 0,
      });
    }
  }
  return cells;
}

function unitNoise(seed: string, id: string, channel: string): number {
  return hashSeed(`${seed}:${channel}:${id}`) / 0xffffffff;
}

function signedSpatialNoise(seed: string, hex: Axial, channel: string): number {
  let value = (unitNoise(seed, axialKey(hex), channel) * 2 - 1) * 4;
  let weight = 4;
  for (const adjacent of ring(hex, 1)) {
    value += (unitNoise(seed, axialKey(adjacent), channel) * 2 - 1) * 2;
    weight += 2;
  }
  for (const nearby of ring(hex, 2)) {
    value += unitNoise(seed, axialKey(nearby), channel) * 2 - 1;
    weight += 1;
  }
  return value / weight;
}

interface LakeSeed {
  x: number;
  y: number;
  radius: number;
  depth: number;
}

function scoreLandCells(
  cells: GenerationCell[],
  width: number,
  height: number,
  archetype: MapArchetype,
  seed: string,
): void {
  const rng = new SeededRng(`${seed}:coast`);
  const phaseA = (rng.nextUint() / 0xffffffff) * Math.PI * 2;
  const phaseB = (rng.nextUint() / 0xffffffff) * Math.PI * 2;
  const lakeCount = archetype === "heartland" ? 2 : archetype === "broken-crown" ? 3 : 7;
  const lakes: LakeSeed[] = [];
  for (let index = 0; index < lakeCount; index += 1) {
    lakes.push({
      x: (rng.range(-500, 501) / 1000) * (archetype === "highland-basin" ? 1.25 : 1),
      y: rng.range(-450, 451) / 1000,
      radius: (archetype === "highland-basin" ? rng.range(105, 190) : rng.range(75, 140)) / 1000,
      depth: (archetype === "highland-basin" ? rng.range(180, 330) : rng.range(80, 170)) / 1000,
    });
  }

  for (const cell of cells) {
    const x = (cell.column - (width - 1) / 2) / (width / 2);
    const y = (cell.row - (height - 1) / 2) / (height / 2);
    const radius = Math.sqrt(x * x + y * y);
    const angle = Math.atan2(y, x);
    const noise = signedSpatialNoise(seed, cell, "coast-noise");
    let score: number;

    if (archetype === "heartland") {
      score = -radius + noise * 0.055;
    } else if (archetype === "broken-crown") {
      const lobes = Math.cos(angle * 5 + phaseA) * 0.13 + Math.cos(angle * 3 + phaseB) * 0.055;
      const winding = Math.sin(x * 5.5 + phaseB) * Math.sin(y * 4.5 + phaseA) * 0.035;
      score = -radius + lobes * (0.35 + radius * 0.65) + winding + noise * 0.065;
    } else {
      const basin = Math.cos(radius * Math.PI * 3.2 + phaseA) * 0.018;
      score = -radius + noise * 0.09 + basin;
    }

    for (const lake of lakes) {
      const lakeDistance = Math.hypot(x - lake.x, y - lake.y);
      if (lakeDistance < lake.radius) {
        score -= lake.depth * (1 - lakeDistance / lake.radius);
      }
    }
    cell.score = score;
  }
}

function componentsOf(
  ids: ReadonlySet<string>,
  cellById: ReadonlyMap<string, GenerationCell>,
): string[][] {
  const unvisited = new Set(ids);
  const components: string[][] = [];
  while (unvisited.size > 0) {
    const start = unvisited.values().next().value as string;
    unvisited.delete(start);
    const component = [start];
    for (let index = 0; index < component.length; index += 1) {
      const current = cellById.get(component[index]!)!;
      for (const adjacent of neighbors(current)) {
        const id = axialKey(adjacent);
        if (!ids.has(id) || !unvisited.delete(id)) continue;
        component.push(id);
      }
    }
    components.push(component);
  }
  return components;
}

function connectedLandSelection(cells: GenerationCell[], targetLand: number): Set<string> {
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const sorted = [...cells].sort(
    (left, right) => right.score - left.score || compareIds(left.id, right.id),
  );
  const initial = new Set(sorted.slice(0, targetLand).map((cell) => cell.id));
  const components = componentsOf(initial, cellById).sort(
    (left, right) => right.length - left.length || compareIds(left[0]!, right[0]!),
  );
  const land = new Set(components[0] ?? []);
  const frontier = new Set<string>();

  const pushFrontier = (id: string): void => {
    const cell = cellById.get(id)!;
    for (const adjacent of neighbors(cell)) {
      const adjacentId = axialKey(adjacent);
      if (cellById.has(adjacentId) && !land.has(adjacentId)) frontier.add(adjacentId);
    }
  };
  for (const id of land) pushFrontier(id);

  while (land.size < targetLand) {
    let selectedId: string | null = null;
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (const id of frontier) {
      const cell = cellById.get(id)!;
      const adjacentLand = neighbors(cell).reduce(
        (count, adjacent) => count + Number(land.has(axialKey(adjacent))),
        0,
      );
      // Favor broad fronts over tendrils while retaining the archetype score.
      const compactScore = cell.score + adjacentLand * 0.025;
      if (
        compactScore > selectedScore ||
        (compactScore === selectedScore && (selectedId === null || compareIds(id, selectedId) < 0))
      ) {
        selectedId = id;
        selectedScore = compactScore;
      }
    }
    if (selectedId === null) throw new Error("Connected land growth exhausted its frontier");
    frontier.delete(selectedId);
    land.add(selectedId);
    pushFrontier(selectedId);
  }
  return land;
}

const ARCHETYPE_GATE_WIDTH = {
  heartland: 2,
  "broken-crown": 1,
  "highland-basin": 2,
} as const;

function growLandToTarget(
  cells: readonly GenerationCell[],
  initialLand: ReadonlySet<string>,
  forcedWater: ReadonlySet<string>,
  targetLand: number,
): Set<string> {
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const land = new Set(initialLand);
  const frontier = new Set<string>();

  const pushFrontier = (id: string): void => {
    const cell = cellById.get(id)!;
    for (const adjacent of neighbors(cell)) {
      const adjacentId = axialKey(adjacent);
      if (cellById.has(adjacentId) && !land.has(adjacentId) && !forcedWater.has(adjacentId)) {
        frontier.add(adjacentId);
      }
    }
  };
  for (const id of land) pushFrontier(id);

  while (land.size < targetLand) {
    let selectedId: string | null = null;
    let selectedScore = Number.NEGATIVE_INFINITY;
    for (const id of frontier) {
      const cell = cellById.get(id)!;
      const adjacentLand = neighbors(cell).reduce(
        (count, adjacent) => count + Number(land.has(axialKey(adjacent))),
        0,
      );
      const compactScore = cell.score + adjacentLand * 0.025;
      if (
        compactScore > selectedScore ||
        (compactScore === selectedScore && (selectedId === null || compareIds(id, selectedId) < 0))
      ) {
        selectedId = id;
        selectedScore = compactScore;
      }
    }
    if (selectedId === null) throw new Error("Water seam exhausted connected land growth");
    frontier.delete(selectedId);
    land.add(selectedId);
    pushFrontier(selectedId);
  }
  return land;
}

function applyDeterministicWaterSeam(
  cells: readonly GenerationCell[],
  baseLand: ReadonlySet<string>,
  width: number,
  height: number,
  archetype: MapArchetype,
  seed: string,
  targetLand: number,
): Set<string> {
  // A complete offset-column is an uncrossable hex barrier. Preserve only the
  // seeded gate cells, then refill on either side without ever filling the seam.
  const cellByOffset = new Map(cells.map((cell) => [`${cell.column},${cell.row}`, cell]));
  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const gateWidth = ARCHETYPE_GATE_WIDTH[archetype];
  const minimumRegion = minimumChokepointRegionSize(targetLand);
  const minimumColumn = Math.max(2, Math.floor(width * 0.34));
  const maximumColumn = Math.min(width - 3, Math.ceil(width * 0.66));
  const columns = Array.from(
    { length: maximumColumn - minimumColumn + 1 },
    (_, index) => minimumColumn + index,
  ).sort(
    (left, right) =>
      hashSeed(`${seed}:seam-column:${right}`) - hashSeed(`${seed}:seam-column:${left}`) ||
      left - right,
  );

  for (const column of columns) {
    const validRows: number[] = [];
    for (let row = 2; row < height - 2; row += 1) {
      const gate = cellByOffset.get(`${column},${row}`);
      const left = cellByOffset.get(`${column - 1},${row}`);
      const right = cellByOffset.get(`${column + 1},${row}`);
      if (
        gate &&
        left &&
        right &&
        baseLand.has(gate.id) &&
        baseLand.has(left.id) &&
        baseLand.has(right.id)
      ) {
        validRows.push(row);
      }
    }
    const gateStarts = validRows
      .filter(
        (row) =>
          gateWidth === 1 ||
          (validRows.includes(row + 1) &&
            distance(
              cellByOffset.get(`${column},${row}`)!,
              cellByOffset.get(`${column},${row + 1}`)!,
            ) === 1),
      )
      .sort(
        (left, right) =>
          hashSeed(`${seed}:seam-gate:${column}:${right}`) -
            hashSeed(`${seed}:seam-gate:${column}:${left}`) || left - right,
      );

    for (const gateStart of gateStarts) {
      const gateIds = new Set(
        Array.from(
          { length: gateWidth },
          (_, index) => cellByOffset.get(`${column},${gateStart + index}`)!.id,
        ),
      );
      const forcedWater = new Set(
        cells
          .filter((cell) => cell.column === column && !gateIds.has(cell.id))
          .map((cell) => cell.id),
      );
      const carved = new Set([...baseLand].filter((id) => !forcedWater.has(id)));
      if (componentsOf(carved, cellById).length !== 1) continue;
      const land = growLandToTarget(cells, carved, forcedWater, targetLand);
      const withoutGate = new Set([...land].filter((id) => !gateIds.has(id)));
      const regions = componentsOf(withoutGate, cellById).sort(
        (left, right) => right.length - left.length || compareIds(left[0]!, right[0]!),
      );
      if (regions.length !== 2 || regions[1]!.length < minimumRegion) continue;
      return land;
    }
  }
  throw new Error(`Unable to create a controlled ${gateWidth}-tile ${archetype} water gate`);
}

function terrainCounts(
  archetype: MapArchetype,
  landCount: number,
): Record<Exclude<TerrainType, "water" | "plains">, number> {
  const permille = ARCHETYPE_TERRAIN_PERMILLE[archetype];
  return {
    meadow: Math.round((landCount * permille.meadow) / 1000),
    muster: Math.round((landCount * permille.muster) / 1000),
    forest: Math.round((landCount * permille.forest) / 1000),
    hills: Math.round((landCount * permille.hills) / 1000),
  };
}

function rankTerrainCandidates(ids: readonly string[], seed: string, channel: string): string[] {
  return [...ids].sort((left, right) => {
    const leftNoise = signedSpatialNoise(seed, parseAxialKey(left), channel);
    const rightNoise = signedSpatialNoise(seed, parseAxialKey(right), channel);
    return rightNoise - leftNoise || compareIds(left, right);
  });
}

function assignTerrain(
  tiles: Record<string, TileState>,
  landIds: readonly string[],
  archetype: MapArchetype,
  seed: string,
): void {
  const counts = terrainCounts(archetype, landIds.length);
  const remaining = new Set(landIds);
  // Defensive biomes are laid down first so Highland Basin forms readable belts.
  for (const terrain of ["hills", "forest", "meadow", "muster"] as const) {
    const ranked = rankTerrainCandidates([...remaining], seed, `terrain-${terrain}`);
    for (const id of ranked.slice(0, counts[terrain])) {
      tiles[id]!.terrain = terrain;
      remaining.delete(id);
    }
  }
  for (const id of remaining) tiles[id]!.terrain = "plains";
}

function landInRadius(land: ReadonlySet<string>, centerId: string, radius: number): string[] {
  return spiral(parseAxialKey(centerId), radius)
    .map(axialKey)
    .filter((id) => land.has(id));
}

export function isEligibleSpawnCenter(map: GeneratedMap, centerId: string): boolean {
  const center = map.tiles[centerId];
  if (!center || center.terrain === "water") return false;
  const required = spiral(center, BALANCE.spawnPaddingRadius).map(axialKey);
  const hasPadding = required.every((id) => {
    const tile = map.tiles[id];
    return tile !== undefined && tile.terrain !== "water";
  });
  if (!hasPadding) return false;
  return findControlledChokepoints(map).every((chokepoint) =>
    chokepoint.tileIds.every((id) => distance(center, parseAxialKey(id)) >= 3),
  );
}

export function eligibleSpawnCenters(map: GeneratedMap): string[] {
  return map.landIds.filter((id) => isEligibleSpawnCenter(map, id)).sort(compareIds);
}

export function chooseDefaultSpawnCenters(
  map: GeneratedMap,
  totalPlayers: number,
  seed: string,
): string[] {
  const land = new Set(map.landIds);
  const candidateMetrics = eligibleSpawnCenters(map).map((id) => ({
    id,
    nearby: landInRadius(land, id, 3).length,
    rank: hashSeed(`${seed}:spawn-rank:${id}`),
  }));
  const candidates = candidateMetrics;
  if (candidates.length < totalPlayers) {
    throw new Error(`Only ${candidates.length} safe spawn centers fit ${totalPlayers} players`);
  }

  candidates.sort((left, right) => compareIds(left.id, right.id));
  const probe = candidates[hashSeed(`${seed}:spawn-probe`) % candidates.length]!;
  const first = [...candidates].sort((left, right) => {
    const distanceDifference =
      distance(parseAxialKey(right.id), parseAxialKey(probe.id)) -
      distance(parseAxialKey(left.id), parseAxialKey(probe.id));
    return (
      distanceDifference ||
      right.nearby - left.nearby ||
      right.rank - left.rank ||
      compareIds(left.id, right.id)
    );
  })[0]!;
  const selected = [first.id];

  while (selected.length < totalPlayers) {
    let best: (typeof candidates)[number] | null = null;
    let bestDistance = -1;
    for (const candidate of candidates) {
      if (selected.includes(candidate.id)) continue;
      const nearest = selected.reduce(
        (minimum, id) =>
          Math.min(minimum, distance(parseAxialKey(candidate.id), parseAxialKey(id))),
        Number.POSITIVE_INFINITY,
      );
      if (nearest < BALANCE.minimumSpawnDistance) continue;
      if (
        nearest > bestDistance ||
        (nearest === bestDistance &&
          (best === null ||
            candidate.nearby > best.nearby ||
            (candidate.nearby === best.nearby &&
              (candidate.rank > best.rank ||
                (candidate.rank === best.rank && compareIds(candidate.id, best.id) < 0)))))
      ) {
        best = candidate;
        bestDistance = nearest;
      }
    }
    if (!best) throw new Error(`Unable to place spawn center ${selected.length + 1}`);
    selected.push(best.id);
  }
  return selected;
}

function forceTerrain(
  tiles: Record<string, TileState>,
  landIds: readonly string[],
  protectedIds: ReadonlySet<string>,
  id: string,
  terrain: Exclude<TerrainType, "water">,
  seed: string,
): void {
  const tile = tiles[id]!;
  if (tile.terrain === terrain) return;
  const previous = tile.terrain;
  const donor = landIds
    .filter(
      (candidateId) =>
        candidateId !== id &&
        !protectedIds.has(candidateId) &&
        tiles[candidateId]!.terrain === terrain,
    )
    .sort(
      (left, right) =>
        hashSeed(`${seed}:terrain-donor:${right}`) - hashSeed(`${seed}:terrain-donor:${left}`) ||
        compareIds(left, right),
    )[0];
  if (!donor) throw new Error(`Unable to reserve ${terrain} terrain for spawn ${id}`);
  tiles[donor]!.terrain = previous;
  tile.terrain = terrain;
}

export function applySpawnAllocations(
  map: GeneratedMap,
  centers: readonly string[],
  seed: string,
): void {
  const totalPlayers = centers.length;
  const land = new Set(map.landIds);
  if (totalPlayers < 2 || totalPlayers > 21) {
    throw new Error("Spawn allocation requires 2 through 21 centers");
  }
  if (new Set(centers).size !== centers.length) throw new Error("Spawn centers contain duplicates");
  if (centers.some((id) => !isEligibleSpawnCenter(map, id))) {
    throw new Error("Spawn center lacks required shoreline or map-edge padding");
  }
  for (let left = 0; left < centers.length; left += 1) {
    for (let right = left + 1; right < centers.length; right += 1) {
      if (
        distance(parseAxialKey(centers[left]!), parseAxialKey(centers[right]!)) <
        BALANCE.minimumSpawnDistance
      ) {
        throw new Error("Spawn centers violate minimum spacing");
      }
    }
  }
  const clusters = centers.map((centerId) => [
    centerId,
    ...neighbors(parseAxialKey(centerId)).map(axialKey),
  ]);
  if (clusters.some((cluster) => cluster.some((id) => !land.has(id)))) {
    throw new Error("Spawn cluster crossed the shoreline");
  }
  const allClusterIds = new Set(clusters.flat());
  if (allClusterIds.size !== totalPlayers * BALANCE.startingTiles) {
    throw new Error("Spawn clusters overlap");
  }

  // Swap biomes instead of merely overwriting so global distributions stay exact.
  for (let playerId = 0; playerId < totalPlayers; playerId += 1) {
    const cluster = clusters[playerId]!;
    forceTerrain(map.tiles, map.landIds, allClusterIds, cluster[0]!, "muster", seed);
    forceTerrain(map.tiles, map.landIds, allClusterIds, cluster[1]!, "meadow", seed);
    forceTerrain(map.tiles, map.landIds, allClusterIds, cluster[4]!, "meadow", seed);
    for (const id of cluster) {
      if (map.tiles[id]!.terrain === "hills") {
        forceTerrain(map.tiles, map.landIds, allClusterIds, id, "plains", seed);
      }
    }

    const clusterSet = new Set(cluster);
    const expansion = new Set<string>();
    for (const id of cluster) {
      for (const adjacent of neighbors(parseAxialKey(id)).map(axialKey)) {
        if (land.has(adjacent) && !clusterSet.has(adjacent) && !allClusterIds.has(adjacent)) {
          expansion.add(adjacent);
        }
      }
    }
    const expansionIds = [...expansion].sort((left, right) => {
      const distanceDifference =
        distance(parseAxialKey(right), parseAxialKey(cluster[0]!)) -
        distance(parseAxialKey(left), parseAxialKey(cluster[0]!));
      return distanceDifference || compareIds(left, right);
    });
    for (const id of expansionIds.slice(0, 3)) {
      if (map.tiles[id]!.terrain === "hills") {
        const protectedWithExpansion = new Set(allClusterIds);
        for (const expansionId of expansionIds.slice(0, 3)) {
          protectedWithExpansion.add(expansionId);
        }
        forceTerrain(map.tiles, map.landIds, protectedWithExpansion, id, "plains", seed);
      }
    }
  }

  // Give every neutral tile one deterministic unit without favoring one type globally.
  for (const id of map.landIds) {
    const type = UNIT_TYPES[hashSeed(`${seed}:neutral-unit:${id}`) % UNIT_TYPES.length]!;
    const tile = Object.hasOwn(map.tiles, id) ? map.tiles[id] : undefined;
    if (!tile) throw new Error(`Generated land tile ${id} is missing`);
    tile.units = unitsOf(type, 1);
  }

  for (let playerId = 0; playerId < totalPlayers; playerId += 1) {
    const cluster = clusters[playerId]!;
    const unitOrder = new SeededRng(`${seed}:units:${playerId}`).shuffle([...cluster]);
    for (const id of cluster) {
      const tile = map.tiles[id]!;
      tile.owner = playerId;
      tile.units = emptyUnits();
      tile.controlledSinceTick = 0;
    }
    for (let index = 0; index < BALANCE.startingTroops; index += 1) {
      const tile = map.tiles[unitOrder[index % unitOrder.length]!]!;
      tile.units[UNIT_TYPES[index % UNIT_TYPES.length]!] += 1;
    }
    map.tiles[cluster[0]!]!.structure = {
      type: "barracks",
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

  map.spawnCenters = [...centers];
  map.spawnClusters = clusters;
}

function buildAttempt(options: NormalizedOptions, attempt: number): GeneratedMap {
  const generationSeed = deriveGenerationSeed(options.seed, attempt);
  const targetLand = targetLandForPlayers(options.totalPlayers);
  const { width, height } = dimensionsForLand(targetLand, options.archetype);
  const cells = makeCells(width, height);
  scoreLandCells(cells, width, height, options.archetype, generationSeed);
  const baseLand = connectedLandSelection(cells, targetLand);
  const land = applyDeterministicWaterSeam(
    cells,
    baseLand,
    width,
    height,
    options.archetype,
    generationSeed,
    targetLand,
  );
  const tileIds = cells.map((cell) => cell.id);
  const landIds = tileIds.filter((id) => land.has(id));
  const tiles: Record<string, TileState> = {};

  for (const cell of cells) {
    tiles[cell.id] = {
      id: cell.id,
      q: cell.q,
      r: cell.r,
      terrain: land.has(cell.id) ? "plains" : "water",
      owner: null,
      units: land.has(cell.id)
        ? unitsOf(
            UNIT_TYPES[hashSeed(`${generationSeed}:neutral-unit:${cell.id}`) % UNIT_TYPES.length]!,
            1,
          )
        : emptyUnits(),
      structure: null,
      controlledSinceTick: 0,
      lastRewardTick: 0,
      decorationSeed: hashSeed(`${generationSeed}:decoration:${cell.id}`),
    };
  }
  assignTerrain(tiles, landIds, options.archetype, generationSeed);

  const map: GeneratedMap = {
    archetype: options.archetype,
    seed: options.seed,
    width,
    height,
    landCount: landIds.length,
    tiles,
    tileIds,
    landIds,
    spawnCenters: [],
    spawnClusters: [],
    generationAttempt: attempt,
  };
  return map;
}

export function generateMapOnce(
  input: MatchMapConfig | MapGenerationOptions,
  attempt = 0,
): GeneratedMap {
  const options = normalizeOptions(input);
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("generation attempt must be a non-negative integer");
  }
  return buildAttempt(options, attempt);
}

export function generateNeutralMap(config: MatchMapConfig): GeneratedMap;
export function generateNeutralMap(options: MapGenerationOptions): GeneratedMap;
export function generateNeutralMap(input: MatchMapConfig | MapGenerationOptions): GeneratedMap {
  const options = normalizeOptions(input);
  let lastReport: MapFairnessReport | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    try {
      const map = buildAttempt(options, attempt);
      const generationSeed = deriveGenerationSeed(options.seed, attempt);
      const centers = projectSpacedPlacementCenters({
        seed: generationSeed,
        totalParticipants: options.totalPlayers,
        candidates: eligibleSpawnCenters(map),
        fixedCenters: [],
        minimumDistance: BALANCE.minimumSpawnDistance,
      });
      const allocated = JSON.parse(JSON.stringify(map)) as GeneratedMap;
      applySpawnAllocations(allocated, centers, generationSeed);
      const report = analyzeMapFairness(allocated, options.totalPlayers);
      lastReport = report;
      const acceptedByHook = options.fairnessValidator?.(report, allocated, attempt) ?? true;
      if (report.valid && acceptedByHook) return map;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  const detail = lastReport?.reasons.join("; ") || lastError?.message || "unknown failure";
  throw new Error(
    `Map generation failed fairness checks after ${options.maxAttempts} attempts: ${detail}`,
  );
}

/** Backward-compatible allocated map helper; placement uses generateNeutralMap. */
export function generateMap(config: MatchMapConfig): GeneratedMap;
export function generateMap(options: MapGenerationOptions): GeneratedMap;
export function generateMap(input: MatchMapConfig | MapGenerationOptions): GeneratedMap {
  const options = normalizeOptions(input);
  const map = generateNeutralMap(input);
  const generationSeed = deriveGenerationSeed(map.seed, map.generationAttempt);
  const centers = projectSpacedPlacementCenters({
    seed: generationSeed,
    totalParticipants: options.totalPlayers,
    candidates: eligibleSpawnCenters(map),
    fixedCenters: [],
    minimumDistance: BALANCE.minimumSpawnDistance,
  });
  applySpawnAllocations(map, centers, generationSeed);
  return map;
}

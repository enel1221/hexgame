import { describe, expect, it } from "vitest";
import type { GeneratedMap, TerrainType, TileState } from "../../src/shared/types";
import {
  AXIAL_DIRECTIONS,
  axialKey,
  axialToPixel,
  axialToScreen,
  distance,
  findPath,
  isLegalPath,
  lastLegalFriendlyTile,
  line,
  neighbors,
  pathMovementCost,
  pixelToAxial,
  ring,
  screenToAxial,
  terrainMovementCost,
} from "../../src/core/hex";
import { BALANCE } from "../../src/shared/balance";

function pathMap(
  cells: Array<{
    q: number;
    r: number;
    terrain?: TerrainType;
    owner?: number | null;
  }>,
): GeneratedMap {
  const tiles: Record<string, TileState> = {};
  for (const cell of cells) {
    const id = axialKey(cell);
    tiles[id] = {
      id,
      q: cell.q,
      r: cell.r,
      terrain: cell.terrain ?? "plains",
      owner: cell.owner === undefined ? 0 : cell.owner,
      troops: 1,
      structure: null,
      controlledSinceTick: 0,
      lastRewardTick: 0,
      decorationSeed: 0,
    };
  }
  const tileIds = Object.keys(tiles);
  const landIds = tileIds.filter((id) => tiles[id]!.terrain !== "water");
  return {
    archetype: "heartland",
    seed: "path-test",
    width: cells.length,
    height: 1,
    landCount: landIds.length,
    tiles,
    tileIds,
    landIds,
    spawnCenters: [],
    spawnClusters: [],
    generationAttempt: 0,
  };
}

describe("pointy-top axial geometry", () => {
  it("uses the six canonical clockwise neighbors", () => {
    expect(AXIAL_DIRECTIONS).toEqual([
      { q: 1, r: 0 },
      { q: 0, r: 1 },
      { q: -1, r: 1 },
      { q: -1, r: 0 },
      { q: 0, r: -1 },
      { q: 1, r: -1 },
    ]);
    expect(neighbors({ q: 3, r: -2 })).toHaveLength(6);
    expect(new Set(neighbors({ q: 3, r: -2 }).map(axialKey)).size).toBe(6);
  });

  it("measures axial distance and emits complete rings", () => {
    expect(distance({ q: 0, r: 0 }, { q: 3, r: -1 })).toBe(3);
    expect(ring({ q: 2, r: 3 }, 0)).toEqual([{ q: 2, r: 3 }]);
    const radiusThree = ring({ q: 2, r: 3 }, 3);
    expect(radiusThree).toHaveLength(18);
    expect(new Set(radiusThree.map(axialKey)).size).toBe(18);
    expect(radiusThree.every((hex) => distance(hex, { q: 2, r: 3 }) === 3)).toBe(true);
  });

  it("draws a deterministic adjacent line including both endpoints", () => {
    const cells = line({ q: -2, r: 1 }, { q: 4, r: -3 });
    expect(cells[0]).toEqual({ q: -2, r: 1 });
    expect(cells.at(-1)).toEqual({ q: 4, r: -3 });
    expect(cells).toHaveLength(distance(cells[0]!, cells.at(-1)!) + 1);
    for (let index = 1; index < cells.length; index += 1) {
      expect(distance(cells[index - 1]!, cells[index]!)).toBe(1);
    }
    expect(line({ q: -2, r: 1 }, { q: 4, r: -3 })).toEqual(cells);
  });

  it("round-trips pointy-top pixel centers and camera transforms", () => {
    const size = 24;
    const origin = { x: 18, y: -7 };
    expect(axialToPixel({ q: 1, r: 0 }, size)).toEqual({
      x: Math.sqrt(3) * size,
      y: 0,
    });
    expect(axialToPixel({ q: 0, r: 1 }, size)).toEqual({
      x: (Math.sqrt(3) * size) / 2,
      y: size * 1.5,
    });

    for (const hex of [
      { q: 0, r: 0 },
      { q: 5, r: -3 },
      { q: -8, r: 6 },
    ]) {
      expect(pixelToAxial(axialToPixel(hex, size, origin), size, origin)).toEqual(hex);
      const camera = { x: 300, y: 120, zoom: 1.75 };
      expect(screenToAxial(axialToScreen(hex, size, camera, origin), size, camera, origin)).toEqual(
        hex,
      );
    }
  });

  it("selects the nearest hex on both sides of a shared edge", () => {
    const size = 30;
    const east = axialToPixel({ q: 1, r: 0 }, size);
    const midpoint = { x: east.x / 2, y: 0 };
    expect(pixelToAxial({ x: midpoint.x - 0.01, y: 0 }, size)).toEqual({ q: 0, r: 0 });
    expect(pixelToAxial({ x: midpoint.x + 0.01, y: 0 }, size)).toEqual({ q: 1, r: 0 });
  });
});

describe("deterministic terrain-aware A*", () => {
  it("uses integer terrain costs and chooses a cheaper plains detour", () => {
    expect(terrainMovementCost("plains")).toBe(1000);
    expect(terrainMovementCost("hills")).toBe(BALANCE.hillsMovementPermille);
    expect(terrainMovementCost("water")).toBe(Number.POSITIVE_INFINITY);

    const cells: Parameters<typeof pathMap>[0] = [];
    for (let q = 0; q <= 8; q += 1) {
      cells.push({ q, r: 0, terrain: q > 0 && q < 8 ? "hills" : "plains" });
    }
    for (let q = 0; q <= 7; q += 1) cells.push({ q, r: 1 });
    const map = pathMap(cells);
    const path = findPath(map, "0,0", "8,0", 0, false);
    expect(path).not.toBeNull();
    expect(path).toContain("0,1");
    expect(pathMovementCost(map, path!)).toBe(9000);
  });

  it("allows a non-owned destination only as the final step", () => {
    const map = pathMap([
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0, owner: 1 },
      { q: 3, r: 0, owner: 0 },
    ]);
    expect(findPath(map, "0,0", "2,0", 0)).toEqual(["0,0", "1,0", "2,0"]);
    expect(findPath(map, "0,0", "2,0", 0, false)).toBeNull();
    expect(findPath(map, "0,0", "3,0", 0)).toBeNull();
    expect(isLegalPath(map, ["0,0", "1,0", "2,0"], 0, true)).toBe(true);
    expect(isLegalPath(map, ["0,0", "1,0", "2,0", "3,0"], 0, true)).toBe(false);
  });

  it("breaks equal-cost ties deterministically", () => {
    const map = pathMap([
      { q: 0, r: 0 },
      { q: 0, r: -1 },
      { q: 1, r: -1 },
      { q: 0, r: 1 },
      { q: 1, r: 1 },
      { q: 2, r: 0 },
    ]);
    const paths = Array.from({ length: 20 }, () => findPath(map, "0,0", "2,0", 0));
    expect(paths.every((path) => JSON.stringify(path) === JSON.stringify(paths[0]))).toBe(true);
  });

  it("finds the last legal stop when a route is cut", () => {
    const map = pathMap([
      { q: 0, r: 0 },
      { q: 1, r: 0 },
      { q: 2, r: 0, owner: 1 },
      { q: 3, r: 0 },
    ]);
    expect(lastLegalFriendlyTile(map, ["0,0", "1,0", "2,0", "3,0"], 0)).toBe("1,0");
  });
});

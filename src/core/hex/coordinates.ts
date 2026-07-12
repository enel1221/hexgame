import type { Axial } from "../../shared/types";

export interface Point {
  x: number;
  y: number;
}

export interface CameraTransform {
  x: number;
  y: number;
  zoom: number;
}

interface Cube {
  x: number;
  y: number;
  z: number;
}

/** Clockwise pointy-top directions, beginning at east. */
export const AXIAL_DIRECTIONS: readonly Axial[] = Object.freeze([
  Object.freeze({ q: 1, r: 0 }),
  Object.freeze({ q: 0, r: 1 }),
  Object.freeze({ q: -1, r: 1 }),
  Object.freeze({ q: -1, r: 0 }),
  Object.freeze({ q: 0, r: -1 }),
  Object.freeze({ q: 1, r: -1 }),
]);

export function axialKey(hex: Axial): string;
export function axialKey(q: number, r: number): string;
export function axialKey(hexOrQ: Axial | number, maybeR?: number): string {
  const q = typeof hexOrQ === "number" ? hexOrQ : hexOrQ.q;
  const r = typeof hexOrQ === "number" ? maybeR : hexOrQ.r;
  if (!Number.isInteger(q) || !Number.isInteger(r)) {
    throw new Error("Axial coordinates must be integers");
  }
  return `${q},${r}`;
}

export function parseAxialKey(id: string): Axial {
  const match = /^(-?\d+),(-?\d+)$/.exec(id);
  if (!match) throw new Error(`Invalid axial tile id: ${id}`);
  return { q: Number(match[1]), r: Number(match[2]) };
}

/** Stable numeric ordering for authoritative tile IDs; never uses host collation. */
export function compareAxialKeys(leftId: string, rightId: string): number {
  const left = parseAxialKey(leftId);
  const right = parseAxialKey(rightId);
  return left.q - right.q || left.r - right.r;
}

export function equalAxial(left: Axial, right: Axial): boolean {
  return left.q === right.q && left.r === right.r;
}

export function addAxial(left: Axial, right: Axial): Axial {
  return { q: left.q + right.q, r: left.r + right.r };
}

export function subtractAxial(left: Axial, right: Axial): Axial {
  return { q: left.q - right.q, r: left.r - right.r };
}

export function scaleAxial(hex: Axial, scalar: number): Axial {
  return { q: hex.q * scalar, r: hex.r * scalar };
}

export function neighbor(hex: Axial, direction: number): Axial {
  const normalized = ((direction % 6) + 6) % 6;
  return addAxial(hex, AXIAL_DIRECTIONS[normalized]!);
}

export function neighbors(hex: Axial): Axial[] {
  return AXIAL_DIRECTIONS.map((direction) => addAxial(hex, direction));
}

export function axialToCube(hex: Axial): Cube {
  return { x: hex.q, y: -hex.q - hex.r, z: hex.r };
}

export function cubeToAxial(cube: Cube): Axial {
  return { q: cube.x, r: cube.z };
}

export function distance(left: Axial, right: Axial): number {
  const deltaQ = left.q - right.q;
  const deltaR = left.r - right.r;
  return (Math.abs(deltaQ) + Math.abs(deltaR) + Math.abs(deltaQ + deltaR)) / 2;
}

export const hexDistance = distance;

/**
 * Returns the radius-sized ring in stable clockwise order. Radius zero returns
 * the center, which is convenient for callers building spirals.
 */
export function ring(center: Axial, radius: number): Axial[] {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new Error("Hex ring radius must be a non-negative integer");
  }
  if (radius === 0) return [{ ...center }];

  const output: Axial[] = [];
  let cursor = addAxial(center, scaleAxial(AXIAL_DIRECTIONS[4]!, radius));
  for (let side = 0; side < 6; side += 1) {
    for (let step = 0; step < radius; step += 1) {
      output.push(cursor);
      cursor = neighbor(cursor, side);
    }
  }
  return output;
}

export const hexRing = ring;

export function spiral(center: Axial, radius: number): Axial[] {
  const output: Axial[] = [];
  for (let currentRadius = 0; currentRadius <= radius; currentRadius += 1) {
    output.push(...ring(center, currentRadius));
  }
  return output;
}

function cubeRound(cube: Cube): Cube {
  let x = Math.round(cube.x);
  let y = Math.round(cube.y);
  let z = Math.round(cube.z);

  const xDifference = Math.abs(x - cube.x);
  const yDifference = Math.abs(y - cube.y);
  const zDifference = Math.abs(z - cube.z);

  if (xDifference > yDifference && xDifference > zDifference) {
    x = -y - z;
  } else if (yDifference > zDifference) {
    y = -x - z;
  } else {
    z = -x - y;
  }

  return { x, y, z };
}

export function roundAxial(hex: Axial): Axial {
  return cubeToAxial(cubeRound(axialToCube(hex)));
}

/** Includes both endpoints and always contains exactly distance + 1 cells. */
export function line(start: Axial, end: Axial): Axial[] {
  const length = distance(start, end);
  if (length === 0) return [{ ...start }];

  const startCube = axialToCube(start);
  const endCube = axialToCube(end);
  const epsilon = 1e-6;
  const output: Axial[] = [];

  for (let step = 0; step <= length; step += 1) {
    const amount = step / length;
    // A tiny deterministic nudge resolves lines that run exactly along an edge.
    const interpolated = {
      x: startCube.x + (endCube.x - startCube.x) * amount + epsilon,
      y: startCube.y + (endCube.y - startCube.y) * amount + epsilon,
      z: startCube.z + (endCube.z - startCube.z) * amount - 2 * epsilon,
    };
    output.push(cubeToAxial(cubeRound(interpolated)));
  }

  return output;
}

export const hexLine = line;

/** Pointy-top axial center conversion. */
export function axialToPixel(hex: Axial, size: number, origin: Point = { x: 0, y: 0 }): Point {
  if (!(size > 0)) throw new Error("Hex size must be greater than zero");
  return {
    x: origin.x + size * Math.sqrt(3) * (hex.q + hex.r / 2),
    y: origin.y + size * 1.5 * hex.r,
  };
}

/** Returns the nearest pointy-top axial cell. */
export function pixelToAxial(point: Point, size: number, origin: Point = { x: 0, y: 0 }): Axial {
  if (!(size > 0)) throw new Error("Hex size must be greater than zero");
  const x = (point.x - origin.x) / size;
  const y = (point.y - origin.y) / size;
  return roundAxial({
    q: (Math.sqrt(3) / 3) * x - y / 3,
    r: (2 / 3) * y,
  });
}

export function axialToScreen(
  hex: Axial,
  size: number,
  camera: CameraTransform,
  origin: Point = { x: 0, y: 0 },
): Point {
  const world = axialToPixel(hex, size, origin);
  return {
    x: camera.x + world.x * camera.zoom,
    y: camera.y + world.y * camera.zoom,
  };
}

export function screenToAxial(
  point: Point,
  size: number,
  camera: CameraTransform,
  origin: Point = { x: 0, y: 0 },
): Axial {
  if (!(camera.zoom > 0)) throw new Error("Camera zoom must be greater than zero");
  return pixelToAxial(
    {
      x: (point.x - camera.x) / camera.zoom,
      y: (point.y - camera.y) / camera.zoom,
    },
    size,
    origin,
  );
}

export const hitTestHex = screenToAxial;

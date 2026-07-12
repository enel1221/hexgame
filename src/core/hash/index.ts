import type { GameState } from "../../shared/types";

/**
 * JSON with lexicographically sorted object keys. The simulation only stores
 * JSON-compatible values, so this also gives snapshots a portable wire format.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** A small, browser-safe, deterministic 64-bit-shaped hash (two 32-bit lanes). */
export function stableHash(value: unknown): string {
  const input = typeof value === "string" ? value : stableStringify(value);
  let laneA = 0x811c9dc5;
  let laneB = 0x9e3779b9;

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    laneA = Math.imul(laneA ^ code, 0x01000193) >>> 0;
    laneB = Math.imul(laneB ^ code, 0x85ebca6b) >>> 0;
    laneB = ((laneB << 13) | (laneB >>> 19)) >>> 0;
  }

  return `${laneA.toString(16).padStart(8, "0")}${laneB.toString(16).padStart(8, "0")}`;
}

export function hashGameState(state: GameState): string {
  const rulesConfig: Record<string, unknown> = { ...state.config };
  for (const presentationKey of [
    "graphics",
    "sound",
    "colorPatterns",
    "fullCounts",
    "debug",
    "localPlayerId",
    "playerName",
  ]) {
    delete rulesConfig[presentationKey];
  }
  return stableHash({ ...state, stateHash: undefined, config: rulesConfig });
}

export function cloneDeterministic<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

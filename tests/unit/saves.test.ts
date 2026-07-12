import { describe, expect, it } from "vitest";
import { createGame } from "../../src/core";
import { LOCAL_SAVE_KEY, readLocalSnapshot, type SaveStorage } from "../../src/client/saves";
import { TEST_CONFIG } from "./fixtures";

class MemoryStorage implements SaveStorage {
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.removed.push(key);
    this.values.delete(key);
  }
}

describe("local campaign recovery", () => {
  it("loads a validated local snapshot without changing storage", () => {
    const storage = new MemoryStorage();
    const snapshot = createGame({ ...TEST_CONFIG, seed: "valid-local-save" }).exportSnapshot();
    storage.values.set(LOCAL_SAVE_KEY, JSON.stringify(snapshot));

    expect(readLocalSnapshot(storage)).toEqual(snapshot);
    expect(storage.removed).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{definitely-not-json"],
    [
      "malformed version-1 data",
      JSON.stringify({ state: { version: 1, tick: "wrong" }, commandHistory: [] }),
    ],
  ])("removes %s and reports a recoverable error", (_label, payload) => {
    const storage = new MemoryStorage();
    storage.values.set(LOCAL_SAVE_KEY, payload);

    expect(() => readLocalSnapshot(storage)).toThrow(
      "The local campaign was invalid and has been removed",
    );
    expect(storage.getItem(LOCAL_SAVE_KEY)).toBeNull();
    expect(storage.removed).toEqual([LOCAL_SAVE_KEY]);
  });
});

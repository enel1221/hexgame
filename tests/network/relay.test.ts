import { describe, expect, it } from "vitest";
import {
  assignRelayOrder,
  boundedInteger,
  compareStateHashes,
  createRoomCode,
  currentServerTick,
} from "../../src/edge/relay";
import { ROOM_CODE_ALPHABET } from "../../src/edge/protocol";

describe("deterministic command relay helpers", () => {
  it("creates six-character codes from the non-ambiguous alphabet", () => {
    const code = createRoomCode(new Uint8Array([0, 1, 2, 3, 30, 31]));
    expect(code).toHaveLength(6);
    expect([...code].every((character) => ROOM_CODE_ALPHABET.includes(character))).toBe(true);
    expect(() => createRoomCode(new Uint8Array(5))).toThrow(/six random bytes/i);
  });

  it("assigns monotonic sequence numbers several ticks into the future", () => {
    expect(
      assignRelayOrder({
        nextSequence: 8,
        currentTick: 100,
        lastTargetTick: 104,
        leadTicks: 6,
      }),
    ).toEqual({ sequence: 8, targetTick: 106 });
    expect(
      assignRelayOrder({
        nextSequence: 9,
        currentTick: 100,
        lastTargetTick: 112,
        leadTicks: 6,
      }),
    ).toEqual({ sequence: 9, targetTick: 112 });
  });

  it("derives server ticks without running a permanent timer", () => {
    expect(currentServerTick(1_000, 2_550, 10)).toBe(15);
    expect(currentServerTick(null, 2_550, 10)).toBe(0);
  });

  it("detects disagreements and only identifies a strict majority", () => {
    expect(compareStateHashes({ a: "aaaa", b: "aaaa" })).toEqual({
      desynchronized: false,
      majorityHash: "aaaa",
    });
    expect(compareStateHashes({ a: "aaaa", b: "bbbb" })).toEqual({
      desynchronized: true,
      majorityHash: null,
    });
    expect(compareStateHashes({ a: "aaaa", b: "aaaa", c: "bbbb" })).toEqual({
      desynchronized: true,
      majorityHash: "aaaa",
    });
  });

  it("bounds deployment tuning values", () => {
    expect(boundedInteger(undefined, 6, 2, 30)).toBe(6);
    expect(boundedInteger("1", 6, 2, 30)).toBe(2);
    expect(boundedInteger("999", 6, 2, 30)).toBe(30);
  });
});

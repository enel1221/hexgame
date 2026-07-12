import { describe, expect, it } from "vitest";
import {
  AI_PLACEMENT_MIN_MS,
  assignRelayOrder,
  boundedInteger,
  compareStateHashes,
  createRoomCode,
  currentServerTick,
  finalizePlacementCenters,
  placementCenterDistance,
  placementCentersPreserveDistanceFairness,
} from "../../src/edge/relay";
import { ROOM_CODE_ALPHABET } from "../../src/edge/protocol";
import {
  applyCommand,
  computeFinalSpawnVector,
  createGame,
  deriveGenerationSeed,
  eligibleSpawnCenters,
  validateSpawnChoice,
} from "../../src/core";
import { BALANCE, TICKS_PER_SECOND } from "../../src/shared/balance";

describe("deterministic command relay helpers", () => {
  it("holds room start beyond the deterministic core AI lock deadline", () => {
    expect(AI_PLACEMENT_MIN_MS).toBeGreaterThanOrEqual(
      (BALANCE.aiPlacementLockDeadlineTicks * 1000) / TICKS_PER_SECOND,
    );
  });

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

  it("completes timed-out placements deterministically without candidate-order drift", () => {
    const candidates = ["0,0", "6,0", "12,0", "18,0", "24,0", "30,0"];
    const input = {
      seed: "placement-timeout",
      totalParticipants: 4,
      candidates,
      selections: [
        { seat: 0, centerId: "0,0" },
        { seat: 2, centerId: "12,0" },
      ],
    } as const;
    const expected = finalizePlacementCenters(input);
    expect(finalizePlacementCenters({ ...input, candidates: [...candidates].reverse() })).toEqual(
      expected,
    );
    expect(expected[0]).toBe("0,0");
    expect(expected[2]).toBe("12,0");
    expect(placementCentersPreserveDistanceFairness(expected)).toBe(true);
    for (let left = 0; left < expected.length; left += 1) {
      for (let right = left + 1; right < expected.length; right += 1) {
        expect(placementCenterDistance(expected[left]!, expected[right]!)).toBeGreaterThanOrEqual(
          6,
        );
      }
    }
  });

  it("uses the core projection rule for fixed human claims", () => {
    const engine = createGame({
      seed: "fair-choice-audit",
      archetype: "heartland",
      difficulty: "normal",
      aiCount: 0,
      multiplayer: true,
      humanSeats: [0, 1, 2, 3],
      playerNames: ["North", "East", "South", "West"],
      playerName: "North",
      graphics: "low",
      sound: false,
      colorPatterns: true,
      debug: false,
    });
    const selections = [
      { seat: 0, centerId: "8,13" },
      { seat: 1, centerId: "18,7" },
      { seat: 2, centerId: "16,3" },
    ] as const;
    for (const selection of selections) {
      expect(
        applyCommand(engine.state, {
          type: "choose-spawn",
          playerId: selection.seat,
          centerId: selection.centerId,
        }).ok,
      ).toBe(true);
    }

    const coreVector = computeFinalSpawnVector(engine.state);
    const candidates = eligibleSpawnCenters(engine.state.map);
    const relayVector = finalizePlacementCenters({
      seed: "fair-choice-audit",
      totalParticipants: 4,
      candidates: [...candidates].reverse(),
      selections,
    });
    expect(relayVector).toEqual(coreVector);
    expect(placementCentersPreserveDistanceFairness(relayVector)).toBe(true);
  });

  it("matches core AI reservations regardless of provisional lock timing", () => {
    const engine = createGame({
      seed: "relay-ai-reservations",
      archetype: "heartland",
      difficulty: "normal",
      aiCount: 2,
      multiplayer: true,
      humanSeats: [0, 1],
      playerNames: ["North", "South", "Bot One", "Bot Two"],
      playerName: "North",
      graphics: "low",
      sound: false,
      colorPatterns: true,
      debug: false,
    });
    const candidates = eligibleSpawnCenters(engine.state.map);
    const north = candidates.find((center) => validateSpawnChoice(engine.state, 0, center).ok)!;
    expect(
      applyCommand(engine.state, { type: "choose-spawn", playerId: 0, centerId: north }).ok,
    ).toBe(true);
    const south = candidates.find(
      (center) => center !== north && validateSpawnChoice(engine.state, 1, center).ok,
    )!;
    expect(
      applyCommand(engine.state, { type: "choose-spawn", playerId: 1, centerId: south }).ok,
    ).toBe(true);

    const coreVector = computeFinalSpawnVector(engine.state);
    const relayVector = finalizePlacementCenters({
      seed: deriveGenerationSeed(engine.state.map.seed, engine.state.map.generationAttempt),
      totalParticipants: 4,
      candidates: [...candidates].reverse(),
      selections: [
        { seat: 0, centerId: north },
        { seat: 1, centerId: south },
      ],
      reservedSeats: [2, 3],
    });
    expect(relayVector).toEqual(coreVector);

    engine.step(100);
    expect(
      engine.state.placement.placements.slice(2).map((placement) => placement.centerId),
    ).toEqual(coreVector.slice(2));
    expect(engine.state.placement.placements.slice(2).every((placement) => placement.locked)).toBe(
      true,
    );
  });

  it("rejects conflicting fixed placements atomically", () => {
    expect(() =>
      finalizePlacementCenters({
        seed: "placement-conflict",
        totalParticipants: 2,
        candidates: ["0,0", "5,0", "10,0"],
        selections: [
          { seat: 0, centerId: "0,0" },
          { seat: 1, centerId: "5,0" },
        ],
      }),
    ).toThrow(/conflicts/i);
  });

  it("rejects a complete vector with a materially isolated center", () => {
    const centers = ["8,13", "18,7", "16,3", "2,5"];
    expect(placementCentersPreserveDistanceFairness(centers)).toBe(false);
    expect(() =>
      finalizePlacementCenters({
        seed: "fair-choice-audit",
        totalParticipants: centers.length,
        candidates: centers,
        selections: centers.map((centerId, seat) => ({ seat, centerId })),
      }),
    ).toThrow(/nearest-distance fairness/i);
  });
});

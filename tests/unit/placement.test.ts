import { describe, expect, it } from "vitest";
import {
  analyzeMapFairness,
  applyCommand,
  computeFinalSpawnVector,
  createGame,
  deriveGenerationSeed,
  deriveReservedPlacementCenters,
  eligibleSpawnCenters,
  importSnapshot,
  distance,
  parseAxialKey,
  validateFinalSpawnVector,
  validateSpawnChoice,
  validateSpawnChoicePreview,
  axialKey,
  neighbors,
  totalUnits,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import type { GameCommand } from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function humanChoices(engine: ReturnType<typeof createGame>, playerId = 0): string[] {
  return eligibleSpawnCenters(engine.state.map).filter(
    (id) => validateSpawnChoice(engine.state, playerId, id).ok,
  );
}

describe("deterministic spawn placement", () => {
  it("starts on a neutral tick-zero map and validates provisional conflicts", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "placement-neutral" });
    expect(engine.state.phase).toBe("placement");
    expect(engine.state.tick).toBe(0);
    expect(engine.state.map.spawnCenters).toEqual([]);
    expect(engine.state.map.landIds.every((id) => engine.state.map.tiles[id]!.owner === null)).toBe(
      true,
    );
    expect(engine.state.placement.placements.slice(1).every((entry) => entry.centerId)).toBe(true);

    const candidate = humanChoices(engine)[0]!;
    const shoreline = engine.state.map.landIds.find(
      (id) => !eligibleSpawnCenters(engine.state.map).includes(id),
    )!;
    expect(validateSpawnChoice(engine.state, 0, shoreline).ok).toBe(false);
    expect(
      engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId: candidate }).ok,
    ).toBe(true);
    engine.step(1);
    expect(engine.state.placement.placements[0]).toMatchObject({
      centerId: candidate,
      locked: false,
    });
    const conflictingAi = engine.state.placement.placements[1]!.centerId!;
    expect(validateSpawnChoice(engine.state, 0, conflictingAi).ok).toBe(false);
  });

  it("rejects every gameplay command without mutation before the match is running", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "placement-command-gate" });
    const [sourceId, destinationId] = eligibleSpawnCenters(engine.state.map);
    const commands: GameCommand[] = [
      {
        type: "move",
        playerId: 0,
        sourceId: sourceId!,
        destinationId: destinationId!,
        percent: 50,
      },
      {
        type: "multi-move",
        playerId: 0,
        sourceIds: [sourceId!],
        destinationIds: [destinationId!],
        percent: 50,
      },
      { type: "build", playerId: 0, tileId: sourceId!, structure: "wizard-tower" },
      { type: "cancel-build", playerId: 0, tileId: sourceId! },
      { type: "toggle-production", playerId: 0, tileId: sourceId! },
      { type: "set-rally", playerId: 0, tileId: sourceId!, destinationId: destinationId! },
      { type: "clear-rally", playerId: 0, tileId: sourceId! },
    ];
    const before = structuredClone(engine.state);
    for (const command of commands) {
      expect(applyCommand(engine.state, command)).toEqual({
        ok: false,
        reason: "Match is not running",
      });
    }
    expect(engine.state).toEqual(before);
  });

  it("lets a human relocate, lock, and wait while AI performs two or three relocations", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "placement-relocate" });
    const [first, second] = humanChoices(engine);
    engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId: first! });
    engine.step(1);
    engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId: second! });
    engine.submitCommand({ type: "lock-spawn", playerId: 0 });
    engine.step(1);
    expect(engine.state.placement.placements[0]).toMatchObject({ centerId: second, locked: true });
    expect(engine.state.tick).toBe(0);

    const previous = engine.state.placement.placements.map((entry) => entry.centerId);
    const relocationCounts = new Array(engine.state.players.length).fill(0);
    for (let tick = 0; tick < 100 && engine.state.phase === "placement"; tick += 1) {
      engine.step(1);
      engine.state.placement.placements.forEach((placement, playerId) => {
        if (placement.centerId !== previous[playerId]) {
          relocationCounts[playerId] += 1;
          previous[playerId] = placement.centerId;
        }
      });
    }
    expect(engine.state.phase).toBe("opening");
    expect(engine.state.tick).toBe(0);
    for (const placement of engine.state.placement.placements.slice(1)) {
      expect(placement.locked).toBe(true);
      expect([2, 3]).toContain(relocationCounts[placement.playerId]);
    }
    for (let playerId = 0; playerId < engine.state.players.length; playerId += 1) {
      const cluster = engine.state.map.spawnClusters[playerId]!;
      expect(cluster).toHaveLength(BALANCE.startingTiles);
      expect(
        cluster.reduce((sum, id) => sum + totalUnits(engine.state.map.tiles[id]!.units), 0),
      ).toBe(BALANCE.startingTroops);
      const centerId = engine.state.map.spawnCenters[playerId]!;
      expect(new Set(cluster)).toEqual(
        new Set([centerId, ...neighbors(engine.state.map.tiles[centerId]!).map(axialKey)]),
      );
      expect(
        engine.state.map.tiles[engine.state.map.spawnCenters[playerId]!]!.structure,
      ).toMatchObject({
        type: "barracks",
        completedCount: 1,
      });
    }
  });

  it("locks reserved AI centers without waiting for an unlocked human to finish", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "placement-bots-do-not-wait" });
    const reservations = deriveReservedPlacementCenters({
      seed: deriveGenerationSeed(engine.state.map.seed, engine.state.map.generationAttempt),
      totalParticipants: engine.state.players.length,
      candidates: eligibleSpawnCenters(engine.state.map),
      reservedSeats: engine.state.players
        .filter((player) => !player.isHuman)
        .map((player) => player.id),
      minimumDistance: BALANCE.minimumSpawnDistance,
    });
    for (const reservation of reservations) {
      expect(validateSpawnChoicePreview(engine.state, 0, reservation.centerId)).toMatchObject({
        ok: false,
      });
    }
    const first = humanChoices(engine)[0]!;
    expect(engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId: first }).ok).toBe(
      true,
    );
    engine.step(1);
    expect(engine.state.placement.placements[0]).toMatchObject({
      centerId: first,
      locked: false,
    });

    for (let tick = 0; tick < BALANCE.aiPlacementLockDeadlineTicks; tick += 1) {
      if (engine.state.placement.placements.slice(1).every((placement) => placement.locked)) break;
      engine.step(1);
    }
    expect(engine.state.phase).toBe("placement");
    expect(engine.state.tick).toBe(0);
    expect(engine.state.placement.elapsedTicks).toBeLessThanOrEqual(
      BALANCE.aiPlacementLockDeadlineTicks,
    );
    expect(engine.state.placement.placements.slice(1).every((placement) => placement.locked)).toBe(
      true,
    );
    const lockedAiCenters = engine.state.placement.placements
      .slice(1)
      .map((placement) => placement.centerId);
    expect(lockedAiCenters.every(Boolean)).toBe(true);
    expect(
      lockedAiCenters.every(
        (center) =>
          distance(parseAxialKey(first), parseAxialKey(center!)) >= BALANCE.minimumSpawnDistance,
      ),
    ).toBe(true);

    const second = humanChoices(engine).find((center) => center !== first)!;
    expect(second).toBeDefined();
    engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId: second });
    engine.submitCommand({ type: "lock-spawn", playerId: 0 });
    engine.step(1);

    expect(engine.state.phase).toBe("opening");
    expect(engine.state.map.spawnCenters[0]).toBe(second);
    expect(engine.state.map.spawnCenters.slice(1)).toEqual(lockedAiCenters);
  });

  it("purely projects an accepted reserved-layout choice into a fair final allocation", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "fair-choice-audit" });
    const beforeValidation = structuredClone(engine.state);
    const centerId = humanChoices(engine)[0]!;

    expect(validateSpawnChoice(engine.state, 0, centerId)).toEqual({ ok: true });
    expect(engine.state).toEqual(beforeValidation);
    expect(engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId }).ok).toBe(true);
    engine.step(1);
    expect(engine.submitCommand({ type: "lock-spawn", playerId: 0 }).ok).toBe(true);
    for (let tick = 0; tick < 100 && engine.state.phase === "placement"; tick += 1) {
      engine.step(1);
    }

    const report = analyzeMapFairness(engine.state.map, engine.state.players.length);
    expect(engine.state.phase).toBe("opening");
    expect(engine.state.map.spawnCenters[0]).toBe(centerId);
    expect(report.valid, report.reasons.join("; ")).toBe(true);
    expect(report.maximumNearestSpawnDistance).toBeLessThanOrEqual(report.minimumSpawnDistance * 2);
  });

  it("extends partial human claims while preview rejects an unbalanced final choice", () => {
    const engine = createGame({
      ...TEST_CONFIG,
      seed: "balance-fixture-0",
      multiplayer: true,
      aiCount: 0,
      humanSeats: [0, 1, 2, 3],
      playerNames: ["North", "East", "South", "West"],
    });
    for (const [playerId, centerId] of [
      [0, "0,4"],
      [1, "10,5"],
      [2, "6,7"],
    ] as const) {
      expect(applyCommand(engine.state, { type: "choose-spawn", playerId, centerId })).toEqual({
        ok: true,
      });
    }

    const beforePreview = structuredClone(engine.state);
    const rejectedPreview = validateSpawnChoicePreview(engine.state, 3, "9,2");
    expect(rejectedPreview).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/balanced placement spacing/i),
    });
    expect(validateSpawnChoice(engine.state, 3, "9,2")).toEqual(rejectedPreview);
    expect(engine.state).toEqual(beforePreview);

    const vector = computeFinalSpawnVector(engine.state);
    expect(vector.slice(0, 3)).toEqual(["0,4", "10,5", "6,7"]);
    expect(validateFinalSpawnVector(engine.state, vector)).toEqual({ ok: true });
  });

  it("uses one canonical multiplayer final vector for timeout and reconnect", () => {
    const config = {
      ...TEST_CONFIG,
      seed: "placement-multiplayer-final",
      multiplayer: true,
      aiCount: 2,
      humanSeats: [0, 1],
      playerNames: ["North", "South", "Bot", "Bot Two"],
    };
    const left = createGame(config);
    const right = createGame(config);
    const leftChoice = humanChoices(left, 0)[0]!;
    const rightChoice = humanChoices(left, 1).find((id) => id !== leftChoice)!;
    for (const engine of [left, right]) {
      engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId: leftChoice });
      engine.submitCommand({ type: "lock-spawn", playerId: 0 });
      engine.submitCommand({ type: "choose-spawn", playerId: 1, centerId: rightChoice });
      engine.submitCommand({ type: "lock-spawn", playerId: 1 });
    }
    // Clients can reach the deadline with different local placement clocks and
    // therefore different provisional AI markers. Consensus ignores that
    // presentation state and derives bots only from map seed + human claims.
    left.step(1);
    right.step(80);
    const vector = computeFinalSpawnVector(left.state);
    expect(computeFinalSpawnVector(right.state)).toEqual(vector);
    expect(validateFinalSpawnVector(left.state, vector).ok).toBe(true);
    expect(right.finalizePlacement(vector).ok).toBe(true);
    expect(left.finalizePlacement(vector).ok).toBe(true);
    expect(left.state.stateHash).toBe(right.state.stateHash);
    expect(left.state.phase).toBe("opening");

    const direct = createGame(left.state.config);
    expect(direct.state.stateHash).toBe(left.state.stateHash);
    expect(direct.state.nextEntityId).toBe(left.state.nextEntityId);

    const restored = importSnapshot(left.exportSnapshot());
    expect(restored.state.stateHash).toBe(left.state.stateHash);
    expect(restored.state.map.spawnCenters).toEqual(vector);
  });

  it("deterministically assigns a missing human on multiplayer timeout finalization", () => {
    const engine = createGame({
      ...TEST_CONFIG,
      seed: "placement-timeout",
      multiplayer: true,
      aiCount: 0,
      humanSeats: [0, 1],
      playerNames: ["North", "South"],
    });
    const vector = computeFinalSpawnVector(engine.state);
    expect(vector).toHaveLength(2);
    expect(new Set(vector).size).toBe(2);
    expect(engine.finalizePlacement(vector).ok).toBe(true);
    expect(engine.state.phase).toBe("opening");
  });
});

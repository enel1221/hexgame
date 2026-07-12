import { describe, expect, it } from "vitest";
import type { EngineSnapshot, WorkerResponse } from "../../src/shared/types";
import {
  cloneDeterministic,
  hashGameState,
  importSnapshot,
  parseEngineSnapshot,
  SnapshotValidationError,
  stableHash,
} from "../../src/core";
import { SimulationWorkerController } from "../../src/worker";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

function validSnapshot(): EngineSnapshot {
  const engine = createRunningGame({ ...TEST_CONFIG, seed: "snapshot-runtime-validation" });
  engine.step(90);
  return engine.exportSnapshot();
}

describe("runtime EngineSnapshot validation", () => {
  it("accepts and restores a complete version-2 snapshot", () => {
    const snapshot = validSnapshot();
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);
    const restored = importSnapshot(snapshot);
    expect(restored.state.stateHash).toBe(snapshot.state.stateHash);
    expect(restored.state.tick).toBe(snapshot.state.tick);
  });

  it("accepts a multiplayer checkpoint with multiple configured human seats", () => {
    const snapshot = createRunningGame({
      ...TEST_CONFIG,
      seed: "multiplayer-snapshot-validation",
      multiplayer: true,
      aiCount: 2,
      humanSeats: [0, 2],
      playerNames: ["North", "Bot", "South", "Bot Two"],
      localPlayerId: 2,
    }).exportSnapshot();
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);
  });

  it("round-trips a blocked Barracks rally queue and rejects impossible provenance", () => {
    const snapshot = validSnapshot();
    const tile = snapshot.state.map.tiles[snapshot.state.map.spawnCenters[0]!]!;
    const destinationId = snapshot.state.map.spawnClusters[0]!.find((id) => id !== tile.id)!;
    tile.troops = Math.max(tile.troops, 4);
    tile.structure!.rallyTargetId = destinationId;
    tile.structure!.rallyQueuedTroops = 3;
    snapshot.state.stateHash = hashGameState(snapshot.state);
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);

    const impossible = cloneDeterministic(snapshot);
    impossible.state.map.tiles[tile.id]!.structure!.rallyQueuedTroops = tile.troops + 1;
    impossible.state.stateHash = hashGameState(impossible.state);
    expect(() => parseEngineSnapshot(impossible)).toThrow(
      /rallyQueuedTroops.*retained local troops/i,
    );
  });

  it.each([
    [
      "missing state fields",
      (snapshot: Record<string, unknown>) => {
        snapshot.state = { version: 1 };
      },
    ],
    [
      "invalid owner reference",
      (snapshot: Record<string, unknown>) => {
        const state = (snapshot as unknown as EngineSnapshot).state;
        state.map.tiles[state.map.landIds[0]!]!.owner = 999;
      },
    ],
    [
      "invalid command percentage",
      (snapshot: Record<string, unknown>) => {
        const typed = snapshot as unknown as EngineSnapshot;
        typed.commandHistory.push({
          type: "move",
          playerId: 0,
          sourceId: typed.state.map.landIds[0]!,
          destinationId: typed.state.map.landIds[1]!,
          percent: 30,
        } as never);
      },
    ],
    [
      "mismatched tile record",
      (snapshot: Record<string, unknown>) => {
        const typed = snapshot as unknown as EngineSnapshot;
        const tileId = typed.state.map.tileIds[0]!;
        delete typed.state.map.tiles[tileId];
      },
    ],
  ])("rejects malformed version-1 data: %s", (_label, mutate) => {
    const malformed = cloneDeterministic(validSnapshot()) as unknown as Record<string, unknown>;
    mutate(malformed);
    expect(() => parseEngineSnapshot(malformed)).toThrow(SnapshotValidationError);
  });

  it("rejects unsupported versions explicitly", () => {
    const malformed = cloneDeterministic(validSnapshot()) as unknown as {
      state: { version: number };
    };
    malformed.state.version = 3;
    expect(() => parseEngineSnapshot(malformed)).toThrow("Unsupported snapshot version");
  });

  it("rejects a shape-valid snapshot whose deterministic payload was altered", () => {
    const tampered = cloneDeterministic(validSnapshot());
    tampered.state.players[0]!.supplyMilli += 1;
    expect(() => parseEngineSnapshot(tampered)).toThrow(/stateHash.*does not match/i);
  });

  it.each([
    [
      "land ID missing from tileIds",
      (snapshot: EngineSnapshot) => {
        snapshot.state.map.landIds.push("999,999");
        snapshot.state.map.landCount += 1;
      },
    ],
    [
      "tile coordinate identity",
      (snapshot: EngineSnapshot) => {
        snapshot.state.map.tiles[snapshot.state.map.tileIds[0]!]!.q += 1;
      },
    ],
    [
      "local player reference",
      (snapshot: EngineSnapshot) => {
        snapshot.state.config.localPlayerId = 20;
      },
    ],
    [
      "victory leader reference",
      (snapshot: EngineSnapshot) => {
        snapshot.state.victory.leaderId = 20;
      },
    ],
    [
      "victory winner reference",
      (snapshot: EngineSnapshot) => {
        snapshot.state.phase = "complete";
        snapshot.state.victory.winnerId = 20;
        snapshot.state.victory.reason = "sole-survivor";
      },
    ],
  ])("rejects a hash-consistent invalid %s", (_label, mutate) => {
    const malformed = cloneDeterministic(validSnapshot());
    mutate(malformed);
    malformed.state.stateHash = hashGameState(malformed.state);
    expect(() => parseEngineSnapshot(malformed)).toThrow(SnapshotValidationError);
  });

  it("keeps an existing engine unchanged when import validation fails", () => {
    const engine = createRunningGame({ ...TEST_CONFIG, seed: "atomic-import" });
    engine.step(25);
    const stateBefore = cloneDeterministic(engine.state);
    const historyBefore = cloneDeterministic(engine.commandHistory);
    const malformed = cloneDeterministic(engine.exportSnapshot());
    malformed.state.players[0]!.name = "";

    expect(() => engine.importSnapshot(malformed)).toThrow(SnapshotValidationError);
    expect(engine.state).toEqual(stateBefore);
    expect(engine.commandHistory).toEqual(historyBefore);
  });

  it("rejects a bad network restore while the live worker keeps advancing", () => {
    const responses: WorkerResponse[] = [];
    const controller = new SimulationWorkerController({
      postMessage: (message) => responses.push(message),
    });
    controller.handle({ type: "start", config: { ...TEST_CONFIG, seed: "worker-recovery" } });
    const malformed = cloneDeterministic(validSnapshot());
    malformed.state.map.landCount += 1;
    controller.handle({ type: "restore", snapshot: malformed });
    controller.pumpOnce();
    controller.dispose();

    expect(responses.some((message) => message.type === "error")).toBe(true);
    expect(responses.at(-1)).toEqual(
      expect.objectContaining({
        type: "state",
        state: expect.objectContaining({
          tick: 0,
          placement: expect.objectContaining({ elapsedTicks: 1 }),
          config: expect.objectContaining({ seed: "worker-recovery" }),
        }),
      }),
    );
  });

  it("strictly verifies and deterministically migrates a valid version-1 snapshot", () => {
    const current = createRunningGame({
      ...TEST_CONFIG,
      seed: "legacy-v1-migration",
    }).exportSnapshot();
    const stateFields = { ...current.state } as Partial<typeof current.state> &
      Record<string, unknown>;
    delete stateFields.phase;
    delete stateFields.placement;
    delete stateFields.enclosures;
    const legacyConfig = { ...current.state.config } as Partial<typeof current.state.config> &
      Record<string, unknown>;
    delete legacyConfig.startingCenters;
    const legacyState: Record<string, unknown> = {
      ...stateFields,
      version: 1,
      config: legacyConfig,
      map: {
        ...current.state.map,
        tiles: Object.fromEntries(
          Object.entries(current.state.map.tiles).map(([id, tile]) => [
            id,
            {
              ...tile,
              structure: tile.structure
                ? {
                    type: tile.structure.type,
                    status: tile.structure.status ?? "constructing",
                    integrity: tile.structure.integrity,
                    progressTicks:
                      tile.structure.pendingProgressTicks ??
                      Math.floor(tile.structure.barracksProgressMilli / 1_000),
                    seizedTicks: tile.structure.seizedTicks,
                    productionPaused: tile.structure.productionPaused,
                  }
                : null,
            },
          ]),
        ),
      },
      events: [],
      stateHash: "",
    };
    const legacyMap = legacyState.map as {
      tiles: Record<string, Record<string, unknown>>;
      spawnCenters: string[];
      landIds: string[];
    };
    const pendingTileId = legacyMap.landIds.find(
      (id) =>
        legacyMap.tiles[id]!.owner === 0 &&
        legacyMap.tiles[id]!.terrain === "meadow" &&
        legacyMap.tiles[id]!.structure === null,
    )!;
    legacyMap.tiles[pendingTileId]!.structure = {
      type: "farm",
      status: "constructing",
      integrity: 250,
      progressTicks: 17,
      seizedTicks: 0,
      productionPaused: false,
    };
    const battleTileId = legacyMap.spawnCenters[0]!;
    legacyMap.tiles[battleTileId]!.troops = 0;
    legacyState.tick = 10;
    legacyState.battles = [
      {
        id: 50,
        tileId: battleTileId,
        defender: 0,
        attacker: 1,
        defenderTroops: 6,
        attackerTroops: 8,
        control: 6_000,
        ageTicks: 5,
        roundAccumulator: 1,
        entryFrom: legacyMap.spawnCenters[1]!,
        waiting: [
          {
            owner: 2,
            troops: 20,
            entryFrom: legacyMap.spawnCenters[2]!,
            queuedTick: 8,
          },
        ],
        lastReinforcementTick: 9,
        reinforcementSide: "attacker",
        reinforcementAmount: 2,
      },
    ];
    legacyState.nextEntityId = 100;
    const rulesConfig = { ...legacyConfig } as Record<string, unknown>;
    for (const key of [
      "graphics",
      "sound",
      "colorPatterns",
      "debug",
      "localPlayerId",
      "playerName",
    ]) {
      delete rulesConfig[key];
    }
    legacyState.stateHash = stableHash({
      ...legacyState,
      stateHash: undefined,
      config: rulesConfig,
    });
    const migrated = parseEngineSnapshot({
      state: legacyState,
      commandHistory: [],
      pendingCommands: [],
    });
    expect(migrated.state.version).toBe(2);
    expect(migrated.state.phase).toBe("running");
    expect(migrated.state.config.startingCenters).toEqual(migrated.state.map.spawnCenters);
    expect(migrated.state.map.tiles[migrated.state.map.spawnCenters[0]!]!.structure).toMatchObject({
      completedCount: 1,
      pendingProgressTicks: null,
      rallyQueuedTroops: 0,
    });
    expect(migrated.state.map.tiles[pendingTileId]!.structure).toMatchObject({
      completedCount: 0,
      status: null,
      pendingProgressTicks: 17,
    });
    expect(migrated.state.battles[0]).toMatchObject({
      incumbentOwner: 0,
      ageTicks: 5,
      participants: [
        { playerId: 0, troops: 6, control: 4_000 },
        { playerId: 1, troops: 8, control: 6_000, reinforcementAmount: 2 },
        { playerId: 2, troops: 20, control: 5_000 },
      ],
    });
    expect(parseEngineSnapshot(migrated)).toEqual(migrated);
  });
});

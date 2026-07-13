import { describe, expect, it } from "vitest";
import type { EngineSnapshot, WorkerResponse } from "../../src/shared/types";
import {
  cloneDeterministic,
  emptyUnits,
  hashGameState,
  importSnapshot,
  parseEngineSnapshot,
  SnapshotValidationError,
  stableHash,
  totalUnits,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import { SimulationWorkerController } from "../../src/worker";
import { createRunningGame, TEST_CONFIG } from "./fixtures";

function validSnapshot(): EngineSnapshot {
  const engine = createRunningGame({ ...TEST_CONFIG, seed: "snapshot-runtime-validation" });
  engine.step(90);
  return engine.exportSnapshot();
}

function snapshotWithBattle(): EngineSnapshot {
  const snapshot = validSnapshot();
  const occupiedTile = snapshot.state.map.landIds
    .map((id) => snapshot.state.map.tiles[id]!)
    .find(
      (tile) =>
        tile.owner !== null && !snapshot.state.battles.some((battle) => battle.tileId === tile.id),
    )!;
  const units = occupiedTile.units;
  occupiedTile.units = emptyUnits();
  snapshot.state.battles.push({
    id: snapshot.state.nextEntityId,
    tileId: occupiedTile.id,
    incumbentOwner: occupiedTile.owner,
    participants: [
      {
        playerId: occupiedTile.owner,
        units,
        control: 10_000,
        casualtyProgressMilli: emptyUnits(),
        entryFrom: occupiedTile.id,
        joinedTick: snapshot.state.tick,
        lastReinforcementTick: -1,
        reinforcementAmount: 0,
      },
    ],
    ageTicks: BALANCE.minimumBattleTicks,
    roundAccumulator: 0,
  });
  snapshot.state.nextEntityId += 1;
  snapshot.state.stateHash = hashGameState(snapshot.state);
  return snapshot;
}

function asVersion2Snapshot(snapshot: EngineSnapshot): unknown {
  const migrateCommand = (command: EngineSnapshot["commandHistory"][number]): unknown => {
    if (command.type === "build") {
      const structure =
        command.structure === "archery-range"
          ? "farm"
          : command.structure === "wizard-tower"
            ? "turret"
            : "barracks";
      return { ...command, structure };
    }
    if (command.type === "toggle-production") {
      return { ...command, type: "toggle-barracks" };
    }
    return command;
  };
  const state = {
    ...snapshot.state,
    version: 2,
    map: {
      ...snapshot.state.map,
      tiles: Object.fromEntries(
        Object.entries(snapshot.state.map.tiles).map(([id, tile]) => {
          const type =
            tile.structure?.type === "archery-range"
              ? "farm"
              : tile.structure?.type === "wizard-tower"
                ? "turret"
                : tile.structure?.type;
          return [
            id,
            {
              id: tile.id,
              q: tile.q,
              r: tile.r,
              terrain: tile.terrain,
              owner: tile.owner,
              troops: totalUnits(tile.units),
              structure: tile.structure
                ? {
                    type,
                    completedCount: tile.structure.completedCount,
                    status: tile.structure.status,
                    integrity: tile.structure.integrity,
                    pendingProgressTicks: tile.structure.pendingProgressTicks,
                    seizedTicks: tile.structure.seizedTicks,
                    productionPaused: tile.structure.productionPaused,
                    barracksProgressMilli:
                      tile.structure.type === "barracks" ? tile.structure.trainingProgressMilli : 0,
                    rallyTargetId: tile.structure.rallyTargetId,
                    rallyQueuedTroops: totalUnits(tile.structure.rallyQueuedUnits),
                    turretShotProgressMilli:
                      tile.structure.type === "wizard-tower"
                        ? Math.floor((tile.structure.trainingProgressMilli * 30) / 25)
                        : 0,
                  }
                : null,
              controlledSinceTick: tile.controlledSinceTick,
              lastRewardTick: tile.lastRewardTick,
              decorationSeed: tile.decorationSeed,
            },
          ];
        }),
      ),
    },
    stacks: snapshot.state.stacks.map((stack) => ({
      id: stack.id,
      owner: stack.owner,
      troops: totalUnits(stack.units),
      path: stack.path,
      pathIndex: stack.pathIndex,
      segmentProgress: stack.segmentProgress,
      segmentDuration: stack.segmentDuration,
      originId: stack.originId,
      destinationId: stack.destinationId,
      lane: stack.lane,
      issuedTick: stack.issuedTick,
    })),
    battles: snapshot.state.battles.map((battle) => ({
      id: battle.id,
      tileId: battle.tileId,
      incumbentOwner: battle.incumbentOwner,
      participants: battle.participants.map((participant) => ({
        playerId: participant.playerId,
        troops: totalUnits(participant.units),
        control: participant.control,
        casualtyProgressMilli: Math.min(999, totalUnits(participant.casualtyProgressMilli)),
        entryFrom: participant.entryFrom,
        joinedTick: participant.joinedTick,
        lastReinforcementTick: participant.lastReinforcementTick,
        reinforcementAmount: participant.reinforcementAmount,
      })),
      ageTicks: battle.ageTicks,
      roundAccumulator: battle.roundAccumulator,
    })),
    events: snapshot.state.events.filter((event) => event.type !== "typed-support"),
    stateHash: "",
  } as Record<string, unknown> & { stateHash: string };
  state.stateHash = hashGameState(state as unknown as EngineSnapshot["state"]);
  return {
    state,
    commandHistory: snapshot.commandHistory.map(migrateCommand),
    pendingCommands: snapshot.pendingCommands?.map(migrateCommand),
  };
}

describe("runtime EngineSnapshot validation", () => {
  it("accepts and restores a complete version-3 snapshot", () => {
    const snapshot = validSnapshot();
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);
    const restored = importSnapshot(snapshot);
    expect(restored.state.stateHash).toBe(snapshot.state.stateHash);
    expect(restored.state.tick).toBe(snapshot.state.tick);
  });

  it("strictly verifies and migrates a complete version-2 snapshot", () => {
    const current = validSnapshot();
    const migrated = parseEngineSnapshot(asVersion2Snapshot(current));
    expect(migrated.state.version).toBe(3);
    expect(migrated.state.tick).toBe(current.state.tick);
    expect(migrated.state.players.map((player) => player.troopCount)).toEqual(
      current.state.players.map((player) => player.troopCount),
    );
    expect(parseEngineSnapshot(migrated)).toEqual(migrated);
  });

  it("preserves a blocked version-2 Barracks rally queue as Melee", () => {
    const legacy = asVersion2Snapshot(validSnapshot()) as {
      state: EngineSnapshot["state"] & {
        map: EngineSnapshot["state"]["map"] & {
          tiles: Record<
            string,
            {
              troops: number;
              structure: null | {
                type: "farm" | "barracks" | "turret";
                rallyTargetId: string | null;
                rallyQueuedTroops: number;
              };
            }
          >;
        };
      };
    };
    const [tileId, tile] = Object.entries(legacy.state.map.tiles).find(
      ([, candidate]) => candidate.structure?.type === "barracks" && candidate.troops >= 2,
    )!;
    const targetId = legacy.state.map.landIds.find((id) => id !== tileId)!;
    const queuedTroops = Math.min(5, tile.troops);
    tile.structure!.rallyTargetId = targetId;
    tile.structure!.rallyQueuedTroops = queuedTroops;
    legacy.state.stateHash = hashGameState(legacy.state);

    const migrated = parseEngineSnapshot(legacy);
    const migratedTile = migrated.state.map.tiles[tileId]!;
    expect(totalUnits(migratedTile.units)).toBe(tile.troops);
    expect(migratedTile.structure?.rallyQueuedUnits).toEqual({
      melee: queuedTroops,
      ranged: 0,
      wizard: 0,
    });

    const malformed = cloneDeterministic(legacy);
    malformed.state.map.tiles[tileId]!.structure!.rallyQueuedTroops = tile.troops + 1;
    malformed.state.stateHash = hashGameState(malformed.state);
    expect(() => parseEngineSnapshot(malformed)).toThrow(/rallyQueuedTroops.*retained local/i);
  });

  it("rejects hash-consistent combat accumulators outside runtime bounds", () => {
    const casualty = snapshotWithBattle();
    casualty.state.battles.at(-1)!.participants[0]!.casualtyProgressMilli.melee = 1_000;
    casualty.state.stateHash = hashGameState(casualty.state);
    expect(() => parseEngineSnapshot(casualty)).toThrow(/casualtyProgressMilli\.melee/i);

    const rounds = snapshotWithBattle();
    rounds.state.battles.at(-1)!.roundAccumulator = BALANCE.combatRoundTicks;
    rounds.state.stateHash = hashGameState(rounds.state);
    expect(() => parseEngineSnapshot(rounds)).toThrow(/roundAccumulator/i);
  });

  it("rejects hash-consistent structure timers outside their runtime phase", () => {
    const training = validSnapshot();
    const trainingTile = Object.values(training.state.map.tiles).find(
      (tile) => tile.structure !== null,
    )!;
    trainingTile.structure!.trainingProgressMilli = 999_999_999;
    training.state.stateHash = hashGameState(training.state);
    expect(() => parseEngineSnapshot(training)).toThrow(/trainingProgressMilli/i);

    const construction = validSnapshot();
    const constructionTile = Object.values(construction.state.map.tiles).find(
      (tile) => tile.structure !== null,
    )!;
    const constructionTiming =
      constructionTile.structure!.type === "barracks"
        ? BALANCE.barracks
        : constructionTile.structure!.type === "archery-range"
          ? BALANCE.archeryRange
          : BALANCE.wizardTower;
    constructionTile.structure!.pendingProgressTicks = constructionTiming.buildTicks;
    construction.state.stateHash = hashGameState(construction.state);
    expect(() => parseEngineSnapshot(construction)).toThrow(/pendingProgressTicks/i);

    const seizure = validSnapshot();
    const seizureTile = Object.values(seizure.state.map.tiles).find(
      (tile) => tile.structure !== null,
    )!;
    Object.assign(seizureTile.structure!, {
      status: "seized",
      pendingProgressTicks: null,
      integrity: BALANCE.seizedIntegrity,
      seizedTicks: BALANCE.seizedTicks,
      trainingProgressMilli: 0,
      rallyTargetId: null,
      rallyQueuedUnits: emptyUnits(),
    });
    seizure.state.stateHash = hashGameState(seizure.state);
    expect(() => parseEngineSnapshot(seizure)).toThrow(/seizedTicks/i);
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
    tile.units.melee = Math.max(tile.units.melee, 4);
    tile.structure!.rallyTargetId = destinationId;
    tile.structure!.rallyQueuedUnits = { melee: 3, ranged: 0, wizard: 0 };
    snapshot.state.stateHash = hashGameState(snapshot.state);
    expect(parseEngineSnapshot(snapshot)).toEqual(snapshot);

    const impossible = cloneDeterministic(snapshot);
    impossible.state.map.tiles[tile.id]!.structure!.rallyQueuedUnits = {
      melee: tile.units.melee + 1,
      ranged: 0,
      wizard: 0,
    };
    impossible.state.stateHash = hashGameState(impossible.state);
    expect(() => parseEngineSnapshot(impossible)).toThrow(
      /rallyQueuedUnits.*retained local units/i,
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
    malformed.state.version = 4;
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
          Object.entries(current.state.map.tiles).map(([id, tile]) => {
            const legacyType =
              tile.structure?.type === "archery-range"
                ? "farm"
                : tile.structure?.type === "wizard-tower"
                  ? "turret"
                  : tile.structure?.type;
            return [
              id,
              {
                id: tile.id,
                q: tile.q,
                r: tile.r,
                terrain: tile.terrain,
                owner: tile.owner,
                troops: totalUnits(tile.units),
                structure: tile.structure
                  ? {
                      type: legacyType,
                      status: tile.structure.status ?? "constructing",
                      integrity: tile.structure.integrity,
                      progressTicks:
                        tile.structure.pendingProgressTicks ??
                        Math.floor(tile.structure.trainingProgressMilli / 1_000),
                      seizedTicks: tile.structure.seizedTicks,
                      productionPaused: tile.structure.productionPaused,
                    }
                  : null,
                controlledSinceTick: tile.controlledSinceTick,
                lastRewardTick: tile.lastRewardTick,
                decorationSeed: tile.decorationSeed,
              },
            ];
          }),
        ),
      },
      stacks: current.state.stacks.map((stack) => ({
        id: stack.id,
        owner: stack.owner,
        troops: totalUnits(stack.units),
        path: stack.path,
        pathIndex: stack.pathIndex,
        segmentProgress: stack.segmentProgress,
        segmentDuration: stack.segmentDuration,
        originId: stack.originId,
        destinationId: stack.destinationId,
        lane: stack.lane,
        issuedTick: stack.issuedTick,
      })),
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
    expect(migrated.state.version).toBe(3);
    expect(migrated.state.phase).toBe("running");
    expect(migrated.state.config.startingCenters).toEqual(migrated.state.map.spawnCenters);
    expect(migrated.state.map.tiles[migrated.state.map.spawnCenters[0]!]!.structure).toMatchObject({
      completedCount: 1,
      pendingProgressTicks: null,
      rallyQueuedUnits: { melee: 0, ranged: 0, wizard: 0 },
    });
    expect(migrated.state.map.tiles[pendingTileId]!.structure).toMatchObject({
      type: "archery-range",
      completedCount: 0,
      status: null,
      pendingProgressTicks: 17,
    });
    expect(migrated.state.battles[0]).toMatchObject({
      incumbentOwner: 0,
      ageTicks: 5,
      participants: [
        { playerId: 0, units: { melee: 2, ranged: 2, wizard: 2 }, control: 4_000 },
        {
          playerId: 1,
          units: { melee: 3, ranged: 3, wizard: 2 },
          control: 6_000,
          reinforcementAmount: 2,
        },
        { playerId: 2, units: { melee: 7, ranged: 7, wizard: 6 }, control: 5_000 },
      ],
    });
    expect(parseEngineSnapshot(migrated)).toEqual(migrated);
  });
});

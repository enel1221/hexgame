import { describe, expect, it } from "vitest";
import {
  applySpawnAllocations,
  axialKey,
  chooseDefaultSpawnCenters,
  cloneDeterministic,
  createGame,
  detectEnclosedPockets,
  hashGameState,
  neighbors,
  ring,
  spiral,
  stableStringify,
  startBattle,
  tickEncirclements,
  parseEngineSnapshot,
  refreshPlayerAggregates,
  totalUnits,
  unitsOf,
} from "../../src/core";
import { BALANCE } from "../../src/shared/balance";
import type { GameState, MovingStack, StructureState, TileState } from "../../src/shared/types";
import { TEST_CONFIG } from "./fixtures";

function runningState(seed: string, multiplayer = false): GameState {
  const state = createGame(
    multiplayer
      ? {
          ...TEST_CONFIG,
          seed,
          multiplayer: true,
          aiCount: 2,
          humanSeats: [0, 1],
          playerNames: ["North", "South", "Bot One", "Bot Two"],
        }
      : { ...TEST_CONFIG, seed },
  ).state;
  const centers = chooseDefaultSpawnCenters(state.map, state.players.length, `${seed}:tests`);
  applySpawnAllocations(state.map, centers, `${seed}:tests`);
  state.config.startingCenters = centers;
  state.phase = "running";
  return state;
}

function clearBoard(state: GameState): void {
  state.stacks = [];
  state.battles = [];
  state.enclosures = [];
  state.events = [];
  for (const player of state.players) {
    player.eliminated = false;
    player.eliminatedBy = null;
  }
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    tile.owner = null;
    tile.units = unitsOf("melee", 1);
    tile.structure = null;
    tile.controlledSinceTick = 0;
    tile.lastRewardTick = 0;
  }
}

function safeCenter(state: GameState, radius: number): TileState {
  const land = new Set(state.map.landIds);
  const id = state.map.landIds.find((candidate) =>
    spiral(state.map.tiles[candidate]!, radius)
      .map(axialKey)
      .every((within) => land.has(within)),
  );
  if (!id) throw new Error(`No radius-${radius} inland center`);
  return state.map.tiles[id]!;
}

function installPocket(
  state: GameState,
  interiorRadius = 0,
): { center: TileState; interiorIds: string[]; boundaryIds: string[] } {
  clearBoard(state);
  const center = safeCenter(state, interiorRadius + 2);
  const interiorIds = spiral(center, interiorRadius).map(axialKey);
  const boundaryIds = ring(center, interiorRadius + 1).map(axialKey);
  for (const id of interiorIds) {
    state.map.tiles[id]!.owner = 1;
    state.map.tiles[id]!.units = unitsOf("wizard", 4);
  }
  for (const id of boundaryIds) {
    state.map.tiles[id]!.owner = 0;
    state.map.tiles[id]!.units = unitsOf("melee", 8);
  }
  return { center, interiorIds, boundaryIds };
}

function tickEnclosuresFor(state: GameState, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    state.tick += 1;
    tickEncirclements(state);
  }
}

function structure(
  type: StructureState["type"],
  completedCount: number,
  pendingProgressTicks: number | null = null,
): StructureState {
  return {
    type,
    completedCount,
    status: "active",
    integrity: BALANCE.fullIntegrity,
    pendingProgressTicks,
    seizedTicks: 0,
    productionPaused: false,
    trainingProgressMilli: 0,
    rallyTargetId: null,
    rallyQueuedUnits: unitsOf("melee", 0),
  };
}

function movingStack(
  id: number,
  owner: number,
  troops: number,
  path: [string, string],
): MovingStack {
  return {
    id,
    owner,
    units: unitsOf("melee", troops),
    path,
    pathIndex: 0,
    segmentProgress: 0,
    segmentDuration: 9,
    originId: path[0],
    destinationId: path[1],
    lane: 0,
    issuedTick: 0,
  };
}

describe("deterministic delayed encirclement", () => {
  it("captures nothing at tick 149 and consumes the pocket atomically at tick 150", () => {
    const state = runningState("enclosure-150");
    const { center } = installPocket(state);
    tickEnclosuresFor(state, BALANCE.encirclementTicks - 1);
    expect(state.enclosures).toEqual([
      expect.objectContaining({ captorId: 0, progressTicks: 149, tileIds: [center.id] }),
    ]);
    expect(center.owner).toBe(1);

    tickEnclosuresFor(state, 1);
    expect(state.enclosures).toHaveLength(0);
    expect(center.owner).toBe(0);
    expect(totalUnits(center.units)).toBe(0);
    expect(state.events.at(-1)).toMatchObject({
      type: "encirclement-complete",
      playerId: 0,
      tileIds: [center.id],
    });
  });

  it("resets on an ownership or contested-ring breach at tick 149", () => {
    const state = runningState("enclosure-breach");
    const { center, boundaryIds } = installPocket(state);
    tickEnclosuresFor(state, BALANCE.encirclementTicks - 1);
    const breach = state.map.tiles[boundaryIds[0]!]!;
    breach.owner = 2;
    tickEnclosuresFor(state, 1);
    expect(state.enclosures).toHaveLength(0);
    expect(center.owner).toBe(1);

    breach.owner = 0;
    tickEnclosuresFor(state, 1);
    expect(state.enclosures[0]?.progressTicks).toBe(1);
    breach.units = unitsOf("melee", 5);
    startBattle(state, breach, 2, unitsOf("wizard", 5), center.id);
    tickEnclosuresFor(state, 1);
    expect(state.enclosures).toHaveLength(0);
  });

  it("rejects a component with a shoreline or missing-map escape", () => {
    const state = runningState("enclosure-shoreline");
    clearBoard(state);
    const coastal = state.map.landIds
      .map((id) => state.map.tiles[id]!)
      .find((tile) =>
        neighbors(tile).some((adjacent) => {
          const candidate = state.map.tiles[axialKey(adjacent)];
          return !candidate || candidate.terrain === "water";
        }),
      )!;
    coastal.owner = 1;
    for (const adjacent of neighbors(coastal)) {
      const tile = state.map.tiles[axialKey(adjacent)];
      if (tile && tile.terrain !== "water") tile.owner = 0;
    }
    expect(detectEnclosedPockets(state).some((pocket) => pocket.tileIds.includes(coastal.id))).toBe(
      false,
    );
    tickEnclosuresFor(state, 200);
    expect(coastal.owner).toBe(1);
  });

  it("allows neutral and several hostile colors inside one single-captor ring", () => {
    const state = runningState("enclosure-mixed");
    const { interiorIds } = installPocket(state, 1);
    state.map.tiles[interiorIds[0]!]!.owner = null;
    state.map.tiles[interiorIds[1]!]!.owner = 1;
    state.map.tiles[interiorIds[2]!]!.owner = 2;
    const pocket = detectEnclosedPockets(state).find((candidate) => candidate.captorId === 0)!;
    expect(pocket.tileIds).toHaveLength(7);
    tickEnclosuresFor(state, BALANCE.encirclementTicks);
    expect(interiorIds.every((id) => state.map.tiles[id]!.owner === 0)).toBe(true);
  });

  it("discards a nested completion after an earlier canonical capture consumes its ring", () => {
    const state = runningState("enclosure-nested-completion");
    clearBoard(state);
    const center = safeCenter(state, 3);
    const innerBoundaryIds = ring(center, 1).map(axialKey);
    const outerBoundaryIds = ring(center, 2).map(axialKey);
    const nestedArea = new Set(spiral(center, 2).map(axialKey));
    const survivingPlayerOneTile = state.map.landIds.find((id) => !nestedArea.has(id))!;

    center.owner = 2;
    for (const id of innerBoundaryIds) state.map.tiles[id]!.owner = 1;
    for (const id of outerBoundaryIds) state.map.tiles[id]!.owner = 0;
    // Keep player 1 alive after losing the inner ring so elimination cleanup is
    // not what suppresses its now-stale enclosure completion.
    state.map.tiles[survivingPlayerOneTile]!.owner = 1;

    tickEnclosuresFor(state, 1);
    expect(
      state.enclosures.map((enclosure) => ({
        captorId: enclosure.captorId,
        tileCount: enclosure.tileIds.length,
      })),
    ).toEqual([
      { captorId: 0, tileCount: 7 },
      { captorId: 1, tileCount: 1 },
    ]);
    for (const enclosure of state.enclosures) {
      enclosure.progressTicks = BALANCE.encirclementTicks - 1;
    }

    tickEnclosuresFor(state, 1);

    expect(center.owner).toBe(0);
    expect(innerBoundaryIds.every((id) => state.map.tiles[id]!.owner === 0)).toBe(true);
    expect(state.players[1]!.eliminated).toBe(false);
    expect(
      state.events
        .filter((event) => event.type === "encirclement-complete")
        .map((event) => event.playerId),
    ).toEqual([0]);
  });

  it("drops a still-counting nested record when an outer completion consumes its ring", () => {
    const state = runningState("enclosure-nested-active");
    clearBoard(state);
    const center = safeCenter(state, 3);
    const innerBoundaryIds = ring(center, 1).map(axialKey);
    const outerBoundaryIds = ring(center, 2).map(axialKey);
    const nestedArea = new Set(spiral(center, 2).map(axialKey));
    const survivingPlayerOneTile = state.map.landIds.find((id) => !nestedArea.has(id))!;

    center.owner = 2;
    for (const id of innerBoundaryIds) state.map.tiles[id]!.owner = 1;
    for (const id of outerBoundaryIds) state.map.tiles[id]!.owner = 0;
    state.map.tiles[survivingPlayerOneTile]!.owner = 1;
    tickEnclosuresFor(state, 1);

    state.enclosures.find((enclosure) => enclosure.captorId === 0)!.progressTicks =
      BALANCE.encirclementTicks - 1;
    state.enclosures.find((enclosure) => enclosure.captorId === 1)!.progressTicks =
      BALANCE.encirclementTicks - 2;
    tickEnclosuresFor(state, 1);

    expect(center.owner).toBe(0);
    expect(state.enclosures.some((enclosure) => enclosure.captorId === 1)).toBe(false);
    expect(
      state.enclosures.every((enclosure) =>
        enclosure.boundaryIds.every((id) => state.map.tiles[id]!.owner === enclosure.captorId),
      ),
    ).toBe(true);
    refreshPlayerAggregates(state);
    state.stateHash = hashGameState(state);
    expect(() =>
      parseEngineSnapshot({ state, commandHistory: [], pendingCommands: [] }),
    ).not.toThrow();
  });

  it("destroys pending copies, seizes all completed copies, and rewards each tile independently", () => {
    const state = runningState("enclosure-structures-rewards");
    const { interiorIds } = installPocket(state, 1);
    state.tick = BALANCE.minimumOwnershipRewardTicks;
    const rangeTile = state.map.tiles[interiorIds[0]!]!;
    rangeTile.structure = structure("archery-range", 2, 12);
    const hostilePlain = state.map.tiles[interiorIds[1]!]!;
    hostilePlain.owner = 2;
    const neutral = state.map.tiles[interiorIds[2]!]!;
    neutral.owner = null;
    tickEnclosuresFor(state, 1);
    state.enclosures[0]!.progressTicks = BALANCE.encirclementTicks - 1;
    tickEnclosuresFor(state, 1);

    expect(rangeTile.structure).toMatchObject({
      type: "archery-range",
      completedCount: 2,
      status: "seized",
      integrity: BALANCE.seizedIntegrity,
      pendingProgressTicks: null,
    });
    expect(
      state.events.find((event) => event.type === "reward" && event.tileId === rangeTile.id)
        ?.amount,
    ).toBe(BALANCE.captureRewardMilli + BALANCE.archeryRangeCaptureRewardMilli * 2);
    expect(
      state.events.find((event) => event.type === "reward" && event.tileId === hostilePlain.id)
        ?.amount,
    ).toBe(BALANCE.captureRewardMilli);
    expect(
      state.events.find((event) => event.type === "reward" && event.tileId === neutral.id)?.amount,
    ).toBe(BALANCE.neutralCaptureRewardMilli);
  });

  it("cleans hostile garrisons, moving stacks, and battle participants while preserving captor forces", () => {
    const state = runningState("enclosure-force-cleanup");
    const { center, interiorIds, boundaryIds } = installPocket(state, 1);
    const battleTile = state.map.tiles[interiorIds[0]!]!;
    battleTile.owner = 1;
    battleTile.units = unitsOf("ranged", 6);
    const battle = startBattle(state, battleTile, 0, unitsOf("melee", 5), boundaryIds[0]!);
    const beforePlayerOneLosses = state.players[1]!.stats.troopsLost;
    const movingTile = interiorIds[1]!;
    state.stacks = [
      movingStack(state.nextEntityId++, 1, 7, [movingTile, boundaryIds[1]!]),
      movingStack(state.nextEntityId++, 0, 4, [movingTile, boundaryIds[1]!]),
    ];
    tickEnclosuresFor(state, 1);
    state.enclosures[0]!.progressTicks = BALANCE.encirclementTicks - 1;
    tickEnclosuresFor(state, 1);

    expect(state.battles.some((candidate) => candidate.id === battle.id)).toBe(false);
    expect(battleTile.owner).toBe(0);
    expect(battleTile.units).toEqual(unitsOf("melee", 5));
    expect(state.stacks.map((stack) => stack.owner)).toEqual([0]);
    expect(state.players[1]!.stats.troopsLost).toBeGreaterThanOrEqual(
      beforePlayerOneLosses + 6 + 7,
    );
    expect(center.owner).toBe(0);
  });

  it("restores multiplayer peers at tick 149 and completes with identical state and hash", () => {
    const original = runningState("enclosure-restore", true);
    expect(original.config.multiplayer).toBe(true);
    installPocket(original, 1);
    tickEnclosuresFor(original, BALANCE.encirclementTicks - 1);
    const restored = cloneDeterministic(original);
    tickEnclosuresFor(original, 1);
    tickEnclosuresFor(restored, 1);
    original.stateHash = hashGameState(original);
    restored.stateHash = hashGameState(restored);
    expect(restored.stateHash).toBe(original.stateHash);
    expect(stableStringify(restored)).toBe(stableStringify(original));
  });
});

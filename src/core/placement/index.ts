import { BALANCE } from "../../shared/balance";
import type {
  GameCommand,
  GameState,
  MatchConfig,
  PlacementState,
  PlayerState,
  SpawnPlacement,
} from "../../shared/types";
import { emitEvent } from "../engine/events";
import { distance, parseAxialKey } from "../hex";
import {
  analyzeMapFairness,
  applySpawnAllocations,
  deriveGenerationSeed,
  eligibleSpawnCenters,
  isEligibleSpawnCenter,
} from "../map";
import { hashSeed } from "../rng";
import {
  deriveReservedPlacementCenters,
  placementDistanceBalance,
  projectPlacementCentersWithReservations,
  type FixedPlacementCenter,
} from "./projection";

export * from "./projection";

export interface SpawnPlacementResult {
  ok: boolean;
  reason?: string;
}

function compareAxialIds(left: string, right: string): number {
  const leftHex = parseAxialKey(left);
  const rightHex = parseAxialKey(right);
  return leftHex.q - rightHex.q || leftHex.r - rightHex.r;
}

function placementSeed(state: GameState): string {
  return deriveGenerationSeed(state.map.seed, state.map.generationAttempt);
}

const aiReservationCache = new WeakMap<
  object,
  { key: string; reservations: readonly FixedPlacementCenter[] }
>();

function aiSeats(state: GameState): number[] {
  return state.players.filter((player) => !player.isHuman).map((player) => player.id);
}

function reservedAiPlacements(state: GameState): readonly FixedPlacementCenter[] {
  const reservedSeats = aiSeats(state);
  if (reservedSeats.length === 0) return [];
  const key = `${placementSeed(state)}:${state.players.map((player) => (player.isHuman ? "h" : "a")).join("")}`;
  const cached = aiReservationCache.get(state.map);
  if (cached?.key === key) return cached.reservations;
  const reservations = deriveReservedPlacementCenters({
    seed: placementSeed(state),
    totalParticipants: state.players.length,
    candidates: eligibleSpawnCenters(state.map),
    reservedSeats,
    minimumDistance: BALANCE.minimumSpawnDistance,
  });
  aiReservationCache.set(state.map, { key, reservations });
  return reservations;
}

function conflictsWithPlacement(state: GameState, playerId: number, centerId: string): boolean {
  const center = parseAxialKey(centerId);
  return state.placement.placements.some(
    (placement) =>
      placement.playerId !== playerId &&
      placement.centerId !== null &&
      distance(center, parseAxialKey(placement.centerId)) < BALANCE.minimumSpawnDistance,
  );
}

function rankedCandidates(state: GameState, playerId: number, revision: number): string[] {
  const seed = placementSeed(state);
  return eligibleSpawnCenters(state.map).sort(
    (left, right) =>
      hashSeed(`${seed}:placement:${playerId}:${revision}:${right}`) -
        hashSeed(`${seed}:placement:${playerId}:${revision}:${left}`) ||
      compareAxialIds(left, right),
  );
}

function fallbackCenter(
  state: GameState,
  playerId: number,
  revision: number,
  excludeId: string | null = null,
): string | null {
  return (
    rankedCandidates(state, playerId, revision).find(
      (id) => id !== excludeId && !conflictsWithPlacement(state, playerId, id),
    ) ?? null
  );
}

interface FinalSpawnProjection {
  ok: boolean;
  centers?: string[];
  reason?: string;
}

function projectedFairness(state: GameState, centers: readonly string[]): SpawnPlacementResult {
  try {
    const projectedMap = structuredClone(state.map);
    applySpawnAllocations(projectedMap, centers, placementSeed(state));
    const report = analyzeMapFairness(projectedMap, state.players.length);
    return report.valid
      ? { ok: true }
      : {
          ok: false,
          reason: `Final centers violate map fairness: ${report.reasons.join("; ")}`,
        };
  } catch (reason) {
    return {
      ok: false,
      reason: reason instanceof Error ? reason.message : "Final centers are invalid",
    };
  }
}

/**
 * Purely project a complete fair vector from the current human claims.
 * Provisional AI markers are presentation state and never constrain consensus.
 */
function projectFinalCenters(
  state: GameState,
  overrides: ReadonlyMap<number, string> = new Map(),
): FinalSpawnProjection {
  const fixedCenters: FixedPlacementCenter[] = [];
  for (const player of state.players) {
    if (!player.isHuman) continue;
    const centerId = overrides.get(player.id) ?? state.placement.placements[player.id]?.centerId;
    if (centerId) fixedCenters.push({ seat: player.id, centerId });
  }

  let centers: string[];
  try {
    centers = projectPlacementCentersWithReservations({
      seed: placementSeed(state),
      totalParticipants: state.players.length,
      candidates: eligibleSpawnCenters(state.map),
      fixedCenters,
      reservedSeats: aiSeats(state),
      minimumDistance: BALANCE.minimumSpawnDistance,
    });
  } catch (reason) {
    return {
      ok: false,
      reason: reason instanceof Error ? reason.message : "No fair final placement remains",
    };
  }
  const fairness = projectedFairness(state, centers);
  return fairness.ok ? { ok: true, centers } : fairness;
}

export function createPlacementState(
  config: MatchConfig,
  players: readonly PlayerState[],
): PlacementState {
  const placements: SpawnPlacement[] = players.map((player) => {
    if (player.isHuman) {
      return {
        playerId: player.id,
        centerId: null,
        locked: false,
        relocationCount: 0,
        aiTargetRelocations: 0,
        nextAiActionTick: null,
      };
    }
    const scheduleSeed = hashSeed(`${config.seed}:placement-schedule:${player.id}`);
    return {
      playerId: player.id,
      centerId: null,
      locked: false,
      relocationCount: 0,
      aiTargetRelocations: 2 + (scheduleSeed % 2),
      nextAiActionTick: 7 + (scheduleSeed % 6),
    };
  });
  return {
    elapsedTicks: 0,
    maxTicks: config.multiplayer ? BALANCE.multiplayerPlacementTicks : null,
    placements,
  };
}

/** Populate the first visible AI claims in stable player order. */
export function initializeAiPlacements(state: GameState): void {
  for (const placement of state.placement.placements) {
    if (state.players[placement.playerId]?.isHuman || placement.centerId !== null) continue;
    const selected = fallbackCenter(state, placement.playerId, 0);
    if (!selected)
      throw new Error(`No eligible initial spawn remains for AI ${placement.playerId}`);
    placement.centerId = selected;
  }
}

/** Cheap local preview gate used while drawing every candidate center. */
export function validateSpawnChoicePreview(
  state: GameState,
  playerId: number,
  centerId: string,
): SpawnPlacementResult {
  if (state.phase !== "placement") return { ok: false, reason: "Placement is complete" };
  const player = state.players[playerId];
  const placement = state.placement.placements[playerId];
  if (!player || !placement || placement.playerId !== playerId) {
    return { ok: false, reason: "Invalid player" };
  }
  if (!player.isHuman) return { ok: false, reason: "AI placement is deterministic" };
  if (placement.locked) return { ok: false, reason: "Placement is locked" };
  if (!isEligibleSpawnCenter(state.map, centerId)) {
    return { ok: false, reason: "Center lacks a safe seven-hex starting area" };
  }
  if (conflictsWithPlacement(state, playerId, centerId)) {
    return { ok: false, reason: "Center is too close to another placement" };
  }
  const center = parseAxialKey(centerId);
  if (
    reservedAiPlacements(state).some(
      (reservation) =>
        distance(center, parseAxialKey(reservation.centerId)) < BALANCE.minimumSpawnDistance,
    )
  ) {
    return { ok: false, reason: "Center is reserved for a deterministic AI placement" };
  }
  const completeCenters = new Array<string | null>(state.players.length).fill(null);
  for (const reservation of reservedAiPlacements(state)) {
    completeCenters[reservation.seat] = reservation.centerId;
  }
  for (const human of state.players.filter((candidate) => candidate.isHuman)) {
    completeCenters[human.id] =
      human.id === playerId ? centerId : (state.placement.placements[human.id]?.centerId ?? null);
  }
  if (
    completeCenters.every((candidate): candidate is string => candidate !== null) &&
    !placementDistanceBalance(completeCenters).valid
  ) {
    return { ok: false, reason: "Center cannot preserve balanced placement spacing" };
  }
  return { ok: true };
}

/** Authoritative gate: the local candidate must also extend to a fair full vector. */
export function validateSpawnChoice(
  state: GameState,
  playerId: number,
  centerId: string,
): SpawnPlacementResult {
  const preview = validateSpawnChoicePreview(state, playerId, centerId);
  if (!preview.ok) return preview;
  const projection = projectFinalCenters(state, new Map([[playerId, centerId]]));
  if (!projection.ok) {
    return {
      ok: false,
      reason: projection.reason ?? "Center cannot preserve a fair final allocation",
    };
  }
  return { ok: true };
}

export function chooseSpawn(
  state: GameState,
  playerId: number,
  centerId: string,
): SpawnPlacementResult {
  const result = validateSpawnChoice(state, playerId, centerId);
  if (!result.ok) return result;
  const placement = state.placement.placements[playerId]!;
  placement.centerId = centerId;
  placement.relocationCount += 1;
  emitEvent(state, {
    type: "spawn-selected",
    playerId,
    tileId: centerId,
    message: `${state.players[playerId]!.name} selected a starting center`,
  });
  return { ok: true };
}

export function lockSpawn(state: GameState, playerId: number): SpawnPlacementResult {
  if (state.phase !== "placement") return { ok: false, reason: "Placement is complete" };
  const player = state.players[playerId];
  const placement = state.placement.placements[playerId];
  if (!player || !placement || !player.isHuman) return { ok: false, reason: "Invalid player" };
  if (placement.locked) return { ok: false, reason: "Placement is already locked" };
  if (!placement.centerId) return { ok: false, reason: "Choose a starting center first" };
  placement.locked = true;
  emitEvent(state, {
    type: "spawn-locked",
    playerId,
    tileId: placement.centerId,
    message: `${player.name} locked a starting center`,
  });
  completePlacementIfReady(state);
  return { ok: true };
}

export function applyPlacementCommand(
  state: GameState,
  command: Extract<GameCommand, { type: "choose-spawn" | "lock-spawn" }>,
): SpawnPlacementResult {
  return command.type === "choose-spawn"
    ? chooseSpawn(state, command.playerId, command.centerId)
    : lockSpawn(state, command.playerId);
}

function relocateAndLockAi(state: GameState): void {
  const seed = placementSeed(state);
  for (const placement of state.placement.placements) {
    if (state.players[placement.playerId]?.isHuman || placement.locked) continue;
    if (
      placement.nextAiActionTick === null ||
      placement.nextAiActionTick > state.placement.elapsedTicks
    ) {
      continue;
    }
    if (placement.relocationCount < placement.aiTargetRelocations) {
      const nextRelocationCount = placement.relocationCount + 1;
      // Reserve the final visible relocation for the canonical fair vector.
      // Earlier markers remain deterministic, eligible, and noncolliding.
      if (nextRelocationCount < placement.aiTargetRelocations) {
        const selected = fallbackCenter(
          state,
          placement.playerId,
          nextRelocationCount,
          placement.centerId,
        );
        if (selected) placement.centerId = selected;
      }
      placement.relocationCount += 1;
      const gap =
        6 +
        (hashSeed(`${seed}:placement-gap:${placement.playerId}:${placement.relocationCount}`) % 5);
      placement.nextAiActionTick += gap;
    }
  }

  const aiPlacements = state.placement.placements.filter(
    (placement) => !state.players[placement.playerId]?.isHuman && !placement.locked,
  );
  if (
    aiPlacements.length === 0 ||
    !aiPlacements.every(
      (placement) =>
        placement.relocationCount >= placement.aiTargetRelocations &&
        placement.nextAiActionTick !== null &&
        placement.nextAiActionTick <= state.placement.elapsedTicks,
    )
  ) {
    return;
  }

  const projection = projectFinalCenters(state);
  if (!projection.ok || !projection.centers) {
    throw new Error(projection.reason ?? "No fair final AI placement remains");
  }
  for (const placement of aiPlacements) {
    placement.centerId = projection.centers[placement.playerId]!;
    placement.locked = true;
    placement.nextAiActionTick = null;
    emitEvent(state, {
      type: "spawn-locked",
      playerId: placement.playerId,
      tileId: placement.centerId,
      message: `${state.players[placement.playerId]!.name} locked a starting center`,
    });
  }
}

function assignTimeoutPlacements(state: GameState): void {
  for (const placement of state.placement.placements) {
    if (placement.locked) continue;
    if (placement.centerId === null) {
      placement.centerId = fallbackCenter(
        state,
        placement.playerId,
        placement.relocationCount + 100,
      );
    }
    if (!placement.centerId) {
      throw new Error(`No eligible timeout spawn remains for player ${placement.playerId}`);
    }
    placement.locked = true;
    placement.nextAiActionTick = null;
  }
}

export function finalizePlacements(state: GameState): void {
  if (state.phase !== "placement") return;
  const centers = state.placement.placements.map((placement) => placement.centerId);
  if (centers.some((id): id is null => id === null)) {
    throw new Error("Cannot finalize incomplete spawn placements");
  }
  const finalCenters = centers as string[];
  const fairness = projectedFairness(state, finalCenters);
  if (!fairness.ok) {
    throw new Error(fairness.reason ?? "Final centers violate map fairness");
  }
  applySpawnAllocations(state.map, finalCenters, placementSeed(state));
  state.config.startingCenters = [...finalCenters];
  state.placement = {
    elapsedTicks: 0,
    maxTicks: state.config.multiplayer ? BALANCE.multiplayerPlacementTicks : null,
    placements: finalCenters.map((centerId, playerId) => ({
      playerId,
      centerId,
      locked: true,
      relocationCount: 0,
      aiTargetRelocations: 0,
      nextAiActionTick: null,
    })),
  };
  for (const player of state.players) {
    player.tileCount = BALANCE.startingTiles;
    player.troopCount = BALANCE.startingTroops;
  }
  // Placement-only events and IDs are not gameplay inputs. Canonicalizing them
  // makes finalized replay config byte-identical to an interactively placed match.
  state.events = [];
  state.nextEntityId = 1;
  state.phase = "opening";
  emitEvent(state, {
    type: "placement-complete",
    message: "Every ruler has locked a starting center",
  });
}

export function completePlacementIfReady(state: GameState): void {
  if (
    !state.config.multiplayer &&
    state.placement.placements.every((placement) => placement.locked)
  ) {
    finalizePlacements(state);
  }
}

/**
 * Canonical final vector used by the multiplayer relay. It depends only on the
 * seed/map and the latest human claims, never on provisional AI animation timing.
 */
export function computeFinalSpawnVector(state: GameState): string[] {
  if (state.phase !== "placement") throw new Error("Placement is complete");
  const projection = projectFinalCenters(state);
  if (!projection.ok || !projection.centers) {
    throw new Error(projection.reason ?? "No canonical fair final placement remains");
  }
  return projection.centers;
}

export function validateFinalSpawnVector(
  state: GameState,
  centers: readonly string[],
): SpawnPlacementResult {
  if (state.phase !== "placement") return { ok: false, reason: "Placement is complete" };
  if (centers.length !== state.players.length) {
    return { ok: false, reason: "Final vector does not match participant count" };
  }
  let expected: string[];
  try {
    expected = computeFinalSpawnVector(state);
  } catch (reason) {
    return { ok: false, reason: reason instanceof Error ? reason.message : "Invalid placement" };
  }
  return expected.every((center, index) => center === centers[index])
    ? { ok: true }
    : { ok: false, reason: "Final vector is not canonical for the current claims" };
}

export function finalizePlacementVector(
  state: GameState,
  centers: readonly string[],
): SpawnPlacementResult {
  const result = validateFinalSpawnVector(state, centers);
  if (!result.ok) return result;
  state.placement.placements.forEach((placement, index) => {
    placement.centerId = centers[index]!;
    placement.locked = true;
    placement.nextAiActionTick = null;
  });
  finalizePlacements(state);
  return { ok: true };
}

/** Advance only the pre-game placement clock; the ordinary game tick remains zero. */
export function tickPlacement(state: GameState): void {
  if (state.phase !== "placement") return;
  state.placement.elapsedTicks += 1;
  evaluatePlacement(state);
}

/** Run deterministic AI actions/timeouts after due human claims for this placement tick. */
export function evaluatePlacement(state: GameState): void {
  if (state.phase !== "placement") return;
  relocateAndLockAi(state);
  if (
    !state.config.multiplayer &&
    state.placement.maxTicks !== null &&
    state.placement.elapsedTicks >= state.placement.maxTicks
  ) {
    assignTimeoutPlacements(state);
  }
  completePlacementIfReady(state);
}

export function beginMatch(state: GameState): SpawnPlacementResult {
  if (state.phase !== "opening") return { ok: false, reason: "Opening allocation is not ready" };
  state.phase = "running";
  return { ok: true };
}

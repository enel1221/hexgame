import { ROOM_CODE_ALPHABET } from "./protocol";
import { BALANCE } from "../shared/balance";
import {
  compareProjectedCenterIds,
  placementDistanceBalance,
  projectPlacementCentersWithReservations,
  projectedCenterDistance,
} from "../core/placement/projection";

export const DEFAULT_TICK_RATE = 10;
export const DEFAULT_COMMAND_LEAD_TICKS = 6;
export const DEFAULT_ROOM_TTL_SECONDS = 6 * 60 * 60;
// Leaves room for one compact (max 256 KiB) checkpoint plus its JSON envelope.
export const MAX_MESSAGE_BYTES = 320 * 1024;
export const MAX_COMMAND_BATCH = 100;
export const PLACEMENT_DURATION_MS = 30_000;
// Core's deterministic bot choreography completes by tick 42. Keep the room
// in placement long enough that no visibly provisional bot can move at start.
export const AI_PLACEMENT_MIN_MS = 5_000;
export const OPENING_HANDOFF_MS = 1_000;
export const MIN_PLACEMENT_CENTER_DISTANCE = BALANCE.minimumSpawnDistance;

export interface PlacementSelectionInput {
  seat: number;
  centerId: string | null;
}

export function placementCenterDistance(leftId: string, rightId: string): number {
  return projectedCenterDistance(leftId, rightId);
}

export function compareAxialIds(leftId: string, rightId: string): number {
  return compareProjectedCenterIds(leftId, rightId);
}

export function placementCentersPreserveDistanceFairness(centers: readonly string[]): boolean {
  return placementDistanceBalance(centers).valid;
}

/**
 * Deterministically completes a partial human placement from a trusted list of
 * core-validated eligible centers. Candidate order and reconnect order do not
 * affect the result.
 */
export function finalizePlacementCenters(input: {
  seed: string;
  totalParticipants: number;
  candidates: readonly string[];
  selections: readonly PlacementSelectionInput[];
  reservedSeats?: readonly number[];
  minimumDistance?: number;
}): string[] {
  return projectPlacementCentersWithReservations({
    seed: input.seed,
    totalParticipants: input.totalParticipants,
    candidates: input.candidates,
    fixedCenters: input.selections
      .filter(
        (selection): selection is PlacementSelectionInput & { centerId: string } =>
          selection.centerId !== null,
      )
      .map((selection) => ({ seat: selection.seat, centerId: selection.centerId })),
    reservedSeats: input.reservedSeats ?? [],
    minimumDistance: input.minimumDistance ?? MIN_PLACEMENT_CENTER_DISTANCE,
  });
}

export function createRoomCode(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(6));
  if (bytes.byteLength < 6) {
    throw new Error("At least six random bytes are required");
  }

  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[bytes[index]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

export function createReconnectToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashReconnectToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function currentServerTick(
  startedAt: number | null,
  now = Date.now(),
  tickRate = DEFAULT_TICK_RATE,
): number {
  if (startedAt === null || startedAt > now) return 0;
  return Math.floor(((now - startedAt) * tickRate) / 1000);
}

export function assignRelayOrder(input: {
  nextSequence: number;
  currentTick: number;
  lastTargetTick: number;
  leadTicks: number;
}): { sequence: number; targetTick: number } {
  if (!Number.isInteger(input.nextSequence) || input.nextSequence < 1) {
    throw new Error("nextSequence must be a positive integer");
  }
  if (!Number.isInteger(input.currentTick) || input.currentTick < 0) {
    throw new Error("currentTick must be a non-negative integer");
  }
  if (!Number.isInteger(input.leadTicks) || input.leadTicks < 1) {
    throw new Error("leadTicks must be a positive integer");
  }

  return {
    sequence: input.nextSequence,
    targetTick: Math.max(input.currentTick + input.leadTicks, input.lastTargetTick),
  };
}

export function compareStateHashes(hashes: Record<string, string>): {
  desynchronized: boolean;
  majorityHash: string | null;
} {
  const values = Object.values(hashes);
  if (values.length < 2) {
    return { desynchronized: false, majorityHash: values[0] ?? null };
  }

  const counts = new Map<string, number>();
  for (const hash of values) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  if (counts.size === 1) {
    return { desynchronized: false, majorityHash: values[0]! };
  }

  let winner: string | null = null;
  let winnerCount = 0;
  for (const [hash, count] of counts) {
    if (count > winnerCount) {
      winner = hash;
      winnerCount = count;
    }
  }
  return {
    desynchronized: true,
    majorityHash: winnerCount > values.length / 2 ? winner : null,
  };
}

export function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

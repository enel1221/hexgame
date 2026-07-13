import { hashSeed } from "../rng";

export interface FixedPlacementCenter {
  seat: number;
  centerId: string;
}

export interface PlacementProjectionInput {
  seed: string;
  totalParticipants: number;
  candidates: readonly string[];
  fixedCenters: readonly FixedPlacementCenter[];
  minimumDistance: number;
}

export interface ReservedPlacementProjectionInput extends PlacementProjectionInput {
  /** Seats whose seed-derived centers are immutable before any live claims arrive. */
  reservedSeats: readonly number[];
}

function parseAxialId(id: string): { q: number; r: number } {
  const [q, r, extra] = id.split(",");
  if (extra !== undefined || q === undefined || r === undefined) {
    throw new Error(`Invalid axial tile ID ${id}`);
  }
  const parsed = { q: Number(q), r: Number(r) };
  if (!Number.isInteger(parsed.q) || !Number.isInteger(parsed.r)) {
    throw new Error(`Invalid axial tile ID ${id}`);
  }
  return parsed;
}

function axialDistance(
  left: Readonly<{ q: number; r: number }>,
  right: Readonly<{ q: number; r: number }>,
): number {
  return Math.max(
    Math.abs(left.q - right.q),
    Math.abs(left.r - right.r),
    Math.abs(-left.q - left.r + right.q + right.r),
  );
}

export function projectedCenterDistance(leftId: string, rightId: string): number {
  return axialDistance(parseAxialId(leftId), parseAxialId(rightId));
}

export function compareProjectedCenterIds(leftId: string, rightId: string): number {
  const left = parseAxialId(leftId);
  const right = parseAxialId(rightId);
  return left.q - right.q || left.r - right.r;
}

export interface PlacementDistanceBalance {
  valid: boolean;
  minimumNearestDistance: number;
  maximumNearestDistance: number;
}

function balanceFromNearestDistances(nearest: readonly number[]): PlacementDistanceBalance {
  if (nearest.length < 2) {
    return {
      valid: true,
      minimumNearestDistance: 0,
      maximumNearestDistance: 0,
    };
  }
  const minimumNearestDistance = Math.min(...nearest);
  const maximumNearestDistance = Math.max(...nearest);
  return {
    valid: minimumNearestDistance > 0 && maximumNearestDistance <= minimumNearestDistance * 2,
    minimumNearestDistance,
    maximumNearestDistance,
  };
}

/** Distance-only portion of the map fairness contract, usable at the edge. */
export function placementDistanceBalance(centers: readonly string[]): PlacementDistanceBalance {
  const nearest = centers.map((center, index) =>
    centers.reduce(
      (minimum, other, otherIndex) =>
        index === otherIndex ? minimum : Math.min(minimum, projectedCenterDistance(center, other)),
      Number.POSITIVE_INFINITY,
    ),
  );
  return balanceFromNearestDistances(nearest);
}

interface ProjectionCandidateScore {
  id: string;
  nearest: number;
  rank: number;
  balance: PlacementDistanceBalance;
  violation: number;
}

function compareProjectionCandidateScores(
  left: ProjectionCandidateScore,
  right: ProjectionCandidateScore,
): number {
  if (left.balance.valid !== right.balance.valid) return left.balance.valid ? 1 : -1;
  if (left.violation !== right.violation) return right.violation - left.violation;
  if (left.balance.minimumNearestDistance !== right.balance.minimumNearestDistance) {
    return left.balance.minimumNearestDistance - right.balance.minimumNearestDistance;
  }
  if (left.nearest !== right.nearest) return left.nearest - right.nearest;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return -compareProjectedCenterIds(left.id, right.id);
}

/**
 * Pure, bounded placement projection shared by the simulation and relay.
 *
 * Fixed human choices are preserved by seat. Every missing seat first prefers
 * a distance-balanced partial vector, then the widest nearest-center spacing.
 * A seed-derived rank is only a stable tie-breaker, so reconnect/candidate
 * order cannot produce a random-looking cluster with one isolated ruler.
 */
export function projectSpacedPlacementCenters(input: PlacementProjectionInput): string[] {
  if (
    !Number.isInteger(input.totalParticipants) ||
    input.totalParticipants < 2 ||
    input.totalParticipants > 21
  ) {
    throw new Error("Placement participant count must be between 2 and 21");
  }
  if (!Number.isInteger(input.minimumDistance) || input.minimumDistance < 1) {
    throw new Error("Placement minimum distance must be a positive integer");
  }

  const candidateCoordinates = new Map(
    input.candidates.map((id) => [id, parseAxialId(id)] as const),
  );
  const candidates = [...input.candidates].sort((left, right) => {
    const leftHex = candidateCoordinates.get(left)!;
    const rightHex = candidateCoordinates.get(right)!;
    return leftHex.q - rightHex.q || leftHex.r - rightHex.r;
  });
  const distanceById = (left: string, right: string): number =>
    axialDistance(candidateCoordinates.get(left)!, candidateCoordinates.get(right)!);
  const candidateSet = new Set(candidates);
  if (candidateSet.size !== candidates.length) {
    throw new Error("Placement candidates must be unique");
  }
  if (candidates.length < input.totalParticipants) {
    throw new Error("Not enough eligible placement centers");
  }

  const centers = new Array<string | null>(input.totalParticipants).fill(null);
  const chosen: string[] = [];
  const chosenSet = new Set<string>();
  for (const fixed of [...input.fixedCenters].sort((left, right) => left.seat - right.seat)) {
    if (!Number.isInteger(fixed.seat) || fixed.seat < 0 || fixed.seat >= centers.length) {
      throw new Error("Placement selection references an invalid seat");
    }
    if (!candidateSet.has(fixed.centerId)) {
      throw new Error(`Placement center ${fixed.centerId} is not eligible`);
    }
    if (centers[fixed.seat] !== null) {
      throw new Error(`Placement seat ${fixed.seat} is duplicated`);
    }
    if (chosen.some((center) => distanceById(center, fixed.centerId) < input.minimumDistance)) {
      throw new Error(`Placement center ${fixed.centerId} conflicts with another selection`);
    }
    centers[fixed.seat] = fixed.centerId;
    chosen.push(fixed.centerId);
    chosenSet.add(fixed.centerId);
  }

  let chosenNearest = chosen.map((center, index) =>
    chosen.reduce(
      (minimum, other, otherIndex) =>
        index === otherIndex ? minimum : Math.min(minimum, distanceById(center, other)),
      Number.POSITIVE_INFINITY,
    ),
  );

  for (let seat = 0; seat < centers.length; seat += 1) {
    if (centers[seat] !== null) continue;
    let selectedScore: ProjectionCandidateScore | null = null;
    for (const candidate of candidates) {
      if (chosenSet.has(candidate)) continue;
      const distances = chosen.map((center) => distanceById(center, candidate));
      const nearest = distances.length ? Math.min(...distances) : Number.POSITIVE_INFINITY;
      if (nearest < input.minimumDistance) continue;
      const rank = hashSeed(`${input.seed}:placement-projection:${seat}:${candidate}`);
      const balance = balanceFromNearestDistances([
        ...chosenNearest.map((current, index) => Math.min(current, distances[index]!)),
        nearest,
      ]);
      const balanceViolation = Math.max(
        0,
        balance.maximumNearestDistance - balance.minimumNearestDistance * 2,
      );
      const score = {
        id: candidate,
        nearest,
        rank,
        balance,
        violation: balanceViolation,
      };
      if (!selectedScore || compareProjectionCandidateScores(score, selectedScore) > 0) {
        selectedScore = score;
      }
    }
    if (!selectedScore) throw new Error(`No eligible placement center remains for seat ${seat}`);
    centers[seat] = selectedScore.id;
    if (chosen.length === 0) {
      chosenNearest = [Number.POSITIVE_INFINITY];
    } else {
      const selectedDistances = chosen.map((center) => distanceById(center, selectedScore!.id));
      chosenNearest = [
        ...chosenNearest.map((current, index) => Math.min(current, selectedDistances[index]!)),
        Math.min(...selectedDistances),
      ];
    }
    chosen.push(selectedScore.id);
    chosenSet.add(selectedScore.id);
  }

  const projected = centers as string[];
  if (!balanceFromNearestDistances(chosenNearest).valid) {
    throw new Error("No completion preserves nearest-distance fairness");
  }
  return projected;
}

/**
 * Derive immutable seat reservations from only the generation seed, participant
 * layout, candidate set, and spacing contract. Placement clocks and provisional
 * markers never enter this projection.
 */
export function deriveReservedPlacementCenters(
  input: Omit<ReservedPlacementProjectionInput, "fixedCenters">,
): FixedPlacementCenter[] {
  const seats = [...input.reservedSeats].sort((left, right) => left - right);
  if (new Set(seats).size !== seats.length) {
    throw new Error("Reserved placement seats must be unique");
  }
  for (const seat of seats) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= input.totalParticipants) {
      throw new Error("Reserved placement references an invalid seat");
    }
  }
  if (seats.length === 0) return [];
  const baseline = projectSpacedPlacementCenters({
    seed: input.seed,
    totalParticipants: input.totalParticipants,
    candidates: input.candidates,
    fixedCenters: [],
    minimumDistance: input.minimumDistance,
  });
  return seats.map((seat) => ({ seat, centerId: baseline[seat]! }));
}

/** Complete live claims while keeping every reserved seat byte-for-byte fixed. */
export function projectPlacementCentersWithReservations(
  input: ReservedPlacementProjectionInput,
): string[] {
  if (input.reservedSeats.length === 0) return projectSpacedPlacementCenters(input);
  const reservations = deriveReservedPlacementCenters(input);
  if (input.fixedCenters.length === 0) {
    return projectSpacedPlacementCenters({
      ...input,
      fixedCenters: [],
    });
  }
  const fixedBySeat = new Map(reservations.map((fixed) => [fixed.seat, fixed.centerId] as const));
  for (const fixed of input.fixedCenters) {
    const reserved = fixedBySeat.get(fixed.seat);
    if (reserved !== undefined && reserved !== fixed.centerId) {
      throw new Error(`Reserved placement seat ${fixed.seat} cannot move`);
    }
    fixedBySeat.set(fixed.seat, fixed.centerId);
  }
  return projectSpacedPlacementCenters({
    seed: input.seed,
    totalParticipants: input.totalParticipants,
    candidates: input.candidates,
    fixedCenters: [...fixedBySeat]
      .map(([seat, centerId]) => ({ seat, centerId }))
      .sort((left, right) => left.seat - right.seat),
    minimumDistance: input.minimumDistance,
  });
}

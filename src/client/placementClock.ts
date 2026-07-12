import { BALANCE, TICKS_PER_SECOND } from "../shared/balance";

/** Convert the relay's wall-clock placement epoch into a bounded deterministic Worker tick. */
export function placementCatchUpTick(startedAt: number, now = Date.now()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.min(
    BALANCE.multiplayerPlacementTicks,
    Math.max(0, Math.floor(((now - startedAt) * TICKS_PER_SECOND) / 1000)),
  );
}

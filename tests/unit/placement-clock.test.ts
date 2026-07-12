import { describe, expect, it } from "vitest";
import { placementCatchUpTick } from "../../src/client/placementClock";
import { BALANCE } from "../../src/shared/balance";

describe("multiplayer placement relay clock", () => {
  it("floors elapsed relay time and clamps reconnect catch-up to the placement deadline", () => {
    const startedAt = 10_000;
    expect(placementCatchUpTick(startedAt, 9_999)).toBe(0);
    expect(placementCatchUpTick(startedAt, 14_299)).toBe(42);
    expect(placementCatchUpTick(startedAt, 14_300)).toBe(43);
    expect(placementCatchUpTick(startedAt, 90_000)).toBe(BALANCE.multiplayerPlacementTicks);
  });
});

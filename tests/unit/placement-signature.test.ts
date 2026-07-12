import { describe, expect, it } from "vitest";
import { createGame, eligibleSpawnCenters, validateSpawnChoice } from "../../src/core";
import { placementPresentationSignature } from "../../src/client/placementSignature";
import { TEST_CONFIG } from "./fixtures";

describe("placement presentation signature", () => {
  it("ignores elapsed ticks but invalidates for a changed claim", () => {
    const engine = createGame({ ...TEST_CONFIG, seed: "placement-signature" });
    const initial = placementPresentationSignature(engine.state, 0);
    engine.step(1);
    expect(placementPresentationSignature(engine.state, 0)).toBe(initial);

    const centerId = eligibleSpawnCenters(engine.state.map).find(
      (candidate) => validateSpawnChoice(engine.state, 0, candidate).ok,
    )!;
    engine.submitCommand({ type: "choose-spawn", playerId: 0, centerId });
    engine.step(1);
    expect(placementPresentationSignature(engine.state, 0)).not.toBe(initial);
  });
});

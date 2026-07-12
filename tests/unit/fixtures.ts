import type { MatchConfig } from "../../src/shared/types";
import { computeFinalSpawnVector, createGame } from "../../src/core";

export const TEST_CONFIG: MatchConfig = {
  seed: "unit-test-seed",
  archetype: "heartland",
  aiCount: 3,
  difficulty: "normal",
  playerName: "Tester",
  graphics: "low",
  sound: false,
  colorPatterns: true,
  debug: false,
};

/** Finalize deterministic placement and cross the presentation handoff for rule tests. */
export function createRunningGame(config: MatchConfig = TEST_CONFIG) {
  const engine = createGame(config);
  if (engine.state.phase === "placement") {
    const finalized = engine.finalizePlacement(computeFinalSpawnVector(engine.state));
    if (!finalized.ok) throw new Error(finalized.reason);
  }
  if (engine.state.phase === "opening") {
    const begun = engine.beginMatch();
    if (!begun.ok) throw new Error(begun.reason);
  }
  return engine;
}

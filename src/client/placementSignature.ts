import type { GameState } from "../shared/types";

/** Fields that can change placement candidates, footprints, or local selectability. */
export function placementPresentationSignature(state: GameState, localPlayerId: number): string {
  return [
    state.phase,
    state.map.seed,
    state.map.archetype,
    state.map.generationAttempt,
    state.map.landCount,
    localPlayerId,
    state.players.map((player) => `${player.id}:${player.isHuman ? "h" : "a"}`).join(","),
    state.placement.placements
      .map(
        (placement) =>
          `${placement.playerId}:${placement.centerId ?? ""}:${placement.locked ? 1 : 0}`,
      )
      .join(","),
  ].join("|");
}

import { BALANCE, TICKS_PER_SECOND } from "../../shared/balance";
import type { GameState, StructureState } from "../../shared/types";
import { isStructureOperational } from "../buildings";

export function calculateFarmIncomeMilliPerSecond(structure: StructureState | null): number {
  if (
    structure?.type !== "farm" ||
    !isStructureOperational(structure) ||
    structure.productionPaused
  ) {
    return 0;
  }
  return Math.floor(
    (BALANCE.farm.incomeMilliPerSecond * structure.completedCount * structure.integrity) /
      BALANCE.fullIntegrity,
  );
}

export function calculateIncomeMilliPerSecond(state: GameState, playerId: number): number {
  let income = 0;
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    if (tile.owner !== playerId) continue;
    income += BALANCE.tileIncomeMilliPerSecond;

    const structure = tile.structure;
    if (!state.battles.some((battle) => battle.tileId === tile.id)) {
      income += calculateFarmIncomeMilliPerSecond(structure);
    }
  }
  return income;
}

/**
 * Income is settled once per simulation second. This avoids fractional carry
 * fields while retaining exact fixed-point rates and deterministic save data.
 */
export function tickEconomy(state: GameState): void {
  if (state.tick % TICKS_PER_SECOND !== 0) return;
  for (const player of state.players) {
    if (player.eliminated) continue;
    const income = calculateIncomeMilliPerSecond(state, player.id);
    player.supplyMilli += income;
    player.stats.supplyEarnedMilli += income;
  }
}

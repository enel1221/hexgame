import { BALANCE, TICKS_PER_SECOND } from "../../shared/balance";
import type { GameState } from "../../shared/types";

export function calculateIncomeMilliPerSecond(state: GameState, playerId: number): number {
  const player = state.players[playerId];
  if (!player || player.eliminated) return 0;

  let income = BALANCE.passiveIncomeMilliPerSecond;
  for (const tileId of state.map.landIds) {
    const tile = state.map.tiles[tileId]!;
    if (tile.owner !== playerId) continue;
    income += BALANCE.tileIncomeMilliPerSecond;
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

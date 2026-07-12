import { BALANCE, SUPPLY_SCALE } from "../../shared/balance";
import type { GameState, StructureType, TileState } from "../../shared/types";
import { emitEvent } from "../engine/events";

export interface CapturedStructureValue {
  type: StructureType;
  completedCount: number;
}

export type CaptureRewardStructure = StructureType | CapturedStructureValue | null;

function normalizeCapturedStructure(value: CaptureRewardStructure): CapturedStructureValue | null {
  if (value === null) return null;
  return typeof value === "string" ? { type: value, completedCount: 1 } : value;
}

function structureRewardMilli(type: StructureType | null): number {
  if (type === "farm") return BALANCE.farmCaptureRewardMilli;
  if (type === "barracks") return BALANCE.barracksCaptureRewardMilli;
  if (type === "turret") return BALANCE.turretCaptureRewardMilli;
  return 0;
}

export function captureRewardEligibility(state: GameState, tile: TileState): boolean {
  const heldLongEnough =
    state.tick - tile.controlledSinceTick >= BALANCE.minimumOwnershipRewardTicks;
  const cooldownReady =
    tile.lastRewardTick <= 0 || state.tick - tile.lastRewardTick >= BALANCE.rewardCooldownTicks;
  return heldLongEnough && cooldownReady;
}

export function grantCaptureReward(
  state: GameState,
  captorId: number,
  tile: TileState,
  previousOwner: number | null,
  capturedStructure: CaptureRewardStructure,
): number {
  if (previousOwner === null || previousOwner === captorId) return 0;
  if (!captureRewardEligibility(state, tile)) return 0;

  const captured = normalizeCapturedStructure(capturedStructure);
  const amount =
    BALANCE.captureRewardMilli +
    structureRewardMilli(captured?.type ?? null) * (captured?.completedCount ?? 0);
  const captor = state.players[captorId];
  if (!captor) return 0;
  captor.supplyMilli += amount;
  captor.stats.supplyEarnedMilli += amount;
  tile.lastRewardTick = state.tick;
  emitEvent(state, {
    type: "reward",
    playerId: captorId,
    tileId: tile.id,
    amount,
    message: `+${amount / SUPPLY_SCALE} Supply for hostile capture`,
  });
  return amount;
}

function removeEliminatedForces(state: GameState, playerId: number): void {
  const eliminated = state.players[playerId];
  if (eliminated) {
    for (const stack of state.stacks) {
      if (stack.owner === playerId) eliminated.stats.troopsLost += stack.troops;
    }
  }
  state.stacks = state.stacks.filter((stack) => stack.owner !== playerId);

  const retainedBattles = [];
  for (const battle of state.battles) {
    const removed = battle.participants.find((participant) => participant.playerId === playerId);
    if (removed && eliminated) eliminated.stats.troopsLost += removed.troops;
    battle.participants = battle.participants.filter(
      (participant) => participant.playerId !== playerId,
    );
    if (battle.participants.length === 1) {
      const survivor = battle.participants[0]!;
      const tile = state.map.tiles[battle.tileId];
      if (tile && survivor.playerId === battle.incumbentOwner) {
        tile.troops = Math.max(tile.troops, survivor.troops);
        continue;
      }
    }
    if (battle.participants.length > 0) retainedBattles.push(battle);
  }
  state.battles = retainedBattles;
  state.enclosures = state.enclosures.filter((enclosure) => enclosure.captorId !== playerId);
}

/** Returns the reward paid, or zero if the player still owns land. */
export function checkAndRewardElimination(
  state: GameState,
  defeatedId: number | null,
  eliminatorId: number,
): number {
  if (defeatedId === null || defeatedId === eliminatorId) return 0;
  const defeated = state.players[defeatedId];
  const eliminator = state.players[eliminatorId];
  if (!defeated || defeated.eliminated) return 0;
  if (state.map.landIds.some((tileId) => state.map.tiles[tileId]!.owner === defeatedId)) {
    return 0;
  }

  const transfer = Math.min(
    BALANCE.eliminationTransferCapMilli,
    Math.floor((defeated.supplyMilli * BALANCE.eliminationTransferPermille) / 1000),
  );
  const reward = BALANCE.eliminationRewardMilli + transfer;
  defeated.eliminated = true;
  defeated.eliminatedBy = eliminatorId;
  defeated.supplyMilli = 0;
  defeated.tileCount = 0;
  defeated.troopCount = 0;
  removeEliminatedForces(state, defeatedId);

  if (eliminator) {
    eliminator.supplyMilli += reward;
    eliminator.stats.supplyEarnedMilli += reward;
    eliminator.stats.enemiesEliminated += 1;
  }
  emitEvent(state, {
    type: "elimination",
    playerId: eliminatorId,
    amount: reward,
    message: `${eliminator?.name ?? "Unknown"} eliminated ${defeated.name}`,
  });
  return reward;
}

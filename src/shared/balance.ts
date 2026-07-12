export const TICKS_PER_SECOND = 10;
export const SUPPLY_SCALE = 1000;

export const BALANCE = {
  startingSupplyMilli: 100 * SUPPLY_SCALE,
  startingTroops: 24,
  startingTiles: 7,
  landPerPlayer: 95,
  minLand: 380,
  maxLand: 2100,
  tileIncomeMilliPerSecond: 35,
  farm: {
    costMilli: 45 * SUPPLY_SCALE,
    buildTicks: 6 * TICKS_PER_SECOND,
    incomeMilliPerSecond: 1100,
  },
  barracks: {
    costMilli: 70 * SUPPLY_SCALE,
    buildTicks: 8 * TICKS_PER_SECOND,
    trainTicks: 25,
    troopCostMilli: 1000,
    localTarget: 40,
  },
  turret: {
    costMilli: 90 * SUPPLY_SCALE,
    buildTicks: 10 * TICKS_PER_SECOND,
    virtualDefenders: 12,
    defensePermille: 180,
  },
  cancelRefundPermille: 650,
  seizedTicks: 6 * TICKS_PER_SECOND,
  repairTicks: 12 * TICKS_PER_SECOND,
  seizedIntegrity: 400,
  fullIntegrity: 1000,
  forestDefensePermille: 120,
  hillsDefensePermille: 250,
  hillsMovementPermille: 1150,
  baseMovementTicks: 9,
  combatRoundTicks: 2,
  minimumBattleTicks: 35,
  battleBaseControlPerRound: 100,
  battleAdvantageControlPerRound: 225,
  captureRewardMilli: 3 * SUPPLY_SCALE,
  farmCaptureRewardMilli: 6 * SUPPLY_SCALE,
  barracksCaptureRewardMilli: 10 * SUPPLY_SCALE,
  turretCaptureRewardMilli: 8 * SUPPLY_SCALE,
  rewardCooldownTicks: 45 * TICKS_PER_SECOND,
  minimumOwnershipRewardTicks: 20 * TICKS_PER_SECOND,
  eliminationRewardMilli: 50 * SUPPLY_SCALE,
  eliminationTransferPermille: 250,
  eliminationTransferCapMilli: 50 * SUPPLY_SCALE,
  victoryThresholdPermille: 800,
  victoryHoldTicks: 15 * TICKS_PER_SECOND,
  autosaveTicks: 15 * TICKS_PER_SECOND,
  maxRecentEvents: 24,
} as const;

export const TERRAIN_DISTRIBUTION = {
  meadow: [180, 230],
  muster: [80, 120],
  forest: [105, 145],
  hills: [95, 155],
} as const;

export const PLAYER_COLORS = [
  0x4ecdc4, 0xff6b6b, 0xffc857, 0x6c8cff, 0xc77dff, 0x63d471, 0xff8fab, 0x00b4d8, 0xf77f00,
  0x9ef01a, 0xb8c0ff, 0xe76f51, 0x2ec4b6, 0xf72585, 0xf9c74f, 0x90be6d, 0x577590, 0xbb3e03,
  0x7b2cbf, 0x06d6a0, 0xef476f,
] as const;

export const TERRAIN_COLORS = {
  meadow: 0x7fae62,
  muster: 0xb79a72,
  plains: 0x9ca56b,
  forest: 0x416b4c,
  hills: 0x8a806a,
  water: 0x315f73,
} as const;

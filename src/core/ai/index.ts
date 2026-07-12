import { BALANCE } from "../../shared/balance";
import type {
  Difficulty,
  GameCommand,
  GameState,
  SendPercent,
  StructureType,
  TileState,
} from "../../shared/types";
import { axialKey, distance, neighbors } from "../hex";
import { findPath } from "../hex/pathfinding";
import { SeededRng } from "../rng";
import { validateCommand } from "../commands";
import { attackerEffectivePower, defenderEffectivePower } from "../combat";

interface AiTuning {
  intervalTicks: number;
  candidateLimit: number;
  reserveTroops: number;
  attackRatioPermille: number;
  sendPercent: SendPercent;
  jitter: number;
}

interface AiDecisionProfile extends AiTuning {
  pressureLevel: 0 | 1 | 2;
  attackBatchSize: 1 | 2 | 3 | 4 | 5;
}

const AI_TUNING: Record<Difficulty, AiTuning> = {
  easy: {
    intervalTicks: 30,
    candidateLimit: 14,
    reserveTroops: 2,
    attackRatioPermille: 1500,
    sendPercent: 50,
    jitter: 80,
  },
  normal: {
    intervalTicks: 20,
    candidateLimit: 28,
    reserveTroops: 2,
    attackRatioPermille: 1225,
    sendPercent: 75,
    jitter: 40,
  },
  hard: {
    intervalTicks: 10,
    candidateLimit: 48,
    reserveTroops: 1,
    attackRatioPermille: 1025,
    sendPercent: 100,
    jitter: 16,
  },
};

function adjacentTiles(state: GameState, tile: TileState): TileState[] {
  const result: TileState[] = [];
  for (const coordinate of neighbors(tile)) {
    const neighborTile = state.map.tiles[axialKey(coordinate)];
    if (neighborTile && neighborTile.terrain !== "water") result.push(neighborTile);
  }
  return result;
}

function ownedTiles(state: GameState, playerId: number): TileState[] {
  return state.map.landIds
    .map((id) => state.map.tiles[id]!)
    .filter((tile) => tile.owner === playerId);
}

function movingTroopsForPercent(troops: number, percent: SendPercent): number {
  return Math.min(troops - 1, Math.floor((troops * percent) / 100));
}

/**
 * Easy and Normal begin with visibly more cautious doctrine, but eventually
 * break a mature front instead of stockpiling forever. This changes only the
 * commands the bot is willing to issue; every troop, Supply payment, movement,
 * and combat result still uses the shared authoritative rules.
 */
function decisionProfile(state: GameState, playerId: number, tuning: AiTuning): AiDecisionProfile {
  const neutralCount = state.map.landIds.reduce(
    (count, id) => count + Number(state.map.tiles[id]!.owner === null),
    0,
  );
  const neutralPermille = Math.floor((neutralCount * 1000) / Math.max(1, state.map.landCount));
  const player = state.players[playerId]!;
  const ownControlPermille = Math.floor(
    (player.tileCount * 1000) / Math.max(1, state.map.landCount),
  );
  const mustContestLeader = state.victory.leaderId !== null && state.victory.leaderId !== playerId;

  let pressureLevel: 0 | 1 | 2 = state.config.difficulty === "hard" ? 2 : 0;
  if (state.config.difficulty === "easy") {
    if (state.tick >= 3_000 || neutralPermille <= 550) pressureLevel = 1;
    if (state.tick >= 4_000 || neutralPermille <= 375) pressureLevel = 2;
  } else if (state.config.difficulty === "normal") {
    if (state.tick >= 2_500 || neutralPermille <= 550) pressureLevel = 1;
    if (state.tick >= 4_000 || neutralPermille <= 375) pressureLevel = 2;
  }
  if (mustContestLeader || ownControlPermille >= 650) pressureLevel = 2;
  const attackBatchSize: 1 | 2 | 3 | 4 | 5 =
    ownControlPermille >= 450
      ? 5
      : state.config.difficulty === "hard"
        ? 3
        : pressureLevel < 2
          ? 1
          : state.config.difficulty === "easy"
            ? 3
            : neutralPermille <= 100 || state.tick >= 9_000
              ? 3
              : 2;

  if (state.config.difficulty === "easy") {
    if (pressureLevel === 1) {
      return {
        ...tuning,
        pressureLevel,
        attackBatchSize,
        attackRatioPermille: 1_300,
        sendPercent: 75,
      };
    }
    if (pressureLevel === 2) {
      return {
        ...tuning,
        pressureLevel,
        attackBatchSize,
        attackRatioPermille: mustContestLeader || neutralPermille <= 100 ? 1_025 : 1_050,
        sendPercent: 100,
      };
    }
  }

  if (state.config.difficulty === "normal") {
    if (pressureLevel === 1) {
      return {
        ...tuning,
        pressureLevel,
        attackBatchSize,
        attackRatioPermille: 1_150,
      };
    }
    if (pressureLevel === 2) {
      return {
        ...tuning,
        pressureLevel,
        attackBatchSize,
        attackRatioPermille: mustContestLeader ? 1_000 : 1_025,
        sendPercent: 100,
      };
    }
  }

  return { ...tuning, pressureLevel, attackBatchSize };
}

function battleLossDistance(battle: GameState["battles"][number], playerId: number): number {
  // Attackers lose at 0 control; defenders lose at 10,000 control.
  return battle.defender === playerId ? 10_000 - battle.control : battle.control;
}

function chooseReinforcement(
  state: GameState,
  playerId: number,
  tuning: AiDecisionProfile,
): GameCommand | null {
  const reactionGapTicks =
    state.config.difficulty === "easy"
      ? tuning.intervalTicks * 2
      : state.config.difficulty === "normal"
        ? tuning.intervalTicks * 2
        : tuning.intervalTicks;
  const battles = state.battles
    .filter((battle) => battle.attacker === playerId || battle.defender === playerId)
    .filter((battle) => state.tick - battle.lastReinforcementTick >= reactionGapTicks)
    .filter((battle) => {
      const tile = state.map.tiles[battle.tileId]!;
      const isDefender = battle.defender === playerId;
      const ownPower = isDefender
        ? defenderEffectivePower(tile, battle.defenderTroops)
        : attackerEffectivePower(battle.attackerTroops);
      const enemyPower = isDefender
        ? attackerEffectivePower(battle.attackerTroops)
        : defenderEffectivePower(tile, battle.defenderTroops);
      const losingControl = isDefender ? battle.control >= 5_500 : battle.control <= 4_500;
      return ownPower <= enemyPower || losingControl;
    })
    .sort((left, right) => {
      const leftUrgency = battleLossDistance(left, playerId);
      const rightUrgency = battleLossDistance(right, playerId);
      return leftUrgency - rightUrgency || left.id - right.id;
    });
  if (battles.length === 0) return null;

  const sources = ownedTiles(state, playerId)
    .filter((tile) => tile.troops > tuning.reserveTroops + 1)
    .sort((left, right) => right.troops - left.troops || left.id.localeCompare(right.id))
    .slice(0, tuning.candidateLimit);

  for (const battle of battles) {
    const target = state.map.tiles[battle.tileId]!;
    for (const source of sources) {
      if (source.id === target.id) continue;
      const path = findPath(state.map, source.id, target.id, playerId, true);
      if (!path) continue;
      const percent: SendPercent = source.troops >= 12 ? 50 : 75;
      const sent = movingTroopsForPercent(source.troops, percent);
      const isDefender = battle.defender === playerId;
      const projectedPower = isDefender
        ? defenderEffectivePower(target, battle.defenderTroops + sent)
        : attackerEffectivePower(battle.attackerTroops + sent);
      const enemyPower = isDefender
        ? attackerEffectivePower(battle.attackerTroops)
        : defenderEffectivePower(target, battle.defenderTroops);
      // Do not drain the realm into a battle a single reinforcement cannot
      // plausibly recover. Hard accepts a riskier rescue than Easy.
      const recoveryPermille =
        state.config.difficulty === "easy" ? 900 : state.config.difficulty === "normal" ? 800 : 700;
      if (projectedPower * 1000 < enemyPower * recoveryPermille) continue;
      const command: GameCommand = {
        type: "move",
        playerId,
        sourceId: source.id,
        destinationId: target.id,
        percent,
      };
      if (validateCommand(state, command).ok) return command;
    }
  }
  return null;
}

function chooseDevelopedTileDefense(
  state: GameState,
  playerId: number,
  tuning: AiDecisionProfile,
): GameCommand | null {
  const threatened = ownedTiles(state, playerId)
    .filter((tile) => tile.structure && !state.battles.some((battle) => battle.tileId === tile.id))
    .map((tile) => ({
      tile,
      threat: adjacentTiles(state, tile)
        .filter((neighbor) => neighbor.owner !== null && neighbor.owner !== playerId)
        .reduce((largest, neighbor) => Math.max(largest, neighbor.troops), 0),
    }))
    .filter(({ tile, threat }) => threat > tile.troops)
    .sort(
      (left, right) =>
        right.threat - right.tile.troops - (left.threat - left.tile.troops) ||
        left.tile.id.localeCompare(right.tile.id),
    );
  if (threatened.length === 0) return null;

  const sources = ownedTiles(state, playerId)
    .filter((tile) => tile.troops > tuning.reserveTroops + 2)
    .sort((left, right) => right.troops - left.troops || left.id.localeCompare(right.id))
    .slice(0, tuning.candidateLimit);
  for (const target of threatened) {
    for (const source of sources) {
      if (source.id === target.tile.id) continue;
      const command: GameCommand = {
        type: "move",
        playerId,
        sourceId: source.id,
        destinationId: target.tile.id,
        percent: 50,
      };
      if (validateCommand(state, command).ok) return command;
    }
  }
  return null;
}

interface AttackChoice {
  source: TileState;
  target: TileState;
  score: number;
}

function targetValue(
  state: GameState,
  playerId: number,
  target: TileState,
  pressureLevel: 0 | 1 | 2,
  focusOpponentId: number | null,
): number {
  let score = target.owner === null ? 520 : 360;
  if (target.terrain === "meadow") score += 140;
  else if (target.terrain === "muster") score += 175;
  else if (target.terrain === "hills") score += 35;
  if (target.structure?.type === "farm") score += 180;
  else if (target.structure?.type === "barracks") score += 280;
  else if (target.structure?.type === "turret") score += 120;
  if (target.owner !== null) {
    const opponent = state.players[target.owner];
    if (opponent?.tileCount === 1) score += 800;
    else if (opponent && opponent.tileCount <= 3) score += 260;
    if (state.victory.leaderId === target.owner) score += 600;
    if (target.owner === focusOpponentId) {
      score += pressureLevel === 2 ? 1_800 : pressureLevel === 1 ? 500 : 0;
    }
    if (opponent && pressureLevel === 2) {
      // Once the board matures, convert a territorial edge into eliminations
      // instead of spreading attacks evenly enough to preserve every rival.
      score += Math.max(0, 480 - opponent.tileCount * 6);
      if (state.players[playerId]!.tileCount >= opponent.tileCount * 2) score += 260;
    }
  }
  score -= target.troops * 45;
  // Prefer coherent fronts rather than long tendrils.
  score += adjacentTiles(state, target).filter((tile) => tile.owner === playerId).length * 35;
  return score;
}

/**
 * Select one reachable rival for the current decision batch. Mature bots focus
 * the weakest bordering realm, creating deterministic elimination pressure
 * instead of trading unrelated border tiles forever. The victory leader wins
 * priority whenever it is actually reachable from a candidate source.
 */
function chooseFocusOpponent(
  state: GameState,
  playerId: number,
  sources: readonly TileState[],
): number | null {
  const candidates = new Set<number>();
  for (const source of sources) {
    for (const target of adjacentTiles(state, source)) {
      if (target.owner !== null && target.owner !== playerId) candidates.add(target.owner);
    }
  }
  if (
    state.victory.leaderId !== null &&
    state.victory.leaderId !== playerId &&
    candidates.has(state.victory.leaderId)
  ) {
    return state.victory.leaderId;
  }

  const player = state.players[playerId]!;
  const tieOrigin = player.aiSeed % state.players.length;
  return (
    [...candidates]
      .filter((id) => !state.players[id]!.eliminated)
      .sort((left, right) => {
        const tileDifference = state.players[left]!.tileCount - state.players[right]!.tileCount;
        if (tileDifference !== 0) return tileDifference;
        const leftRank = (left - tieOrigin + state.players.length) % state.players.length;
        const rightRank = (right - tieOrigin + state.players.length) % state.players.length;
        return leftRank - rightRank || left - right;
      })[0] ?? null
  );
}

function chooseAttackOrExpansion(
  state: GameState,
  playerId: number,
  tuning: AiDecisionProfile,
  rng: SeededRng,
  excludedSources: ReadonlySet<string> = new Set(),
): GameCommand | null {
  const sources = ownedTiles(state, playerId)
    .filter(
      (tile) =>
        tile.troops > tuning.reserveTroops &&
        !excludedSources.has(tile.id) &&
        isFrontier(state, tile, playerId),
    )
    .sort((left, right) => right.troops - left.troops || left.id.localeCompare(right.id))
    .slice(0, tuning.candidateLimit);
  const focusOpponentId = chooseFocusOpponent(state, playerId, sources);
  const choices: AttackChoice[] = [];

  for (const source of sources) {
    const sent = movingTroopsForPercent(source.troops, tuning.sendPercent);
    if (sent <= 0) continue;
    for (const target of adjacentTiles(state, source)) {
      if (target.owner === playerId) continue;
      // Reinforcement policy owns contested tiles. Treating an active battle
      // as a fresh attack would bypass its urgency and reaction-gap checks.
      if (state.battles.some((battle) => battle.tileId === target.id)) continue;
      const requiredPower = Math.floor(
        (defenderEffectivePower(target, target.troops) * tuning.attackRatioPermille) / 1000,
      );
      if (sent * 1000 < requiredPower) continue;
      choices.push({
        source,
        target,
        score:
          targetValue(state, playerId, target, tuning.pressureLevel, focusOpponentId) +
          Math.min(180, (sent - target.troops) * 20) +
          rng.int(tuning.jitter + 1),
      });
    }
  }

  choices.sort(
    (left, right) =>
      right.score - left.score ||
      left.target.id.localeCompare(right.target.id) ||
      left.source.id.localeCompare(right.source.id),
  );
  const choice = choices[0];
  if (!choice) return null;
  const command: GameCommand = {
    type: "move",
    playerId,
    sourceId: choice.source.id,
    destinationId: choice.target.id,
    percent: tuning.sendPercent,
  };
  return validateCommand(state, command).ok ? command : null;
}

function isFrontier(state: GameState, tile: TileState, playerId: number): boolean {
  return adjacentTiles(state, tile).some((neighbor) => neighbor.owner !== playerId);
}

function chooseMobilization(
  state: GameState,
  playerId: number,
  tuning: AiTuning,
): GameCommand | null {
  const owned = ownedTiles(state, playerId);
  const frontier = owned.filter((tile) => isFrontier(state, tile, playerId));
  if (frontier.length === 0) return null;
  const sources = owned
    .filter(
      (tile) =>
        !isFrontier(state, tile, playerId) && tile.troops > Math.max(5, tuning.reserveTroops + 2),
    )
    .sort((left, right) => right.troops - left.troops || left.id.localeCompare(right.id))
    .slice(0, tuning.candidateLimit);

  for (const source of sources) {
    const targets = [...frontier].sort(
      (left, right) =>
        distance(source, left) - distance(source, right) || left.id.localeCompare(right.id),
    );
    for (const target of targets.slice(0, 5)) {
      const command: GameCommand = {
        type: "move",
        playerId,
        sourceId: source.id,
        destinationId: target.id,
        percent: 50,
      };
      if (validateCommand(state, command).ok) return command;
    }
  }
  return null;
}

function countStructures(state: GameState, playerId: number, type: StructureType): number {
  return ownedTiles(state, playerId).filter((tile) => tile.structure?.type === type).length;
}

function chooseBuild(state: GameState, playerId: number): GameCommand | null {
  const player = state.players[playerId]!;
  const owned = ownedTiles(state, playerId);
  const farms = countStructures(state, playerId, "farm");
  const barracks = countStructures(state, playerId, "barracks");
  const turrets = countStructures(state, playerId, "turret");
  const desiredFarms = Math.max(1, Math.ceil(owned.length / 10));
  const desiredBarracks = Math.max(1, Math.ceil(owned.length / 22));
  const desiredTurrets = Math.floor(owned.length / 18);

  const options: Array<{ type: StructureType; tiles: TileState[]; desired: boolean }> = [
    {
      type: "farm",
      desired: farms < desiredFarms && player.supplyMilli >= BALANCE.farm.costMilli + 10_000,
      tiles: owned.filter((tile) => tile.terrain === "meadow" && !tile.structure),
    },
    {
      type: "barracks",
      desired:
        barracks < desiredBarracks && player.supplyMilli >= BALANCE.barracks.costMilli + 15_000,
      tiles: owned.filter((tile) => tile.terrain === "muster" && !tile.structure),
    },
    {
      type: "turret",
      desired: turrets < desiredTurrets && player.supplyMilli >= BALANCE.turret.costMilli + 20_000,
      tiles: owned.filter(
        (tile) => !tile.structure && isFrontier(state, tile, playerId) && tile.terrain !== "meadow",
      ),
    },
  ];

  for (const option of options) {
    if (!option.desired) continue;
    option.tiles.sort((left, right) => {
      const leftThreat = adjacentTiles(state, left).filter(
        (tile) => tile.owner !== null && tile.owner !== playerId,
      ).length;
      const rightThreat = adjacentTiles(state, right).filter(
        (tile) => tile.owner !== null && tile.owner !== playerId,
      ).length;
      return rightThreat - leftThreat || left.id.localeCompare(right.id);
    });
    for (const tile of option.tiles) {
      const command: GameCommand = {
        type: "build",
        playerId,
        tileId: tile.id,
        structure: option.type,
      };
      if (validateCommand(state, command).ok) return command;
    }
  }
  return null;
}

export function aiDecisionInterval(difficulty: Difficulty): number {
  return AI_TUNING[difficulty].intervalTicks;
}

export function shouldEvaluateAi(state: GameState, playerId: number): boolean {
  const interval = aiDecisionInterval(state.config.difficulty);
  return (state.tick + playerId * 7) % interval === 0;
}

export function decideAiCommands(state: GameState, playerId: number): GameCommand[] {
  const player = state.players[playerId];
  if (!player || player.isHuman || player.eliminated || state.victory.winnerId !== null) return [];
  const tuning = decisionProfile(state, playerId, AI_TUNING[state.config.difficulty]);
  const rng = new SeededRng(`${player.aiSeed}:${state.tick}:${state.config.difficulty}`);
  const output: GameCommand[] = [];
  const decisionNumber = Math.floor(
    (state.tick + player.id * 7) / AI_TUNING[state.config.difficulty].intervalTicks,
  );

  const reinforce = chooseReinforcement(state, playerId, tuning);
  const defend = reinforce ? null : chooseDevelopedTileDefense(state, playerId, tuning);
  // Periodic logistics prevents productive interior Barracks from becoming
  // stranded while a bot keeps finding small attacks on a distant front.
  const mobilize =
    !reinforce && !defend && decisionNumber % 4 === 0
      ? chooseMobilization(state, playerId, tuning)
      : null;
  const move =
    reinforce ??
    defend ??
    mobilize ??
    chooseAttackOrExpansion(state, playerId, tuning, rng) ??
    chooseMobilization(state, playerId, tuning);
  if (move) {
    output.push(move);
    player.aiMode =
      reinforce || move.type !== "move"
        ? "reinforce"
        : defend
          ? "defend"
          : mobilize
            ? "mobilize"
            : state.map.tiles[move.destinationId]?.owner === playerId
              ? "mobilize"
              : "attack";
  } else {
    player.aiMode = "develop";
  }

  const extraAttacks = tuning.attackBatchSize - 1;
  if (extraAttacks > 0) {
    const usedSources = new Set(
      output.filter((command) => command.type === "move").map((command) => command.sourceId),
    );
    for (let extra = 0; extra < extraAttacks; extra += 1) {
      const attack = chooseAttackOrExpansion(state, playerId, tuning, rng, usedSources);
      if (!attack || attack.type !== "move") break;
      output.push(attack);
      usedSources.add(attack.sourceId);
    }
  }

  const build = chooseBuild(state, playerId);
  if (
    build &&
    (state.config.difficulty === "hard" || output.length === 0 || decisionNumber % 3 === 0)
  ) {
    output.push(build);
    if (!move) player.aiMode = "develop";
  }
  return output;
}

/** Round-robin evaluation keeps the 20-AI stress case bounded. */
export function collectAiCommands(state: GameState): GameCommand[] {
  const commands: GameCommand[] = [];
  for (const player of state.players) {
    if (!player.isHuman && shouldEvaluateAi(state, player.id)) {
      commands.push(...decideAiCommands(state, player.id));
    }
  }
  return commands;
}

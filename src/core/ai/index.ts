import { BALANCE } from "../../shared/balance";
import type {
  Difficulty,
  GameCommand,
  GameState,
  SendPercent,
  StructureType,
  TileState,
} from "../../shared/types";
import { axialKey, compareAxialKeys, distance, neighbors } from "../hex";
import { findPath } from "../hex/pathfinding";
import { SeededRng } from "../rng";
import { validateCommand } from "../commands";
import {
  attackerEffectivePower,
  battlePresentation,
  defenderEffectivePower,
  getBattleParticipant,
} from "../combat";

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
  return getBattleParticipant(battle, playerId)?.control ?? 0;
}

function strategicBattlePower(
  state: GameState,
  battle: GameState["battles"][number],
  playerId: number | null,
): number {
  const presentation = battlePresentation(state, battle).find(
    (participant) => participant.playerId === playerId,
  );
  if (!presentation) return 0;
  // Adjacent support causes real casualties instead of virtual soldiers. This
  // small heuristic premium lets AI account for it without altering rules.
  return presentation.effectivePower + presentation.turretSupportCount * 500;
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
    .filter((battle) => getBattleParticipant(battle, playerId))
    .filter((battle) => {
      const participant = getBattleParticipant(battle, playerId)!;
      return state.tick - participant.lastReinforcementTick >= reactionGapTicks;
    })
    .filter((battle) => {
      const participant = getBattleParticipant(battle, playerId)!;
      const ownPower = strategicBattlePower(state, battle, playerId);
      const strongestEnemy = Math.max(
        0,
        ...battle.participants
          .filter((candidate) => candidate.playerId !== playerId)
          .map((candidate) => strategicBattlePower(state, battle, candidate.playerId)),
      );
      return ownPower <= strongestEnemy || participant.control <= 4_500;
    })
    .sort((left, right) => {
      const leftUrgency = battleLossDistance(left, playerId);
      const rightUrgency = battleLossDistance(right, playerId);
      return leftUrgency - rightUrgency || left.id - right.id;
    });
  if (battles.length === 0) return null;

  const sources = ownedTiles(state, playerId)
    .filter((tile) => tile.troops > tuning.reserveTroops + 1)
    .sort((left, right) => right.troops - left.troops || compareAxialKeys(left.id, right.id))
    .slice(0, tuning.candidateLimit);

  for (const battle of battles) {
    const target = state.map.tiles[battle.tileId]!;
    for (const source of sources) {
      if (source.id === target.id) continue;
      const path = findPath(state.map, source.id, target.id, playerId, true);
      if (!path) continue;
      const percent: SendPercent = source.troops >= 12 ? 50 : 75;
      const sent = movingTroopsForPercent(source.troops, percent);
      const participant = getBattleParticipant(battle, playerId)!;
      const projectedOrganicPower =
        participant.playerId === battle.incumbentOwner
          ? defenderEffectivePower(target, participant.troops + sent)
          : attackerEffectivePower(participant.troops + sent);
      const ownSupport =
        battlePresentation(state, battle).find((entry) => entry.playerId === playerId)
          ?.turretSupportCount ?? 0;
      const projectedPower = projectedOrganicPower + ownSupport * 500;
      const enemyPower = Math.max(
        0,
        ...battle.participants
          .filter((candidate) => candidate.playerId !== playerId)
          .map((candidate) => strategicBattlePower(state, battle, candidate.playerId)),
      );
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
        compareAxialKeys(left.tile.id, right.tile.id),
    );
  if (threatened.length === 0) return null;

  const sources = ownedTiles(state, playerId)
    .filter((tile) => tile.troops > tuning.reserveTroops + 2)
    .sort((left, right) => right.troops - left.troops || compareAxialKeys(left.id, right.id))
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

interface EnclosureDecision {
  command: GameCommand;
  mode: "breakout" | "encircle";
}

function chooseEnclosureResponse(
  state: GameState,
  playerId: number,
  tuning: AiDecisionProfile,
): EnclosureDecision | null {
  const trapped = state.enclosures
    .filter((enclosure) =>
      enclosure.tileIds.some((tileId) => state.map.tiles[tileId]?.owner === playerId),
    )
    .sort(
      (left, right) =>
        right.progressTicks - left.progressTicks ||
        left.captorId - right.captorId ||
        left.id - right.id,
    );
  for (const enclosure of trapped) {
    const pocket = new Set(enclosure.tileIds);
    const sources = ownedTiles(state, playerId)
      .filter((tile) => pocket.has(tile.id) && tile.troops > tuning.reserveTroops + 1)
      .sort((left, right) => right.troops - left.troops || compareAxialKeys(left.id, right.id))
      .slice(0, tuning.candidateLimit);
    const targets = enclosure.boundaryIds
      .map((tileId) => state.map.tiles[tileId])
      .filter((tile): tile is TileState => Boolean(tile))
      .sort((left, right) => left.troops - right.troops || compareAxialKeys(left.id, right.id));
    for (const source of sources) {
      for (const target of targets) {
        const command: GameCommand = {
          type: "move",
          playerId,
          sourceId: source.id,
          destinationId: target.id,
          percent: tuning.sendPercent,
        };
        if (validateCommand(state, command).ok) return { command, mode: "breakout" };
      }
    }
  }

  const closing = state.enclosures
    .filter(
      (enclosure) =>
        enclosure.captorId === playerId &&
        enclosure.progressTicks * 3 >= BALANCE.encirclementTicks * 2,
    )
    .sort((left, right) => right.progressTicks - left.progressTicks || left.id - right.id);
  for (const enclosure of closing) {
    const boundary = enclosure.boundaryIds
      .map((tileId) => state.map.tiles[tileId])
      .filter(
        (tile): tile is TileState =>
          Boolean(tile) &&
          tile!.owner === playerId &&
          !state.battles.some((battle) => battle.tileId === tile!.id),
      )
      .sort((left, right) => left.troops - right.troops || compareAxialKeys(left.id, right.id));
    const sources = ownedTiles(state, playerId)
      .filter((tile) => tile.troops > tuning.reserveTroops + 3)
      .sort((left, right) => right.troops - left.troops || compareAxialKeys(left.id, right.id))
      .slice(0, tuning.candidateLimit);
    for (const target of boundary.slice(0, 6)) {
      for (const source of sources) {
        if (source.id === target.id || source.troops <= target.troops + 2) continue;
        const command: GameCommand = {
          type: "move",
          playerId,
          sourceId: source.id,
          destinationId: target.id,
          percent: 50,
        };
        if (validateCommand(state, command).ok) return { command, mode: "encircle" };
      }
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
  if (target.structure?.type === "farm") score += 180 * target.structure.completedCount;
  else if (target.structure?.type === "barracks") score += 280 * target.structure.completedCount;
  else if (target.structure?.type === "turret") score += 120 * target.structure.completedCount;
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
    .sort((left, right) => right.troops - left.troops || compareAxialKeys(left.id, right.id))
    .slice(0, tuning.candidateLimit);
  const focusOpponentId = chooseFocusOpponent(state, playerId, sources);
  const choices: AttackChoice[] = [];

  for (const source of sources) {
    const sent = movingTroopsForPercent(source.troops, tuning.sendPercent);
    if (sent <= 0) continue;
    for (const target of adjacentTiles(state, source)) {
      if (target.owner === playerId) continue;
      const battle = state.battles.find((candidate) => candidate.tileId === target.id);
      // Existing participants are owned by reinforcement policy. A new faction
      // may deliberately enter a favorable free-for-all immediately.
      if (battle && getBattleParticipant(battle, playerId)) continue;
      const defenderPower = battle
        ? Math.max(
            0,
            ...battle.participants.map((participant) =>
              strategicBattlePower(state, battle, participant.playerId),
            ),
          )
        : defenderEffectivePower(target, target.troops);
      const requiredPower = Math.floor((defenderPower * tuning.attackRatioPermille) / 1000);
      if (sent * 1000 < requiredPower) continue;
      choices.push({
        source,
        target,
        score:
          targetValue(state, playerId, target, tuning.pressureLevel, focusOpponentId) +
          (battle ? 220 + battle.participants.length * 45 : 0) +
          Math.min(180, (sent - target.troops) * 20) +
          rng.int(tuning.jitter + 1),
      });
    }
  }

  choices.sort(
    (left, right) =>
      right.score - left.score ||
      compareAxialKeys(left.target.id, right.target.id) ||
      compareAxialKeys(left.source.id, right.source.id),
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
    .sort((left, right) => right.troops - left.troops || compareAxialKeys(left.id, right.id))
    .slice(0, tuning.candidateLimit);

  for (const source of sources) {
    const targets = [...frontier].sort(
      (left, right) =>
        distance(source, left) - distance(source, right) || compareAxialKeys(left.id, right.id),
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
  return ownedTiles(state, playerId).reduce(
    (count, tile) => count + (tile.structure?.type === type ? tile.structure.completedCount : 0),
    0,
  );
}

function canDevelopAs(tile: TileState, type: StructureType): boolean {
  if (!tile.structure) return true;
  return (
    tile.structure.type === type &&
    tile.structure.pendingProgressTicks === null &&
    tile.structure.completedCount < BALANCE.maxStructureCount &&
    tile.structure.status !== "seized"
  );
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
      tiles: owned.filter((tile) => tile.terrain === "meadow" && canDevelopAs(tile, "farm")),
    },
    {
      type: "barracks",
      desired:
        barracks < desiredBarracks && player.supplyMilli >= BALANCE.barracks.costMilli + 15_000,
      tiles: owned.filter((tile) => tile.terrain === "muster" && canDevelopAs(tile, "barracks")),
    },
    {
      type: "turret",
      desired: turrets < desiredTurrets && player.supplyMilli >= BALANCE.turret.costMilli + 20_000,
      tiles: owned.filter(
        (tile) =>
          canDevelopAs(tile, "turret") &&
          isFrontier(state, tile, playerId) &&
          tile.terrain !== "meadow",
      ),
    },
  ];

  for (const option of options) {
    if (!option.desired) continue;
    option.tiles.sort((left, right) => {
      const spreadDifference = Number(Boolean(left.structure)) - Number(Boolean(right.structure));
      if (spreadDifference !== 0) return spreadDifference;
      const leftThreat = adjacentTiles(state, left).filter(
        (tile) => tile.owner !== null && tile.owner !== playerId,
      ).length;
      const rightThreat = adjacentTiles(state, right).filter(
        (tile) => tile.owner !== null && tile.owner !== playerId,
      ).length;
      return rightThreat - leftThreat || compareAxialKeys(left.id, right.id);
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

  const enclosure = chooseEnclosureResponse(state, playerId, tuning);
  const reinforce = enclosure ? null : chooseReinforcement(state, playerId, tuning);
  const defend =
    reinforce || enclosure ? null : chooseDevelopedTileDefense(state, playerId, tuning);
  // Periodic logistics prevents productive interior Barracks from becoming
  // stranded while a bot keeps finding small attacks on a distant front.
  const mobilize =
    !enclosure && !reinforce && !defend && decisionNumber % 4 === 0
      ? chooseMobilization(state, playerId, tuning)
      : null;
  const move =
    enclosure?.command ??
    reinforce ??
    defend ??
    mobilize ??
    chooseAttackOrExpansion(state, playerId, tuning, rng) ??
    chooseMobilization(state, playerId, tuning);
  if (move) {
    output.push(move);
    player.aiMode = enclosure
      ? enclosure.mode
      : reinforce || move.type !== "move"
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { axialKey, findPath, neighbors } from "@/src/core/hex";
import { parseEngineSnapshot } from "@/src/core/engine";
import { stableHash } from "@/src/core/hash";
import { eligibleSpawnCenters } from "@/src/core/map";
import { planMultiMove, unitsForPercent, type MultiMovePlan } from "@/src/core/movement";
import {
  computeFinalSpawnVector,
  validateSpawnChoice,
  validateSpawnChoicePreview,
} from "@/src/core/placement";
import { calculateIncomeMilliPerSecond } from "@/src/core/economy";
import { canPlaceStructure, isBarracksRallyBlocked } from "@/src/core/buildings";
import { battlePresentation } from "@/src/core/combat";
import { formatUnits, totalUnits, unitTypeForStructure } from "@/src/core/units";
import { BALANCE, SUPPLY_SCALE, targetLandCount, TICKS_PER_SECOND } from "@/src/shared/balance";
import { COMMIT_SHA, VERSION_LABEL } from "@/src/shared/version";
import type {
  EngineSnapshot,
  DebugScenario,
  GameCommand,
  GameState,
  GraphicsQuality,
  MapArchetype,
  MatchConfig,
  SendPercent,
  StructureType,
  TileState,
  UnitCounts,
  UnitType,
  WorkerRequest,
  WorkerResponse,
} from "@/src/shared/types";
import { AudioDirector } from "./audio/AudioDirector";
import { OrderedAsyncQueue } from "./asyncQueue";
import { formatTypeMultiplier } from "./battleLabels";
import { placementCatchUpTick } from "./placementClock";
import { placementPresentationSignature } from "./placementSignature";
import type { GameRenderer } from "./render/GameRenderer";
import type { RendererContextStatus } from "./render/contextRecovery";
import type { MultiplayerClient, RoomIdentity } from "@/src/edge/client";
import type { PlayerSummary, ServerMessage } from "@/src/edge/protocol";
import { LOCAL_SAVE_KEY, readLocalSnapshot } from "./saves";
import {
  decodeCheckpointPayload,
  encodeCheckpoint,
  localizeCheckpointForRecipient,
} from "./checkpoints";

type Screen = "menu" | "match";
type SetupTab = "single" | "multiplayer";

interface PerfState {
  fps: number;
  simulationMs: number;
  aiMs: number;
}

interface MultiplayerForm {
  action: "create" | "join";
  roomCode: string;
  status: string;
}

interface DebugRoute {
  sourceId: string;
  destinationId: string;
}

type MultiPhase = "idle" | "sources" | "targets";

const MAPS: Array<{ id: MapArchetype; name: string; subtitle: string; description: string }> = [
  {
    id: "heartland",
    name: "River Gates",
    subtitle: "Canals & crossings",
    description: "Broad riverworks compress the front into guarded crossings and contested gates.",
  },
  {
    id: "broken-crown",
    name: "Shattered Crown",
    subtitle: "Island necks",
    description: "Fractured island realms meet at narrow necks where every reinforcement matters.",
  },
  {
    id: "highland-basin",
    name: "Highland Passes",
    subtitle: "Ridges & passes",
    description:
      "Mountain ridges divide the realm into defensible passes and hard-fought corridors.",
  },
];

const STRUCTURES: Record<
  StructureType,
  {
    name: string;
    unit: UnitType;
    shortcut: string;
    terrain: string;
    costMilli: number;
    buildTicks: number;
  }
> = {
  barracks: {
    name: "Barracks",
    unit: "melee",
    shortcut: "B",
    terrain: "Muster Ground",
    costMilli: BALANCE.barracks.costMilli,
    buildTicks: BALANCE.barracks.buildTicks,
  },
  "archery-range": {
    name: "Archery Range",
    unit: "ranged",
    shortcut: "R",
    terrain: "Fertile Meadow",
    costMilli: BALANCE.archeryRange.costMilli,
    buildTicks: BALANCE.archeryRange.buildTicks,
  },
  "wizard-tower": {
    name: "Wizard Tower",
    unit: "wizard",
    shortcut: "T",
    terrain: "owned land tile",
    costMilli: BALANCE.wizardTower.costMilli,
    buildTicks: BALANCE.wizardTower.buildTicks,
  },
};

const UNIT_LABELS: Record<UnitType, string> = {
  melee: "Melee",
  ranged: "Ranged",
  wizard: "Wizard",
};

function formatPower(power: UnitCounts): string {
  const total = totalUnits(power);
  const equivalents = total / 1000;
  return `${equivalents.toFixed(Number.isInteger(equivalents) ? 0 : 1)} power`;
}

function formatPowerByType(power: UnitCounts): string {
  return (["melee", "ranged", "wizard"] as const)
    .filter((type) => power[type] > 0)
    .map(
      (type) => `${UNIT_LABELS[type]} ${(power[type] / 1000).toFixed(power[type] % 1000 ? 1 : 0)}`,
    )
    .join(", ");
}

function supportPower(participant: {
  localSupportPower: UnitCounts;
  adjacentSupportPower: UnitCounts;
}): number {
  return totalUnits(participant.localSupportPower) + totalUnits(participant.adjacentSupportPower);
}

const DEBUG_SCENARIOS: Array<{ id: DebugScenario; label: string }> = [
  { id: "structures", label: "Structures" },
  { id: "battle", label: "Battle 50/50" },
  { id: "battle-minimum", label: "Minimum battle" },
  { id: "reinforcement", label: "Reinforcement" },
  { id: "capture-before", label: "Capture ready" },
  { id: "capture", label: "Capture" },
  { id: "developed-capture", label: "Developed capture" },
  { id: "elimination", label: "Elimination reward" },
  { id: "interior-build", label: "Interior build" },
  { id: "victory", label: "Victory" },
  { id: "defeat", label: "Defeat" },
];

const DEFAULT_CONFIG: MatchConfig = {
  seed: "CROWN-7421",
  archetype: "heartland",
  aiCount: 5,
  difficulty: "normal",
  playerName: "Warden",
  graphics: "high",
  sound: true,
  colorPatterns: false,
  fullCounts: false,
  debug: false,
};

class SimulationBridge {
  private worker: Worker | null = null;
  private readonly onMessage: (message: WorkerResponse) => void;
  private readonly onFailure: (message: string) => void;

  constructor(onMessage: (message: WorkerResponse) => void, onFailure: (message: string) => void) {
    this.onMessage = onMessage;
    this.onFailure = onFailure;
  }

  start(config: MatchConfig, snapshot?: EngineSnapshot): void {
    try {
      this.worker = new Worker(new URL("../worker/game.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
      this.worker.onerror = (event) =>
        this.onFailure(event.message || "The simulation worker stopped unexpectedly.");
      this.send(snapshot ? { type: "restore", snapshot } : { type: "start", config });
    } catch (error) {
      this.onFailure(
        error instanceof Error ? error.message : "The simulation worker could not start.",
      );
    }
  }

  send(message: WorkerRequest): void {
    this.worker?.postMessage(message);
  }

  destroy(): void {
    this.send({ type: "dispose" });
    this.worker?.terminate();
    this.worker = null;
  }
}

function createSeed(): string {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return `${values[0]!.toString(36)}-${values[1]!.toString(36)}`.toUpperCase().slice(0, 15);
}

function structureReason(
  tile: TileState | undefined,
  structure: StructureType,
  playerId = 0,
  state?: GameState | null,
): string | null {
  if (!tile || !state) return "Structures require a land tile.";
  return canPlaceStructure(state, playerId, tile.id, structure).reason ?? null;
}

function terrainName(terrain: TileState["terrain"]): string {
  return {
    meadow: "Fertile Meadow",
    muster: "Muster Ground",
    plains: "Plains",
    forest: "Forest",
    hills: "Hills",
    water: "Water",
  }[terrain];
}

function debugScenarioFocusTile(state: GameState, scenario: DebugScenario): string | undefined {
  if (scenario === "structures") {
    return state.map.landIds.find((id) =>
      Boolean(
        state.map.tiles[id]?.structure &&
        state.map.tiles[id]?.owner === (state.config.localPlayerId ?? 0),
      ),
    );
  }
  if (scenario === "capture") {
    return [...state.events].reverse().find((event) => event.type === "capture")?.tileId;
  }
  if (scenario === "interior-build") {
    return (
      state.enclosures[0]?.tileIds[0] ?? state.map.spawnCenters[state.config.localPlayerId ?? 0]
    );
  }
  return state.battles[0]?.tileId;
}

function formatSupply(milli: number): string {
  return (milli / SUPPLY_SCALE).toFixed(milli % SUPPLY_SCALE === 0 ? 0 : 1);
}

function StructureGlyph({ type }: { type: StructureType }) {
  return (
    <span className={`structure-glyph structure-glyph--${type}`} aria-hidden="true">
      <i />
    </span>
  );
}

function UnitGlyph({ type }: { type: UnitType }) {
  return (
    <span className={`unit-glyph unit-glyph--${type}`} aria-hidden="true">
      <i />
    </span>
  );
}

function UnitComposition({ units, compact = false }: { units: UnitCounts; compact?: boolean }) {
  return (
    <span
      className={`unit-composition ${compact ? "unit-composition--compact" : ""}`}
      aria-label={formatUnits(units)}
    >
      {(["melee", "ranged", "wizard"] as const).map((type) => (
        <span key={type} data-unit-type={type}>
          <UnitGlyph type={type} />
          <b>{units[type]}</b>
          {!compact && <small>{UNIT_LABELS[type]}</small>}
        </span>
      ))}
    </span>
  );
}

function MapMiniature({ archetype, active }: { archetype: MapArchetype; active: boolean }) {
  return (
    <div
      className={`map-miniature map-miniature--${archetype} ${active ? "is-active" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: 19 }, (_, index) => (
        <i key={index} style={{ "--i": index } as React.CSSProperties} />
      ))}
    </div>
  );
}

export function GameApp() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [tab, setTab] = useState<SetupTab>("single");
  const [config, setConfig] = useState<MatchConfig>(DEFAULT_CONFIG);
  const [state, setState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [sendPercent, setSendPercent] = useState<SendPercent>(50);
  const [buildMode, setBuildMode] = useState<StructureType | null>(null);
  const [rallySourceId, setRallySourceId] = useState<string | null>(null);
  const [multiPhase, setMultiPhase] = useState<MultiPhase>("idle");
  const [multiSources, setMultiSources] = useState<string[]>([]);
  const [multiTargets, setMultiTargets] = useState<string[]>([]);
  const [placementDeadlineAt, setPlacementDeadlineAt] = useState<number | null>(null);
  const [placementNow, setPlacementNow] = useState(() => Date.now());
  const [roomPlacement, setRoomPlacement] = useState<Extract<
    ServerMessage,
    { type: "placement" }
  > | null>(null);
  const [speed, setSpeed] = useState<1 | 2 | 4>(1);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [perf, setPerf] = useState<PerfState>({ fps: 0, simulationMs: 0, aiMs: 0 });
  const [multiplayer, setMultiplayer] = useState<MultiplayerForm>({
    action: "create",
    roomCode: "",
    status: "",
  });
  const [multiplayerBotCount, setMultiplayerBotCount] = useState(3);
  const [roomIdentity, setRoomIdentity] = useState<RoomIdentity | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<PlayerSummary[]>([]);
  const [roomReady, setRoomReady] = useState(false);
  const [roomBusy, setRoomBusy] = useState(false);
  const [hasSave, setHasSave] = useState(false);
  const [rendererStatus, setRendererStatus] = useState<"ready" | RendererContextStatus>("ready");
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const bridgeRef = useRef<SimulationBridge | null>(null);
  const audioRef = useRef<AudioDirector | null>(null);
  const roomClientRef = useRef<MultiplayerClient | null>(null);
  const roomMessageQueueRef = useRef(new OrderedAsyncQueue());
  const roomConnectionGenerationRef = useRef(0);
  const roomAppliedSequenceRef = useRef(0);
  const roomCommandTargetsRef = useRef(new Map<number, number>());
  const appliedRoomSequencesRef = useRef(new Set<number>());
  const roomIdentityRef = useRef<RoomIdentity | null>(null);
  const workerRelaySequenceRef = useRef(0);
  const pendingCheckpointRef = useRef<{ requestedTick: number } | null>(null);
  const lastCheckpointTickRef = useRef(0);
  const lastAutosaveTickRef = useRef(0);
  const roomCompletionSentRef = useRef(false);
  const roomPlacementRef = useRef<Extract<ServerMessage, { type: "placement" }> | null>(null);
  const pendingStartedRef = useRef<Extract<ServerMessage, { type: "started" }> | null>(null);
  const publishedCandidateHashRef = useRef<string | null>(null);
  const publishedFinalVectorRef = useRef<string | null>(null);
  const placementSyncSentRef = useRef(new Map<number, string>());
  const openingTimerRef = useRef<number | null>(null);
  const openingPhaseHandledRef = useRef(false);
  const pendingDebugScenarioRef = useRef<DebugScenario | null>(null);
  const debugStateHistoryRef = useRef(new Map<number, GameState>());
  const latestStateRef = useRef<GameState | null>(null);
  const multiPhaseRef = useRef<MultiPhase>("idle");
  const multiSourcesRef = useRef<string[]>([]);
  const multiTargetsRef = useRef<string[]>([]);
  const multiKeyHeldRef = useRef(false);
  const multiPointerGestureRef = useRef(false);
  const deferredMultiKeyReleaseRef = useRef(false);
  const completeMultiKeyReleaseRef = useRef<() => void>(() => undefined);
  const recommendedPlacementRef = useRef<{ key: string; centerId: string | null } | null>(null);
  const debugPlacementCandidatesRef = useRef<{
    signature: string;
    candidates: string[];
    selectableCandidates: string[];
  } | null>(null);

  const updateMultiPhase = useCallback((phase: MultiPhase) => {
    multiPhaseRef.current = phase;
    setMultiPhase(phase);
  }, []);

  const updateMultiSources = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const value = typeof next === "function" ? next(multiSourcesRef.current) : next;
    multiSourcesRef.current = value;
    setMultiSources(value);
  }, []);

  const updateMultiTargets = useCallback((next: string[] | ((current: string[]) => string[])) => {
    const value = typeof next === "function" ? next(multiTargetsRef.current) : next;
    multiTargetsRef.current = value;
    setMultiTargets(value);
  }, []);

  const updateMultiKeyHeld = useCallback((held: boolean) => {
    multiKeyHeldRef.current = held;
  }, []);

  const loadDebugScenario = useCallback((scenario: DebugScenario) => {
    pendingDebugScenarioRef.current = scenario;
    bridgeRef.current?.send({ type: "debug-scenario", scenario });
    const focus = () => {
      const current = latestStateRef.current;
      const renderer = rendererRef.current;
      if (!current || !renderer) return;
      const tileId = debugScenarioFocusTile(current, scenario);
      if (tileId) renderer.focusOn(tileId, scenario === "structures" ? 1.05 : 0.9);
    };
    window.setTimeout(focus, 180);
    window.setTimeout(focus, 650);
  }, []);

  useEffect(() => {
    const savedName = localStorage.getItem("hex-dominion-player");
    const sound = localStorage.getItem("hex-dominion-sound");
    const graphics = localStorage.getItem("hex-dominion-graphics") as GraphicsQuality | null;
    setConfig((current) => ({
      ...current,
      playerName: savedName || current.playerName,
      sound: sound === null ? current.sound : sound === "true",
      graphics: graphics ?? current.graphics,
      debug:
        process.env.NODE_ENV !== "production" && new URLSearchParams(location.search).has("debug"),
    }));
    setHasSave(Boolean(localStorage.getItem(LOCAL_SAVE_KEY)));
  }, []);

  useEffect(() => {
    latestStateRef.current = state;
    if (!state) return;
    rendererRef.current?.setState(state);
    const pendingScenario = pendingDebugScenarioRef.current;
    if (pendingScenario && rendererRef.current) {
      const focusTile = debugScenarioFocusTile(state, pendingScenario);
      if (focusTile)
        rendererRef.current.focusOn(focusTile, pendingScenario === "structures" ? 1.05 : 0.9);
      pendingDebugScenarioRef.current = null;
    }
    audioRef.current?.consume(state.events, state, state.config.localPlayerId ?? 0);
    if (
      !state.config.multiplayer &&
      state.tick > 0 &&
      state.tick % BALANCE.autosaveTicks === 0 &&
      state.tick !== lastAutosaveTickRef.current &&
      state.victory.winnerId === null
    ) {
      lastAutosaveTickRef.current = state.tick;
      bridgeRef.current?.send({ type: "snapshot" });
    }
    if (typeof window !== "undefined" && state.config.debug) {
      const placementSignature = placementPresentationSignature(
        state,
        state.config.localPlayerId ?? 0,
      );
      if (debugPlacementCandidatesRef.current?.signature !== placementSignature) {
        const candidates = eligibleSpawnCenters(state.map);
        debugPlacementCandidatesRef.current = {
          signature: placementSignature,
          candidates,
          selectableCandidates:
            state.phase === "placement"
              ? candidates.filter(
                  (centerId) =>
                    validateSpawnChoicePreview(state, state.config.localPlayerId ?? 0, centerId).ok,
                )
              : [],
        };
      }
      const placementCandidates = debugPlacementCandidatesRef.current;
      let recommendedPlacementCenter: string | null = null;
      if (state.phase === "placement") {
        const recommendationKey = `${state.map.seed}:${state.map.archetype}:${state.map.generationAttempt}:${state.players
          .map(
            (player) =>
              `${player.id}:${player.isHuman ? (state.placement.placements[player.id]?.centerId ?? "") : "ai"}`,
          )
          .join("|")}`;
        if (recommendedPlacementRef.current?.key !== recommendationKey) {
          try {
            recommendedPlacementRef.current = {
              key: recommendationKey,
              centerId: computeFinalSpawnVector(state)[state.config.localPlayerId ?? 0] ?? null,
            };
          } catch {
            recommendedPlacementRef.current = { key: recommendationKey, centerId: null };
          }
        }
        recommendedPlacementCenter = recommendedPlacementRef.current.centerId;
      }
      (window as Window & { __HEX_DOMINION__?: unknown }).__HEX_DOMINION__ = Object.freeze({
        tick: state.tick,
        phase: state.phase,
        placement: {
          ...state.placement,
          candidates: placementCandidates.candidates,
          recommendedPlacementCenter,
          selectableCandidates: placementCandidates.selectableCandidates,
        },
        config: state.config,
        map: {
          landCount: state.map.landCount,
          archetype: state.map.archetype,
          seed: state.map.seed,
          spawnClusters: state.map.spawnClusters,
          tiles: state.map.landIds.map((id) => {
            const tile = state.map.tiles[id]!;
            return {
              id,
              q: tile.q,
              r: tile.r,
              owner: tile.owner,
              units: tile.units,
              troops: totalUnits(tile.units),
              terrain: tile.terrain,
              structure: tile.structure,
            };
          }),
        },
        players: state.players.map((player) => ({
          id: player.id,
          name: player.name,
          isHuman: player.isHuman,
          tiles: player.tileCount,
          eliminated: player.eliminated,
          eliminatedBy: player.eliminatedBy,
          supplyMilli: player.supplyMilli,
          supplyEarnedMilli: player.stats.supplyEarnedMilli,
          troopsTrained: player.stats.troopsTrained,
          enemiesEliminated: player.stats.enemiesEliminated,
        })),
        events: state.events.map(({ id, type, playerId, tileId, amount, message }) => ({
          id,
          type,
          playerId,
          tileId,
          amount,
          message,
        })),
        paused: state.paused,
        selectedTile: selectedId,
        stacks: state.stacks.map((stack) => ({
          id: stack.id,
          units: stack.units,
          troops: totalUnits(stack.units),
          owner: stack.owner,
          path: stack.path,
          pathIndex: stack.pathIndex,
          segmentProgress: stack.segmentProgress,
          segmentDuration: stack.segmentDuration,
        })),
        battles: state.battles.map((battle) => ({
          id: battle.id,
          tileId: battle.tileId,
          incumbentOwner: battle.incumbentOwner,
          participants: battle.participants.map((participant) => ({
            ...participant,
            troops: totalUnits(participant.units),
          })),
          actualControl: battle.participants.find(
            (participant) => participant.playerId !== battle.incumbentOwner,
          )?.control,
          attacker: battle.participants.find(
            (participant) => participant.playerId !== battle.incumbentOwner,
          )?.units
            ? totalUnits(
                battle.participants.find(
                  (participant) => participant.playerId !== battle.incumbentOwner,
                )!.units,
              )
            : 0,
          defender: battle.participants.find(
            (participant) => participant.playerId === battle.incumbentOwner,
          )?.units
            ? totalUnits(
                battle.participants.find(
                  (participant) => participant.playerId === battle.incumbentOwner,
                )!.units,
              )
            : 0,
        })),
        enclosures: state.enclosures,
        multi: {
          phase: multiPhase,
          sourceIds: multiSources,
          destinationIds: multiTargets,
        },
        stateHash: state.stateHash,
        winner: state.victory.winnerId,
        selectTile: (tileId: string) => handleTileClickRef.current(tileId),
        hoverTile: (tileId: string | null) => handleTileHoverRef.current(tileId),
        cancelSelection: () => cancelSelectionRef.current(),
        fitOverview: () => rendererRef.current?.fitMap(),
        setTransientCapture: (active: boolean) => rendererRef.current?.setCaptureMode(active),
        captureFrame: () => rendererRef.current?.captureFrameDataUrl() ?? Promise.resolve(""),
        getPresentation: () =>
          rendererRef.current?.inspectPresentation() ?? {
            stacks: [],
            battles: [],
            captures: [],
            focusTileId: null,
            keyboardTileId: null,
            visibleObjects: 0,
          },
        getTileClientPoint: (tileId: string) => rendererRef.current?.clientPointFor(tileId) ?? null,
        inspectStateAt: (tick: number) => debugStateHistoryRef.current.get(tick) ?? null,
        loadScenario: (scenario: DebugScenario) => {
          loadDebugScenario(scenario);
        },
      });
    } else if (typeof window !== "undefined") {
      delete (window as Window & { __HEX_DOMINION__?: unknown }).__HEX_DOMINION__;
    }
  }, [state, selectedId, loadDebugScenario, multiPhase, multiSources, multiTargets]);

  useEffect(() => {
    if (state?.phase !== "placement" || placementDeadlineAt === null) return;
    setPlacementNow(Date.now());
    const timer = window.setInterval(() => setPlacementNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [state?.phase, placementDeadlineAt]);

  useEffect(() => {
    if (
      !state?.config.multiplayer ||
      state.phase !== "placement" ||
      !roomClientRef.current ||
      !roomIdentityRef.current?.player.isHost ||
      publishedCandidateHashRef.current !== null
    ) {
      return;
    }
    const candidates = eligibleSpawnCenters(state.map);
    const candidateHash = stableHash({
      generationAttempt: state.map.generationAttempt,
      candidates,
    });
    try {
      roomClientRef.current.publishPlacementCandidates(
        state.map.generationAttempt,
        candidateHash,
        candidates,
      );
      publishedCandidateHashRef.current = candidateHash;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not publish placement candidates.",
      );
    }
  }, [state]);

  useEffect(() => {
    if (!state || state.phase !== "placement" || !roomPlacement) return;
    for (const selection of roomPlacement.selections) {
      const local = state.placement.placements[selection.seat];
      if (!local || !state.players[selection.seat]?.isHuman) continue;
      const syncKey = `${selection.centerId ?? ""}:${selection.locked ? 1 : 0}`;
      if (placementSyncSentRef.current.get(selection.seat) === syncKey) continue;
      if (selection.centerId && local.centerId !== selection.centerId && !local.locked) {
        bridgeRef.current?.send({
          type: "command",
          command: {
            type: "choose-spawn",
            playerId: selection.seat,
            centerId: selection.centerId,
          },
        });
        placementSyncSentRef.current.set(selection.seat, `${syncKey}:choose`);
        continue;
      }
      if (selection.locked && !local.locked && local.centerId === selection.centerId) {
        bridgeRef.current?.send({
          type: "command",
          command: { type: "lock-spawn", playerId: selection.seat },
        });
        placementSyncSentRef.current.set(selection.seat, `${syncKey}:lock`);
        continue;
      }
      placementSyncSentRef.current.set(selection.seat, syncKey);
    }

    const synchronized = roomPlacement.selections.every((selection) => {
      const local = state.placement.placements[selection.seat];
      return local?.centerId === selection.centerId && (!selection.locked || local.locked);
    });
    const timedOut = Date.now() >= roomPlacement.deadlineAt;
    const humansLocked = roomPlacement.selections.every((selection) => selection.locked);
    if (
      synchronized &&
      (humansLocked || timedOut) &&
      roomPlacement.generationAttempt !== null &&
      roomPlacement.candidateHash &&
      roomClientRef.current
    ) {
      try {
        const centers = computeFinalSpawnVector(state);
        const key = centers.join("|");
        if (key !== publishedFinalVectorRef.current) {
          roomClientRef.current.finalizePlacement(
            roomPlacement.generationAttempt,
            roomPlacement.candidateHash,
            centers,
          );
          publishedFinalVectorRef.current = key;
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not finalize starting centers.");
      }
    }
  }, [roomPlacement, state]);

  useEffect(() => {
    const openingState = latestStateRef.current;
    if (!openingState || openingState.phase !== "opening" || openingPhaseHandledRef.current) return;
    openingPhaseHandledRef.current = true;
    const localCenter =
      openingState.config.startingCenters?.[openingState.config.localPlayerId ?? 0];
    if (localCenter) rendererRef.current?.focusOn(localCenter, 0.88);
    const relayStartAt = pendingStartedRef.current?.startedAt;
    const delay = relayStartAt === undefined ? 1_000 : Math.max(0, relayStartAt - Date.now());
    openingTimerRef.current = window.setTimeout(() => {
      bridgeRef.current?.send({ type: "begin-match" });
      if (relayStartAt !== undefined) {
        const targetTick = Math.max(0, Math.floor(((Date.now() - relayStartAt) * 10) / 1000));
        if (targetTick > 0) bridgeRef.current?.send({ type: "catch-up", targetTick });
      }
      openingTimerRef.current = null;
    }, delay);
    return () => {
      if (openingTimerRef.current !== null) window.clearTimeout(openingTimerRef.current);
      openingTimerRef.current = null;
    };
  }, [state?.phase]);

  useEffect(() => {
    if (screen !== "match" || !hostRef.current || rendererRef.current) return;
    let cancelled = false;
    setRendererStatus("ready");
    void (async () => {
      const { GameRenderer } = await import("./render/GameRenderer");
      if (cancelled || !hostRef.current) return;
      const renderer = new GameRenderer(
        hostRef.current,
        {
          quality: config.graphics,
          colorPatterns: config.colorPatterns,
          fullCounts: config.fullCounts ?? false,
          localPlayerId: config.localPlayerId ?? 0,
        },
        {
          onTileClick: (tileId) => handleTileClickRef.current(tileId),
          onTileDrag: (tileId, phase) => handleTileDragRef.current(tileId, phase),
          onTileHover: (tileId) => handleTileHoverRef.current(tileId),
          getMultiSelectionPhase: () => {
            const phase = multiPhaseRef.current;
            return phase === "idle" ? null : phase;
          },
          onMultiGestureState: (active) => {
            multiPointerGestureRef.current = active;
            if (!active && deferredMultiKeyReleaseRef.current) {
              deferredMultiKeyReleaseRef.current = false;
              window.setTimeout(() => completeMultiKeyReleaseRef.current(), 0);
            }
          },
          onCancel: () => cancelSelectionRef.current(),
          onContextStatus: setRendererStatus,
        },
      );
      await renderer.init();
      rendererRef.current = renderer;
      if (latestStateRef.current) renderer.setState(latestStateRef.current);
    })().catch((reason: unknown) =>
      setError(
        reason instanceof Error ? reason.message : "The battlefield renderer failed to load.",
      ),
    );
    return () => {
      cancelled = true;
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, [screen, config.graphics, config.colorPatterns, config.fullCounts, config.localPlayerId]);

  useEffect(() => {
    if (rendererStatus !== "restored") return;
    const timer = window.setTimeout(() => setRendererStatus("ready"), 2_800);
    return () => window.clearTimeout(timer);
  }, [rendererStatus]);

  useEffect(() => {
    rendererRef.current?.setSelected(selectedId);
  }, [selectedId]);

  useEffect(() => {
    rendererRef.current?.setBuildMode(buildMode);
  }, [buildMode]);

  useEffect(() => {
    const selected = selectedId ? state?.map.tiles[selectedId] : undefined;
    if (
      !state ||
      !selectedId ||
      !hoveredId ||
      selected?.owner !== (state.config.localPlayerId ?? 0) ||
      totalUnits(selected.units) <= 1
    ) {
      rendererRef.current?.setRoutePreview(null);
      return;
    }
    const path = findPath(state.map, selectedId, hoveredId, state.config.localPlayerId ?? 0, true);
    rendererRef.current?.setRoutePreview(path ?? [selectedId, hoveredId], Boolean(path));
  }, [state, selectedId, hoveredId]);

  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let frame = 0;
    const loop = (now: number) => {
      const stamp = Number.isFinite(now) ? now : performance.now();
      frames += 1;
      if (stamp - last >= 1000) {
        const measured = Math.round((frames * 1000) / Math.max(1, stamp - last));
        setPerf((current) => ({ ...current, fps: Number.isFinite(measured) ? measured : 0 }));
        frames = 0;
        last = stamp;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const startGame = useCallback(
    (nextConfig: MatchConfig, snapshot?: EngineSnapshot) => {
      bridgeRef.current?.destroy();
      audioRef.current?.destroy();
      setConfig(nextConfig);
      setError(null);
      setState(null);
      setSelectedId(null);
      setBuildMode(null);
      setRallySourceId(null);
      updateMultiPhase("idle");
      updateMultiSources([]);
      updateMultiTargets([]);
      updateMultiKeyHeld(false);
      publishedCandidateHashRef.current = null;
      publishedFinalVectorRef.current = null;
      placementSyncSentRef.current.clear();
      workerRelaySequenceRef.current = 0;
      if (!nextConfig.multiplayer) {
        pendingStartedRef.current = null;
        roomPlacementRef.current = null;
        setRoomPlacement(null);
        setPlacementDeadlineAt(null);
      }
      openingPhaseHandledRef.current = false;
      if (openingTimerRef.current !== null) window.clearTimeout(openingTimerRef.current);
      openingTimerRef.current = null;
      debugStateHistoryRef.current.clear();
      setLoading(true);
      setScreen("match");
      localStorage.setItem("hex-dominion-player", nextConfig.playerName);
      localStorage.setItem("hex-dominion-sound", String(nextConfig.sound));
      localStorage.setItem("hex-dominion-graphics", nextConfig.graphics);
      audioRef.current = new AudioDirector(nextConfig.sound);
      const bridge = new SimulationBridge(
        (message) => {
          if (message.type === "ready" || message.type === "state") {
            if (message.relaySequence !== undefined) {
              workerRelaySequenceRef.current = message.relaySequence;
            }
            if (message.state.config.debug) {
              debugStateHistoryRef.current.set(message.state.tick, message.state);
              const oldestTick = message.state.tick - 40;
              for (const tick of debugStateHistoryRef.current.keys()) {
                if (tick < oldestTick) debugStateHistoryRef.current.delete(tick);
              }
            }
            setState(message.state);
            setLoading(false);
            if (message.type === "state")
              setPerf((current) => ({
                ...current,
                simulationMs: message.simulationMs,
                aiMs: message.aiMs,
              }));
          } else if (message.type === "snapshot") {
            if (!nextConfig.multiplayer) {
              try {
                localStorage.setItem(LOCAL_SAVE_KEY, JSON.stringify(message.snapshot));
                setHasSave(true);
              } catch {
                // The game continues even if browser storage is unavailable.
              }
            } else {
              const pending = pendingCheckpointRef.current;
              const identity = roomIdentityRef.current;
              const checkpointSequence = message.relaySequence;
              if (
                !pending ||
                !identity?.player.isHost ||
                !roomClientRef.current ||
                checkpointSequence === undefined
              ) {
                pendingCheckpointRef.current = null;
                return;
              }
              const checkpointSnapshot: EngineSnapshot = {
                ...message.snapshot,
                // Commands after the applied sequence remain in the relay log.
                pendingCommands: [],
              };
              void encodeCheckpoint(checkpointSnapshot)
                .then(({ encoding, payload }) => {
                  roomClientRef.current?.publishCheckpoint({
                    tick: message.snapshot.state.tick,
                    sequence: checkpointSequence,
                    hash: message.snapshot.state.stateHash,
                    encoding,
                    payload,
                  });
                })
                .catch(() => {
                  // Reconnect will request a prior checkpoint plus the retained log.
                })
                .finally(() => {
                  pendingCheckpointRef.current = null;
                });
            }
          } else if (message.type === "error") {
            setError(message.message);
            setLoading(false);
          }
        },
        (message) => {
          setError(`The deterministic simulation stopped: ${message}`);
          setLoading(false);
        },
      );
      bridgeRef.current = bridge;
      bridge.start(nextConfig, snapshot);
    },
    [updateMultiKeyHeld, updateMultiPhase, updateMultiSources, updateMultiTargets],
  );

  const dispatchCommand = useCallback(
    (command: GameCommand) => {
      const localPlayerId = config.localPlayerId ?? 0;
      const ownedCommand = { ...command, playerId: localPlayerId } as GameCommand;
      if (config.multiplayer && roomClientRef.current) {
        try {
          roomClientRef.current.sendCommand(ownedCommand);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "The room relay rejected the order.");
        }
        return;
      }
      bridgeRef.current?.send({ type: "command", command: ownedCommand });
    },
    [config.localPlayerId, config.multiplayer],
  );

  const connectRoom = useCallback(
    async (reconnect = false) => {
      const connectionGeneration = ++roomConnectionGenerationRef.current;
      setRoomBusy(true);
      setMultiplayer((current) => ({ ...current, status: "Contacting the room relay…" }));
      try {
        roomClientRef.current?.close();
        const { MultiplayerClient } = await import("@/src/edge/client");
        const edgeUrl = process.env.NEXT_PUBLIC_MULTIPLAYER_URL || "http://127.0.0.1:8787";
        const client = new MultiplayerClient({ edgeUrl, autoReconnect: true });
        const identity =
          multiplayer.action === "create"
            ? await client.createRoom({
                playerName: config.playerName.trim(),
                config: {
                  seed: config.seed.trim(),
                  archetype: config.archetype,
                  difficulty: config.difficulty,
                  botCount: multiplayerBotCount,
                  maxHumans: Math.min(8, 21 - multiplayerBotCount),
                },
              })
            : reconnect
              ? await client.reconnectRoom(multiplayer.roomCode, config.playerName.trim())
              : await client.joinRoom(multiplayer.roomCode, {
                  playerName: config.playerName.trim(),
                });

        roomClientRef.current = client;
        client.onMessage((message: ServerMessage) => {
          if (message.type === "lobby") {
            setRoomPlayers(message.players);
            const ownPlayer = message.players.find((player) => player.id === identity.player.id);
            if (ownPlayer) {
              const nextIdentity: RoomIdentity = {
                ...(roomIdentityRef.current ?? identity),
                phase: message.phase,
                player: ownPlayer,
              };
              roomIdentityRef.current = nextIdentity;
              setRoomIdentity(nextIdentity);
              setRoomReady(ownPlayer.ready);
            }
            if (message.phase === "lobby") {
              if (latestStateRef.current?.phase === "placement") {
                bridgeRef.current?.destroy();
                bridgeRef.current = null;
                setState(null);
                setRoomPlacement(null);
                roomPlacementRef.current = null;
                setPlacementDeadlineAt(null);
                setScreen("menu");
                setTab("multiplayer");
              }
              setMultiplayer((current) => ({
                ...current,
                status: "The room is open. Ready your banner when everyone has joined.",
              }));
            }
          } else if (message.type === "placement") {
            roomPlacementRef.current = message;
            setRoomPlacement(message);
            setRoomPlayers(message.players);
            setPlacementDeadlineAt(message.deadlineAt);
            const ownPlayer = message.players.find((player) => player.id === identity.player.id);
            if (ownPlayer) {
              const nextIdentity: RoomIdentity = {
                ...(roomIdentityRef.current ?? identity),
                phase: "placement",
                player: ownPlayer,
              };
              roomIdentityRef.current = nextIdentity;
              setRoomIdentity(nextIdentity);
            }
            const playerNames: string[] = [];
            for (const player of message.players) playerNames[player.seat] = player.name;
            const currentSeat = ownPlayer?.seat ?? identity.player.seat;
            const current = latestStateRef.current;
            if (
              !current?.config.multiplayer ||
              current.map.seed !== message.config.seed ||
              current.map.archetype !== message.config.archetype
            ) {
              publishedCandidateHashRef.current = null;
              publishedFinalVectorRef.current = null;
              pendingStartedRef.current = null;
              appliedRoomSequencesRef.current.clear();
              roomCommandTargetsRef.current.clear();
              roomAppliedSequenceRef.current = 0;
              roomCompletionSentRef.current = false;
              startGame({
                ...config,
                seed: message.config.seed,
                archetype: message.config.archetype,
                difficulty: message.config.difficulty,
                aiCount: message.config.botCount,
                multiplayer: true,
                humanSeats: message.players.map((player) => player.seat),
                playerNames,
                localPlayerId: currentSeat,
              });
            }
            // Initial joins and placement reconnects both start a fresh local
            // Worker at elapsed tick zero. Catch it up to the relay epoch so
            // deterministic bot choreography never visibly replays.
            bridgeRef.current?.send({
              type: "catch-up",
              targetTick: placementCatchUpTick(message.startedAt),
            });
            setMultiplayer((currentStatus) => ({
              ...currentStatus,
              status: "Choose and lock a starting center.",
            }));
          } else if (message.type === "started") {
            pendingStartedRef.current = message;
            const playerNames: string[] = [];
            for (const player of message.players) playerNames[player.seat] = player.name;
            const currentSeat =
              message.players.find((player) => player.id === identity.player.id)?.seat ??
              identity.player.seat;
            // The relay's immutable final vector is the handoff contract. A
            // fresh opening engine avoids racing the last placement broadcast
            // against a one-shot finalize message on this client's old Worker.
            appliedRoomSequencesRef.current.clear();
            roomCommandTargetsRef.current.clear();
            roomAppliedSequenceRef.current = 0;
            roomCompletionSentRef.current = false;
            startGame({
              ...config,
              seed: message.config.seed,
              archetype: message.config.archetype,
              difficulty: message.config.difficulty,
              aiCount: message.config.botCount,
              multiplayer: true,
              humanSeats: message.players.map((player) => player.seat),
              playerNames,
              localPlayerId: currentSeat,
              startingCenters: message.spawnCenters,
            });
            roomPlacementRef.current = null;
            setRoomPlacement(null);
            setPlacementDeadlineAt(null);
          } else if (message.type === "command-batch" || message.type === "sync") {
            void roomMessageQueueRef.current
              .enqueue(async () => {
                if (connectionGeneration !== roomConnectionGenerationRef.current) return;
                if (message.type === "sync" && message.checkpoint) {
                  try {
                    const decoded = await decodeCheckpointPayload(
                      message.checkpoint.encoding,
                      message.checkpoint.payload,
                    );
                    if (connectionGeneration !== roomConnectionGenerationRef.current) return;
                    const checkpoint = parseEngineSnapshot(decoded);
                    const current = latestStateRef.current;
                    const localConfig = current?.config ?? config;
                    const localizedCheckpoint = localizeCheckpointForRecipient(
                      checkpoint,
                      roomIdentityRef.current?.player.seat ?? identity.player.seat,
                      localConfig,
                    );
                    // A sync checkpoint is a canonical repair base, even when
                    // this client has speculatively advanced beyond its tick.
                    bridgeRef.current?.send({
                      type: "restore",
                      snapshot: localizedCheckpoint,
                      relaySequence: message.checkpoint.sequence,
                    });
                    workerRelaySequenceRef.current = message.checkpoint.sequence;
                    appliedRoomSequencesRef.current.clear();
                    roomCommandTargetsRef.current.clear();
                    roomAppliedSequenceRef.current = message.checkpoint.sequence;
                  } catch {
                    setError(
                      "The reconnect checkpoint was invalid. Requesting the command log instead.",
                    );
                  }
                }
                if (connectionGeneration !== roomConnectionGenerationRef.current) return;
                for (const ordered of message.commands) {
                  if (ordered.sequence <= roomAppliedSequenceRef.current) continue;
                  if (appliedRoomSequencesRef.current.has(ordered.sequence)) continue;
                  appliedRoomSequencesRef.current.add(ordered.sequence);
                  roomCommandTargetsRef.current.set(ordered.sequence, ordered.targetTick);
                  bridgeRef.current?.send({
                    type: "command",
                    command: { ...ordered.command, scheduledTick: ordered.targetTick },
                    relaySequence: ordered.sequence,
                  });
                }
                if (message.hasMore) {
                  const lastInPage =
                    message.commands.at(-1)?.sequence ??
                    Math.max(0, ...appliedRoomSequencesRef.current);
                  client.requestMissing(lastInPage);
                } else {
                  bridgeRef.current?.send({ type: "catch-up", targetTick: message.serverTick });
                }
              })
              .catch((reason: unknown) => {
                if (connectionGeneration !== roomConnectionGenerationRef.current) return;
                setError(
                  reason instanceof Error
                    ? `Room synchronization failed: ${reason.message}`
                    : "Room synchronization failed while ordering relay messages.",
                );
              });
          } else if (message.type === "desync") {
            setError(`Synchronization warning at tick ${message.tick}: ${message.message}`);
          } else if (message.type === "complete") {
            roomCompletionSentRef.current = true;
            bridgeRef.current?.send({ type: "catch-up", targetTick: message.finalTick });
            setMultiplayer((current) => ({
              ...current,
              status: "The room has recorded the final deterministic result.",
            }));
          } else if (message.type === "error") {
            setError(message.message);
          }
        });
        await client.connect(identity);
        roomIdentityRef.current = roomIdentityRef.current ?? identity;
        setRoomIdentity(roomIdentityRef.current);
        setRoomPlayers([identity.player]);
        setRoomReady(identity.player.ready);
        setMultiplayer((current) => ({
          ...current,
          roomCode: identity.roomCode,
          status: identity.reconnected ? "Reconnected to the room." : "Room relay connected.",
        }));
      } catch (reason) {
        setMultiplayer((current) => ({
          ...current,
          status: reason instanceof Error ? reason.message : "The multiplayer room is unavailable.",
        }));
      } finally {
        setRoomBusy(false);
      }
    },
    [config, multiplayer.action, multiplayer.roomCode, multiplayerBotCount, startGame],
  );

  const toggleRoomReady = useCallback(() => {
    const next = !roomReady;
    try {
      roomClientRef.current?.setReady(next);
      setRoomReady(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the ready state.");
    }
  }, [roomReady]);

  const startRoomMatch = useCallback(() => {
    try {
      roomClientRef.current?.start();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The room could not start.");
    }
  }, []);

  const leaveMatch = useCallback(() => {
    roomConnectionGenerationRef.current += 1;
    bridgeRef.current?.destroy();
    bridgeRef.current = null;
    audioRef.current?.destroy();
    audioRef.current = null;
    if (roomClientRef.current) {
      try {
        roomClientRef.current.leave();
      } catch {
        roomClientRef.current.close();
      }
      roomClientRef.current = null;
    }
    setRoomIdentity(null);
    roomIdentityRef.current = null;
    setRoomPlayers([]);
    setRoomReady(false);
    setRoomPlacement(null);
    setPlacementDeadlineAt(null);
    setState(null);
    setScreen("menu");
    setLoading(false);
    setError(null);
    roomAppliedSequenceRef.current = 0;
    roomCommandTargetsRef.current.clear();
    appliedRoomSequencesRef.current.clear();
    pendingCheckpointRef.current = null;
    workerRelaySequenceRef.current = 0;
    roomCompletionSentRef.current = false;
    roomPlacementRef.current = null;
    pendingStartedRef.current = null;
    publishedCandidateHashRef.current = null;
    publishedFinalVectorRef.current = null;
    openingPhaseHandledRef.current = false;
    if (openingTimerRef.current !== null) window.clearTimeout(openingTimerRef.current);
    openingTimerRef.current = null;
  }, []);

  useEffect(
    () => () => {
      roomConnectionGenerationRef.current += 1;
      roomClientRef.current?.close();
      bridgeRef.current?.destroy();
      audioRef.current?.destroy();
    },
    [],
  );

  useEffect(() => {
    if (!config.multiplayer || !state || state.tick === 0) return;
    let nextApplied = roomAppliedSequenceRef.current + 1;
    while (
      (roomCommandTargetsRef.current.get(nextApplied) ?? Number.POSITIVE_INFINITY) <= state.tick
    ) {
      roomCommandTargetsRef.current.delete(nextApplied);
      roomAppliedSequenceRef.current = nextApplied;
      nextApplied += 1;
    }
    try {
      if (state.tick % 50 === 0) {
        roomClientRef.current?.sendHash(
          state.tick,
          workerRelaySequenceRef.current,
          state.stateHash,
        );
      }
      if (
        roomIdentity?.player.isHost &&
        state.tick % 300 === 0 &&
        state.tick !== lastCheckpointTickRef.current &&
        !pendingCheckpointRef.current
      ) {
        lastCheckpointTickRef.current = state.tick;
        pendingCheckpointRef.current = {
          requestedTick: state.tick,
        };
        bridgeRef.current?.send({ type: "snapshot" });
      }
      if (
        roomIdentity?.player.isHost &&
        state.victory.winnerId !== null &&
        !roomCompletionSentRef.current
      ) {
        roomClientRef.current?.complete(state.victory.winnerId, state.tick, state.stateHash);
        roomCompletionSentRef.current = true;
      }
    } catch {
      // Automatic reconnect and the next hash interval handle transient disconnects.
    }
  }, [config.multiplayer, roomIdentity, state]);

  const resumeGame = useCallback(() => {
    try {
      const snapshot = readLocalSnapshot(localStorage);
      if (!snapshot) return;
      startGame(snapshot.state.config, snapshot);
    } catch (reason) {
      setHasSave(false);
      setError(
        reason instanceof Error ? reason.message : "The local save is corrupt and was removed.",
      );
    }
  }, [startGame]);

  const cancelMulti = useCallback(() => {
    deferredMultiKeyReleaseRef.current = false;
    updateMultiPhase("idle");
    updateMultiSources([]);
    updateMultiTargets([]);
    updateMultiKeyHeld(false);
    rendererRef.current?.setMultiPreview(null);
  }, [updateMultiKeyHeld, updateMultiPhase, updateMultiSources, updateMultiTargets]);

  const cancelSelection = useCallback(() => {
    setSelectedId(null);
    setHoveredId(null);
    setBuildMode(null);
    setRallySourceId(null);
    cancelMulti();
    rendererRef.current?.setRoutePreview(null);
  }, [cancelMulti]);

  const beginMulti = useCallback(() => {
    if (latestStateRef.current?.phase !== "running") return;
    setSelectedId(null);
    setBuildMode(null);
    setRallySourceId(null);
    updateMultiSources([]);
    updateMultiTargets([]);
    updateMultiPhase("sources");
  }, [updateMultiPhase, updateMultiSources, updateMultiTargets]);

  const sendMultiMove = useCallback(
    (targets = multiTargetsRef.current) => {
      const current = latestStateRef.current;
      const sources = multiSourcesRef.current;
      if (!current || current.phase !== "running" || sources.length === 0 || targets.length === 0)
        return;
      const plan = planMultiMove(
        current,
        current.config.localPlayerId ?? 0,
        sources,
        targets,
        sendPercent,
      );
      if (!plan.ok) {
        setError(plan.reason ?? "The aggregate move is not feasible.");
        window.setTimeout(() => setError(null), 2_200);
        return;
      }
      dispatchCommand({
        type: "multi-move",
        playerId: current.config.localPlayerId ?? 0,
        sourceIds: sources,
        destinationIds: targets,
        percent: sendPercent,
      });
      cancelMulti();
    },
    [cancelMulti, dispatchCommand, sendPercent],
  );

  const handleTileHover = useCallback((tileId: string | null) => setHoveredId(tileId), []);

  const handleTileDrag = useCallback(
    (tileId: string, phase: Exclude<MultiPhase, "idle">) => {
      const current = latestStateRef.current;
      if (!current || current.phase !== "running" || multiPhaseRef.current !== phase) return;
      const tile = current.map.tiles[tileId];
      if (!tile || tile.terrain === "water") return;
      const localPlayerId = current.config.localPlayerId ?? 0;
      if (phase === "sources") {
        if (tile.owner !== localPlayerId || totalUnits(tile.units) <= 1) return;
        updateMultiSources((sources) =>
          sources.includes(tileId) ? sources : [...sources, tileId],
        );
        return;
      }
      updateMultiSources((sources) => sources.filter((sourceId) => sourceId !== tileId));
      updateMultiTargets((targets) => (targets.includes(tileId) ? targets : [...targets, tileId]));
    },
    [updateMultiSources, updateMultiTargets],
  );

  const handleTileClick = useCallback(
    (tileId: string | null) => {
      const current = latestStateRef.current;
      audioRef.current?.unlock();
      if (!current || !tileId) {
        cancelSelection();
        return;
      }
      const tile = current.map.tiles[tileId];
      if (!tile) return;
      const localPlayerId = current.config.localPlayerId ?? 0;
      if (current.phase === "placement") {
        const placement = current.placement.placements[localPlayerId];
        if (placement?.locked) return;
        const placementChoice = validateSpawnChoice(current, localPlayerId, tileId);
        if (!placementChoice.ok) {
          setError(
            placementChoice.reason ?? "Choose a land center with a safe seven-hex starting area.",
          );
          window.setTimeout(() => setError(null), 1_800);
          return;
        }
        if (current.config.multiplayer) {
          try {
            roomClientRef.current?.claimPlacement(tileId);
          } catch (reason) {
            setError(
              reason instanceof Error ? reason.message : "Could not claim that starting area.",
            );
          }
          // The relay broadcast is the placement authority. Applying the
          // provisional choice locally before its acknowledgement would leave
          // an irreversibly divergent claim when the relay rejects a conflict.
          return;
        }
        bridgeRef.current?.send({
          type: "command",
          command: { type: "choose-spawn", playerId: localPlayerId, centerId: tileId },
        });
        return;
      }
      if (current.phase !== "running") return;
      const activeMultiPhase = multiPhaseRef.current;
      if (rallySourceId) {
        const path = findPath(current.map, rallySourceId, tileId, localPlayerId, true);
        if (!path || path.length < 2) {
          setError("That rally destination is currently unreachable.");
          window.setTimeout(() => setError(null), 1_800);
          return;
        }
        dispatchCommand({
          type: "set-rally",
          playerId: localPlayerId,
          tileId: rallySourceId,
          destinationId: tileId,
        });
        setRallySourceId(null);
        return;
      }
      if (activeMultiPhase === "sources") {
        if (tile.owner !== localPlayerId || totalUnits(tile.units) <= 1) return;
        updateMultiSources((sources) =>
          sources.includes(tileId)
            ? sources.filter((sourceId) => sourceId !== tileId)
            : [...sources, tileId],
        );
        return;
      }
      if (activeMultiPhase === "targets") {
        const currentSources = multiSourcesRef.current;
        const nextSources = currentSources.filter((sourceId) => sourceId !== tileId);
        if (nextSources.length !== currentSources.length) updateMultiSources(nextSources);
        if (multiKeyHeldRef.current) {
          updateMultiTargets((targets) =>
            targets.includes(tileId)
              ? targets.filter((destinationId) => destinationId !== tileId)
              : [...targets, tileId],
          );
        } else {
          sendMultiMove([tileId]);
        }
        return;
      }
      if (buildMode) {
        const reason = structureReason(tile, buildMode, localPlayerId, current);
        if (reason) {
          setError(reason);
          window.setTimeout(() => setError(null), 1800);
          return;
        }
        dispatchCommand({
          type: "build",
          playerId: localPlayerId,
          tileId,
          structure: buildMode,
        });
        setBuildMode(null);
        return;
      }
      if (selectedId) {
        if (selectedId === tileId) {
          setSelectedId(null);
          return;
        }
        const selectedSource = current.map.tiles[selectedId];
        if (selectedSource?.owner !== localPlayerId || totalUnits(selectedSource.units) <= 1) {
          setSelectedId(tileId);
          return;
        }
        const path = findPath(current.map, selectedId, tileId, localPlayerId, true);
        if (!path) {
          setError(
            "No legal route. Armies may cross friendly territory and take one final hostile step.",
          );
          window.setTimeout(() => setError(null), 2200);
          return;
        }
        const command: GameCommand = {
          type: "move",
          playerId: localPlayerId,
          sourceId: selectedId,
          destinationId: tileId,
          percent: sendPercent,
        };
        dispatchCommand(command);
        setSelectedId(null);
        rendererRef.current?.setRoutePreview(null);
        return;
      }
      setSelectedId(tileId);
      if (tile.owner === localPlayerId && totalUnits(tile.units) > 1)
        audioRef.current?.playSelection();
    },
    [
      buildMode,
      selectedId,
      sendPercent,
      rallySourceId,
      cancelSelection,
      dispatchCommand,
      sendMultiMove,
      updateMultiSources,
      updateMultiTargets,
    ],
  );

  const handleTileClickRef = useRef(handleTileClick);
  const handleTileDragRef = useRef(handleTileDrag);
  const handleTileHoverRef = useRef(handleTileHover);
  const cancelSelectionRef = useRef(cancelSelection);
  useEffect(() => {
    handleTileClickRef.current = handleTileClick;
  }, [handleTileClick]);
  useEffect(() => {
    handleTileDragRef.current = handleTileDrag;
  }, [handleTileDrag]);
  useEffect(() => {
    handleTileHoverRef.current = handleTileHover;
  }, [handleTileHover]);
  useEffect(() => {
    cancelSelectionRef.current = cancelSelection;
  }, [cancelSelection]);

  const lockLocalPlacement = useCallback(() => {
    const current = latestStateRef.current;
    if (!current || current.phase !== "placement") return;
    const playerId = current.config.localPlayerId ?? 0;
    const placement = current.placement.placements[playerId];
    if (!placement?.centerId || placement.locked) return;
    if (current.config.multiplayer) {
      try {
        roomClientRef.current?.lockPlacement(placement.centerId);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not lock the starting center.");
      }
      // Wait for the public placement payload before locking Worker state.
      return;
    }
    bridgeRef.current?.send({
      type: "command",
      command: { type: "lock-spawn", playerId },
    });
  }, []);

  const togglePause = useCallback(() => {
    const paused = !(latestStateRef.current?.paused ?? false);
    bridgeRef.current?.send({ type: "pause", paused });
    if (paused) bridgeRef.current?.send({ type: "snapshot" });
  }, []);

  const changeSpeed = useCallback((value: 1 | 2 | 4) => {
    setSpeed(value);
    bridgeRef.current?.send({ type: "speed", speed: value });
  }, []);

  const completeMultiKeyRelease = useCallback(() => {
    if (screen !== "match" || latestStateRef.current?.phase !== "running") {
      if (multiPhaseRef.current !== "idle") cancelMulti();
      return;
    }
    const phase = multiPhaseRef.current;
    if (phase === "sources") {
      if (multiSourcesRef.current.length === 0) cancelMulti();
      else updateMultiPhase("targets");
    } else if (phase === "targets" && multiTargetsRef.current.length > 0) {
      sendMultiMove();
    }
  }, [cancelMulti, screen, sendMultiMove, updateMultiPhase]);

  useEffect(() => {
    completeMultiKeyReleaseRef.current = completeMultiKeyRelease;
  }, [completeMultiKeyRelease]);

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      const element = target instanceof HTMLElement ? target : null;
      return Boolean(
        element?.isContentEditable || element?.matches("input, textarea, select, button"),
      );
    };
    const battlefieldActive = (): boolean =>
      screen === "match" && latestStateRef.current?.phase === "running";
    const cancelTransientInput = (): void => {
      if (multiPhaseRef.current !== "idle") cancelMulti();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!battlefieldActive()) return;
      if (event.key === "Shift") {
        if (event.repeat) return;
        updateMultiKeyHeld(true);
        if (multiPhaseRef.current === "idle") beginMulti();
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (["1", "2", "3", "4"].includes(event.key)) {
        const percentages: SendPercent[] = [25, 50, 75, 100];
        setSendPercent(percentages[Number(event.key) - 1]!);
      } else if (event.key === "Escape") {
        cancelSelection();
      } else if (event.key === " " && !config.multiplayer) {
        event.preventDefault();
        togglePause();
      } else if (["b", "r", "t"].includes(event.key.toLowerCase())) {
        cancelMulti();
        setSelectedId(null);
        setRallySourceId(null);
        const type =
          event.key.toLowerCase() === "b"
            ? "barracks"
            : event.key.toLowerCase() === "r"
              ? "archery-range"
              : "wizard-tower";
        setBuildMode((mode) => (mode === type ? null : type));
      } else if (event.key.toLowerCase() === "g" && config.debug) {
        setScoreOpen((open) => !open);
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key !== "Shift") return;
      updateMultiKeyHeld(false);
      if (multiPointerGestureRef.current) {
        deferredMultiKeyReleaseRef.current = true;
        return;
      }
      completeMultiKeyRelease();
    };
    const blur = () => cancelTransientInput();
    const visibility = () => {
      if (document.visibilityState !== "visible") cancelTransientInput();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [
    beginMulti,
    cancelMulti,
    cancelSelection,
    config.debug,
    config.multiplayer,
    completeMultiKeyRelease,
    screen,
    togglePause,
    updateMultiKeyHeld,
  ]);

  useEffect(() => {
    if (!state || state.phase !== "running" || multiPhase === "idle") {
      rendererRef.current?.setMultiPreview(null);
      return;
    }
    const destinationIds =
      multiPhase === "targets" && hoveredId && !multiTargets.includes(hoveredId)
        ? [...multiTargets, hoveredId]
        : multiTargets;
    const plan: MultiMovePlan | null =
      multiSources.length > 0 && destinationIds.length > 0
        ? planMultiMove(
            state,
            state.config.localPlayerId ?? 0,
            multiSources,
            destinationIds,
            sendPercent,
          )
        : null;
    rendererRef.current?.setMultiPreview({
      phase: multiPhase,
      sourceIds: multiSources,
      destinationIds,
      plan,
    });
  }, [hoveredId, multiPhase, multiSources, multiTargets, sendPercent, state]);

  const localPlayerId = config.localPlayerId ?? 0;
  const selectedTile = selectedId && state ? state.map.tiles[selectedId] : undefined;
  const hoveredTile = hoveredId && state ? state.map.tiles[hoveredId] : undefined;
  const human = state?.players[localPlayerId];
  const incomeMilli = useMemo(
    () => (state && human ? calculateIncomeMilliPerSecond(state, localPlayerId) : 0),
    [state, human, localPlayerId],
  );

  const sortedPlayers = useMemo(
    () =>
      state ? [...state.players].sort((a, b) => b.tileCount - a.tileCount || a.id - b.id) : [],
    [state],
  );
  const winner =
    state?.victory.winnerId === null || state?.victory.winnerId === undefined
      ? null
      : state.players[state.victory.winnerId];
  const buildReason = buildMode
    ? structureReason(hoveredTile, buildMode, localPlayerId, state)
    : null;
  const selectedStructureProgress = useMemo(() => {
    const structure = selectedTile?.structure;
    if (!structure) return 0;
    if (structure.pendingProgressTicks !== null) {
      const required = STRUCTURES[structure.type].buildTicks;
      return Math.min(100, Math.round((structure.pendingProgressTicks / required) * 100));
    }
    if (structure.status === "seized")
      return Math.min(100, Math.round((structure.seizedTicks / BALANCE.seizedTicks) * 100));
    if (structure.status === "repairing")
      return Math.min(
        100,
        Math.round(
          ((structure.integrity - BALANCE.seizedIntegrity) /
            (BALANCE.fullIntegrity - BALANCE.seizedIntegrity)) *
            100,
        ),
      );
    const tuning =
      structure.type === "barracks"
        ? BALANCE.barracks
        : structure.type === "archery-range"
          ? BALANCE.archeryRange
          : BALANCE.wizardTower;
    return Math.min(
      100,
      Math.round(
        (structure.trainingProgressMilli / (tuning.trainTicks * BALANCE.fullIntegrity)) * 100,
      ),
    );
  }, [selectedTile]);
  const selectedStructureProgressLabel = useMemo(() => {
    const structure = selectedTile?.structure;
    if (!structure) return "No structure progress";
    if (structure.pendingProgressTicks !== null) {
      return `Construction ${selectedStructureProgress}%`;
    }
    if (structure.status === "seized") {
      return `Seizure recovery ${selectedStructureProgress}%`;
    }
    if (structure.status === "repairing") {
      return `Integrity repair ${selectedStructureProgress}%`;
    }
    return `${STRUCTURES[structure.type].name} ${UNIT_LABELS[unitTypeForStructure(structure.type)]} training cycle ${selectedStructureProgress}%`;
  }, [selectedStructureProgress, selectedTile]);
  const selectedBattle =
    selectedTile && state
      ? state.battles.find((battle) => battle.tileId === selectedTile.id)
      : undefined;
  const selectedBattleParticipants = useMemo(
    () => (state && selectedBattle ? battlePresentation(state, selectedBattle) : []),
    [selectedBattle, state],
  );
  const selectedEnclosure =
    selectedTile && state
      ? state.enclosures.find((enclosure) => enclosure.tileIds.includes(selectedTile.id))
      : undefined;
  const selectedTypedSupportStatus = useMemo(() => {
    const structure = selectedTile?.structure;
    if (!state || !selectedTile || !structure) return null;
    if (
      selectedTile.owner === null ||
      structure.completedCount === 0 ||
      (structure.status !== "active" && structure.status !== "repairing")
    ) {
      return `${STRUCTURES[structure.type].name} support inactive`;
    }
    const owner = selectedTile.owner;
    const eligible = (battle: GameState["battles"][number]): boolean =>
      battle.participants.some(
        (participant) => participant.playerId === owner && totalUnits(participant.units) > 0,
      ) &&
      battle.participants.some(
        (participant) => participant.playerId !== owner && totalUnits(participant.units) > 0,
      );
    const home = state.battles.find(
      (battle) => battle.tileId === selectedTile.id && eligible(battle),
    );
    const adjacentIds = new Set(neighbors(selectedTile).map(axialKey));
    const targets = home
      ? [home]
      : state.battles
          .filter((battle) => adjacentIds.has(battle.tileId) && eligible(battle))
          .sort((left, right) => left.tileId.localeCompare(right.tileId));
    if (targets.length === 0) {
      return `${STRUCTURES[structure.type].name} x${structure.completedCount} ready; no eligible nearby battle`;
    }
    return `${STRUCTURES[structure.type].name} x${structure.completedCount} supporting ${targets.length} ${
      targets.length === 1 ? "battle" : "battles"
    }: ${targets.map((battle) => battle.tileId).join(", ")}${home ? " (home priority)" : ""}`;
  }, [selectedTile, state]);
  const selectedRallyBlocked = Boolean(
    state &&
    selectedTile?.structure &&
    selectedTile.structure.rallyTargetId &&
    isBarracksRallyBlocked(state, selectedTile, selectedTile.structure),
  );
  const localPlacement = state?.placement.placements[localPlayerId];
  const placementSeconds =
    state?.phase === "placement" && placementDeadlineAt !== null
      ? Math.max(0, Math.ceil((placementDeadlineAt - placementNow) / 1000))
      : null;
  const stagedMultiPlan = useMemo<MultiMovePlan | null>(() => {
    if (
      !state ||
      state.phase !== "running" ||
      multiSources.length === 0 ||
      multiTargets.length === 0
    )
      return null;
    return planMultiMove(state, localPlayerId, multiSources, multiTargets, sendPercent);
  }, [localPlayerId, multiSources, multiTargets, sendPercent, state]);
  const multiAvailableTroops = useMemo(() => {
    if (!state) return 0;
    const destinationSet = new Set(multiTargets);
    return multiSources.reduce((sum, tileId) => {
      const tile = state.map.tiles[tileId];
      return (
        sum +
        (tile && tile.owner === localPlayerId && !destinationSet.has(tileId)
          ? totalUnits(unitsForPercent(tile.units, sendPercent))
          : 0)
      );
    }, 0);
  }, [localPlayerId, multiSources, multiTargets, sendPercent, state]);
  const debugRoutes = useMemo<{ friendly: DebugRoute | null; hostile: DebugRoute | null }>(() => {
    if (!state?.config.debug) return { friendly: null, hostile: null };
    let friendly: DebugRoute | null = null;
    let hostile: DebugRoute | null = null;
    for (const tileId of state.map.landIds) {
      const tile = state.map.tiles[tileId]!;
      if (tile.owner !== localPlayerId || totalUnits(tile.units) <= 1) continue;
      for (const coordinate of neighbors(tile)) {
        const adjacent = state.map.tiles[axialKey(coordinate)];
        if (!adjacent || adjacent.terrain === "water") continue;
        if (!friendly && adjacent.owner === localPlayerId)
          friendly = { sourceId: tile.id, destinationId: adjacent.id };
        if (!hostile && adjacent.owner !== localPlayerId)
          hostile = { sourceId: tile.id, destinationId: adjacent.id };
      }
      if (friendly && hostile) break;
    }
    return { friendly, hostile };
  }, [state, localPlayerId]);

  if (screen === "menu") {
    return (
      <main className="title-screen" data-testid="title-screen">
        <div className="title-screen__backdrop" aria-hidden="true">
          <div className="orbital-ring" />
          <div className="hex-drift hex-drift--one" />
          <div className="hex-drift hex-drift--two" />
        </div>
        <header className="title-brand">
          <div className="title-brand__sigil" aria-hidden="true">
            <span />
            <i />
          </div>
          <div>
            <p>Ironwood Cartography Guild presents</p>
            <h1>
              Hex <span>Dominion</span>
            </h1>
            <small>Territory bends to the bold.</small>
          </div>
        </header>

        <section className="setup-shell">
          <div className="setup-tabs" role="tablist" aria-label="Game mode">
            <button
              role="tab"
              aria-selected={tab === "single"}
              className={tab === "single" ? "is-active" : ""}
              onClick={() => setTab("single")}
              data-testid="single-tab"
            >
              Solo Dominion
            </button>
            <button
              role="tab"
              aria-selected={tab === "multiplayer"}
              className={tab === "multiplayer" ? "is-active" : ""}
              onClick={() => setTab("multiplayer")}
              data-testid="multiplayer-tab"
            >
              <span className="alpha-dot" /> Room Code <em>alpha</em>
            </button>
          </div>

          {tab === "single" ? (
            <div className="setup-grid">
              <div className="setup-main">
                <div className="section-heading">
                  <span>01</span>
                  <div>
                    <h2>Choose the realm</h2>
                    <p>Every map is connected, fair, and reproducible from its seed.</p>
                  </div>
                </div>
                <div className="map-options" role="radiogroup" aria-label="Map archetype">
                  {MAPS.map((map) => (
                    <button
                      key={map.id}
                      role="radio"
                      aria-checked={config.archetype === map.id}
                      className={`map-option ${config.archetype === map.id ? "is-active" : ""}`}
                      onClick={() => setConfig((current) => ({ ...current, archetype: map.id }))}
                      data-testid={`map-${map.id}`}
                    >
                      <MapMiniature archetype={map.id} active={config.archetype === map.id} />
                      <span>
                        <strong>{map.name}</strong>
                        <em>{map.subtitle}</em>
                        <small>{map.description}</small>
                      </span>
                    </button>
                  ))}
                </div>

                <div className="section-heading section-heading--compact">
                  <span>02</span>
                  <div>
                    <h2>Set the challengers</h2>
                    <p>
                      Map scale grows automatically from {BALANCE.minLand.toLocaleString()} to{" "}
                      {BALANCE.maxLand.toLocaleString()} land hexes.
                    </p>
                  </div>
                </div>
                <div className="opponent-row">
                  <label className="range-control">
                    <span>
                      AI opponents <strong>{config.aiCount}</strong>
                    </span>
                    <input
                      aria-label="AI opponents"
                      data-testid="ai-count"
                      type="range"
                      min="3"
                      max="20"
                      step="1"
                      value={config.aiCount}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          aiCount: Number(event.target.value),
                        }))
                      }
                    />
                    <i>
                      <b style={{ width: `${((config.aiCount - 3) / 17) * 100}%` }} />
                    </i>
                    <small>
                      <span>3</span>
                      <span>20</span>
                    </small>
                  </label>
                  <label className="select-control">
                    <span>AI doctrine</span>
                    <select
                      aria-label="AI difficulty"
                      data-testid="difficulty"
                      value={config.difficulty}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          difficulty: event.target.value as MatchConfig["difficulty"],
                        }))
                      }
                    >
                      <option value="easy">Easy — Patient</option>
                      <option value="normal">Normal — Tactical</option>
                      <option value="hard">Hard — Relentless</option>
                    </select>
                  </label>
                </div>
              </div>

              <aside className="setup-sidebar">
                <div className="match-card">
                  <div className="match-card__crest" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <h2>Warden’s Ledger</h2>
                  <label>
                    <span>Commander name</span>
                    <input
                      aria-label="Player name"
                      data-testid="player-name"
                      maxLength={22}
                      value={config.playerName}
                      onChange={(event) =>
                        setConfig((current) => ({ ...current, playerName: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>World seed</span>
                    <div className="seed-input">
                      <input
                        aria-label="Map seed"
                        data-testid="seed"
                        maxLength={40}
                        value={config.seed}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            seed: event.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <button
                        aria-label="Generate random seed"
                        onClick={() => setConfig((current) => ({ ...current, seed: createSeed() }))}
                      >
                        ↻
                      </button>
                    </div>
                  </label>
                  <div className="setting-pair">
                    <label>
                      <span>Graphics</span>
                      <select
                        aria-label="Graphics quality"
                        value={config.graphics}
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            graphics: event.target.value as GraphicsQuality,
                          }))
                        }
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                    <button
                      className={`toggle-card ${config.sound ? "is-on" : ""}`}
                      aria-pressed={config.sound}
                      onClick={() =>
                        setConfig((current) => ({ ...current, sound: !current.sound }))
                      }
                    >
                      <span>Sound</span>
                      <i>
                        <b />
                      </i>
                    </button>
                  </div>
                  <button
                    className={`toggle-card toggle-card--wide ${config.colorPatterns ? "is-on" : ""}`}
                    aria-pressed={config.colorPatterns}
                    onClick={() =>
                      setConfig((current) => ({
                        ...current,
                        colorPatterns: !current.colorPatterns,
                      }))
                    }
                  >
                    <span>Color-pattern assistance</span>
                    <i>
                      <b />
                    </i>
                  </button>
                  <button
                    className={`toggle-card toggle-card--wide ${config.fullCounts ? "is-on" : ""}`}
                    aria-pressed={Boolean(config.fullCounts)}
                    onClick={() =>
                      setConfig((current) => ({ ...current, fullCounts: !current.fullCounts }))
                    }
                  >
                    <span>Always show troop counts</span>
                    <i>
                      <b />
                    </i>
                  </button>
                  <div className="match-summary">
                    <span>
                      <b>{config.aiCount + 1}</b> rulers
                    </span>
                    <span>
                      <b>{targetLandCount(config.aiCount + 1).toLocaleString()}</b> land hexes
                    </span>
                    <span>
                      <b>80%</b> to conquer
                    </span>
                  </div>
                  <button
                    className="start-button"
                    data-testid="start-match"
                    disabled={!config.playerName.trim() || !config.seed.trim()}
                    onClick={() =>
                      startGame({
                        ...config,
                        playerName: config.playerName.trim(),
                        seed: config.seed.trim(),
                      })
                    }
                  >
                    <span>Raise the banners</span>
                    <small>Begin single-player match</small>
                    <i aria-hidden="true">→</i>
                  </button>
                  {hasSave && (
                    <button
                      className="resume-button"
                      onClick={resumeGame}
                      data-testid="resume-match"
                    >
                      Resume local campaign
                    </button>
                  )}
                </div>
                <div className="control-note">
                  <span>Field controls</span>
                  <p>
                    <kbd>Click</kbd> select & issue orders · <kbd>1–4</kbd> send strength ·{" "}
                    <kbd>B R T</kbd> build trainers · <kbd>Space</kbd> pause
                  </p>
                </div>
              </aside>
            </div>
          ) : (
            <div className="multiplayer-setup" data-testid="multiplayer-setup">
              <div className="multiplayer-illustration" aria-hidden="true">
                <div className="relay-core">
                  <span />
                  <span />
                  <span />
                </div>
                <i className="relay-line relay-line--a" />
                <i className="relay-line relay-line--b" />
                <i className="relay-line relay-line--c" />
              </div>
              <div className="multiplayer-copy">
                <span className="eyebrow">Experimental command relay</span>
                <h2>Share a battlefield, not a server bill.</h2>
                <p>
                  Two to eight human commanders stay synchronized through an ordered, deterministic
                  room relay. AI fills run identically on every client.
                </p>
                <ul>
                  <li>Six-character private rooms</li>
                  <li>Reconnect tokens and state-hash checks</li>
                  <li>Cloudflare Durable Object hibernation</li>
                </ul>
              </div>
              <div className="room-card">
                {!roomIdentity ? (
                  <>
                    <div className="room-toggle">
                      <button
                        className={multiplayer.action === "create" ? "is-active" : ""}
                        onClick={() =>
                          setMultiplayer((current) => ({ ...current, action: "create" }))
                        }
                      >
                        Create
                      </button>
                      <button
                        className={multiplayer.action === "join" ? "is-active" : ""}
                        onClick={() =>
                          setMultiplayer((current) => ({ ...current, action: "join" }))
                        }
                      >
                        Join
                      </button>
                    </div>
                    <label>
                      <span>Commander</span>
                      <input
                        value={config.playerName}
                        maxLength={22}
                        onChange={(event) =>
                          setConfig((current) => ({ ...current, playerName: event.target.value }))
                        }
                      />
                    </label>
                    {multiplayer.action === "join" && (
                      <label>
                        <span>Room code</span>
                        <input
                          aria-label="Room code"
                          data-testid="room-code"
                          className="room-code"
                          maxLength={6}
                          value={multiplayer.roomCode}
                          onChange={(event) =>
                            setMultiplayer((current) => ({
                              ...current,
                              roomCode: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""),
                            }))
                          }
                          placeholder="CROWN7"
                        />
                      </label>
                    )}
                    {multiplayer.action === "create" && (
                      <>
                        <label>
                          <span>Deterministic bots</span>
                          <select
                            aria-label="Multiplayer bots"
                            data-testid="multiplayer-bot-count"
                            value={multiplayerBotCount}
                            onChange={(event) => setMultiplayerBotCount(Number(event.target.value))}
                          >
                            {Array.from({ length: 20 }, (_, count) => (
                              <option key={count} value={count}>
                                {count === 0
                                  ? "None — humans only"
                                  : `${count} bot${count === 1 ? "" : "s"}`}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="room-config-summary">
                          <span>{MAPS.find((map) => map.id === config.archetype)?.name}</span>
                          <span>{multiplayerBotCount} bots</span>
                          <span>2–{Math.min(8, 21 - multiplayerBotCount)} humans</span>
                        </div>
                      </>
                    )}
                    <button
                      className="start-button"
                      data-testid="room-action"
                      disabled={
                        roomBusy ||
                        !config.playerName.trim() ||
                        (multiplayer.action === "join" && multiplayer.roomCode.length !== 6)
                      }
                      onClick={() => void connectRoom()}
                    >
                      <span>
                        {roomBusy
                          ? "Calling the relay…"
                          : multiplayer.action === "create"
                            ? "Create a war room"
                            : "Join the war room"}
                      </span>
                      <small>
                        {multiplayer.action === "create"
                          ? "Configure the match in the lobby"
                          : "Enter the six-character code"}
                      </small>
                      <i>→</i>
                    </button>
                    {multiplayer.action === "join" && (
                      <button
                        className="resume-button"
                        data-testid="reconnect-room"
                        disabled={
                          roomBusy || multiplayer.roomCode.length !== 6 || !config.playerName.trim()
                        }
                        onClick={() => void connectRoom(true)}
                      >
                        Reconnect saved seat
                      </button>
                    )}
                  </>
                ) : (
                  <div className="room-lobby" data-testid="room-lobby">
                    <span className="eyebrow">War room open</span>
                    <button
                      className="room-lobby__code"
                      aria-label="Room code"
                      title="Share this room code"
                    >
                      {roomIdentity.roomCode}
                    </button>
                    <p>
                      Share this code. The host can start once at least two commanders are ready.
                    </p>
                    <div className="room-roster">
                      {roomPlayers.map((player) => (
                        <div key={player.id}>
                          <i className={player.connected ? "is-connected" : ""} />
                          <span>
                            {player.name}
                            <small>{player.isHost ? "HOST" : `SEAT ${player.seat + 1}`}</small>
                          </span>
                          <b>{player.ready ? "READY" : "WAITING"}</b>
                        </div>
                      ))}
                    </div>
                    <button
                      className={`room-ready ${roomReady ? "is-ready" : ""}`}
                      onClick={toggleRoomReady}
                    >
                      {roomReady ? "Banner ready" : "Ready my banner"}
                    </button>
                    {roomIdentity.player.isHost && (
                      <button
                        className="start-button"
                        data-testid="start-room"
                        disabled={
                          roomPlayers.length < 2 || !roomPlayers.every((player) => player.ready)
                        }
                        onClick={startRoomMatch}
                      >
                        <span>Begin synchronized match</span>
                        <small>
                          {roomPlayers.length < 2
                            ? "Waiting for another commander"
                            : "Every ready client begins at tick zero"}
                        </small>
                        <i>→</i>
                      </button>
                    )}
                    <button
                      className="room-leave"
                      onClick={() => {
                        try {
                          roomClientRef.current?.leave();
                        } catch {
                          roomClientRef.current?.close();
                        }
                        roomClientRef.current = null;
                        setRoomIdentity(null);
                        setRoomPlayers([]);
                        setRoomReady(false);
                      }}
                    >
                      Leave room
                    </button>
                  </div>
                )}
                {multiplayer.status && (
                  <p className="room-status" role="status">
                    {multiplayer.status}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
        {error && (
          <div className="global-toast global-toast--error" role="alert">
            <span>!</span>
            {error}
            <button onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        <footer className="title-footer">
          <span data-testid="build-version">{VERSION_LABEL} · deterministic 10 Hz simulation</span>
          <span>Original procedural art · no remote assets</span>
        </footer>
      </main>
    );
  }

  const playerLandPercent =
    state && human ? Math.round((human.tileCount / state.map.landCount) * 1000) / 10 : 0;
  const victoryLeader =
    state?.victory.leaderId === null || state?.victory.leaderId === undefined
      ? null
      : state.players[state.victory.leaderId];
  const victorySeconds = state
    ? Math.max(
        0,
        Math.ceil((BALANCE.victoryHoldTicks - state.victory.holdTicks) / TICKS_PER_SECOND),
      )
    : 0;

  return (
    <main className="game-screen" data-testid="game-screen">
      <div className="battlefield-host" ref={hostRef} />
      <div className="map-vignette" aria-hidden="true" />
      {state?.phase === "placement" && (
        <section
          className="placement-panel"
          data-testid="placement-panel"
          aria-labelledby="placement-title"
        >
          <header>
            <span>Before the first tick</span>
            <h1 id="placement-title">Choose your dominion</h1>
            <p>
              Select a highlighted center. Its seven-hex footprint remains provisional until you
              lock it.
            </p>
          </header>
          <div className="placement-roster" aria-label="Starting center status">
            {state.placement.placements.map((placement) => {
              const player = state.players[placement.playerId]!;
              return (
                <div key={placement.playerId} className={placement.locked ? "is-locked" : ""}>
                  <i style={{ background: `#${player.color.toString(16).padStart(6, "0")}` }} />
                  <span>
                    <strong>{player.name}</strong>
                    <small>{placement.centerId ?? "Choosing a center"}</small>
                  </span>
                  <b>{placement.locked ? "LOCKED" : "PROVISIONAL"}</b>
                </div>
              );
            })}
          </div>
          <footer>
            <span aria-live="polite">
              {placementSeconds === null
                ? "Single-player waits for your lock"
                : `${placementSeconds}s until deterministic assignment`}
            </span>
            <button
              type="button"
              data-testid="lock-placement"
              disabled={!localPlacement?.centerId || localPlacement.locked}
              onClick={lockLocalPlacement}
            >
              {localPlacement?.locked ? "Center locked" : "Lock In"}
            </button>
          </footer>
        </section>
      )}
      {state?.phase === "opening" && (
        <div className="opening-banner" data-testid="opening-banner" role="status">
          <span>Your banner rises</span>
          <strong>The realm opens…</strong>
        </div>
      )}
      <header className="hud-top">
        <button
          className="hud-brand"
          onClick={() => setSettingsOpen(true)}
          aria-label="Open game menu"
        >
          <span className="hud-brand__mark" />
          <strong>
            HEX <b>DOMINION</b>
          </strong>
        </button>
        <div className="resource-strip">
          <div>
            <span className="resource-icon resource-icon--supply" />
            <small>Supply</small>
            <strong data-testid="supply">{formatSupply(human?.supplyMilli ?? 0)}</strong>
            <em>+{formatSupply(incomeMilli)}/s</em>
          </div>
          <div>
            <span className="resource-icon resource-icon--troops" />
            <small>Troops</small>
            <strong>{human?.troopCount ?? 0}</strong>
            <em>
              {state?.stacks.filter((stack) => stack.owner === localPlayerId).length ?? 0} columns
            </em>
          </div>
          <div>
            <span className="resource-icon resource-icon--land" />
            <small>Dominion</small>
            <strong data-testid="land-control">
              {human?.tileCount ?? 0}
              <i> / {state?.map.landCount ?? 0}</i>
            </strong>
            <em>{playerLandPercent}% controlled</em>
          </div>
        </div>
        <div
          className="time-controls"
          aria-label={config.multiplayer ? "Live multiplayer status" : "Simulation speed"}
        >
          {state?.phase === "placement" || state?.phase === "opening" ? (
            <span className="live-status">
              <i /> {state.phase === "placement" ? "PLACEMENT" : "OPENING"}
            </span>
          ) : config.multiplayer ? (
            <span className="live-status">
              <i /> LIVE
            </span>
          ) : (
            <>
              <button
                data-testid="pause-toggle"
                aria-label={state?.paused ? "Resume simulation" : "Pause simulation"}
                aria-pressed={state?.paused}
                onClick={togglePause}
              >
                {state?.paused ? "▶" : "Ⅱ"}
              </button>
              {([1, 2, 4] as const).map((value) => (
                <button
                  key={value}
                  className={speed === value ? "is-active" : ""}
                  aria-pressed={speed === value}
                  onClick={() => changeSpeed(value)}
                >
                  {value}×
                </button>
              ))}
            </>
          )}
          <button
            className="settings-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {victoryLeader && !winner && (
        <div className="victory-ribbon" data-testid="victory-countdown">
          <span style={{ background: `#${victoryLeader.color.toString(16).padStart(6, "0")}` }} />
          <p>
            <strong>{victoryLeader.name} nears dominion</strong>
            <small>Hold 80% of the realm for</small>
          </p>
          <b>{victorySeconds}</b>
        </div>
      )}

      <aside className={`scoreboard ${scoreOpen ? "is-open" : ""}`}>
        <button className="scoreboard__toggle" onClick={() => setScoreOpen((open) => !open)}>
          <span>Realm standings</span>
          <b>{sortedPlayers[0]?.name ?? "—"}</b>
          <i>{scoreOpen ? "›" : "‹"}</i>
        </button>
        <div className="scoreboard__body">
          <header>
            <span>Ruler</span>
            <span>Land</span>
          </header>
          {sortedPlayers.map((player, index) => (
            <div
              key={player.id}
              className={`${player.id === localPlayerId ? "is-human" : ""} ${index === 0 ? "is-leader" : ""} ${player.eliminated ? "is-eliminated" : ""}`}
            >
              <b>{index === 0 ? "♛" : index + 1}</b>
              <i style={{ background: `#${player.color.toString(16).padStart(6, "0")}` }} />
              <span>
                {player.name}
                <small>
                  {player.id === localPlayerId ? "YOU" : player.isHuman ? "HUMAN" : player.aiMode}
                </small>
              </span>
              <strong>
                {player.eliminated ? (
                  "FALLEN"
                ) : (
                  <>
                    {player.tileCount}
                    <small>
                      {state ? ((player.tileCount / state.map.landCount) * 100).toFixed(1) : "0.0"}%
                    </small>
                  </>
                )}
              </strong>
            </div>
          ))}
        </div>
        {human && (
          <div className="scoreboard__human-pin">
            <span>Your standing</span>
            <b>#{sortedPlayers.findIndex((player) => player.id === localPlayerId) + 1}</b>
            <strong>
              {human.tileCount} · {playerLandPercent}%
            </strong>
          </div>
        )}
      </aside>

      <aside className="event-feed" aria-live="polite">
        {state?.events
          .slice(-5)
          .reverse()
          .map((event) => (
            <div key={event.id} className={`event-feed__item event-feed__item--${event.type}`}>
              <i />
              <span>{event.message}</span>
              <small>
                {Math.max(0, Math.floor(((state?.tick ?? 0) - event.tick) / TICKS_PER_SECOND))}s
              </small>
            </div>
          ))}
        {state?.enclosures.map((enclosure) => {
          const remainingTicks = Math.max(0, BALANCE.encirclementTicks - enclosure.progressTicks);
          const captor =
            state.players[enclosure.captorId]?.name ?? `Player ${enclosure.captorId + 1}`;
          return (
            <div
              key={`enclosure-${enclosure.id}`}
              className="event-feed__item event-feed__item--encirclement"
              data-testid={`enclosure-summary-${enclosure.id}`}
              role="status"
            >
              <i />
              <span>
                {captor} encircles a {enclosure.tileIds.length}-tile pocket
              </span>
              <small>
                {remainingTicks} {remainingTicks === 1 ? "tick" : "ticks"} ·{" "}
                {(remainingTicks / TICKS_PER_SECOND).toFixed(1)}s
              </small>
            </div>
          );
        })}
      </aside>

      {selectedTile && (
        <aside className="tile-inspector" data-testid="tile-inspector">
          <header>
            <span className={`terrain-swatch terrain-swatch--${selectedTile.terrain}`} />
            <div>
              <small>
                {selectedTile.owner === localPlayerId
                  ? "YOUR TERRITORY"
                  : selectedTile.owner === null
                    ? "UNCHARTED"
                    : state?.players[selectedTile.owner]?.name}
              </small>
              <h2>{terrainName(selectedTile.terrain)}</h2>
            </div>
            <button onClick={() => setSelectedId(null)} aria-label="Close tile details">
              ×
            </button>
          </header>
          <div className="tile-stats">
            <span>
              <small>Garrison</small>
              <strong>{totalUnits(selectedTile.units)}</strong>
            </span>
            <span>
              <small>Defense</small>
              <strong>
                {selectedTile.terrain === "hills"
                  ? "+25%"
                  : selectedTile.terrain === "forest"
                    ? "+12%"
                    : "Normal"}
              </strong>
            </span>
            <span>
              <small>Structure</small>
              <strong>
                {selectedTile.structure ? STRUCTURES[selectedTile.structure.type].name : "None"}
              </strong>
            </span>
          </div>
          <div className="tile-unit-roster" data-testid="tile-unit-roster">
            <strong>Unit composition</strong>
            <UnitComposition units={selectedTile.units} />
          </div>
          {selectedBattle && (
            <div
              className="structure-status"
              data-testid="battle-participant-roster"
              aria-label={`Battle participants at ${selectedTile.id}`}
            >
              <span aria-hidden="true">BATTLE</span>
              <span role="list">
                <strong>Battle participants</strong>
                {selectedBattleParticipants.map((participant) => {
                  const name =
                    participant.playerId === null
                      ? "Neutral defenders"
                      : (state?.players[participant.playerId]?.name ??
                        `Player ${participant.playerId + 1}`);
                  return (
                    <small
                      key={participant.playerId ?? "neutral"}
                      data-testid={`battle-participant-${participant.playerId ?? "neutral"}`}
                      role="listitem"
                    >
                      <b>{name}</b>
                      <UnitComposition units={participant.units} compact />
                      <span>
                        {participant.troops} units · {(participant.sharePermyriad / 100).toFixed(2)}
                        % effective share
                        {participant.incumbent ? " · incumbent" : ""}
                      </span>
                      <span
                        data-testid={`battle-type-multiplier-${participant.playerId ?? "neutral"}`}
                        className={`battle-advantage battle-advantage--${participant.rpsMultiplierPermille > 1000 ? "up" : participant.rpsMultiplierPermille < 1000 ? "down" : "even"}`}
                        aria-label={`Type multiplier ${(participant.rpsMultiplierPermille / 1000).toFixed(2)}`}
                      >
                        Type {formatTypeMultiplier(participant.rpsMultiplierPermille)}
                      </span>
                      {supportPower(participant) > 0 && (
                        <span>
                          Typed support · local {formatPower(participant.localSupportPower)}
                          {formatPowerByType(participant.localSupportPower)
                            ? ` (${formatPowerByType(participant.localSupportPower)})`
                            : ""}
                          {` · adjacent ${formatPower(participant.adjacentSupportPower)}`}
                          {formatPowerByType(participant.adjacentSupportPower)
                            ? ` (${formatPowerByType(participant.adjacentSupportPower)})`
                            : ""}
                        </span>
                      )}
                    </small>
                  );
                })}
              </span>
            </div>
          )}
          {selectedEnclosure && state && (
            <div className="structure-status" data-testid="enclosure-status" role="status">
              <span aria-hidden="true">RING</span>
              <span>
                <strong>
                  Encirclement by
                  {` ${state.players[selectedEnclosure.captorId]?.name ?? `Player ${selectedEnclosure.captorId + 1}`}`}
                </strong>
                <small>
                  {selectedEnclosure.tileIds.length}-tile pocket ·
                  {` ${Math.max(0, BALANCE.encirclementTicks - selectedEnclosure.progressTicks)} ${Math.max(0, BALANCE.encirclementTicks - selectedEnclosure.progressTicks) === 1 ? "tick" : "ticks"} · `}
                  {(
                    Math.max(0, BALANCE.encirclementTicks - selectedEnclosure.progressTicks) /
                    TICKS_PER_SECOND
                  ).toFixed(1)}{" "}
                  seconds remaining
                </small>
              </span>
            </div>
          )}
          {selectedTile.structure && (
            <div className="structure-status">
              <StructureGlyph type={selectedTile.structure.type} />
              <span>
                <strong>
                  {STRUCTURES[selectedTile.structure.type].name} x
                  {selectedTile.structure.completedCount}
                  {selectedTile.structure.pendingProgressTicks !== null ? " +1" : ""}
                </strong>
                <small>
                  {selectedTile.structure.pendingProgressTicks !== null
                    ? "constructing next copy"
                    : (selectedTile.structure.status ?? "foundation")}
                  {" · "}
                  {Math.round(selectedTile.structure.integrity / 10)}% integrity
                  {` · ${selectedTile.structure.productionPaused ? "production paused" : `training ${UNIT_LABELS[unitTypeForStructure(selectedTile.structure.type)]}`}`}
                  {selectedTile.structure.rallyTargetId &&
                    ` · rally ${selectedRallyBlocked ? "blocked" : "active"} to ${selectedTile.structure.rallyTargetId}`}
                </small>
                {totalUnits(selectedTile.structure.rallyQueuedUnits) > 0 && (
                  <small data-testid="rally-queued-status">
                    {formatUnits(selectedTile.structure.rallyQueuedUnits)} queued
                  </small>
                )}
                {selectedTypedSupportStatus && (
                  <small data-testid="typed-support-status">{selectedTypedSupportStatus}</small>
                )}
                <small data-testid="structure-progress-text">
                  {selectedStructureProgressLabel}
                </small>
                <i
                  className="structure-progress"
                  role="progressbar"
                  aria-label={selectedStructureProgressLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={selectedStructureProgress}
                >
                  <b style={{ width: `${selectedStructureProgress}%` }} />
                </i>
              </span>
              {selectedTile.owner === localPlayerId &&
                (selectedTile.structure.pendingProgressTicks !== null ? (
                  <button
                    onClick={() =>
                      dispatchCommand({
                        type: "cancel-build",
                        playerId: localPlayerId,
                        tileId: selectedTile.id,
                      })
                    }
                  >
                    Cancel
                  </button>
                ) : (
                  selectedTile.structure.completedCount > 0 && (
                    <button
                      onClick={() =>
                        dispatchCommand({
                          type: "toggle-production",
                          playerId: localPlayerId,
                          tileId: selectedTile.id,
                        })
                      }
                    >
                      {selectedTile.structure.productionPaused ? "Resume" : "Pause"}
                    </button>
                  )
                ))}
              {selectedTile.structure.completedCount > 0 &&
                selectedTile.owner === localPlayerId && (
                  <div className="rally-actions">
                    <button
                      type="button"
                      className={rallySourceId === selectedTile.id ? "is-active" : ""}
                      onClick={() => {
                        cancelMulti();
                        setBuildMode(null);
                        setRallySourceId(selectedTile.id);
                      }}
                    >
                      Set Rally Point
                    </button>
                    {selectedTile.structure.rallyTargetId && (
                      <button
                        type="button"
                        onClick={() =>
                          dispatchCommand({
                            type: "clear-rally",
                            playerId: localPlayerId,
                            tileId: selectedTile.id,
                          })
                        }
                      >
                        Clear Rally Point
                      </button>
                    )}
                  </div>
                )}
            </div>
          )}
        </aside>
      )}

      {state?.phase === "running" && (
        <div className="command-dock">
          <div className="send-control">
            <span>Dispatch</span>
            {([25, 50, 75, 100] as const).map((value, index) => (
              <button
                key={value}
                className={sendPercent === value ? "is-active" : ""}
                onClick={() => setSendPercent(value)}
                aria-pressed={sendPercent === value}
              >
                <b>{value}%</b>
                <small>{index + 1}</small>
              </button>
            ))}
            <em>
              {selectedTile
                ? `Send ${totalUnits(unitsForPercent(selectedTile.units, sendPercent))} units`
                : "Select a garrison"}
            </em>
            <button
              type="button"
              className={`multi-launch ${multiPhase !== "idle" ? "is-active" : ""}`}
              aria-pressed={multiPhase !== "idle"}
              aria-label="Start Multi movement selection"
              onClick={() => {
                if (multiPhase !== "idle") cancelMulti();
                else {
                  beginMulti();
                  updateMultiKeyHeld(true);
                }
              }}
            >
              Multi <kbd>Shift</kbd>
            </button>
          </div>
          <div className="dock-divider" />
          <div className="build-control">
            <span>Train & support</span>
            {(["barracks", "archery-range", "wizard-tower"] as const).map((type) => {
              const details = STRUCTURES[type];
              return (
                <button
                  key={type}
                  data-testid={`build-${type}`}
                  className={buildMode === type ? "is-active" : ""}
                  onClick={() => {
                    cancelMulti();
                    setRallySourceId(null);
                    setSelectedId(null);
                    setBuildMode((mode) => (mode === type ? null : type));
                  }}
                  aria-pressed={buildMode === type}
                >
                  <StructureGlyph type={type} />
                  <span>
                    <b>{details.name}</b>
                    <small>
                      {formatSupply(details.costMilli)} supply · trains {UNIT_LABELS[details.unit]}{" "}
                      · {details.shortcut}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {state?.phase === "running" && multiPhase !== "idle" && (
        <section className="multi-panel" data-testid="multi-panel" aria-label="Multi movement">
          <header aria-live="polite">
            <span>MULTI · {multiPhase === "sources" ? "SELECT SOURCES" : "CHOOSE TARGETS"}</span>
            <strong>
              {multiSources.length} source{multiSources.length === 1 ? "" : "s"} ·{" "}
              {multiTargets.length} target{multiTargets.length === 1 ? "" : "s"}
            </strong>
          </header>
          <p>
            Drag across hexes or click one by one · {multiAvailableTroops} troops at {sendPercent}%
            {stagedMultiPlan?.ok
              ? ` · ${stagedMultiPlan.destinationQuotas.map((quota) => quota.troops).join(" / ")} projected`
              : stagedMultiPlan?.reason
                ? ` · ${stagedMultiPlan.reason}`
                : ""}
          </p>
          <div>
            <button
              type="button"
              className={multiPhase === "sources" ? "is-active" : ""}
              onClick={() => {
                updateMultiPhase("sources");
                updateMultiTargets([]);
                updateMultiKeyHeld(true);
              }}
            >
              Select Sources
            </button>
            <button
              type="button"
              className={multiPhase === "targets" ? "is-active" : ""}
              disabled={multiSources.length === 0}
              onClick={() => {
                updateMultiPhase("targets");
                updateMultiKeyHeld(true);
              }}
            >
              Choose Targets
            </button>
            <button type="button" disabled={!stagedMultiPlan?.ok} onClick={() => sendMultiMove()}>
              Send
            </button>
            <button type="button" onClick={cancelMulti}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {buildMode && (
        <div className={`build-tooltip ${buildReason ? "is-invalid" : ""}`}>
          <StructureGlyph type={buildMode} />
          <span>
            <strong>Placing {STRUCTURES[buildMode].name}</strong>
            <small>
              {buildReason ??
                `Choose a glowing ${STRUCTURES[buildMode].terrain}. This trains ${UNIT_LABELS[STRUCTURES[buildMode].unit]}.`}
            </small>
          </span>
          <kbd>Esc</kbd>
        </div>
      )}

      {rallySourceId && (
        <div className="build-tooltip rally-tooltip" role="status">
          <StructureGlyph type={state?.map.tiles[rallySourceId]?.structure?.type ?? "barracks"} />
          <span>
            <strong>Choose rally destination</strong>
            <small>Friendly, neutral, or one reachable hostile final step.</small>
          </span>
          <button type="button" onClick={() => setRallySourceId(null)}>
            Cancel
          </button>
        </div>
      )}

      {config.debug && state && (
        <div className="debug-overlay" data-testid="debug-overlay">
          <b>FIELD TELEMETRY</b>
          <span>
            FPS <strong>{perf.fps}</strong>
          </span>
          <span>
            SIM <strong>{perf.simulationMs.toFixed(2)} ms</strong>
          </span>
          <span>
            AI <strong>{perf.aiMs.toFixed(2)} ms</strong>
          </span>
          <span>
            TICK <strong>{state.tick}</strong>
          </span>
          <span>
            STACKS <strong>{state.stacks.length}</strong>
          </span>
          <span>
            BATTLES <strong>{state.battles.length}</strong>
          </span>
          <span>
            SPRITES{" "}
            <strong>{rendererRef.current?.inspectPresentation().visibleObjects ?? 0}</strong>
          </span>
          <span>
            SEED <strong>{state.map.seed}</strong>
          </span>
          <span>
            HASH <strong>{state.stateHash.slice(0, 10)}</strong>
          </span>
          <div className="debug-actions">
            <button
              data-testid="debug-friendly-order"
              disabled={!debugRoutes.friendly}
              onClick={() =>
                debugRoutes.friendly &&
                dispatchCommand({
                  type: "move",
                  playerId: localPlayerId,
                  sourceId: debugRoutes.friendly.sourceId,
                  destinationId: debugRoutes.friendly.destinationId,
                  percent: 50,
                })
              }
            >
              Friendly order
            </button>
            <button
              data-testid="debug-hostile-order"
              disabled={!debugRoutes.hostile}
              onClick={() =>
                debugRoutes.hostile &&
                dispatchCommand({
                  type: "move",
                  playerId: localPlayerId,
                  sourceId: debugRoutes.hostile.sourceId,
                  destinationId: debugRoutes.hostile.destinationId,
                  percent: 75,
                })
              }
            >
              Hostile order
            </button>
          </div>
          <select
            data-testid="debug-scenario"
            aria-label="Debug scenario"
            defaultValue=""
            onChange={(event) => {
              const scenario = event.currentTarget.value as DebugScenario;
              if (scenario) loadDebugScenario(scenario);
              event.currentTarget.value = "";
            }}
          >
            <option value="" disabled>
              Load scenario…
            </option>
            {DEBUG_SCENARIOS.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && (
        <div className="loading-overlay" data-testid="loading-overlay">
          <div className="loading-emblem">
            <span />
            <span />
            <span />
          </div>
          <p>Surveyors are raising the realm</p>
          <small>Shaping connected land · placing fair strongholds · mustering armies</small>
          <div>
            <i />
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-scrim">
          <section className="pause-card" role="dialog" aria-modal="true" aria-label="Game menu">
            <span className="eyebrow">Campaign ledger</span>
            <h2>{state?.paused ? "The realm is paused" : "Game menu"}</h2>
            <p>
              Seed <b>{state?.map.seed}</b> · Tick <b>{state?.tick}</b>
            </p>
            <p className="build-version">
              {VERSION_LABEL} · commit {COMMIT_SHA}
            </p>
            <div className="pause-settings">
              <button
                className={`toggle-card ${config.sound ? "is-on" : ""}`}
                onClick={() => {
                  const next = !config.sound;
                  setConfig((current) => ({ ...current, sound: next }));
                  localStorage.setItem("hex-dominion-sound", String(next));
                  audioRef.current?.setEnabled(next);
                }}
              >
                <span>Sound</span>
                <i>
                  <b />
                </i>
              </button>
              <button onClick={() => rendererRef.current?.fitMap()}>Fit battlefield</button>
              <label>
                <span>Graphics quality</span>
                <select
                  value={config.graphics}
                  onChange={(event) => {
                    const graphics = event.target.value as GraphicsQuality;
                    setConfig((current) => ({ ...current, graphics }));
                    localStorage.setItem("hex-dominion-graphics", graphics);
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <button
                className={`toggle-card ${config.fullCounts ? "is-on" : ""}`}
                onClick={() =>
                  setConfig((current) => ({ ...current, fullCounts: !current.fullCounts }))
                }
              >
                <span>Full counts</span>
                <i>
                  <b />
                </i>
              </button>
            </div>
            <div className="pause-actions">
              <button onClick={() => setSettingsOpen(false)}>Return to battle</button>
              <button onClick={() => state && startGame(state.config)}>Restart this seed</button>
              <button className="danger" onClick={leaveMatch}>
                Leave campaign
              </button>
            </div>
          </section>
        </div>
      )}

      {winner && (
        <div
          className="modal-scrim victory-screen"
          data-testid={winner.id === localPlayerId ? "victory-screen" : "defeat-screen"}
        >
          <section>
            <div
              className={`victory-crown ${winner.id === localPlayerId ? "is-victory" : "is-defeat"}`}
            >
              <span />
              <span />
              <span />
            </div>
            <span className="eyebrow">
              {winner.id === localPlayerId ? "The realm bows" : "Your banners have fallen"}
            </span>
            <h1>{winner.id === localPlayerId ? "Dominion secured" : `${winner.name} prevails`}</h1>
            <p>
              {winner.name}{" "}
              {state?.victory.reason === "sole-survivor"
                ? "stands as the sole surviving ruler."
                : "held eighty percent of the realm for fifteen unbroken seconds."}
            </p>
            <div className="victory-stats">
              <span>
                <small>Land held</small>
                <strong>{winner.tileCount}</strong>
              </span>
              <span>
                <small>Tiles captured</small>
                <strong>{winner.stats.tilesCaptured}</strong>
              </span>
              <span>
                <small>Rivals fallen</small>
                <strong>{winner.stats.enemiesEliminated}</strong>
              </span>
              <span>
                <small>Duration</small>
                <strong>
                  {Math.floor((state?.tick ?? 0) / 600)}:
                  {String(Math.floor(((state?.tick ?? 0) % 600) / 10)).padStart(2, "0")}
                </strong>
              </span>
            </div>
            <div className="victory-actions">
              <button onClick={() => state && startGame(state.config)}>Replay this realm</button>
              <button onClick={() => state && startGame({ ...state.config, seed: createSeed() })}>
                New seed
              </button>
              <button onClick={leaveMatch}>Main menu</button>
            </div>
          </section>
        </div>
      )}

      {error && (
        <div className="global-toast global-toast--error" role="alert">
          <span>!</span>
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {rendererStatus !== "ready" && (
        <div
          className={`global-toast global-toast--renderer global-toast--renderer-${rendererStatus}`}
          role={rendererStatus === "lost" ? "alert" : "status"}
          data-testid="renderer-context-status"
        >
          <span>{rendererStatus === "lost" ? "!" : "✓"}</span>
          {rendererStatus === "lost"
            ? "Graphics connection lost. The simulation is safe while the battlefield recovers."
            : "Battlefield graphics restored from the latest simulation state."}
          {rendererStatus === "restored" && (
            <button onClick={() => setRendererStatus("ready")} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}
    </main>
  );
}

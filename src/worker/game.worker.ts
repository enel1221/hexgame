import { TICKS_PER_SECOND } from "../shared/balance";
import type { EngineSnapshot, GameCommand, WorkerRequest, WorkerResponse } from "../shared/types";
import { createDebugScenario } from "../core/debug-scenarios";
import { GameEngine, parseEngineSnapshot } from "../core/engine";
import { cloneDeterministic, stableStringify } from "../core/hash";

export interface WorkerPort {
  postMessage(message: WorkerResponse): void;
}

interface WorkerCommandRecord {
  command: GameCommand;
  relaySequence: number | null;
  receiptOrder: number;
}

export class SimulationWorkerController {
  private static readonly ROLLBACK_INTERVAL_TICKS = 50;
  private static readonly RECENT_ROLLBACK_POINTS = 4;
  private engine: GameEngine | null = null;
  private speed: 1 | 2 | 4 = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping = false;
  private rollbackBase: EngineSnapshot | null = null;
  private rollbackPoints: EngineSnapshot[] = [];
  /** Commands received since the current start/checkpoint recovery base. */
  private commandRecords: WorkerCommandRecord[] = [];
  /** Relay commands may cross WebSocket batches out of order, so gaps stay buffered. */
  private relayCommands = new Map<number, WorkerCommandRecord>();
  private relayBaseSequence = 0;
  private relayActivatedSequence = 0;
  private nextReceiptOrder = 0;

  constructor(private readonly port: WorkerPort) {}

  handle(request: WorkerRequest): void {
    try {
      switch (request.type) {
        case "start":
          this.stopTimer();
          this.speed = 1;
          this.engine = new GameEngine(request.config);
          this.resetTransportTracking();
          this.resetRollbackPoints();
          this.port.postMessage({
            type: "ready",
            state: this.engine.state,
            ...this.relayMetadata(),
          });
          this.startTimer();
          break;
        case "command": {
          if (!this.engine) return this.error("Simulation has not started");
          const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
          const result = this.submitCommand(request.command, request.relaySequence);
          if (!result.ok) this.error(result.reason ?? "Command rejected");
          if (result.replayed) {
            const finishedAt = typeof performance === "undefined" ? Date.now() : performance.now();
            this.port.postMessage({
              type: "state",
              state: this.engine.state,
              simulationMs: Math.max(0, finishedAt - startedAt),
              aiMs: 0,
              ...this.relayMetadata(),
            });
          }
          break;
        }
        case "pause":
          if (!this.engine) return this.error("Simulation has not started");
          if (this.engine.state.config.multiplayer) {
            return this.error("Multiplayer simulations cannot be paused");
          }
          this.engine.setPaused(request.paused);
          this.port.postMessage({
            type: "state",
            state: this.engine.state,
            simulationMs: 0,
            aiMs: 0,
            ...this.relayMetadata(),
          });
          break;
        case "speed":
          if (this.engine?.state.config.multiplayer && request.speed !== 1) {
            this.speed = 1;
            return this.error("Multiplayer simulations are locked to 1× speed");
          }
          this.speed = request.speed;
          break;
        case "catch-up": {
          if (!this.engine) return this.error("Simulation has not started");
          if (!Number.isInteger(request.targetTick) || request.targetTick < 0) {
            return this.error("Catch-up tick must be a non-negative integer");
          }
          const timerWasRunning = this.timer !== null;
          this.stopTimer();
          // A reconnect can receive sync immediately after `started`, while
          // the absolute opening handoff is still playing. Do not spin on an
          // opening-phase engine whose ordinary tick intentionally stays zero;
          // GameApp issues a fresh catch-up immediately after `begin-match`.
          if (this.engine.state.phase === "opening") {
            this.port.postMessage({
              type: "state",
              state: this.engine.state,
              simulationMs: 0,
              aiMs: 0,
              ...this.relayMetadata(),
            });
            if (timerWasRunning) this.startTimer();
            break;
          }
          const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
          while (
            this.currentClockTick() < request.targetTick &&
            this.engine.state.victory.winnerId === null
          ) {
            this.engine.tick();
            this.captureRollbackPoint();
          }
          const finishedAt = typeof performance === "undefined" ? Date.now() : performance.now();
          this.port.postMessage({
            type: "state",
            state: this.engine.state,
            simulationMs: Math.max(0, finishedAt - startedAt),
            aiMs: 0,
            ...this.relayMetadata(),
          });
          if (timerWasRunning) this.startTimer();
          break;
        }
        case "finalize-placement": {
          if (!this.engine) return this.error("Simulation has not started");
          const result = this.engine.finalizePlacement(request.centers);
          if (!result.ok) return this.error(result.reason ?? "Placement finalization was rejected");
          this.resetTransportTracking();
          this.resetRollbackPoints();
          this.port.postMessage({
            type: "state",
            state: this.engine.state,
            simulationMs: 0,
            aiMs: 0,
            ...this.relayMetadata(),
          });
          break;
        }
        case "begin-match": {
          if (!this.engine) return this.error("Simulation has not started");
          const result = this.engine.beginMatch();
          if (!result.ok) return this.error(result.reason ?? "Match opening is not ready");
          // The relay clock starts before the presentation handoff ends. Sync
          // can therefore queue ordered commands while the engine is opening;
          // retain that transport buffer across the phase transition.
          this.resetRollbackPoints();
          this.port.postMessage({
            type: "state",
            state: this.engine.state,
            simulationMs: 0,
            aiMs: 0,
            ...this.relayMetadata(),
          });
          break;
        }
        case "debug-scenario": {
          if (!this.engine) return this.error("Simulation has not started");
          if (!this.engine.state.config.debug) {
            return this.error("Debug scenarios require a debug match");
          }
          const snapshot = this.engine.exportSnapshot();
          snapshot.state = createDebugScenario(snapshot.state, request.scenario);
          snapshot.pendingCommands = [];
          this.engine.importSnapshot(snapshot);
          this.resetTransportTracking(this.currentAppliedRelaySequence());
          this.resetRollbackPoints();
          this.port.postMessage({
            type: "state",
            state: this.engine.state,
            simulationMs: 0,
            aiMs: 0,
            ...this.relayMetadata(),
          });
          break;
        }
        case "snapshot":
          if (!this.engine) return this.error("Simulation has not started");
          this.port.postMessage({
            type: "snapshot",
            snapshot: this.engine.exportSnapshot(),
            ...this.relayMetadata(),
          });
          break;
        case "restore": {
          // Construct and validate before disturbing the live engine. A bad
          // reconnect checkpoint is recoverable and must not freeze the match.
          if (
            request.relaySequence !== undefined &&
            (!Number.isInteger(request.relaySequence) || request.relaySequence < 0)
          ) {
            return this.error("Restore relay sequence must be a non-negative integer");
          }
          const restored = new GameEngine(parseEngineSnapshot(request.snapshot));
          this.stopTimer();
          this.engine = restored;
          if (this.engine.state.config.multiplayer) this.speed = 1;
          this.resetTransportTracking(
            request.relaySequence ?? 0,
            this.engine.exportSnapshot().pendingCommands ?? [],
          );
          this.resetRollbackPoints();
          this.port.postMessage({
            type: "ready",
            state: this.engine.state,
            ...this.relayMetadata(),
          });
          this.startTimer();
          break;
        }
        case "dispose":
          this.dispose();
          break;
      }
    } catch (error) {
      this.error(error instanceof Error ? error.message : "Unknown simulation error");
    }
  }

  /** One-tick primitive retained for deterministic tests and direct callers. */
  pumpOnce(): void {
    this.pumpTicks(1);
  }

  /** Production scheduler: one publication containing the configured fixed-step batch. */
  pumpScheduledOnce(): void {
    const ticks = this.engine?.state.config.multiplayer ? 1 : this.speed;
    this.pumpTicks(ticks);
  }

  private pumpTicks(ticks: number): void {
    if (!this.engine || this.engine.state.paused || this.pumping) return;
    this.pumping = true;
    const start = typeof performance === "undefined" ? Date.now() : performance.now();
    let aiStart = start;
    let aiMs = 0;
    try {
      for (let index = 0; index < ticks; index += 1) {
        if (this.engine.state.victory.winnerId !== null) break;
        this.engine.tick({
          beforeAi: () => {
            aiStart = typeof performance === "undefined" ? Date.now() : performance.now();
          },
          afterAi: () => {
            const aiEnd = typeof performance === "undefined" ? Date.now() : performance.now();
            aiMs += Math.max(0, aiEnd - aiStart);
          },
        });
        this.captureRollbackPoint();
      }
      const end = typeof performance === "undefined" ? Date.now() : performance.now();
      this.port.postMessage({
        type: "state",
        state: this.engine.state,
        simulationMs: Math.max(0, end - start),
        // Timing callbacks observe the AI phase; wall-clock data never enters state.
        aiMs,
        ...this.relayMetadata(),
      });
    } finally {
      this.pumping = false;
    }
  }

  dispose(): void {
    this.stopTimer();
    this.engine = null;
    this.rollbackBase = null;
    this.rollbackPoints = [];
    this.resetTransportTracking();
  }

  /**
   * Relay order is transport metadata rather than part of GameCommand/state.
   * Buffer sequence gaps, activate only a contiguous prefix, and rebuild from
   * a pre-target snapshot when that prefix arrives after its authoritative tick.
   */
  private submitCommand(
    command: GameCommand,
    relaySequence?: number,
  ): {
    ok: boolean;
    reason?: string;
    replayed: boolean;
  } {
    const engine = this.engine!;
    if (!engine.state.config.multiplayer) {
      if (relaySequence !== undefined) {
        return {
          ok: false,
          reason: "Relay sequence metadata requires a multiplayer simulation",
          replayed: false,
        };
      }
      return { ...engine.submitCommand(command), replayed: false };
    }

    if (engine.state.victory.winnerId !== null) {
      return { ...engine.submitCommand(command), replayed: false };
    }

    if (relaySequence !== undefined) {
      return this.submitRelayCommand(command, relaySequence);
    }

    const requestedTick = command.scheduledTick;
    if (requestedTick !== undefined && !Number.isInteger(requestedTick)) {
      return {
        ok: false,
        reason: "scheduledTick must be an integer",
        replayed: false,
      };
    }
    const targetTick =
      requestedTick === undefined ? this.currentClockTick() + 1 : Math.max(0, requestedTick);
    const canonical = cloneDeterministic({ ...command, scheduledTick: targetTick }) as GameCommand;
    const record: WorkerCommandRecord = {
      command: canonical,
      relaySequence: null,
      receiptOrder: this.nextReceiptOrder++,
    };
    if (requestedTick === undefined || targetTick > this.currentClockTick()) {
      const submitted = engine.submitCommand(canonical);
      if (submitted.ok) this.commandRecords.push(record);
      return { ...submitted, replayed: false };
    }

    const rebuilt = this.rebuildWithRecords([...this.commandRecords, record], targetTick);
    if (rebuilt.ok) this.commandRecords.push(record);
    return rebuilt;
  }

  private submitRelayCommand(
    command: GameCommand,
    relaySequence: number,
  ): { ok: boolean; reason?: string; replayed: boolean } {
    if (!Number.isInteger(relaySequence) || relaySequence < 1) {
      return {
        ok: false,
        reason: "Relay sequence must be a positive integer",
        replayed: false,
      };
    }
    if (!Number.isInteger(command.scheduledTick) || (command.scheduledTick ?? -1) < 0) {
      return {
        ok: false,
        reason: "Ordered relay commands require a non-negative scheduled tick",
        replayed: false,
      };
    }

    // A reconnect may redundantly deliver a command already represented by
    // its checkpoint base. It must not create a second rules-history record.
    if (relaySequence <= this.relayBaseSequence) {
      return { ok: true, replayed: false };
    }

    const canonical = cloneDeterministic(command);
    const existing = this.relayCommands.get(relaySequence);
    if (existing) {
      if (stableStringify(existing.command) !== stableStringify(canonical)) {
        return {
          ok: false,
          reason: `Relay sequence ${relaySequence} conflicts with an earlier command`,
          replayed: false,
        };
      }
      return { ok: true, replayed: false };
    }

    const received: WorkerCommandRecord = {
      command: canonical,
      relaySequence,
      receiptOrder: this.nextReceiptOrder++,
    };
    this.relayCommands.set(relaySequence, received);

    const activated: WorkerCommandRecord[] = [];
    let nextSequence = this.relayActivatedSequence + 1;
    while (this.relayCommands.has(nextSequence)) {
      activated.push(this.relayCommands.get(nextSequence)!);
      nextSequence += 1;
    }
    // A higher sequence cannot affect state until every preceding command is
    // present. This keeps checkpoint state exactly aligned to its sequence.
    if (activated.length === 0) return { ok: true, replayed: false };

    const lateTarget = activated
      .map((record) => record.command.scheduledTick!)
      .filter((targetTick) => targetTick <= this.currentClockTick())
      .sort((left, right) => left - right)[0];
    if (lateTarget !== undefined) {
      const rebuilt = this.rebuildWithRecords([...this.commandRecords, ...activated], lateTarget);
      if (!rebuilt.ok) {
        // The gap-closing record was not activated. Remove it so an identical
        // relay retry re-attempts the rebuild instead of taking the duplicate
        // fast path and silently stranding the buffered suffix.
        this.relayCommands.delete(relaySequence);
        return rebuilt;
      }
    } else {
      const before = this.engine!.exportSnapshot();
      for (const record of activated) {
        const submitted = this.engine!.submitCommand(record.command);
        if (!submitted.ok) {
          this.engine = new GameEngine(before);
          this.relayCommands.delete(relaySequence);
          return { ...submitted, replayed: false };
        }
      }
    }

    this.commandRecords.push(...activated);
    this.relayActivatedSequence = activated.at(-1)!.relaySequence!;
    return { ok: true, replayed: lateTarget !== undefined };
  }

  private rebuildWithRecords(
    records: WorkerCommandRecord[],
    targetTick: number,
  ): { ok: boolean; reason?: string; replayed: boolean } {
    const throughTick = this.currentClockTick();
    const rollback = [...this.rollbackPoints]
      .reverse()
      .find((snapshot) => this.snapshotClockTick(snapshot) < targetTick);
    if (!rollback) {
      return {
        ok: false,
        reason: `Ordered command tick ${targetTick} predates the recovery base`,
        replayed: false,
      };
    }

    const replay = new GameEngine(rollback);
    const rollbackTick = this.snapshotClockTick(rollback);
    const commands = records
      .filter((record) => record.command.scheduledTick! > rollbackTick)
      .sort((left, right) => {
        const tickOrder = left.command.scheduledTick! - right.command.scheduledTick!;
        if (tickOrder !== 0) return tickOrder;
        if (left.relaySequence !== null && right.relaySequence !== null) {
          return left.relaySequence - right.relaySequence;
        }
        return left.receiptOrder - right.receiptOrder;
      });
    for (const record of commands) {
      const submitted = replay.submitCommand(record.command);
      if (!submitted.ok) return { ...submitted, replayed: false };
    }
    replay.step(throughTick - rollbackTick);
    this.engine = replay;

    // Points at or after the inserted command came from the superseded
    // timeline. Keep the immutable recovery base and unaffected earlier points.
    this.rollbackPoints = this.rollbackPoints.filter(
      (snapshot) => snapshot === this.rollbackBase || this.snapshotClockTick(snapshot) < targetTick,
    );
    this.captureRollbackPoint(true);
    return { ok: true, replayed: true };
  }

  private resetTransportTracking(
    relayBaseSequence = 0,
    pendingCommands: readonly GameCommand[] = [],
  ): void {
    this.nextReceiptOrder = 0;
    this.commandRecords = pendingCommands.map((command) => ({
      command: cloneDeterministic(command),
      relaySequence: null,
      receiptOrder: this.nextReceiptOrder++,
    }));
    this.relayCommands = new Map();
    this.relayBaseSequence = relayBaseSequence;
    this.relayActivatedSequence = relayBaseSequence;
  }

  private currentAppliedRelaySequence(): number {
    let applied = this.relayBaseSequence;
    const throughTick = this.currentClockTick();
    while (applied < this.relayActivatedSequence) {
      const next = this.relayCommands.get(applied + 1);
      if (!next || next.command.scheduledTick! > throughTick) break;
      applied += 1;
    }
    return applied;
  }

  private relayMetadata(): { relaySequence?: number } {
    return this.engine?.state.config.multiplayer
      ? { relaySequence: this.currentAppliedRelaySequence() }
      : {};
  }

  private resetRollbackPoints(): void {
    if (!this.engine) {
      this.rollbackBase = null;
      this.rollbackPoints = [];
      return;
    }
    const snapshot = this.rollbackSnapshot();
    this.rollbackBase = snapshot;
    this.rollbackPoints = [snapshot];
  }

  private captureRollbackPoint(force = false): void {
    if (!this.engine) return;
    const tick = this.currentClockTick();
    if (!force && tick % SimulationWorkerController.ROLLBACK_INTERVAL_TICKS !== 0) return;
    if (this.rollbackPoints.some((snapshot) => this.snapshotClockTick(snapshot) === tick)) return;
    this.rollbackPoints.push(this.rollbackSnapshot());
    const base = this.rollbackBase;
    const recent = this.rollbackPoints
      .filter((snapshot) => snapshot !== base)
      .slice(-SimulationWorkerController.RECENT_ROLLBACK_POINTS);
    this.rollbackPoints = base ? [base, ...recent] : recent;
  }

  private rollbackSnapshot(): EngineSnapshot {
    const snapshot = this.engine!.exportSnapshot();
    // Commands after this point are reconstructed from commandRecords, sorting
    // equal target ticks by authoritative relay sequence.
    snapshot.pendingCommands = [];
    return snapshot;
  }

  private currentClockTick(): number {
    if (!this.engine) return 0;
    return this.engine.state.phase === "placement"
      ? this.engine.state.placement.elapsedTicks
      : this.engine.state.tick;
  }

  private snapshotClockTick(snapshot: EngineSnapshot): number {
    return snapshot.state.phase === "placement"
      ? snapshot.state.placement.elapsedTicks
      : snapshot.state.tick;
  }

  private startTimer(): void {
    if (this.timer || !this.engine) return;
    const intervalMs = 1000 / TICKS_PER_SECOND;
    this.timer = setInterval(() => this.pumpScheduledOnce(), intervalMs);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private error(message: string): void {
    this.port.postMessage({ type: "error", message });
  }
}

type WorkerLikeGlobal = WorkerPort & {
  document?: unknown;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const possibleWorker = globalThis as unknown as WorkerLikeGlobal;
if (typeof possibleWorker.postMessage === "function" && possibleWorker.document === undefined) {
  const controller = new SimulationWorkerController(possibleWorker);
  possibleWorker.onmessage = (event) => controller.handle(event.data);
}

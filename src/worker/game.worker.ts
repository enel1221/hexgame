import { TICKS_PER_SECOND } from "../shared/balance";
import type { EngineSnapshot, GameCommand, WorkerRequest, WorkerResponse } from "../shared/types";
import { createDebugScenario } from "../core/debug-scenarios";
import { GameEngine, parseEngineSnapshot } from "../core/engine";

export interface WorkerPort {
  postMessage(message: WorkerResponse): void;
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

  constructor(private readonly port: WorkerPort) {}

  handle(request: WorkerRequest): void {
    try {
      switch (request.type) {
        case "start":
          this.stopTimer();
          this.speed = 1;
          this.engine = new GameEngine(request.config);
          this.resetRollbackPoints();
          this.port.postMessage({ type: "ready", state: this.engine.state });
          this.startTimer();
          break;
        case "command": {
          if (!this.engine) return this.error("Simulation has not started");
          const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
          const result = this.submitCommand(request.command);
          if (!result.ok) this.error(result.reason ?? "Command rejected");
          if (result.replayed) {
            const finishedAt = typeof performance === "undefined" ? Date.now() : performance.now();
            this.port.postMessage({
              type: "state",
              state: this.engine.state,
              simulationMs: Math.max(0, finishedAt - startedAt),
              aiMs: 0,
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
          const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
          while (
            this.engine.state.tick < request.targetTick &&
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
          });
          if (timerWasRunning) this.startTimer();
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
          this.resetRollbackPoints();
          this.port.postMessage({
            type: "state",
            state: this.engine.state,
            simulationMs: 0,
            aiMs: 0,
          });
          break;
        }
        case "snapshot":
          if (!this.engine) return this.error("Simulation has not started");
          this.port.postMessage({ type: "snapshot", snapshot: this.engine.exportSnapshot() });
          break;
        case "restore": {
          // Construct and validate before disturbing the live engine. A bad
          // reconnect checkpoint is recoverable and must not freeze the match.
          const restored = new GameEngine(parseEngineSnapshot(request.snapshot));
          this.stopTimer();
          this.engine = restored;
          if (this.engine.state.config.multiplayer) this.speed = 1;
          this.resetRollbackPoints();
          this.port.postMessage({ type: "ready", state: this.engine.state });
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
  }

  /**
   * Relay commands carry an authoritative target tick. A browser can already
   * have published that tick when a delayed WebSocket batch arrives, so simply
   * queueing through GameEngine.submitCommand would clamp the order to a
   * different local tick. Rebuild from the latest pre-target point instead.
   */
  private submitCommand(command: GameCommand): {
    ok: boolean;
    reason?: string;
    replayed: boolean;
  } {
    const engine = this.engine!;
    const targetTick = command.scheduledTick;
    if (
      !engine.state.config.multiplayer ||
      targetTick === undefined ||
      !Number.isInteger(targetTick) ||
      targetTick > engine.state.tick ||
      engine.state.victory.winnerId !== null
    ) {
      return { ...engine.submitCommand(command), replayed: false };
    }

    const throughTick = engine.state.tick;
    const current = engine.exportSnapshot();
    const rollback = [...this.rollbackPoints]
      .reverse()
      .find((snapshot) => snapshot.state.tick < targetTick);
    if (!rollback) {
      return {
        ok: false,
        reason: `Ordered command tick ${targetTick} predates the recovery base`,
        replayed: false,
      };
    }

    const replay = new GameEngine(rollback);
    const commands = [
      ...current.commandHistory.slice(rollback.commandHistory.length),
      ...(current.pendingCommands ?? []),
      command,
    ];
    for (const replayCommand of commands) {
      const submitted = replay.submitCommand(replayCommand);
      if (!submitted.ok) return { ...submitted, replayed: false };
    }
    replay.step(throughTick - rollback.state.tick);
    this.engine = replay;

    // Points at or after the inserted command came from the superseded
    // timeline. Keep the immutable recovery base and unaffected earlier points.
    this.rollbackPoints = this.rollbackPoints.filter(
      (snapshot) => snapshot === this.rollbackBase || snapshot.state.tick < targetTick,
    );
    this.captureRollbackPoint(true);
    return { ok: true, replayed: true };
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
    const tick = this.engine.state.tick;
    if (!force && tick % SimulationWorkerController.ROLLBACK_INTERVAL_TICKS !== 0) return;
    if (this.rollbackPoints.some((snapshot) => snapshot.state.tick === tick)) return;
    this.rollbackPoints.push(this.rollbackSnapshot());
    const base = this.rollbackBase;
    const recent = this.rollbackPoints
      .filter((snapshot) => snapshot !== base)
      .slice(-SimulationWorkerController.RECENT_ROLLBACK_POINTS);
    this.rollbackPoints = base ? [base, ...recent] : recent;
  }

  private rollbackSnapshot(): EngineSnapshot {
    const snapshot = this.engine!.exportSnapshot();
    // Commands after this point are reconstructed in relay receipt order from
    // the current accepted history and pending queue.
    snapshot.pendingCommands = [];
    return snapshot;
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

import {
  ClientMessageSchema,
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  RoomCodeSchema,
  ServerMessageSchema,
  type AtomicClientMessage,
  type CreateRoomRequest,
  type GameCommand,
  type JoinRoomRequest,
  type PlayerSummary,
  type RoomConfig,
  type ServerMessage,
} from "./protocol";

export interface RoomIdentity {
  roomCode: string;
  phase: "lobby" | "placement" | "started" | "complete";
  config: RoomConfig;
  player: PlayerSummary;
  reconnectToken: string;
  websocketUrl: string;
  reconnected: boolean;
  latestSequence: number;
}

export interface MultiplayerClientOptions {
  edgeUrl?: string;
  autoReconnect?: boolean;
  maxReconnectDelayMs?: number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

type Listener = (message: ServerMessage) => void;

/** Browser transport only; the deterministic simulation remains in the game worker. */
export class MultiplayerClient {
  private readonly edgeUrl: string;
  private readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  private readonly listeners = new Set<Listener>();
  private readonly autoReconnect: boolean;
  private readonly maxReconnectDelayMs: number;
  private socket: WebSocket | null = null;
  private identity: RoomIdentity | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private nextClientSequence = 1;

  constructor(options: MultiplayerClientOptions = {}) {
    this.edgeUrl = (options.edgeUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    this.storage =
      options.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 8_000;
  }

  async createRoom(request: CreateRoomRequest): Promise<RoomIdentity> {
    const body = CreateRoomRequestSchema.parse(request);
    const identity = await this.requestIdentity("/api/rooms", body);
    this.rememberIdentity(identity);
    return identity;
  }

  async joinRoom(roomCode: string, request: JoinRoomRequest): Promise<RoomIdentity> {
    const code = RoomCodeSchema.parse(roomCode);
    const body = JoinRoomRequestSchema.parse(request);
    const identity = await this.requestIdentity(`/api/rooms/${code}/join`, body);
    this.rememberIdentity(identity);
    return identity;
  }

  async reconnectRoom(roomCode: string, playerName: string): Promise<RoomIdentity> {
    const code = RoomCodeSchema.parse(roomCode);
    const saved = this.loadIdentity(code);
    if (!saved) throw new Error(`No reconnect identity is stored for room ${code}`);
    return this.joinRoom(code, {
      playerName,
      reconnectToken: saved.reconnectToken,
    });
  }

  connect(identity = this.identity): Promise<void> {
    if (!identity) return Promise.reject(new Error("Create or join a room first"));
    this.identity = identity;
    this.intentionallyClosed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Replacing connection");

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(identity.websocketUrl);
      this.socket = socket;
      const onInitialError = () => reject(new Error("Multiplayer WebSocket failed to open"));
      socket.addEventListener("error", onInitialError, { once: true });
      socket.addEventListener(
        "open",
        () => {
          socket.removeEventListener("error", onInitialError);
          this.reconnectAttempt = 0;
          resolve();
        },
        { once: true },
      );
      socket.addEventListener("message", (event) => this.receive(event));
      socket.addEventListener("close", () => {
        const wasCurrent = this.socket === socket;
        if (wasCurrent) this.socket = null;
        if (wasCurrent && !this.intentionallyClosed && this.autoReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setReady(ready: boolean, requestId?: string): void {
    this.send({ type: "ready", ready, requestId });
  }

  start(requestId?: string): void {
    this.send({ type: "start", requestId });
  }

  publishPlacementCandidates(
    generationAttempt: number,
    candidateHash: string,
    candidates: string[],
    requestId?: string,
  ): void {
    this.send({
      type: "placement-candidates",
      generationAttempt,
      candidateHash,
      candidates,
      requestId,
    });
  }

  claimPlacement(centerId: string, requestId?: string): void {
    this.send({ type: "placement-claim", centerId, requestId });
  }

  lockPlacement(centerId: string, requestId?: string): void {
    this.send({ type: "placement-lock", centerId, requestId });
  }

  finalizePlacement(
    generationAttempt: number,
    candidateHash: string,
    spawnCenters: string[],
    requestId?: string,
  ): void {
    this.send({
      type: "placement-finalize",
      generationAttempt,
      candidateHash,
      spawnCenters,
      requestId,
    });
  }

  sendCommand(command: GameCommand, requestId?: string): number {
    const clientSequence = this.nextClientSequence;
    this.send({ type: "command", clientSequence, command, requestId });
    this.nextClientSequence += 1;
    return clientSequence;
  }

  sendHash(tick: number, sequence: number, hash: string, requestId?: string): void {
    this.send({ type: "hash", tick, sequence, hash, requestId });
  }

  publishCheckpoint(
    checkpoint: {
      tick: number;
      sequence: number;
      hash: string;
      encoding: "json" | "base64" | "gzip-base64";
      payload: string;
    },
    requestId?: string,
  ): void {
    this.send({ type: "checkpoint", ...checkpoint, requestId });
  }

  requestMissing(afterSequence: number, limit = 500, requestId?: string): void {
    this.send({ type: "missing", afterSequence, limit, requestId });
  }

  sendBatch(messages: AtomicClientMessage[]): void {
    this.send({ type: "batch", messages });
  }

  complete(winnerSeat: number, finalTick: number, hash: string, requestId?: string): void {
    this.send({ type: "complete", winnerSeat, finalTick, hash, requestId });
  }

  leave(requestId?: string): void {
    const socket = this.socket;
    this.intentionallyClosed = true;
    this.send({ type: "leave", requestId });
    this.forgetIdentity();
    // Let the server acknowledge and close first; this fallback handles a lost relay.
    if (socket) {
      setTimeout(() => {
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "Left room");
      }, 1_000);
    }
  }

  close(code = 1000, reason = "Client closed"): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(code, reason);
    this.socket = null;
  }

  private send(message: unknown): void {
    const parsed = ClientMessageSchema.parse(message);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Multiplayer WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(parsed));
  }

  private receive(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = ServerMessageSchema.safeParse(value);
    if (!parsed.success) return;
    if (parsed.data.type === "welcome") {
      this.nextClientSequence = parsed.data.nextClientSequence;
    }
    for (const listener of this.listeners) listener(parsed.data);
  }

  private scheduleReconnect(): void {
    if (!this.identity || this.reconnectTimer) return;
    const delay = Math.min(this.maxReconnectDelayMs, 250 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private async requestIdentity(path: string, body: unknown): Promise<RoomIdentity> {
    const response = await fetch(`${this.edgeUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as RoomIdentity & {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Multiplayer request failed (${response.status})`);
    }
    RoomCodeSchema.parse(payload.roomCode);
    if (!payload.reconnectToken || !payload.websocketUrl) {
      throw new Error("Multiplayer response did not contain connection credentials");
    }
    return payload;
  }

  private rememberIdentity(identity: RoomIdentity): void {
    this.identity = identity;
    this.storage?.setItem(
      this.storageKey(identity.roomCode),
      JSON.stringify({
        reconnectToken: identity.reconnectToken,
        websocketUrl: identity.websocketUrl,
      }),
    );
  }

  private loadIdentity(roomCode: string): { reconnectToken: string; websocketUrl: string } | null {
    const serialized = this.storage?.getItem(this.storageKey(roomCode));
    if (!serialized) return null;
    try {
      const value = JSON.parse(serialized) as Record<string, unknown>;
      return typeof value.reconnectToken === "string" && typeof value.websocketUrl === "string"
        ? { reconnectToken: value.reconnectToken, websocketUrl: value.websocketUrl }
        : null;
    } catch {
      return null;
    }
  }

  private forgetIdentity(): void {
    if (this.identity) this.storage?.removeItem(this.storageKey(this.identity.roomCode));
    this.identity = null;
  }

  private storageKey(roomCode: string): string {
    return `hex-dominion:multiplayer:${roomCode}`;
  }
}

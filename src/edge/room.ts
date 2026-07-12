import {
  AtomicClientMessageSchema,
  ClientMessageSchema,
  CompleteMessageSchema,
  CreateRoomRequestSchema,
  JoinRoomRequestSchema,
  MIN_MATCH_PARTICIPANTS,
  MIN_PARTICIPANT_CAPACITY_MESSAGE,
  RoomCodeSchema,
  RoomConfigSchema,
  type AtomicClientMessage,
  type Checkpoint,
  type OrderedCommand,
  type PlayerSummary,
  type RoomConfig,
} from "./protocol";
import {
  assignRelayOrder,
  boundedInteger,
  compareStateHashes,
  createReconnectToken,
  currentServerTick,
  DEFAULT_COMMAND_LEAD_TICKS,
  DEFAULT_ROOM_TTL_SECONDS,
  hashReconnectToken,
  MAX_COMMAND_BATCH,
  MAX_MESSAGE_BYTES,
} from "./relay";
import {
  createWebSocketPair,
  type DurableState,
  type HibernatingWebSocket,
  type MultiplayerEnv,
} from "./runtime";

type RoomPhase = "lobby" | "started" | "complete";

interface RoomRow {
  code: string;
  phase: RoomPhase;
  config_json: string;
  host_player_id: string;
  created_at: number;
  expires_at: number;
  started_at: number | null;
  completed_at: number | null;
  next_seat: number;
  next_sequence: number;
  last_target_tick: number;
  winner_seat: number | null;
  final_tick: number | null;
  final_hash: string | null;
}

interface PlayerRow {
  id: string;
  seat: number;
  name: string;
  reconnect_hash: string;
  ready: number;
  connected: number;
  left_room: number;
  joined_at: number;
  last_seen: number;
  last_client_sequence: number;
  rate_window_at: number;
  rate_count: number;
}

interface CommandRow {
  sequence: number;
  player_id: string;
  player_seat: number;
  client_sequence: number;
  target_tick: number;
  command_json: string;
  broadcasted: number;
}

interface CheckpointRow {
  sequence: number;
  tick: number;
  state_hash: string;
  encoding: "json" | "base64";
  payload: string;
}

interface ConnectionAttachment {
  playerId: string;
  connectedAt: number;
}

const BATCH_WINDOW_MS = 50;
const RATE_WINDOW_MS = 10_000;
const MAX_LOGICAL_MESSAGES_PER_WINDOW = 160;
const RECONNECT_SYNC_LIMIT = 500;

export class RoomDurableObject {
  private readonly ready: Promise<void>;
  private readonly ttlSeconds: number;
  private readonly leadTicks: number;

  constructor(
    private readonly state: DurableState,
    private readonly env: MultiplayerEnv,
  ) {
    this.ttlSeconds = boundedInteger(
      env.ROOM_TTL_SECONDS,
      DEFAULT_ROOM_TTL_SECONDS,
      1,
      24 * 60 * 60,
    );
    this.leadTicks = boundedInteger(env.COMMAND_LEAD_TICKS, DEFAULT_COMMAND_LEAD_TICKS, 2, 30);
    this.ready = state.blockConcurrencyWhile(async () => this.initialize());
  }

  private initialize(): void {
    const sql = this.state.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room (
        code TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK (phase IN ('lobby', 'started', 'complete')),
        config_json TEXT NOT NULL,
        host_player_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        next_seat INTEGER NOT NULL,
        next_sequence INTEGER NOT NULL,
        last_target_tick INTEGER NOT NULL,
        winner_seat INTEGER,
        final_tick INTEGER,
        final_hash TEXT
      )
    `);
    const roomColumns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(room)")
        .toArray()
        .map((column) => column.name),
    );
    if (!roomColumns.has("final_tick")) {
      sql.exec("ALTER TABLE room ADD COLUMN final_tick INTEGER");
    }
    if (!roomColumns.has("final_hash")) {
      sql.exec("ALTER TABLE room ADD COLUMN final_hash TEXT");
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        seat INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        reconnect_hash TEXT NOT NULL UNIQUE,
        ready INTEGER NOT NULL DEFAULT 0,
        connected INTEGER NOT NULL DEFAULT 0,
        left_room INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        last_client_sequence INTEGER NOT NULL DEFAULT 0,
        rate_window_at INTEGER NOT NULL DEFAULT 0,
        rate_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        sequence INTEGER PRIMARY KEY,
        player_id TEXT NOT NULL,
        player_seat INTEGER NOT NULL,
        client_sequence INTEGER NOT NULL,
        target_tick INTEGER NOT NULL,
        command_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        broadcasted INTEGER NOT NULL DEFAULT 0,
        UNIQUE (player_id, client_sequence)
      )
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS commands_broadcast ON commands (broadcasted, sequence)");
    sql.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        sequence INTEGER PRIMARY KEY,
        tick INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        encoding TEXT NOT NULL CHECK (encoding IN ('json', 'base64')),
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS state_hashes (
        tick INTEGER NOT NULL,
        player_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        reported_at INTEGER NOT NULL,
        PRIMARY KEY (tick, player_id)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS desync_notices (
        tick INTEGER PRIMARY KEY,
        reported_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/internal/create") {
      return this.createRoom(request);
    }
    if (request.method === "POST" && url.pathname === "/internal/join") {
      return this.joinRoom(request);
    }
    if (request.method === "GET" && url.pathname === "/internal/status") {
      const room = this.getRoom();
      return room
        ? this.json(this.lobbyPayload(room))
        : this.problem(404, "room-not-found", "Room not found");
    }
    if (request.method === "GET" && url.pathname === "/internal/ws") {
      return this.connectWebSocket(request, url);
    }

    return this.problem(404, "not-found", "Unknown room operation");
  }

  private async createRoom(request: Request): Promise<Response> {
    if (this.getRoom()) {
      return this.problem(409, "room-code-collision", "Room code is already in use");
    }

    const codeResult = RoomCodeSchema.safeParse(request.headers.get("x-room-code"));
    const body = await this.parseJson(request);
    const parsed = CreateRoomRequestSchema.safeParse(body);
    if (!codeResult.success || !parsed.success) {
      const capacityIssue = parsed.success
        ? undefined
        : parsed.error.issues.find((issue) => issue.message === MIN_PARTICIPANT_CAPACITY_MESSAGE);
      return this.problem(
        400,
        capacityIssue ? "insufficient-participant-capacity" : "invalid-create",
        capacityIssue?.message ?? "Invalid room creation request",
        {
          issues: [
            ...(codeResult.success ? [] : codeResult.error.issues),
            ...(parsed.success ? [] : parsed.error.issues),
          ],
        },
      );
    }

    const now = Date.now();
    const playerId = crypto.randomUUID();
    const reconnectToken = createReconnectToken();
    const reconnectHash = await hashReconnectToken(reconnectToken);
    const configJson = JSON.stringify(parsed.data.config);

    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO room
          (code, phase, config_json, host_player_id, created_at, expires_at,
           started_at, completed_at, next_seat, next_sequence, last_target_tick,
           winner_seat, final_tick, final_hash)
         VALUES (?, 'lobby', ?, ?, ?, ?, NULL, NULL, 1, 1, 0, NULL, NULL, NULL)`,
        codeResult.data,
        configJson,
        playerId,
        now,
        now + this.ttlSeconds * 1000,
      );
      this.state.storage.sql.exec(
        `INSERT INTO players
          (id, seat, name, reconnect_hash, ready, connected, left_room,
           joined_at, last_seen, last_client_sequence, rate_window_at, rate_count)
         VALUES (?, 0, ?, ?, 1, 0, 0, ?, ?, 0, ?, 0)`,
        playerId,
        parsed.data.playerName,
        reconnectHash,
        now,
        now,
        now,
      );
    });

    await this.scheduleAlarm();
    return this.json(
      this.identityPayload(this.getRoom()!, this.getPlayer(playerId)!, reconnectToken, false),
      201,
    );
  }

  private async joinRoom(request: Request): Promise<Response> {
    const room = this.getRoom();
    if (!room) return this.problem(404, "room-not-found", "Room not found");

    const body = await this.parseJson(request);
    const parsed = JoinRoomRequestSchema.safeParse(body);
    if (!parsed.success) {
      return this.problem(400, "invalid-join", "Invalid join request", {
        issues: parsed.error.issues,
      });
    }

    const now = Date.now();
    if (parsed.data.reconnectToken) {
      const reconnectHash = await hashReconnectToken(parsed.data.reconnectToken);
      const player = this.rows<PlayerRow>(
        "SELECT * FROM players WHERE reconnect_hash = ? LIMIT 1",
        reconnectHash,
      )[0];
      if (!player || player.left_room === 1) {
        return this.problem(
          401,
          "invalid-reconnect-token",
          "Reconnect token is invalid or the player already left",
        );
      }
      if (room.phase === "lobby" && player.name !== parsed.data.playerName) {
        this.state.storage.sql.exec(
          "UPDATE players SET name = ?, last_seen = ? WHERE id = ?",
          parsed.data.playerName,
          now,
          player.id,
        );
      } else {
        this.state.storage.sql.exec(
          "UPDATE players SET last_seen = ? WHERE id = ?",
          now,
          player.id,
        );
      }
      this.refreshTtl(now);
      await this.scheduleAlarm();
      return this.json(
        this.identityPayload(
          this.getRoom()!,
          this.getPlayer(player.id)!,
          parsed.data.reconnectToken,
          true,
        ),
      );
    }

    if (room.phase !== "lobby") {
      return this.problem(409, "match-in-progress", "This match has already started");
    }
    const config = this.roomConfig(room);
    const activePlayers = this.activePlayers();
    if (activePlayers.length >= config.maxHumans) {
      return this.problem(409, "room-full", "The room has reached its human-player limit");
    }
    if (activePlayers.length + 1 + config.botCount > 21) {
      return this.problem(409, "room-full", "The match has reached 21 participants");
    }

    const playerId = crypto.randomUUID();
    const reconnectToken = createReconnectToken();
    const reconnectHash = await hashReconnectToken(reconnectToken);
    const occupiedSeats = new Set(activePlayers.map((candidate) => candidate.seat));
    let seat = 0;
    while (occupiedSeats.has(seat) && seat < config.maxHumans) seat += 1;
    if (seat >= config.maxHumans) {
      return this.problem(409, "room-full", "The room has no available human seat");
    }
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO players
          (id, seat, name, reconnect_hash, ready, connected, left_room,
           joined_at, last_seen, last_client_sequence, rate_window_at, rate_count)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, 0, ?, 0)`,
        playerId,
        seat,
        parsed.data.playerName,
        reconnectHash,
        now,
        now,
        now,
      );
      this.state.storage.sql.exec(
        "UPDATE room SET next_seat = ?, expires_at = ? WHERE code = ?",
        Math.max(room.next_seat, seat + 1),
        now + this.ttlSeconds * 1000,
        room.code,
      );
    });

    await this.scheduleAlarm();
    return this.json(
      this.identityPayload(this.getRoom()!, this.getPlayer(playerId)!, reconnectToken, false),
      201,
    );
  }

  private async connectWebSocket(request: Request, url: URL): Promise<Response> {
    const room = this.getRoom();
    if (!room) return this.problem(404, "room-not-found", "Room not found");
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return this.problem(426, "upgrade-required", "Expected a WebSocket upgrade");
    }

    const token = url.searchParams.get("token");
    if (!token) return this.problem(401, "missing-token", "Reconnect token is required");
    const reconnectHash = await hashReconnectToken(token);
    const player = this.rows<PlayerRow>(
      "SELECT * FROM players WHERE reconnect_hash = ? AND left_room = 0 LIMIT 1",
      reconnectHash,
    )[0];
    if (!player) {
      return this.problem(401, "invalid-token", "Reconnect token is invalid");
    }

    for (const previous of this.state.getWebSockets(`player:${player.id}`)) {
      if (previous.readyState === WebSocket.OPEN) {
        previous.close(4001, "Replaced by a newer connection");
      }
    }

    const pair = createWebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const now = Date.now();
    this.state.acceptWebSocket(server, ["room", `player:${player.id}`]);
    server.serializeAttachment({
      playerId: player.id,
      connectedAt: now,
    } satisfies ConnectionAttachment);
    this.state.storage.sql.exec(
      "UPDATE players SET connected = 1, last_seen = ? WHERE id = ?",
      now,
      player.id,
    );
    this.refreshTtl(now);

    const freshRoom = this.getRoom()!;
    const freshPlayer = this.getPlayer(player.id)!;
    this.send(server, {
      type: "welcome",
      roomCode: freshRoom.code,
      phase: freshRoom.phase,
      player: this.playerSummary(freshRoom, freshPlayer),
      config: this.roomConfig(freshRoom),
      latestSequence: freshRoom.next_sequence - 1,
      nextClientSequence: freshPlayer.last_client_sequence + 1,
      serverTick: this.roomServerTick(freshRoom),
    });
    this.send(server, this.lobbyPayload(freshRoom));
    if (freshRoom.phase !== "lobby") {
      this.send(server, this.startedPayload(freshRoom));
      this.sendSync(server, freshRoom);
      if (
        freshRoom.phase === "complete" &&
        freshRoom.winner_seat !== null &&
        freshRoom.final_tick !== null &&
        freshRoom.final_hash
      ) {
        this.send(server, {
          type: "complete",
          winnerSeat: freshRoom.winner_seat,
          finalTick: freshRoom.final_tick,
          hash: freshRoom.final_hash,
        });
      }
    }
    this.broadcast(this.lobbyPayload(freshRoom), server);
    await this.scheduleAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(
    socket: HibernatingWebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.ready;
    const attachment = this.connectionAttachment(socket);
    if (!attachment) {
      this.sendError(socket, "missing-session", "Connection identity was lost", false);
      socket.close(1011, "Missing session identity");
      return;
    }
    const player = this.getPlayer(attachment.playerId);
    if (!player || player.left_room === 1) {
      this.sendError(socket, "invalid-session", "Player is no longer in this room", false);
      socket.close(4003, "Player left room");
      return;
    }

    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(socket, "message-too-large", "Message exceeds 320 KiB", false);
      socket.close(1009, "Message too large");
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      this.sendError(socket, "invalid-json", "Message is not valid JSON", true);
      return;
    }
    const parsed = ClientMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.sendError(socket, "invalid-message", "Message failed schema validation", true);
      return;
    }
    const messages = parsed.data.type === "batch" ? parsed.data.messages : [parsed.data];
    if (!this.consumeRateLimit(player, messages.length)) {
      this.sendError(socket, "rate-limited", "Too many messages; slow down", true);
      return;
    }

    for (const atomicMessage of messages) {
      const reparsed = AtomicClientMessageSchema.parse(atomicMessage);
      await this.handleAtomicMessage(socket, this.getPlayer(player.id)!, reparsed);
      if (reparsed.type === "leave") break;
    }

    const fresh = this.getPlayer(player.id);
    if (fresh && fresh.left_room === 0) {
      const now = Date.now();
      this.state.storage.sql.exec("UPDATE players SET last_seen = ? WHERE id = ?", now, player.id);
      this.refreshTtl(now);
      await this.scheduleAlarm();
    } else if (this.getRoom()) {
      await this.scheduleAlarm();
    }
  }

  private async handleAtomicMessage(
    socket: HibernatingWebSocket,
    player: PlayerRow,
    message: AtomicClientMessage,
  ): Promise<void> {
    switch (message.type) {
      case "ready":
        this.handleReady(socket, player, message.ready, message.requestId);
        break;
      case "start":
        this.handleStart(socket, player, message.requestId);
        break;
      case "command":
        this.handleCommand(socket, player, message);
        break;
      case "hash":
        this.handleHash(socket, player, message);
        break;
      case "checkpoint":
        this.handleCheckpoint(socket, player, message);
        break;
      case "missing":
        this.handleMissing(socket, message.afterSequence, message.limit, message.requestId);
        break;
      case "leave":
        this.handleLeave(socket, player, message.requestId);
        break;
      case "complete":
        this.handleComplete(socket, player, message);
        break;
      case "ping":
        this.send(socket, {
          type: "pong",
          clientTime: message.clientTime,
          serverTime: Date.now(),
        });
        break;
    }
  }

  private handleReady(
    socket: HibernatingWebSocket,
    player: PlayerRow,
    ready: boolean,
    requestId?: string,
  ): void {
    const room = this.getRoom()!;
    if (room.phase !== "lobby") {
      this.sendError(socket, "match-started", "Ready state is locked after start", true, requestId);
      return;
    }
    this.state.storage.sql.exec(
      "UPDATE players SET ready = ? WHERE id = ?",
      ready ? 1 : 0,
      player.id,
    );
    this.sendAck(socket, "ready", requestId);
    this.broadcast(this.lobbyPayload(this.getRoom()!));
  }

  private handleStart(socket: HibernatingWebSocket, player: PlayerRow, requestId?: string): void {
    const room = this.getRoom()!;
    if (room.host_player_id !== player.id) {
      this.sendError(socket, "host-only", "Only the host can start the match", true, requestId);
      return;
    }
    if (room.phase !== "lobby") {
      this.sendError(socket, "already-started", "The match has already started", true, requestId);
      return;
    }
    const players = this.activePlayers();
    if (players.length < 2) {
      this.sendError(
        socket,
        "need-two-humans",
        "At least two human players must join",
        true,
        requestId,
      );
      return;
    }
    const config = this.roomConfig(room);
    if (players.length + config.botCount < MIN_MATCH_PARTICIPANTS) {
      this.sendError(
        socket,
        "insufficient-participants",
        `At least ${MIN_MATCH_PARTICIPANTS} total participants are required; this room currently has ${players.length} humans and ${config.botCount} bots`,
        true,
        requestId,
      );
      return;
    }
    if (players.some((candidate) => candidate.ready === 0)) {
      this.sendError(socket, "players-not-ready", "Every player must be ready", true, requestId);
      return;
    }
    if (players.some((candidate) => candidate.connected === 0)) {
      this.sendError(
        socket,
        "players-disconnected",
        "Every player must be connected when the match starts",
        true,
        requestId,
      );
      return;
    }

    const now = Date.now();
    this.state.storage.sql.exec(
      "UPDATE room SET phase = 'started', started_at = ?, expires_at = ? WHERE code = ?",
      now,
      now + this.ttlSeconds * 1000,
      room.code,
    );
    const freshRoom = this.getRoom()!;
    this.sendAck(socket, "start", requestId);
    this.broadcast(this.startedPayload(freshRoom));
  }

  private handleCommand(
    socket: HibernatingWebSocket,
    player: PlayerRow,
    message: Extract<AtomicClientMessage, { type: "command" }>,
  ): void {
    const room = this.getRoom()!;
    if (room.phase !== "started") {
      this.sendError(
        socket,
        "match-not-running",
        "Commands require a running match",
        true,
        message.requestId,
      );
      return;
    }
    if (message.command.playerId !== player.seat) {
      this.sendError(
        socket,
        "invalid-command-owner",
        "Command playerId does not own this connection",
        true,
        message.requestId,
      );
      return;
    }

    if (message.clientSequence <= player.last_client_sequence) {
      const existing = this.rows<CommandRow>(
        "SELECT * FROM commands WHERE player_id = ? AND client_sequence = ? LIMIT 1",
        player.id,
        message.clientSequence,
      )[0];
      if (existing) {
        this.send(socket, {
          type: "ack",
          action: "command",
          requestId: message.requestId,
          sequence: existing.sequence,
          targetTick: existing.target_tick,
          duplicate: true,
        });
      } else {
        this.sendError(
          socket,
          "stale-client-sequence",
          "Client sequence is stale",
          true,
          message.requestId,
        );
      }
      return;
    }
    if (message.clientSequence !== player.last_client_sequence + 1) {
      this.sendError(
        socket,
        "client-sequence-gap",
        `Expected client sequence ${player.last_client_sequence + 1}`,
        true,
        message.requestId,
      );
      return;
    }

    const now = Date.now();
    const ordered = this.state.storage.transactionSync(() => {
      const currentRoom = this.getRoom()!;
      const assignment = assignRelayOrder({
        nextSequence: currentRoom.next_sequence,
        currentTick: currentServerTick(currentRoom.started_at, now),
        lastTargetTick: currentRoom.last_target_tick,
        leadTicks: this.leadTicks,
      });
      const command = {
        ...message.command,
        scheduledTick: assignment.targetTick,
      };
      this.state.storage.sql.exec(
        `INSERT INTO commands
          (sequence, player_id, player_seat, client_sequence, target_tick,
           command_json, created_at, broadcasted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        assignment.sequence,
        player.id,
        player.seat,
        message.clientSequence,
        assignment.targetTick,
        JSON.stringify(command),
        now,
      );
      this.state.storage.sql.exec(
        "UPDATE room SET next_sequence = ?, last_target_tick = ? WHERE code = ?",
        assignment.sequence + 1,
        assignment.targetTick,
        currentRoom.code,
      );
      this.state.storage.sql.exec(
        "UPDATE players SET last_client_sequence = ? WHERE id = ?",
        message.clientSequence,
        player.id,
      );
      return {
        sequence: assignment.sequence,
        targetTick: assignment.targetTick,
      };
    });

    this.send(socket, {
      type: "ack",
      action: "command",
      requestId: message.requestId,
      sequence: ordered.sequence,
      targetTick: ordered.targetTick,
    });
  }

  private handleHash(
    socket: HibernatingWebSocket,
    player: PlayerRow,
    message: Extract<AtomicClientMessage, { type: "hash" }>,
  ): void {
    const room = this.getRoom()!;
    if (room.phase === "lobby") {
      this.sendError(
        socket,
        "match-not-running",
        "Hashes require a running match",
        true,
        message.requestId,
      );
      return;
    }
    const latestSequence = room.next_sequence - 1;
    if (message.sequence > latestSequence) {
      this.sendError(
        socket,
        "future-sequence",
        "Hash references an unknown sequence",
        true,
        message.requestId,
      );
      return;
    }
    if (message.tick > currentServerTick(room.started_at) + 50) {
      this.sendError(
        socket,
        "future-tick",
        "Hash tick is too far ahead of the room clock",
        true,
        message.requestId,
      );
      return;
    }

    this.state.storage.sql.exec(
      `INSERT INTO state_hashes (tick, player_id, sequence, state_hash, reported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tick, player_id) DO UPDATE SET
         sequence = excluded.sequence,
         state_hash = excluded.state_hash,
         reported_at = excluded.reported_at`,
      message.tick,
      player.id,
      message.sequence,
      message.hash.toLowerCase(),
      Date.now(),
    );
    this.state.storage.sql.exec(
      "DELETE FROM state_hashes WHERE tick < ?",
      Math.max(0, message.tick - 1000),
    );

    const reports = this.rows<{ player_id: string; state_hash: string }>(
      `SELECT h.player_id, h.state_hash
       FROM state_hashes h
       JOIN players p ON p.id = h.player_id
       WHERE h.tick = ? AND p.left_room = 0`,
      message.tick,
    );
    const hashes = Object.fromEntries(
      reports.map((report) => [report.player_id, report.state_hash]),
    );
    const comparison = compareStateHashes(hashes);
    if (comparison.desynchronized) {
      const existing = this.rows<{ tick: number }>(
        "SELECT tick FROM desync_notices WHERE tick = ? LIMIT 1",
        message.tick,
      )[0];
      if (!existing) {
        this.state.storage.sql.exec(
          "INSERT INTO desync_notices (tick, reported_at) VALUES (?, ?)",
          message.tick,
          Date.now(),
        );
        this.broadcast({
          type: "desync",
          tick: message.tick,
          sequence: message.sequence,
          hashes,
          majorityHash: comparison.majorityHash,
          message: "Clients reported different deterministic state hashes",
        });
      }
    }
    this.sendAck(socket, "hash", message.requestId);
  }

  private handleCheckpoint(
    socket: HibernatingWebSocket,
    player: PlayerRow,
    message: Extract<AtomicClientMessage, { type: "checkpoint" }>,
  ): void {
    const room = this.getRoom()!;
    if (room.host_player_id !== player.id) {
      this.sendError(
        socket,
        "host-only",
        "Only the host can publish checkpoints",
        true,
        message.requestId,
      );
      return;
    }
    if (room.phase !== "started") {
      this.sendError(
        socket,
        "match-not-running",
        "Checkpoint requires a running match",
        true,
        message.requestId,
      );
      return;
    }
    if (message.sequence > room.next_sequence - 1) {
      this.sendError(
        socket,
        "future-sequence",
        "Checkpoint references an unknown sequence",
        true,
        message.requestId,
      );
      return;
    }
    const serverTick = this.roomServerTick(room);
    if (message.tick > serverTick) {
      this.sendError(
        socket,
        "checkpoint-future-tick",
        `Checkpoint tick ${message.tick} is ahead of server tick ${serverTick}`,
        true,
        message.requestId,
      );
      return;
    }
    const latestCheckpoint = this.latestCheckpoint();
    if (
      latestCheckpoint &&
      (message.sequence < latestCheckpoint.sequence || message.tick < latestCheckpoint.tick)
    ) {
      this.sendError(
        socket,
        "checkpoint-rollback",
        "Checkpoint sequence and tick must not move backward",
        true,
        message.requestId,
      );
      return;
    }
    const pending =
      this.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commands WHERE sequence <= ? AND broadcasted = 0",
        message.sequence,
      )[0]?.count ?? 0;
    if (pending > 0) {
      this.sendError(
        socket,
        "checkpoint-before-broadcast",
        "Wait for accepted commands to be broadcast before checkpointing",
        true,
        message.requestId,
      );
      return;
    }
    const commandsScheduledAfterCheckpoint =
      this.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM commands WHERE sequence <= ? AND target_tick > ?",
        message.sequence,
        message.tick,
      )[0]?.count ?? 0;
    if (commandsScheduledAfterCheckpoint > 0) {
      this.sendError(
        socket,
        "checkpoint-before-command-tick",
        "Checkpoint tick must include every command covered by its sequence",
        true,
        message.requestId,
      );
      return;
    }

    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO checkpoints
          (sequence, tick, state_hash, encoding, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (sequence) DO UPDATE SET
           tick = excluded.tick,
           state_hash = excluded.state_hash,
           encoding = excluded.encoding,
           payload = excluded.payload,
           created_at = excluded.created_at`,
        message.sequence,
        message.tick,
        message.hash.toLowerCase(),
        message.encoding,
        message.payload,
        Date.now(),
      );
      this.state.storage.sql.exec("DELETE FROM checkpoints WHERE sequence < ?", message.sequence);
      this.state.storage.sql.exec("DELETE FROM commands WHERE sequence <= ?", message.sequence);
      this.state.storage.sql.exec("DELETE FROM state_hashes WHERE tick < ?", message.tick);
    });
    this.sendAck(socket, "checkpoint", message.requestId);
  }

  private handleMissing(
    socket: HibernatingWebSocket,
    afterSequence: number,
    limit: number,
    requestId?: string,
  ): void {
    const room = this.getRoom()!;
    const checkpoint = this.latestCheckpoint();
    const effectiveAfter =
      checkpoint && afterSequence < checkpoint.sequence ? checkpoint.sequence : afterSequence;
    const commands = this.commandRowsAfter(effectiveAfter, limit + 1);
    const hasMore = commands.length > limit;
    const page = commands.slice(0, limit).map((row) => this.orderedCommand(row));

    if (checkpoint && afterSequence < checkpoint.sequence) {
      this.send(socket, {
        type: "sync",
        checkpoint,
        commands: page,
        latestSequence: room.next_sequence - 1,
        serverTick: this.roomServerTick(room),
        hasMore,
      });
    } else {
      this.send(socket, {
        type: "command-batch",
        commands: page,
        latestSequence: room.next_sequence - 1,
        serverTick: this.roomServerTick(room),
        replay: true,
        hasMore,
      });
    }
    this.sendAck(socket, "missing", requestId);
  }

  private handleComplete(
    socket: HibernatingWebSocket,
    player: PlayerRow,
    message: Extract<AtomicClientMessage, { type: "complete" }>,
  ): void {
    const room = this.getRoom()!;
    if (room.host_player_id !== player.id) {
      this.sendError(
        socket,
        "host-only",
        "Only the host can complete the match",
        true,
        message.requestId,
      );
      return;
    }
    if (room.phase !== "started") {
      this.sendError(
        socket,
        "match-not-running",
        "The match is not running",
        true,
        message.requestId,
      );
      return;
    }
    const participantCount = room.next_seat + this.roomConfig(room).botCount;
    if (message.winnerSeat >= participantCount) {
      this.sendError(
        socket,
        "invalid-winner",
        "Winner seat is outside the configured participant range",
        true,
        message.requestId,
      );
      return;
    }
    const validation = CompleteMessageSchema.safeParse(message);
    if (!validation.success) {
      this.sendError(
        socket,
        "invalid-completion",
        "Invalid completion report",
        true,
        message.requestId,
      );
      return;
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `UPDATE room SET phase = 'complete', completed_at = ?, winner_seat = ?,
         final_tick = ?, final_hash = ?, expires_at = ? WHERE code = ?`,
      now,
      message.winnerSeat,
      message.finalTick,
      message.hash.toLowerCase(),
      now + this.ttlSeconds * 1000,
      room.code,
    );
    this.sendAck(socket, "complete", message.requestId);
    this.broadcast({
      type: "complete",
      winnerSeat: message.winnerSeat,
      finalTick: message.finalTick,
      hash: message.hash,
    });
  }

  private handleLeave(socket: HibernatingWebSocket, player: PlayerRow, requestId?: string): void {
    const room = this.getRoom()!;
    if (room.phase === "lobby") {
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec("DELETE FROM players WHERE id = ?", player.id);
        const remaining = this.activePlayers();
        remaining.forEach((candidate, seat) => {
          if (candidate.seat !== seat) {
            this.state.storage.sql.exec(
              "UPDATE players SET seat = ? WHERE id = ?",
              seat,
              candidate.id,
            );
          }
        });
        this.state.storage.sql.exec(
          "UPDATE room SET next_seat = ? WHERE code = ?",
          remaining.length,
          room.code,
        );
      });
    } else {
      this.state.storage.sql.exec(
        "UPDATE players SET left_room = 1, connected = 0, ready = 0 WHERE id = ?",
        player.id,
      );
    }
    if (room.host_player_id === player.id) {
      const replacement = this.activePlayers()[0];
      if (replacement) {
        this.state.storage.sql.exec(
          "UPDATE room SET host_player_id = ? WHERE code = ?",
          replacement.id,
          room.code,
        );
      }
    }

    this.sendAck(socket, "leave", requestId);
    const freshRoom = this.getRoom()!;
    this.broadcast(this.lobbyPayload(freshRoom), socket);
    for (const playerSocket of this.state.getWebSockets(`player:${player.id}`)) {
      playerSocket.close(1000, "Left room");
    }
    if (this.activePlayers().length === 0) {
      this.state.storage.sql.exec(
        "UPDATE room SET expires_at = ? WHERE code = ?",
        Date.now() + 5 * 60 * 1000,
        freshRoom.code,
      );
    }
  }

  async webSocketClose(
    socket: HibernatingWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void wasClean;
    await this.ready;
    const attachment = this.connectionAttachment(socket);
    if (!attachment) return;
    const hasAnotherOpenSocket = this.state
      .getWebSockets(`player:${attachment.playerId}`)
      .some((candidate) => candidate !== socket && candidate.readyState === WebSocket.OPEN);
    if (!hasAnotherOpenSocket) {
      this.state.storage.sql.exec(
        "UPDATE players SET connected = 0, last_seen = ? WHERE id = ?",
        Date.now(),
        attachment.playerId,
      );
      const room = this.getRoom();
      if (room) this.broadcast(this.lobbyPayload(room), socket);
    }
    if (socket.readyState !== WebSocket.CLOSED) socket.close(code, reason);
    if (this.getRoom()) await this.scheduleAlarm();
  }

  async webSocketError(socket: HibernatingWebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011, "WebSocket error", false);
  }

  async alarm(): Promise<void> {
    await this.ready;
    const room = this.getRoom();
    if (!room) return;
    if (room.expires_at <= Date.now()) {
      this.broadcast({
        type: "error",
        code: "room-expired",
        message: "Room expired after its inactivity TTL",
        recoverable: false,
      });
      for (const socket of this.state.getWebSockets()) {
        socket.close(4004, "Room expired");
      }
      await this.state.storage.deleteAll();
      // The hibernated object instance can survive storage deletion. Recreate the
      // empty schema so a later status probe returns a clean 404 instead of a
      // SQLite "no such table" error.
      this.initialize();
      return;
    }

    for (let batchNumber = 0; batchNumber < 10; batchNumber += 1) {
      const rows = this.rows<CommandRow>(
        `SELECT * FROM commands WHERE broadcasted = 0
         ORDER BY sequence ASC LIMIT ?`,
        MAX_COMMAND_BATCH,
      );
      if (rows.length === 0) break;
      const currentRoom = this.getRoom()!;
      this.broadcast({
        type: "command-batch",
        commands: rows.map((row) => this.orderedCommand(row)),
        latestSequence: currentRoom.next_sequence - 1,
        serverTick: this.roomServerTick(currentRoom),
        replay: false,
        hasMore: rows.length === MAX_COMMAND_BATCH,
      });
      const lastSequence = rows.at(-1)!.sequence;
      this.state.storage.sql.exec(
        "UPDATE commands SET broadcasted = 1 WHERE sequence <= ? AND broadcasted = 0",
        lastSequence,
      );
    }
    await this.scheduleAlarm();
  }

  private sendInitialSync(socket: HibernatingWebSocket, room: RoomRow): void {
    const checkpoint = this.latestCheckpoint();
    const afterSequence = checkpoint?.sequence ?? 0;
    const rows = this.commandRowsAfter(afterSequence, RECONNECT_SYNC_LIMIT + 1);
    this.send(socket, {
      type: "sync",
      checkpoint,
      commands: rows.slice(0, RECONNECT_SYNC_LIMIT).map((row) => this.orderedCommand(row)),
      latestSequence: room.next_sequence - 1,
      serverTick: this.roomServerTick(room),
      hasMore: rows.length > RECONNECT_SYNC_LIMIT,
    });
  }

  private sendSync(socket: HibernatingWebSocket, room: RoomRow): void {
    this.sendInitialSync(socket, room);
  }

  private async scheduleAlarm(): Promise<void> {
    const room = this.getRoom();
    if (!room) return;
    const pending = this.rows<{ sequence: number }>(
      "SELECT sequence FROM commands WHERE broadcasted = 0 ORDER BY sequence LIMIT 1",
    )[0];
    const target = pending
      ? Math.min(room.expires_at, Date.now() + BATCH_WINDOW_MS)
      : room.expires_at;
    await this.state.storage.setAlarm(target);
  }

  private refreshTtl(now = Date.now()): void {
    const room = this.getRoom();
    if (!room) return;
    this.state.storage.sql.exec(
      "UPDATE room SET expires_at = ? WHERE code = ?",
      now + this.ttlSeconds * 1000,
      room.code,
    );
  }

  private consumeRateLimit(player: PlayerRow, logicalMessages: number): boolean {
    const now = Date.now();
    const reset = now - player.rate_window_at >= RATE_WINDOW_MS;
    const count = reset ? logicalMessages : player.rate_count + logicalMessages;
    this.state.storage.sql.exec(
      "UPDATE players SET rate_window_at = ?, rate_count = ? WHERE id = ?",
      reset ? now : player.rate_window_at,
      count,
      player.id,
    );
    return count <= MAX_LOGICAL_MESSAGES_PER_WINDOW;
  }

  private lobbyPayload(room: RoomRow) {
    const config = this.roomConfig(room);
    const players = this.playerSummaries(room);
    return {
      type: "lobby" as const,
      roomCode: room.code,
      phase: room.phase,
      config,
      players,
      totalParticipants: players.length + config.botCount,
    };
  }

  private startedPayload(room: RoomRow) {
    if (room.started_at === null) {
      throw new Error("Started room is missing its start timestamp");
    }
    return {
      type: "started" as const,
      startedAt: room.started_at,
      startTick: 0 as const,
      config: this.roomConfig(room),
      players: this.rows<PlayerRow>("SELECT * FROM players ORDER BY seat ASC").map((player) =>
        this.playerSummary(room, player),
      ),
    };
  }

  private identityPayload(
    room: RoomRow,
    player: PlayerRow,
    reconnectToken: string,
    reconnected: boolean,
  ) {
    return {
      roomCode: room.code,
      phase: room.phase,
      config: this.roomConfig(room),
      player: this.playerSummary(room, player),
      reconnectToken,
      reconnected,
      latestSequence: room.next_sequence - 1,
    };
  }

  private playerSummaries(room: RoomRow): PlayerSummary[] {
    return this.activePlayers().map((player) => this.playerSummary(room, player));
  }

  private playerSummary(room: RoomRow, player: PlayerRow): PlayerSummary {
    return {
      id: player.id,
      seat: player.seat,
      name: player.name,
      ready: player.ready === 1,
      connected: player.connected === 1,
      isHost: room.host_player_id === player.id,
    };
  }

  private activePlayers(): PlayerRow[] {
    return this.rows<PlayerRow>("SELECT * FROM players WHERE left_room = 0 ORDER BY seat ASC");
  }

  private getRoom(): RoomRow | undefined {
    return this.rows<RoomRow>("SELECT * FROM room LIMIT 1")[0];
  }

  private getPlayer(playerId: string): PlayerRow | undefined {
    return this.rows<PlayerRow>("SELECT * FROM players WHERE id = ? LIMIT 1", playerId)[0];
  }

  private roomConfig(room: RoomRow): RoomConfig {
    return RoomConfigSchema.parse(JSON.parse(room.config_json));
  }

  /** Wall-clock simulation position while running; immutable final position after completion. */
  private roomServerTick(room: RoomRow): number {
    return room.phase === "complete" && room.final_tick !== null
      ? room.final_tick
      : currentServerTick(room.started_at);
  }

  private latestCheckpoint(): Checkpoint | null {
    const row = this.rows<CheckpointRow>(
      "SELECT * FROM checkpoints ORDER BY sequence DESC LIMIT 1",
    )[0];
    return row
      ? {
          sequence: row.sequence,
          tick: row.tick,
          hash: row.state_hash,
          encoding: row.encoding,
          payload: row.payload,
        }
      : null;
  }

  private commandRowsAfter(sequence: number, limit: number): CommandRow[] {
    return this.rows<CommandRow>(
      "SELECT * FROM commands WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
      sequence,
      limit,
    );
  }

  private orderedCommand(row: CommandRow): OrderedCommand {
    return {
      sequence: row.sequence,
      targetTick: row.target_tick,
      playerId: row.player_id,
      playerSeat: row.player_seat,
      clientSequence: row.client_sequence,
      command: JSON.parse(row.command_json) as OrderedCommand["command"],
    };
  }

  private connectionAttachment(socket: HibernatingWebSocket): ConnectionAttachment | null {
    const value = socket.deserializeAttachment() as Partial<ConnectionAttachment> | null;
    return value && typeof value.playerId === "string"
      ? { playerId: value.playerId, connectedAt: Number(value.connectedAt ?? 0) }
      : null;
  }

  private broadcast(payload: unknown, except?: HibernatingWebSocket): void {
    const serialized = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets("room")) {
      if (socket === except || socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(serialized);
      } catch {
        socket.close(1011, "Broadcast failed");
      }
    }
  }

  private send(socket: HibernatingWebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  private sendAck(
    socket: HibernatingWebSocket,
    action: "ready" | "start" | "hash" | "checkpoint" | "missing" | "leave" | "complete",
    requestId?: string,
  ): void {
    this.send(socket, { type: "ack", action, requestId });
  }

  private sendError(
    socket: HibernatingWebSocket,
    code: string,
    message: string,
    recoverable: boolean,
    requestId?: string,
  ): void {
    this.send(socket, { type: "error", code, message, recoverable, requestId });
  }

  private rows<Row>(query: string, ...bindings: (string | number | null)[]): Row[] {
    return this.state.storage.sql.exec<Row>(query, ...bindings).toArray();
  }

  private async parseJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  private json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  private problem(status: number, code: string, message: string, details?: unknown): Response {
    return this.json({ error: { code, message, details } }, status);
  }
}

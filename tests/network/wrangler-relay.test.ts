import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stableHash } from "../../src/core/hash";

interface Identity {
  roomCode: string;
  phase: "lobby" | "placement" | "started" | "complete";
  reconnectToken: string;
  websocketUrl: string;
  reconnected: boolean;
  player: { seat: number };
}

interface RelayMessage {
  type?: string;
  requestId?: string;
  code?: string;
  recoverable?: boolean;
  sequence?: number;
  targetTick?: number;
  latestSequence?: number;
  serverTick?: number;
  replay?: boolean;
  majorityHash?: string | null;
  phase?: "lobby" | "placement" | "started" | "complete";
  winnerSeat?: number;
  finalTick?: number;
  hash?: string;
  hashes?: Record<string, string>;
  checkpoint?: { sequence: number; encoding?: string; payload: string } | null;
  players?: Array<{ ready: boolean; seat?: number; isHost?: boolean }>;
  selections?: Array<{ seat: number; centerId: string | null; locked: boolean }>;
  spawnCenters?: string[];
  commands?: Array<{
    sequence: number;
    targetTick: number;
    command: { scheduledTick?: number };
  }>;
}

class SocketInbox {
  readonly socket: WebSocket;
  private readonly messages: unknown[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (event) => {
      this.messages.push(JSON.parse(String(event.data)));
      for (const wake of this.waiters) wake();
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await Promise.race([
      once(this.socket, "open"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000),
      ),
    ]);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async take(
    predicate: (value: RelayMessage) => boolean,
    timeoutMs = 7_000,
  ): Promise<RelayMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex((value) => predicate(value as RelayMessage));
      if (index >= 0) return this.messages.splice(index, 1)[0] as RelayMessage;
      await new Promise<void>((resolveWait) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolveWait();
        };
        const timer = setTimeout(wake, Math.min(100, deadline - Date.now()));
        this.waiters.add(wake);
      });
    }
    throw new Error(
      `Timed out waiting for WebSocket message; queued=${JSON.stringify(this.messages)}`,
    );
  }

  close(): void {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "Test complete");
  }
}

describe("local Wrangler multiplayer relay", () => {
  const port = 18_800 + (process.pid % 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  let wrangler: ChildProcessWithoutNullStreams;
  let wranglerOutput = "";

  beforeAll(async () => {
    const executable = resolve("node_modules/wrangler/bin/wrangler.js");
    wrangler = spawn(
      process.execPath,
      [
        executable,
        "dev",
        "--config",
        "wrangler.multiplayer.jsonc",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-level",
        "info",
        "--show-interactive-dev-session=false",
        "--var",
        "ROOM_TTL_SECONDS:3",
        "--persist-to",
        `.wrangler/network-test-${process.pid}`,
      ],
      { cwd: resolve("."), env: { ...process.env, CI: "1" } },
    );
    wrangler.stdout.on("data", (chunk) => (wranglerOutput += String(chunk)));
    wrangler.stderr.on("data", (chunk) => (wranglerOutput += String(chunk)));

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (wrangler.exitCode !== null) {
        throw new Error(`Wrangler exited before readiness:\n${wranglerOutput}`);
      }
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) return;
      } catch {
        // Local runtime is still booting.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Wrangler readiness timed out:\n${wranglerOutput}`);
  }, 20_000);

  afterAll(async () => {
    if (!wrangler || wrangler.exitCode !== null) return;
    wrangler.kill("SIGTERM");
    await Promise.race([
      once(wrangler, "exit"),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
    ]);
  });

  it("creates, joins, orders, checks hashes, checkpoints, and reconnects", async () => {
    const host = await postIdentity(`${baseUrl}/api/rooms`, {
      playerName: "Host",
      config: {
        seed: "network-fixture",
        archetype: "heartland",
        difficulty: "normal",
        botCount: 0,
        maxHumans: 2,
      },
    });
    expect(host.roomCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(host.player.seat).toBe(0);

    const guest = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Guest",
    });
    expect(guest.player.seat).toBe(1);

    const hostSocket = new SocketInbox(host.websocketUrl);
    const guestSocket = new SocketInbox(guest.websocketUrl);
    await Promise.all([hostSocket.open(), guestSocket.open()]);
    await Promise.all([
      hostSocket.take((message) => message.type === "welcome"),
      guestSocket.take((message) => message.type === "welcome"),
    ]);

    guestSocket.send({ type: "ready", ready: true, requestId: "ready-guest" });
    await guestSocket.take(
      (message) => message.type === "ack" && message.requestId === "ready-guest",
    );
    await hostSocket.take(
      (message) =>
        message.type === "lobby" &&
        message.players?.length === 2 &&
        message.players.every((player) => player.ready),
    );

    hostSocket.send({ type: "start", requestId: "start" });
    await Promise.all([
      hostSocket.take((message) => message.type === "placement"),
      guestSocket.take((message) => message.type === "placement"),
    ]);
    const candidates = ["0,0", "12,0", "6,0"];
    const candidateHash = stableHash({ generationAttempt: 0, candidates });
    guestSocket.send({
      type: "placement-candidates",
      generationAttempt: 0,
      candidateHash,
      candidates,
      requestId: "guest-candidate-poison",
    });
    expect(
      await guestSocket.take(
        (message) => message.type === "error" && message.requestId === "guest-candidate-poison",
      ),
    ).toMatchObject({ code: "placement-candidates-host-only", recoverable: false });
    hostSocket.send({
      type: "placement-candidates",
      generationAttempt: 0,
      candidateHash: "0123456789abcdef",
      candidates,
      requestId: "bad-candidate-hash",
    });
    expect(
      await hostSocket.take(
        (message) => message.type === "error" && message.requestId === "bad-candidate-hash",
      ),
    ).toMatchObject({ code: "placement-candidate-hash", recoverable: false });
    hostSocket.send({
      type: "placement-candidates",
      generationAttempt: 0,
      candidateHash,
      candidates,
      requestId: "placement-candidates",
    });
    await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "placement-candidates",
    );
    hostSocket.send({
      type: "placement-claim",
      centerId: "0,0",
      requestId: "host-claim",
    });
    guestSocket.send({
      type: "placement-claim",
      centerId: "6,0",
      requestId: "guest-claim",
    });
    await Promise.all([
      hostSocket.take((message) => message.type === "ack" && message.requestId === "host-claim"),
      guestSocket.take((message) => message.type === "ack" && message.requestId === "guest-claim"),
    ]);
    hostSocket.send({ type: "placement-lock", centerId: "0,0", requestId: "host-lock" });
    guestSocket.send({ type: "placement-lock", centerId: "6,0", requestId: "guest-lock" });
    await Promise.all([
      hostSocket.take((message) => message.type === "ack" && message.requestId === "host-lock"),
      guestSocket.take((message) => message.type === "ack" && message.requestId === "guest-lock"),
    ]);
    hostSocket.send({
      type: "placement-finalize",
      generationAttempt: 0,
      candidateHash,
      spawnCenters: ["0,0", "6,0"],
      requestId: "placement-finalize",
    });
    await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "placement-finalize",
    );
    await Promise.all([
      hostSocket
        .take((message) => message.type === "started", 8_000)
        .then((message) => expect(message.spawnCenters).toEqual(["0,0", "6,0"])),
      guestSocket
        .take((message) => message.type === "started", 8_000)
        .then((message) => expect(message.spawnCenters).toEqual(["0,0", "6,0"])),
    ]);

    guestSocket.send({
      type: "command",
      clientSequence: 1,
      requestId: "wrong-owner",
      command: {
        type: "move",
        playerId: 0,
        sourceId: "0,0",
        destinationId: "1,0",
        percent: 50,
      },
    });
    expect(
      await guestSocket.take(
        (message) => message.type === "error" && message.requestId === "wrong-owner",
      ),
    ).toMatchObject({ code: "invalid-command-owner", recoverable: true });

    hostSocket.send({
      type: "command",
      clientSequence: 1,
      requestId: "command-1",
      command: {
        type: "move",
        playerId: 0,
        sourceId: "0,0",
        destinationId: "1,0",
        percent: 50,
      },
    });
    const commandAck = await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "command-1",
    );
    expect(commandAck.sequence).toBe(1);
    expect(commandAck.targetTick).toBeGreaterThan(0);
    const [hostBatch, guestBatch] = await Promise.all([
      hostSocket.take(
        (message) =>
          message.type === "command-batch" &&
          message.commands?.some((command) => command.sequence === 1) === true,
      ),
      guestSocket.take(
        (message) =>
          message.type === "command-batch" &&
          message.commands?.some((command) => command.sequence === 1) === true,
      ),
    ]);
    expect(hostBatch.commands?.[0]?.targetTick).toBe(commandAck.targetTick);
    expect(guestBatch.commands?.[0]?.command.scheduledTick).toBe(commandAck.targetTick);

    hostSocket.send({
      type: "command",
      clientSequence: 1,
      requestId: "command-1-retry",
      command: {
        type: "move",
        playerId: 0,
        sourceId: "0,0",
        destinationId: "1,0",
        percent: 50,
      },
    });
    expect(
      await hostSocket.take(
        (message) => message.type === "ack" && message.requestId === "command-1-retry",
      ),
    ).toMatchObject({ sequence: 1, duplicate: true });

    hostSocket.send({
      type: "checkpoint",
      tick: 0,
      sequence: 1,
      hash: "aaaaaaaa",
      encoding: "json",
      payload: '{"checkpoint":0}',
      requestId: "checkpoint-before-command",
    });
    expect(
      await hostSocket.take(
        (message) => message.type === "error" && message.requestId === "checkpoint-before-command",
      ),
    ).toMatchObject({ code: "checkpoint-before-command-tick", recoverable: true });

    const checkpointTick = commandAck.targetTick!;
    hostSocket.send({
      type: "checkpoint",
      tick: checkpointTick + 100,
      sequence: 1,
      hash: "aaaaaaaa",
      encoding: "json",
      payload: '{"checkpoint":"future"}',
      requestId: "checkpoint-future-tick",
    });
    expect(
      await hostSocket.take(
        (message) => message.type === "error" && message.requestId === "checkpoint-future-tick",
      ),
    ).toMatchObject({ code: "checkpoint-future-tick", recoverable: true });

    await waitForServerTick(hostSocket, 1, checkpointTick);
    hostSocket.send({
      type: "checkpoint",
      tick: checkpointTick,
      sequence: 1,
      hash: "aaaaaaaa",
      encoding: "gzip-base64",
      payload: "H4sIAAAAAAAA/6tWSs5IzMtLLS5RslIyrAUAZcRIexAAAAA=",
      requestId: "checkpoint-1",
    });
    await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "checkpoint-1",
    );

    guestSocket.send({
      type: "command",
      clientSequence: 2,
      requestId: "sequence-gap",
      command: {
        type: "build",
        playerId: 1,
        tileId: "2,0",
        structure: "wizard-tower",
      },
    });
    expect(
      await guestSocket.take(
        (message) => message.type === "error" && message.requestId === "sequence-gap",
      ),
    ).toMatchObject({ code: "client-sequence-gap" });

    guestSocket.send({
      type: "command",
      clientSequence: 1,
      requestId: "guest-command",
      command: {
        type: "build",
        playerId: 1,
        tileId: "2,0",
        structure: "wizard-tower",
      },
    });
    const guestAck = await guestSocket.take(
      (message) => message.type === "ack" && message.requestId === "guest-command",
    );
    expect(guestAck.sequence).toBe(2);
    expect(guestAck.targetTick).toBeGreaterThanOrEqual(commandAck.targetTick ?? 0);
    await Promise.all([
      hostSocket.take(
        (message) =>
          message.type === "command-batch" &&
          message.commands?.some((command) => command.sequence === 2) === true,
      ),
      guestSocket.take(
        (message) =>
          message.type === "command-batch" &&
          message.commands?.some((command) => command.sequence === 2) === true,
      ),
    ]);

    hostSocket.send({
      type: "command",
      clientSequence: 2,
      requestId: "command-3",
      command: {
        type: "move",
        playerId: 0,
        sourceId: "0,0",
        destinationId: "1,0",
        percent: 25,
      },
    });
    const thirdAck = await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "command-3",
    );
    expect(thirdAck).toMatchObject({ sequence: 3 });
    await Promise.all([
      hostSocket.take(
        (message) =>
          message.type === "command-batch" &&
          message.commands?.some((command) => command.sequence === 3) === true,
      ),
      guestSocket.take(
        (message) =>
          message.type === "command-batch" &&
          message.commands?.some((command) => command.sequence === 3) === true,
      ),
    ]);
    await waitForServerTick(hostSocket, 2, thirdAck.targetTick!);
    hostSocket.send({
      type: "checkpoint",
      tick: thirdAck.targetTick!,
      sequence: 2,
      hash: "aaaaaaaa",
      encoding: "json",
      payload: '{"checkpoint":"skips-sequence-3"}',
      requestId: "checkpoint-skips-command",
    });
    expect(
      await hostSocket.take(
        (message) => message.type === "error" && message.requestId === "checkpoint-skips-command",
      ),
    ).toMatchObject({ code: "checkpoint-uncovered-command", recoverable: true });

    hostSocket.send({ type: "hash", tick: 20, sequence: 2, hash: "aaaaaaaa" });
    guestSocket.send({ type: "hash", tick: 20, sequence: 2, hash: "bbbbbbbb" });
    const desync = await hostSocket.take((message) => message.type === "desync");
    expect(Object.values(desync.hashes ?? {}).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    expect(desync.majorityHash).toBeNull();

    guestSocket.send({
      type: "missing",
      afterSequence: 0,
      requestId: "missing",
    });
    const recovery = await guestSocket.take(
      (message) => message.type === "sync" && message.checkpoint?.sequence === 1,
    );
    expect(recovery.checkpoint).toMatchObject({
      encoding: "gzip-base64",
      payload: "H4sIAAAAAAAA/6tWSs5IzMtLLS5RslIyrAUAZcRIexAAAAA=",
    });
    expect(recovery.commands?.map((command) => command.sequence)).toEqual([2, 3]);
    expect(recovery.serverTick).toBeGreaterThanOrEqual(checkpointTick);

    guestSocket.close();
    const reconnected = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Guest",
      reconnectToken: guest.reconnectToken,
    });
    expect(reconnected.reconnected).toBe(true);
    expect(reconnected.player.seat).toBe(1);
    const replacement = new SocketInbox(reconnected.websocketUrl);
    await replacement.open();
    await replacement.take((message) => message.type === "welcome");
    const reconnectSync = await replacement.take(
      (message) => message.type === "sync" && message.checkpoint?.sequence === 1,
    );
    expect(reconnectSync.latestSequence).toBe(3);
    expect(reconnectSync.commands?.map((command) => command.sequence)).toEqual([2, 3]);
    expect(reconnectSync.serverTick).toBeGreaterThanOrEqual(checkpointTick);

    hostSocket.send({
      type: "complete",
      winnerSeat: 0,
      finalTick: 30,
      hash: "aaaaaaaa",
      requestId: "complete",
    });
    await hostSocket.take((message) => message.type === "ack" && message.requestId === "complete");
    expect(await replacement.take((message) => message.type === "complete")).toMatchObject({
      winnerSeat: 0,
      finalTick: 30,
      hash: "aaaaaaaa",
    });

    replacement.close();
    const completedIdentity = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Guest",
      reconnectToken: guest.reconnectToken,
    });
    expect(completedIdentity.phase).toBe("complete");
    const completedSocket = new SocketInbox(completedIdentity.websocketUrl);
    await completedSocket.open();
    expect(await completedSocket.take((message) => message.type === "welcome")).toMatchObject({
      phase: "complete",
      serverTick: 30,
    });
    await completedSocket.take((message) => message.type === "started");
    await completedSocket.take((message) => message.type === "sync");
    expect(await completedSocket.take((message) => message.type === "complete")).toMatchObject({
      winnerSeat: 0,
      finalTick: 30,
      hash: "aaaaaaaa",
    });

    completedSocket.close();
    hostSocket.close();
  }, 20_000);

  it("preserves provisional placement through reconnect and rejects conflicting finals", async () => {
    const host = await postIdentity(`${baseUrl}/api/rooms`, {
      playerName: "Placement Host",
      config: {
        seed: "placement-reconnect",
        archetype: "heartland",
        difficulty: "normal",
        botCount: 0,
        maxHumans: 2,
      },
    });
    const guest = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Placement Guest",
    });
    const hostSocket = new SocketInbox(host.websocketUrl);
    const guestSocket = new SocketInbox(guest.websocketUrl);
    await Promise.all([hostSocket.open(), guestSocket.open()]);
    await Promise.all([
      hostSocket.take((message) => message.type === "welcome"),
      guestSocket.take((message) => message.type === "welcome"),
    ]);
    guestSocket.send({ type: "ready", ready: true });
    await hostSocket.take(
      (message) =>
        message.type === "lobby" &&
        message.players?.length === 2 &&
        message.players[1]?.ready === true,
    );
    hostSocket.send({ type: "start" });
    await Promise.all([
      hostSocket.take((message) => message.type === "placement"),
      guestSocket.take((message) => message.type === "placement"),
    ]);
    const candidates = ["0,0", "12,0", "5,0", "6,0"];
    const candidateHash = stableHash({ generationAttempt: 2, candidates });
    hostSocket.send({
      type: "placement-candidates",
      generationAttempt: 2,
      candidateHash,
      candidates,
      requestId: "reconnect-candidates",
    });
    await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "reconnect-candidates",
    );
    guestSocket.send({ type: "placement-claim", centerId: "6,0", requestId: "claim-before-drop" });
    await guestSocket.take(
      (message) => message.type === "ack" && message.requestId === "claim-before-drop",
    );
    guestSocket.close();

    const identity = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Placement Guest",
      reconnectToken: guest.reconnectToken,
    });
    expect(identity).toMatchObject({ phase: "placement", reconnected: true, player: { seat: 1 } });
    const replacement = new SocketInbox(identity.websocketUrl);
    await replacement.open();
    await replacement.take(
      (message) => message.type === "welcome" && message.phase === "placement",
    );
    const restored = await replacement.take((message) => message.type === "placement");
    expect(restored.selections).toContainEqual({ seat: 1, centerId: "6,0", locked: false });

    hostSocket.send({ type: "placement-lock", centerId: "0,0", requestId: "reconnect-host-lock" });
    replacement.send({
      type: "placement-lock",
      centerId: "6,0",
      requestId: "reconnect-guest-lock",
    });
    await Promise.all([
      hostSocket.take(
        (message) => message.type === "ack" && message.requestId === "reconnect-host-lock",
      ),
      replacement.take(
        (message) => message.type === "ack" && message.requestId === "reconnect-guest-lock",
      ),
    ]);
    replacement.send({
      type: "placement-finalize",
      generationAttempt: 2,
      candidateHash,
      spawnCenters: ["0,0", "5,0"],
      requestId: "conflicting-final",
    });
    expect(
      await replacement.take(
        (message) => message.type === "error" && message.requestId === "conflicting-final",
      ),
    ).toMatchObject({ code: "placement-conflict", recoverable: true });

    replacement.send({
      type: "placement-finalize",
      generationAttempt: 2,
      candidateHash,
      spawnCenters: ["0,0", "6,0"],
      requestId: "valid-final",
    });
    await replacement.take(
      (message) => message.type === "ack" && message.requestId === "valid-final",
    );
    const started = await replacement.take((message) => message.type === "started", 8_000);
    expect(started.spawnCenters).toEqual(["0,0", "6,0"]);

    replacement.close();
    hostSocket.close();
  }, 15_000);

  it("requires a second human before a zero-bot room can start", async () => {
    const host = await postIdentity(`${baseUrl}/api/rooms`, {
      playerName: "Waiting Host",
      config: {
        seed: "active-roster",
        archetype: "heartland",
        difficulty: "normal",
        botCount: 0,
        maxHumans: 2,
      },
    });
    const hostSocket = new SocketInbox(host.websocketUrl);
    await hostSocket.open();
    await hostSocket.take((message) => message.type === "welcome");

    hostSocket.send({ type: "start", requestId: "start-small-room" });
    expect(
      await hostSocket.take(
        (message) => message.type === "error" && message.requestId === "start-small-room",
      ),
    ).toMatchObject({
      code: "need-two-humans",
      recoverable: true,
    });
    hostSocket.close();
  });

  it("caps capacity and transfers a compacted lobby seat on explicit host leave", async () => {
    const host = await postIdentity(`${baseUrl}/api/rooms`, {
      playerName: "Departing Host",
      config: {
        seed: "leave-fixture",
        archetype: "highland-basin",
        difficulty: "hard",
        botCount: 19,
        maxHumans: 2,
      },
    });
    const guest = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Successor",
    });

    const fullResponse = await fetch(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerName: "Too Late" }),
    });
    expect(fullResponse.status).toBe(409);

    const hostSocket = new SocketInbox(host.websocketUrl);
    const guestSocket = new SocketInbox(guest.websocketUrl);
    await Promise.all([hostSocket.open(), guestSocket.open()]);
    await Promise.all([
      hostSocket.take((message) => message.type === "welcome"),
      guestSocket.take((message) => message.type === "welcome"),
    ]);

    hostSocket.send({ type: "leave", requestId: "host-leave" });
    await hostSocket.take(
      (message) => message.type === "ack" && message.requestId === "host-leave",
    );
    const transferred = await guestSocket.take(
      (message) =>
        message.type === "lobby" &&
        message.players?.length === 1 &&
        message.players[0]?.isHost === true,
    );
    expect(transferred.players?.[0]).toMatchObject({ seat: 0, isHost: true });

    const replacement = await postIdentity(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      playerName: "Replacement",
    });
    expect(replacement.player.seat).toBe(1);

    const invalidReconnect = await fetch(`${baseUrl}/api/rooms/${host.roomCode}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerName: "Departing Host",
        reconnectToken: host.reconnectToken,
      }),
    });
    expect(invalidReconnect.status).toBe(401);

    guestSocket.close();
  });

  it("expires inactive SQLite room data through the Durable Object alarm", async () => {
    const room = await postIdentity(`${baseUrl}/api/rooms`, {
      playerName: "Ephemeral Host",
      config: {
        seed: "ttl-fixture",
        archetype: "broken-crown",
        difficulty: "easy",
        botCount: 2,
        maxHumans: 2,
      },
    });
    expect((await fetch(`${baseUrl}/api/rooms/${room.roomCode}/status`)).status).toBe(200);

    const deadline = Date.now() + 7_000;
    let expired = false;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const response = await fetch(`${baseUrl}/api/rooms/${room.roomCode}/status`);
      if (response.status === 404) {
        expired = true;
        break;
      }
    }
    if (!expired) {
      throw new Error(`Room did not expire; Wrangler output:\n${wranglerOutput}`);
    }
  }, 10_000);
});

async function postIdentity(url: string, body: unknown): Promise<Identity> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Identity & {
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  return payload;
}

async function waitForServerTick(
  inbox: SocketInbox,
  afterSequence: number,
  targetTick: number,
): Promise<number> {
  // Placement finalization includes a one-second presentation handoff before
  // the relay's authoritative 10 Hz match clock begins.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    inbox.send({
      type: "missing",
      afterSequence,
      requestId: `tick-probe-${attempt}`,
    });
    const replay = await inbox.take(
      (message) => message.type === "command-batch" && message.replay === true,
    );
    if ((replay.serverTick ?? 0) >= targetTick) return replay.serverTick!;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(`Server tick did not reach ${targetTick}`);
}

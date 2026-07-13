# Multiplayer alpha

Hex Dominion's multiplayer service is a deterministic command relay. It does **not** run a second copy of the match simulation at the edge. Every browser runs the same fixed-step simulation; one SQLite-backed Durable Object validates and orders player commands for one room.

This keeps the service inexpensive, allows a room to hibernate between messages, and leaves single-player completely independent from Cloudflare.

## Local two-tab run

```bash
npm ci
npm run dev:all
```

The expected local addresses are:

- Game client: `http://localhost:3000`
- Multiplayer relay: `http://127.0.0.1:8787`
- Relay health check: `http://127.0.0.1:8787/health`

Open the game in two tabs. In the first, create a room, copy the six-character code, and keep the reconnect token in browser storage. In the second, join that code, mark the guest ready, then start placement from the host tab. Both tabs see the same provisional footprints and locks. After the center-first opening handoff, closing and reopening the second tab should recover either the current placement state or a compact match checkpoint plus any commands after it.

The relay can also be run directly:

```bash
npx wrangler dev --config wrangler.multiplayer.jsonc --local --port 8787
npx vitest run tests/network
```

`src/edge/client.ts` supplies the browser transport. Construct `MultiplayerClient` with the edge URL, call `createRoom` or `joinRoom`, subscribe with `onMessage`, and then call `connect`. The class stores reconnect credentials per room when browser storage is available.

## Room contract

Rooms support two through eight humans. Bots are optional, so two humans and zero bots is a valid match. The host chooses seed, map archetype, bot difficulty, and bot count. The room's human capacity is capped from two through eight so that human capacity plus bots never exceeds 21.

HTTP endpoints:

| Method | Path                            | Purpose                                            |
| ------ | ------------------------------- | -------------------------------------------------- |
| `GET`  | `/health`                       | Relay health probe                                 |
| `POST` | `/api/rooms`                    | Create a room and host identity                    |
| `POST` | `/api/rooms/:code/join`         | Join or reclaim an identity with a reconnect token |
| `GET`  | `/api/rooms/:code/status`       | Read public lobby state                            |
| `GET`  | `/api/rooms/:code/ws?token=...` | Upgrade the authenticated room socket              |

Create body:

```json
{
  "playerName": "Rook",
  "config": {
    "seed": "summer-citadel",
    "archetype": "broken-crown",
    "difficulty": "normal",
    "botCount": 3,
    "maxHumans": 4
  }
}
```

Join body:

```json
{ "playerName": "Vale" }
```

Reconnect body:

```json
{
  "playerName": "Vale",
  "reconnectToken": "the-token-returned-by-create-or-join"
}
```

Create/join returns a room code, stable player ID, assigned lobby seat, reconnect token, room configuration, and a ready-to-use WebSocket URL. Room codes use a 32-character alphabet without `I`, `O`, `0`, or `1`. Seats are compacted if someone explicitly leaves in the lobby, then become immutable when placement starts.

The room lifecycle is `lobby -> placement -> started -> complete`. Placement has a separate 30-second deadline; `started_at`, the source of the simulation tick, is written only after final centers converge and the roughly one-second opening handoff begins. Economy, gameplay AI, movement, construction, combat, victory, and the ordinary tick therefore remain stopped throughout placement.

Bot choreography is deterministic and completes by placement tick 42 (4.2 seconds). A room with bots uses a 5-second minimum placement handoff, so a bot shown as locked can never move when the final vector starts; rooms without bots do not pay that delay. Bot seats use the same seed-derived reservation projection in the core and relay, so provisional animation timing and reconnect timing cannot alter their final centers.

## Lobby and match messages

All frames are JSON and validated with Zod. A client may send one atomic message or a `batch` containing up to 32 atomic messages.

Client messages:

- `ready`: set lobby readiness.
- `start`: host-only; requires at least two active humans and all humans ready, then enters placement.
- `placement-candidates`: publish or confirm the deterministic eligible-center set and generation attempt.
- `placement-claim`: change the sender's provisional center while it remains unlocked.
- `placement-lock`: make the sender's current center immutable.
- `placement-finalize`: propose the complete canonical human-plus-AI center vector after deterministic AI placement or timeout.
- `command`: a game command plus the player's next contiguous `clientSequence`.
- `hash`: deterministic state hash at a tick and relay sequence.
- `checkpoint`: host-only compact snapshot, at most 256 KiB.
- `missing`: request ordered commands after a known sequence.
- `complete`: host-only match-complete report.
- `leave`: permanently relinquish the room identity.
- `ping`: application latency measurement. Protocol ping/pong frames remain runtime-managed.

Server messages:

- `welcome`: identity, room phase, latest sequence, next client sequence, and current derived server tick.
- `lobby`: current public player readiness/connectivity state.
- `placement`: public provisional human selections, lock state, deadline, and map-candidate identity.
- `started`: immutable match configuration, seat mapping, final center vector, placement timing, and timeout result.
- `ack`: request acceptance, including command sequence and target tick.
- `command-batch`: ordered live or replayed commands.
- `sync`: latest checkpoint and commands after it.
- `desync`: conflicting hashes and a strict-majority hash when one exists.
- `complete`: final match result.
- `error`: stable machine-readable error code plus recovery guidance.

## Ordering and future ticks

The Durable Object serializes events for its room. For every accepted game command it atomically:

1. Verifies membership and that `command.playerId` equals the connection's stable seat.
2. Requires the next contiguous per-player `clientSequence`; retransmission of an accepted sequence returns the original acknowledgement.
3. Allocates the room's next monotonic sequence number.
4. Derives the current 10 Hz tick from the persisted `started_at` timestamp—there is no simulation timer.
5. Assigns `max(currentTick + COMMAND_LEAD_TICKS, lastTargetTick)` and overwrites any client-proposed scheduled tick.
6. Writes the command before acknowledging it.

The default lead is six ticks (600 ms). Clients may render a pending-order preview immediately, but the simulation must execute only the ordered command at its assigned tick. Commands with the same target tick execute in relay-sequence order.

Placement messages are serialized by the same Durable Object but are not ordinary gameplay commands and do not consume a simulation tick. The relay accepts only centers from the shared padded-candidate set, rejects provisional spacing conflicts and claims that leave no distance-balanced completion, preserves every human selection in the final vector, and requires final proposals to agree. Core and relay share the same pure candidate-order-independent completion rule; the core additionally verifies the complete projected map-fairness report. Once all humans and deterministic AI are locked, the room may start early; otherwise the deadline deterministically fills and locks missing centers. A reconnect receives the current `placement` payload or the immutable final vector in `started`.

`multi-move` remains one `command` frame, one client sequence, one relay sequence, one target tick, and one command-log row. The relay validates bounded unique ID arrays but never expands the command into a batch.

If a browser has already published an authoritative target tick before a delayed batch reaches it, its Worker does not clamp that command to a later local tick. It buffers relay-sequence gaps, rolls back to a bounded pre-target snapshot once the contiguous prefix is available, replays accepted and pending commands in exact relay-sequence order through its prior current tick, and republishes the corrected deterministic state. The Worker retains one recovery base plus four recent 50-tick points; the base also permits a longer replay when a tab was delayed beyond the recent window. Checkpoints record the exact highest applied contiguous relay sequence, so reconnect never skips an order merely because a later frame arrived first.

Unbroadcast commands stay marked in SQLite. A single Durable Object alarm is scheduled roughly 50 ms ahead and broadcasts up to 100 commands per frame. Alarm execution is at least once, so clients must deduplicate by relay sequence. Incoming command batches and outgoing relay batches reduce WebSocket wakeups.

## Reconnection and recovery

Reconnect tokens are 256-bit random values; only SHA-256 token hashes are stored. The WebSocket serializes the stable player ID into its hibernation attachment. On a new socket for the same identity, the older socket is closed and the seat remains unchanged.

On connection during placement, the room sends `welcome`, `lobby`, and the current public `placement` state. On connection during a running or completed match, the room sends:

The placement payload's `startedAt` epoch catches a new local Worker up to
`floor((now - startedAt) * 10 / 1000)`, bounded by the 300-tick deadline. A reconnect therefore
resumes the current deterministic bot choreography instead of replaying it from placement tick zero.

1. `welcome`, including `nextClientSequence`.
2. `started`, including the immutable full human seat mapping.
3. The latest checkpoint, if one exists.
4. Ordered commands after that checkpoint, up to 500 in the first page.
5. The persisted `complete` result as well when the match already ended.

If `hasMore` is true, request the next page with `missing`. A client whose last sequence predates the retained checkpoint receives the checkpoint automatically. The host can publish a checkpoint only after all commands through its sequence were broadcast, every covered command has reached its scheduled tick, and no uncovered later sequence is scheduled at or before the proposed checkpoint tick. Version-3 clients use a compact negotiated encoding when plain JSON would exceed the limit; typed Melee/Ranged/Wizard counts remain inside the strictly validated snapshot while the relay treats the payload opaquely. Reconnect decodes incoming frames through one serialized queue before validation and command application, preventing an asynchronous gzip decode from reordering later frames. Once accepted, older commands and checkpoints are deleted; that checkpoint becomes the recovery base.

An explicit `leave` invalidates that token. If the host explicitly leaves, the lowest active seat becomes host. A network disconnect does not immediately transfer host ownership because the original host is allowed to reconnect.

## Hashes and desynchronization

Clients periodically submit a hexadecimal state hash keyed by simulation tick and latest applied relay sequence. Hash reports are stored sparsely. As soon as at least two active humans report different hashes for a tick, the room broadcasts one `desync` notice for that tick.

The notice includes every reported hash and a majority value only when more than half of reports agree. The UI should pause command submission, show a clear synchronization warning, and request recovery. Hash comparison detects divergence; it does not prove which client is honest.

## SQLite storage schema

Each room code maps with `idFromName` to one Durable Object and one private SQLite database.

| Table            | Durable data                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `room`           | Code, phase, immutable config, host, expiry, start/completion times, next seat/sequence, last target tick |
| `players`        | Stable identity/seat, token hash, ready/connected/left flags, client sequence, persistent rate window     |
| `commands`       | Ordered compact command JSON, client sequence, assigned tick, broadcast marker                            |
| `checkpoints`    | Latest compact snapshot, sequence, tick, state hash, encoding                                             |
| `state_hashes`   | Sparse per-player hash reports                                                                            |
| `desync_notices` | Ticks already announced as divergent                                                                      |

Schema creation uses `CREATE TABLE IF NOT EXISTS` plus additive column guards for forward-compatible room rows, while `wrangler.multiplayer.jsonc` declares the Durable Object itself as `new_sqlite_classes` migration `v1`.

## Hibernation, alarms, and TTL

The room uses `ctx.acceptWebSocket`, `getWebSockets`, serialized attachments, and class-level `webSocketMessage`/`webSocketClose` handlers. It never calls the standard `WebSocket.accept`, installs socket event listeners, or starts `setInterval`/`setTimeout` in the Durable Object.

The single alarm is multiplexed:

- If commands await broadcast, it wakes for a short batch flush.
- Otherwise it is set to the room expiry.
- Activity extends the default six-hour TTL.
- If every player explicitly leaves, expiry shortens to five minutes.
- At expiry all sockets close and `storage.deleteAll()` atomically removes the SQLite database and alarm.

Cloudflare alarms are at-least-once and may be delayed. The command log and per-client sequence checks make replay safe.

## Validation and abuse limits

The relay enforces:

- CORS origin allow-listing at the HTTP entry point.
- Zod validation and a 320 KiB WebSocket-frame limit (sized for one bounded checkpoint).
- Room membership and non-left identity.
- Stable-seat command ownership.
- Contiguous client sequences and monotonic relay sequences.
- 160 logical messages per persistent ten-second player window.
- Two-to-eight human capacity and 21 total participants.
- Host-only start, checkpoint, and completion operations.

## Casual-alpha limitations

This is not an authoritative or ranked architecture:

- A modified client can lie about legal moves or its state hash. The relay validates command shape and ownership, not complete game legality.
- The host is trusted to publish usable checkpoints and the completion report.
- Reconnect tokens appear in the WebSocket URL. Treat relay/access logs as sensitive and never share a full socket URL.
- A disconnected host retains host status until reconnect or explicit leave; lobby owners may need to recreate an abandoned room.
- No cross-room matchmaking, spectator mode, chat, moderation, replay archive, or permanent account identity exists.
- Checkpoints are bounded but not server-simulated or independently verified.

Ranked play requires authoritative server-side simulation or substantially stronger verification. The deterministic core and ordered-command protocol can be reused by that future service.

Cloudflare references: [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), and [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

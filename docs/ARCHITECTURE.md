# Architecture

Hex Dominion separates rules, scheduling, rendering, interface state, and room coordination so the same ordered inputs can drive a headless test, a single-player Worker, or every client in a multiplayer room.

## Runtime boundaries

```mermaid
flowchart LR
  UI["React setup and HUD"] -->|validated player intent| Worker["Simulation Web Worker"]
  Worker -->|10 Hz GameState snapshots| UI
  UI --> Renderer["PixiJS GameRenderer"]
  Worker --> Core["Pure deterministic core"]
  Core --> Worker
  UI <-->|ordered commands, hashes, checkpoints| Relay["Cloudflare room relay"]
  Relay --> Store["One SQLite Durable Object per room"]
```

- `src/core/` owns all authoritative rules. It has no DOM, React, PixiJS, or Cloudflare dependency.
- `src/worker/game.worker.ts` owns a `GameEngine`, runs its fixed-step cadence, and returns initial/state/snapshot/error messages.
- `src/client/GameApp.tsx` owns setup, HUD, local preferences, selection, menus, autosave, and multiplayer transport coordination.
- `src/client/render/GameRenderer.ts` draws and animates one PixiJS canvas. It consumes state but never changes authoritative rules.
- `src/edge/` owns HTTP/WebSocket validation, room identity, ordered relay sequences, checkpoint transport, and room expiry. It does not run a high-frequency game simulation.
- `src/shared/` contains balance constants and JSON-compatible cross-boundary types.

## Fixed-step simulation

The simulation rate is ten ticks per second (`TICKS_PER_SECOND = 10`). A tick executes in a stable order:

1. increment the integer tick;
2. apply due player commands in submission/relay order;
3. evaluate due deterministic AI rulers and apply their legal commands;
4. advance moving stacks;
5. advance battles;
6. advance construction, repair, and Barracks training;
7. settle economy when the tick reaches a whole simulation second;
8. refresh player tile/troop aggregates;
9. evaluate victory;
10. compute the stable state hash.

Pause prevents the tick from advancing. The 1x, 2x, and 4x controls change only how frequently the Worker requests ticks; movement, construction, economy, combat, AI, and victory all continue to use tick counts.

The Worker timer is a scheduling mechanism, not a rules input. Core code does not read wall-clock time. `performance.now()` is used only to report diagnostic simulation duration.

## Commands and validation

The shared `GameCommand` union contains move, build, cancel-build, and toggle-Barracks commands. Human UI, AI, replay, and multiplayer all pass through `validateCommand`/`applyCommand`.

A `GameEngine` schedules submitted commands no earlier than the next tick. Multiplayer can supply a future `scheduledTick`; the room relay replaces client timing with its ordered target tick. Invalid commands do not mutate state. Accepted commands enter `commandHistory`, which supports deterministic replay from a matching configuration.

Movement paths may cross owned land and make at most one final hostile step. A route cut during travel is recalculated from the current owned tile; if no legal route remains, the stack returns to its last owned position.

## Determinism

The deterministic contract is:

- integer ticks and fixed-point Supply (`1 Supply = 1,000 milli-Supply`);
- JSON-compatible state with no class instances inside snapshots;
- xmur3 string hashing plus a Mulberry32-style integer PRNG in `src/core/rng.ts`;
- seed-derived streams for map generation, decoration, spawn troop distribution, and each AI ruler;
- no `Math.random()` in deterministic modules;
- lexicographically sorted object keys before hashing;
- a two-lane, 16-hex-character state hash;
- no graphics, sound, color-pattern, or debug preferences in the rules hash;
- no wall-clock, browser layout, or renderer interpolation in rules decisions.

Map generation retries with `seed:map-retry:<attempt>` and accepts only a fairness report that satisfies connectivity, terrain, spawn-cluster, distance, and expansion checks. The requested seed remains the public map seed; `generationAttempt` records which deterministic retry succeeded.

## State snapshots and resume

`EngineSnapshot` contains a versioned `GameState`, accepted command history, and commands that the Worker accepted but scheduled after the snapshot tick. Export and import deep-clone through the same JSON-compatible representation and recompute the state hash. A restored Worker therefore continues from the stored tick without dropping an order that was still pending.

Single-player requests and writes the complete Worker snapshot every 150 ticks (15 simulation seconds) and immediately after entering pause. Resume validates the complete versioned shape, cross-references, participant/entity bounds, command payloads, and stored deterministic hash. Invalid JSON, tampered data, and malformed version-1 saves are removed with a recoverable message rather than replacing the live engine.

In multiplayer, the host periodically publishes a size-bounded JSON checkpoint tagged with the latest applied relay sequence. Checkpoints intentionally clear `pendingCommands`: commands after that applied sequence remain owned by the ordered relay log and would otherwise be applied twice. A reconnect restores the checkpoint, deduplicates and queues subsequent relay commands, requests additional pages when necessary, then tells the Worker to catch up to `serverTick` (or the recorded final tick) before normal real-time ticking continues. See [MULTIPLAYER.md](MULTIPLAYER.md).

## Debug acceptance fixtures

Development debug matches expose frozen, deterministic structures, battle, reinforcement, capture, victory, and defeat states to browser acceptance tests. The fixture request replaces the current Worker state so short-lived renderer transitions can be captured reliably. The debug surface also retains a bounded history of recent Worker publications so two browser contexts can compare the same simulation tick even when their renderer phases differ. Both the browser API and Worker guard these inspection paths with `config.debug`, and production builds ignore the debug URL flag entirely; fixtures are never part of normal command handling or deterministic replay.

## Rendering and interpolation

The Worker sends authoritative state at tick boundaries. Rendering fills the 100 ms gaps without feeding visual values back into the core:

- a stack's rule position is `pathIndex`, `segmentProgress`, and `segmentDuration`;
- PixiJS derives a smoothstep position between adjacent axial tile centers;
- the visible stack container eases toward each new target position;
- soldier limbs use frame-time animation only for presentation;
- battle state exposes exact attacker/defender counts and integer control from 0–10,000;
- the battle bar maintains `actual`, an eased main seam, and a slower delayed ghost seam for reinforcement impact;
- battle presentation adds paired fighters, strike animation, particles, and a brief bright impact segment without changing combat state;
- ownership changes create a directional edge-wipe before the displayed border/tint commits;
- capture and reward events create short world-space labels over the affected tile.

Static terrain geometry is drawn when a map first arrives. Ownership is retained and redrawn only when a capture wipe completes instead of on every state tick. Labels, structures, stacks, and battles are updated in retained PixiJS layers. HUD panels remain semantic HTML/CSS for accessibility and responsive layout.

If the browser loses its WebGL context, the renderer prevents permanent disposal, stops only the presentation ticker, and shows a recovery status while the Worker simulation remains safe. On restoration it rebuilds retained layers from the latest authoritative state, restarts rendering, and reports success.

## AI scheduling

AI uses the same legal command path as the human. Difficulty changes decision interval, candidate cap, reserve, attack-confidence threshold, send percentage, and seeded score jitter; it does not change economy or combat rules.

Evaluation is staggered by player ID: `(tick + playerId * 7) % interval === 0`. Easy, Normal, and Hard evaluate every 30, 20, and 10 ticks respectively. Candidate sets are capped at 14, 28, and 48. Each due ruler considers reinforcement first, then expansion/attack, then interior mobilization, and separately evaluates development. This staggering and pruning bound the 20-AI case without making decisions depend on available CPU time.

## Performance approach

- Simulation and AI run off the main thread.
- The map is one canvas, not one DOM node per hex.
- Terrain is retained in a static PixiJS graphics layer until the map changes.
- Garrison, structure, stack, and battle objects are reused by stable IDs and destroyed when no longer present.
- Repeated troop labels use `BitmapText`.
- A moving stack renders only 3–6 representative soldiers regardless of troop count.
- Low zoom hides non-border garrison labels unless selected.
- Graphics quality changes deterministic decorative density, not game information.
- State events are capped at the most recent 24.
- Camera input, visual easing, and effects are frame-time work; rules remain fixed-step.
- Worker tick hooks measure the AI phase independently from whole-tick simulation duration; timing remains diagnostic and never enters state.
- The debug overlay reports FPS, simulation and AI milliseconds, tick, stack/battle counts, retained visible-object count, seed, and hash.

## Multiplayer boundary

The Durable Object orders commands and persists compact recovery data, but every browser runs the deterministic core. Applied relay-sequence tracking, checkpoint restoration, and Worker catch-up keep reconnects aligned without making the edge service run ticks. Each multiplayer Worker retains a base plus four recent 50-tick rollback points: if a relay batch arrives after its authoritative target tick was already published, the Worker restores the latest pre-target point, inserts accepted and pending commands in relay receipt order, and deterministically replays to its prior tick. This prevents independent browser timer phases from silently clamping the same order to different ticks.

This keeps idle rooms inexpensive and hibernation-compatible. It also means the casual alpha is not authoritative: state hashes detect divergence but cannot prove honesty. Protocol, storage, TTL, reconnection, and migration details live in [MULTIPLAYER.md](MULTIPLAYER.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

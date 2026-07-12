# Hex Dominion

[![CI](https://github.com/enel1221/hexgame/actions/workflows/ci.yml/badge.svg)](https://github.com/enel1221/hexgame/actions/workflows/ci.yml)
[![Security](https://github.com/enel1221/hexgame/actions/workflows/security.yml/badge.svg)](https://github.com/enel1221/hexgame/actions/workflows/security.yml)

Hex Dominion is a real-time browser strategy game about expanding a local army across a seeded, procedural hex realm. One human commander faces 3–20 deterministic AI rulers on one of three connected map archetypes. Armies move as exact-count stacks, battles resolve over several seconds, and Farms, Barracks, and Turrets make captured land economically and tactically distinct.

The game uses a React/vinext-on-Vite application shell, a PixiJS 8 battlefield, a pure TypeScript simulation running at 10 Hz in a Web Worker, and an optional Cloudflare Durable Object command relay for casual room-code multiplayer.

## Screenshots

The visual suite writes deterministic, named captures to `docs/screenshots/`. Run `npm run test:visual` to refresh them.

| Setup                                                   | Active match                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| ![Hex Dominion setup](docs/screenshots/title-setup.png) | ![Hex Dominion active match](docs/screenshots/active-game.png) |

| Heartland                                        | Broken Crown                                           | Highland Basin                                             |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| ![Heartland](docs/screenshots/map-heartland.png) | ![Broken Crown](docs/screenshots/map-broken-crown.png) | ![Highland Basin](docs/screenshots/map-highland-basin.png) |

| Structures                                     | Reinforced battle                                               | Capture transition                                             |
| ---------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| ![Structures](docs/screenshots/structures.png) | ![Reinforced battle](docs/screenshots/battle-reinforcement.png) | ![Capture transition](docs/screenshots/capture-transition.png) |

The capture inventory, fixed seeds, viewports, and review checklist are in [docs/VISUAL_QA.md](docs/VISUAL_QA.md). Generated files are evidence to inspect, not proof that visual review happened.

## Requirements

- Node.js 22.13 or newer.
- npm and the committed `package-lock.json`.
- A current Chromium, Firefox, or WebKit-class browser with canvas/WebGL support.
- Wrangler authentication only when running or deploying the optional multiplayer relay.

## Install

```bash
npm ci
```

Copy the local environment example only when you need to change multiplayer relay settings:

```bash
cp .env.example .env.local
```

The example contains public URLs and non-secret local defaults. Never commit Cloudflare API tokens.

## Run single-player locally

```bash
npm run dev
```

Open `http://localhost:3000`, choose a realm, set 3–20 AI opponents, enter a seed, and select **Raise the banners**. Single-player does not require the edge relay.

In a local development build, add `?debug=1` to expose the browser inspection surface and performance overlay used by Playwright. Selection helpers still route through normal UI validation. Debug matches also expose deterministic, frozen presentation fixtures for structures, combat, capture, victory, and defeat; loading one deliberately replaces Worker state and is rejected unless the match was created with debug enabled. Production builds ignore the URL flag and do not expose this API.

## Run two-tab multiplayer locally

```bash
npm run dev:all
```

This starts:

- the game at `http://localhost:3000`;
- the relay at `http://127.0.0.1:8787`;
- the relay health endpoint at `http://127.0.0.1:8787/health`.

Then:

1. Open two separate browser contexts or profiles.
2. In the first, open **Room Code**, choose **Create**, select the optional bot count (`None — humans only` is valid), and create a war room.
3. In the second, open **Room Code**, choose **Join**, and enter the six-character code.
4. Mark the joining banner ready. A newly created host banner begins ready.
5. Start from the host. Issue an order from each client and compare their debug state hashes at the same tick.
6. Close and reopen one client to exercise reconnect-token recovery.

The relay is an experimental deterministic command sequencer, not an authoritative anti-cheat server. See [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md) for the protocol and local recovery flow.

## Controls

| Input                       | Action                                          |
| --------------------------- | ----------------------------------------------- |
| Click/tap an owned garrison | Select a source tile                            |
| Click/tap a destination     | Issue a friendly move or one final hostile step |
| Drag or middle-mouse drag   | Pan the battlefield                             |
| Mouse wheel / pinch         | Zoom around the pointer or touch midpoint       |
| WASD / arrow keys           | Pan the camera                                  |
| Double-click                | Center the clicked tile                         |
| Right-click or `Esc`        | Cancel selection/build mode                     |
| `1`, `2`, `3`, `4`          | Send 25%, 50%, 75%, or 100% (one troop remains) |
| `F`, `B`, `T`               | Toggle Farm, Barracks, or Turret placement      |
| `Space`                     | Pause/resume single-player                      |

The HUD also provides pause, 1x, 2x, and 4x controls. Farm placement requires an owned Fertile Meadow; Barracks require an owned Muster Ground; Turrets allow any owned land tile without another structure.

## Test and verify

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:visual
npm run build
npm run build:edge
```

`npm test` includes unit, simulation, and network protocol coverage. The Playwright commands start the local app through `playwright.config.ts`; they require an already installed Playwright browser and do not install one automatically.

Run the complete gate with:

```bash
npm run verify
```

The visual command creates curated PNGs in `docs/screenshots/`; review those images using [docs/VISUAL_QA.md](docs/VISUAL_QA.md) before accepting a visual change.

## Production build

```bash
npm run build
npm run build:edge
```

The first command builds the vinext application. The second performs a dry-run build of the standalone multiplayer Worker into `dist-edge`.

## Cloudflare configuration and deployment

The app and relay deploy independently. Set the browser-visible relay URL when building the app:

```bash
NEXT_PUBLIC_MULTIPLAYER_URL=https://hex-dominion-multiplayer.<account-subdomain>.workers.dev
```

Relay configuration lives in `wrangler.multiplayer.jsonc`. Its `ROOMS` binding uses SQLite-backed Durable Objects and the forward-only `v1` migration. Configure exact allowed origins before production deployment.

```bash
npx wrangler login
npm run deploy:edge
npm run build
npx vinext deploy --name hex-dominion
```

Read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) before deploying; it covers credentials, origin policy, migration safety, production smoke tests, and rollback. Architecture and tuning references are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/BALANCE.md](docs/BALANCE.md).

## Known limitations

- Multiplayer is a casual alpha. The relay validates identity, ordering, and message shape, but each browser simulates the match and a modified client can cheat.
- Rooms are ephemeral and expire; there is no account system, matchmaking, spectator mode, chat, or permanent replay archive.
- Local autosaves are browser-local, schema-versioned snapshots. Clearing site storage removes them.
- Large 21-player maps have a heavier initial generation/render cost than ordinary 4–8-player matches.
- The MVP has no teams, alliances, diplomacy, fog of war, naval units, campaign, or ranked play.

Hex Dominion is available under the [MIT License](LICENSE).

## Hosted environments

- `main` continuously deploys to <https://main.hex-dominion.inkgrid.io>.
- The latest `v*` release tag deploys to <https://hex-dominion.inkgrid.io>.

The title screen and in-game campaign ledger show the semantic version and a UTC-dated build
number. Deployment credentials are stored only in protected GitHub environments. Security reports
should use the private process in [SECURITY.md](SECURITY.md), not public issues.

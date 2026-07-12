# Deployment

## Automated environments

GitHub Actions is the production deployment authority:

| Git ref         | Game                                   | Multiplayer relay                            |
| --------------- | -------------------------------------- | -------------------------------------------- |
| `main`          | `https://main.hex-dominion.inkgrid.io` | `https://relay-main.hex-dominion.inkgrid.io` |
| latest `v*` tag | `https://hex-dominion.inkgrid.io`      | `https://relay.hex-dominion.inkgrid.io`      |

Every push and release tag must pass lint, typechecking, tests, production-dependency audit, and
both Worker builds before deployment. Builds display the package/tag version plus a build number in
the form `YYYYMMDD.<github-run>.<short-sha>`.

The `preview` and `production` GitHub environments each hold `CLOUDFLARE_API_TOKEN` as a secret and
`CLOUDFLARE_ACCOUNT_ID` as a non-secret variable. The token must be scoped to the one Cloudflare
account and the `inkgrid.io` zone with only Workers Scripts and Workers Routes edit permissions.
Never replace it with a global API key or an interactive Wrangler OAuth token.

Hex Dominion deploys as two independently versioned Cloudflare Workers:

1. The vinext game application serves the static/client assets and application shell.
2. `hex-dominion-multiplayer` is the optional room relay with a SQLite Durable Object binding.

Single-player works when the second Worker is absent or unavailable.

## Prerequisites

- Node.js 22.13 or newer.
- npm and the committed lockfile.
- A Cloudflare account with Workers access.
- Wrangler authentication by interactive login or a scoped CI API token.

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

For CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the CI secret store. They are real secrets and do not belong in `.env`, `.env.example`, Wrangler JSON, source control, or browser-visible variables.

## Local production verification

```bash
npm run lint
npm run typecheck
npm run test
npx vitest run tests/network
npm run build
```

Run the relay and client locally:

```bash
npm run dev:edge
npm run dev
```

Verify the relay before opening the two-tab flow:

```bash
curl --fail http://127.0.0.1:8787/health
```

The full local network test launches an isolated Wrangler process, creates and joins a room, opens two WebSockets, starts, orders a command into a future tick, rejects wrong ownership, reports a desync, writes a checkpoint, requests missing commands, and reconnects the guest:

```bash
npx vitest run tests/network/wrangler-relay.test.ts
```

## Deploy the multiplayer Worker

`wrangler.multiplayer.jsonc` contains:

- The `ROOMS` Durable Object namespace binding.
- Migration tag `v1` with `new_sqlite_classes: ["RoomDurableObject"]`.
- Non-secret local defaults for allowed origins, six-hour TTL, and six-tick scheduling lead.

Before production deployment, set `ALLOWED_ORIGINS` to the exact public game origin. Same-origin requests are always accepted. Do not leave broad wildcard origins unless the relay is deliberately public.

The checked-in `main` and `production` environments already contain their exact allowed origin and
custom domain. The commands below remain useful for local/manual disaster recovery; routine changes
must flow through GitHub Actions.

For a one-off deployment with production overrides:

```bash
npx wrangler deploy --config wrangler.multiplayer.jsonc \
  --var ALLOWED_ORIGINS:https://game.example.com \
  --var ROOM_TTL_SECONDS:21600 \
  --var COMMAND_LEAD_TICKS:6
```

For repeatable CI, put equivalent non-secret values in a checked-in Wrangler environment and deploy with `--env production`. The first deploy applies migration `v1` and creates a SQLite-backed Durable Object namespace. Cloudflare Durable Object migrations are forward-only: do not change `v1` from `new_sqlite_classes` to `new_classes`, reuse its tag, or attempt to convert the deployed class to the legacy KV backend. Append a new uniquely tagged migration when a future class change requires one.

Record the resulting Worker URL, for example:

```text
https://hex-dominion-multiplayer.<account-subdomain>.workers.dev
```

## Configure and deploy the game application

Set the browser-visible relay origin for the production build:

```bash
NEXT_PUBLIC_MULTIPLAYER_URL=https://hex-dominion-multiplayer.<account-subdomain>.workers.dev
```

This URL is public configuration, not a secret. Keep it in the hosting environment or a non-secret production dotenv file excluded from source control. The committed `.env.example` documents the expected name.

Build and deploy the vinext application:

```bash
npm run build
npx vinext deploy --name hex-dominion
```

For the checked-in custom-domain environments, set `CLOUDFLARE_ENV` while building so the Vite
adapter carries the selected Worker name, image binding, and custom-domain route into its generated
deployment configuration:

```bash
npm run deploy:main
npm run deploy:production
```

If the app is published through Codex Sites instead, use the Sites deployment flow for the application and deploy only the relay with the standalone Wrangler config. In either case, ensure the final game origin exactly matches the relay's `ALLOWED_ORIGINS` value.

Deploying the relay separately avoids mixing its Durable Object migration with vinext's generated application Worker configuration.

## Production smoke test

1. Probe `https://<relay>/health` and require HTTP 200.
2. Load the production game in a private window and confirm single-player starts without a relay call.
3. Open two separate browser contexts.
4. Create a room in one and join its six-character code in the other.
5. Ready the guest, host-start the match, and issue a command from each seat.
6. Confirm both clients receive identical relay sequences, future target ticks, and periodic hashes.
7. Close one context, reopen it, and confirm the same seat reconnects from checkpoint plus missing commands.
8. Inspect both browser consoles and Worker logs for uncaught errors, failed upgrades, or repeated desync notices.

An HTTP-only creation probe is useful but does not replace the two-WebSocket smoke test:

```bash
RELAY_URL='https://hex-dominion-multiplayer.<account-subdomain>.workers.dev'
curl --fail --show-error \
  -H 'content-type: application/json' \
  --data '{"playerName":"Smoke Host","config":{"seed":"deploy-smoke","archetype":"heartland","difficulty":"normal","botCount":0,"maxHumans":2}}' \
  "${RELAY_URL%/}/api/rooms"
```

Do not paste the returned full `websocketUrl` into tickets or public logs because it contains a reconnect token.

## Observability and data lifetime

Wrangler observability is enabled for the relay. Monitor response status, WebSocket upgrade failures, alarm errors, CPU duration, and Durable Object storage. The relay intentionally has no permanent simulation loop; idle WebSockets may hibernate.

Room activity extends the default six-hour TTL. The expiry alarm closes sockets and deletes the room's private SQLite database. Rooms are ephemeral and are not a replay/account data store.

## Rollback

List and roll back Worker code versions with the Wrangler version/rollback commands supported by the installed Wrangler release:

```bash
npx wrangler versions list --config wrangler.multiplayer.jsonc
npx wrangler rollback --config wrangler.multiplayer.jsonc
```

Rollback the vinext application independently through its Worker/Sites deployment history.

Important Durable Object constraints:

- Rolling back Worker code does not reverse an already-applied Durable Object migration.
- Keep database changes backward compatible across at least one deployed code version.
- Prefer additive `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` migrations, deploy readers first, and delay destructive cleanup.
- If a faulty release wrote incompatible room rows, rooms are disposable; restore compatible code and let their TTL remove them rather than attempting an unsafe bulk mutation.

After rollback, repeat the health, create/join, two-socket command, and reconnect smoke tests.

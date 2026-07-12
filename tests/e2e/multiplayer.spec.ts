import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { observeBrowserHealth, type BrowserHealth } from "./support";

interface ClientSample {
  tick: number;
  hash: string;
  localPlayerId: number;
  nextEntityId: number;
  orderPlayerIds: number[];
  stateStacks: Array<{ id: number; owner: number }>;
  presentation: {
    stacks: Array<{ id: number; targetX: number; targetY: number }>;
    visibleObjects: number;
  };
}

interface HistoricalState {
  tick: number;
  stateHash: string;
  nextEntityId: number;
  events: Array<{ type: string; playerId?: number }>;
  stacks: Array<{ id: number; owner: number }>;
}

function normalizeCanonicalState(value: unknown): unknown {
  const state = structuredClone(value) as {
    stateHash?: string;
    config?: Record<string, unknown>;
  };
  delete state.stateHash;
  if (state.config) {
    for (const key of [
      "graphics",
      "sound",
      "colorPatterns",
      "debug",
      "localPlayerId",
      "playerName",
    ])
      delete state.config[key];
  }
  return state;
}

function firstDifferences(
  left: unknown,
  right: unknown,
  path = "$",
  output: string[] = [],
): string[] {
  if (output.length >= 12 || Object.is(left, right)) return output;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    output.push(`${path}: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
    return output;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    firstDifferences(leftRecord[key], rightRecord[key], `${path}.${key}`, output);
    if (output.length >= 12) break;
  }
  return output;
}

async function openMultiplayer(
  page: Page,
  playerName: string,
  options: { clearStorage?: boolean; seed?: string; botCount?: number } = {},
): Promise<void> {
  if (options.clearStorage !== false) await page.addInitScript(() => localStorage.clear());
  await page.goto("/?debug=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("title-screen")).toBeVisible();
  await page.getByTestId("player-name").fill(playerName);
  if (options.seed) await page.getByTestId("seed").fill(options.seed);
  const multiplayerTab = page.getByTestId("multiplayer-tab");
  await expect
    .poll(async () => {
      if ((await multiplayerTab.getAttribute("aria-selected")) !== "true") {
        await multiplayerTab.click();
      }
      return multiplayerTab.getAttribute("aria-selected");
    })
    .toBe("true");
  await expect(page.getByTestId("multiplayer-setup")).toBeVisible();
  await page.getByLabel("Commander").fill(playerName);
  if (options.botCount !== undefined) {
    await page.getByTestId("multiplayer-bot-count").selectOption(String(options.botCount));
  }
}

async function waitForRunningMatch(page: Page): Promise<void> {
  await expect(page.getByTestId("game-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("loading-overlay")).toBeHidden({ timeout: 45_000 });
  await page.waitForFunction(
    () =>
      Boolean(
        window.__HEX_DOMINION__?.config.multiplayer &&
        window.__HEX_DOMINION__.stateHash &&
        window.__HEX_DOMINION__.tick > 0,
      ),
    undefined,
    { timeout: 45_000 },
  );
}

async function sampleClient(page: Page): Promise<ClientSample> {
  return page.evaluate(() => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    const presentation = api.getPresentation();
    const inspected = api.inspectStateAt(api.tick) as HistoricalState | null;
    return {
      tick: api.tick,
      hash: api.stateHash,
      localPlayerId: api.config.localPlayerId ?? 0,
      nextEntityId: inspected?.nextEntityId ?? 0,
      orderPlayerIds:
        inspected?.events
          .filter((event) => event.type === "order" && event.playerId !== undefined)
          .map((event) => event.playerId!) ?? [],
      stateStacks: api.stacks.map(({ id, owner }) => ({ id, owner })),
      presentation: {
        stacks: presentation.stacks
          .map(({ id, targetX, targetY }) => ({ id, targetX, targetY }))
          .sort((left, right) => left.id - right.id),
        visibleObjects: presentation.visibleObjects,
      },
    };
  });
}

async function waitForAlignedClients(
  host: Page,
  guest: Page,
  options: {
    minimumTick?: number;
    minimumNextEntityId?: number;
    requireOrderPlayers?: number[];
    timeout?: number;
  } = {},
): Promise<[ClientSample, ClientSample]> {
  const deadline = Date.now() + (options.timeout ?? 20_000);
  let last: [ClientSample, ClientSample] | null = null;
  let newestMismatchedTick: number | null = null;
  let newestMismatchStates: [unknown, unknown] | null = null;
  while (Date.now() < deadline) {
    last = await Promise.all([sampleClient(host), sampleClient(guest)]);
    const candidateTick = Math.min(last[0].tick, last[1].tick) - 1;
    if (candidateTick >= (options.minimumTick ?? 0)) {
      const states = (await Promise.all(
        [host, guest].map((page) =>
          page.evaluate(
            (tick) => window.__HEX_DOMINION__?.inspectStateAt(tick) ?? null,
            candidateTick,
          ),
        ),
      )) as [HistoricalState | null, HistoricalState | null];
      if (states[0] && states[1]) {
        const hostSample: ClientSample = {
          ...last[0],
          tick: states[0].tick,
          hash: states[0].stateHash,
          nextEntityId: states[0].nextEntityId,
          orderPlayerIds: states[0].events
            .filter((event) => event.type === "order" && event.playerId !== undefined)
            .map((event) => event.playerId!),
          stateStacks: states[0].stacks.map(({ id, owner }) => ({ id, owner })),
        };
        const guestSample: ClientSample = {
          ...last[1],
          tick: states[1].tick,
          hash: states[1].stateHash,
          nextEntityId: states[1].nextEntityId,
          orderPlayerIds: states[1].events
            .filter((event) => event.type === "order" && event.playerId !== undefined)
            .map((event) => event.playerId!),
          stateStacks: states[1].stacks.map(({ id, owner }) => ({ id, owner })),
        };
        const containsOrders = (options.requireOrderPlayers ?? []).every(
          (owner) =>
            hostSample.orderPlayerIds.includes(owner) && guestSample.orderPlayerIds.includes(owner),
        );
        const reachedEntity =
          hostSample.nextEntityId >= (options.minimumNextEntityId ?? 0) &&
          guestSample.nextEntityId >= (options.minimumNextEntityId ?? 0);
        if (hostSample.hash === guestSample.hash && containsOrders && reachedEntity) {
          return [hostSample, guestSample];
        }
        if (hostSample.hash !== guestSample.hash) {
          newestMismatchedTick = candidateTick;
          newestMismatchStates = states;
        }
      }
    }
    await host.waitForTimeout(10);
  }
  let differences: string[] = [];
  if (newestMismatchStates) {
    differences = firstDifferences(
      normalizeCanonicalState(newestMismatchStates[0]),
      normalizeCanonicalState(newestMismatchStates[1]),
    );
  }
  throw new Error(
    `Clients did not align: ${JSON.stringify(
      last?.map(({ tick, hash, stateStacks }) => ({ tick, hash, stateStacks })),
    )}; commonTick=${newestMismatchedTick}; differences=${differences.join(" | ")}`,
  );
}

async function newClient(
  browser: Browser,
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>,
): Promise<{ context: BrowserContext; page: Page; health: BrowserHealth }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState,
  });
  const page = await context.newPage();
  return {
    context,
    page,
    health: observeBrowserHealth(page, {
      allowedRuntimeOrigins: ["http://127.0.0.1:8787"],
    }),
  };
}

test("two browser contexts synchronize commands and reconnect the same guest seat", async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const host = await newClient(browser);
  let guest = await newClient(browser);

  try {
    await openMultiplayer(host.page, "Host Warden", {
      seed: "E2E-ROOM-SYNC",
      botCount: 0,
    });
    await host.page.getByTestId("room-action").click();
    await expect(host.page.getByTestId("room-lobby")).toBeVisible({ timeout: 15_000 });
    const roomCode = (
      await host.page.getByRole("button", { name: "Room code" }).innerText()
    ).trim();
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/);
    await expect(host.page.getByRole("button", { name: "Banner ready" })).toBeVisible();

    await openMultiplayer(guest.page, "Guest Warden");
    await guest.page.getByRole("button", { name: "Join", exact: true }).click();
    await guest.page.getByTestId("room-code").fill(roomCode);
    await guest.page.getByTestId("room-action").click();
    await expect(guest.page.getByTestId("room-lobby")).toBeVisible({ timeout: 15_000 });
    await expect(host.page.locator(".room-roster")).toContainText("Guest Warden");

    await guest.page
      .getByRole("button", { name: "Ready my banner" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(guest.page.getByRole("button", { name: "Banner ready" })).toBeVisible();
    await expect(host.page.locator(".room-roster")).toContainText(/Guest Warden[\s\S]*READY/);
    await expect(host.page.getByTestId("start-room")).toBeEnabled({ timeout: 10_000 });
    await host.page.getByTestId("start-room").click();

    await Promise.all([waitForRunningMatch(host.page), waitForRunningMatch(guest.page)]);
    const initial = await waitForAlignedClients(host.page, guest.page);
    expect(initial[0].localPlayerId).toBe(0);
    expect(initial[1].localPlayerId).toBe(1);
    expect(initial[0].hash).toBe(initial[1].hash);
    const participants = await host.page.evaluate(() => ({
      aiCount: window.__HEX_DOMINION__?.config.aiCount,
      humans: window.__HEX_DOMINION__?.players.map((player) => player.isHuman),
    }));
    expect(participants).toEqual({ aiCount: 0, humans: [true, true] });

    const hostOrder = host.page.getByTestId("debug-friendly-order");
    const guestOrder = guest.page.getByTestId("debug-friendly-order");
    await expect(hostOrder).toBeEnabled();
    await expect(guestOrder).toBeEnabled();
    let ordered = initial;
    for (const { button, owner } of [
      { button: hostOrder, owner: 0 },
      { button: guestOrder, owner: 1 },
    ]) {
      await button.click();
      ordered = await waitForAlignedClients(host.page, guest.page, {
        minimumTick: ordered[0].tick + 1,
        minimumNextEntityId: ordered[0].nextEntityId + 1,
        requireOrderPlayers: [owner],
        timeout: 15_000,
      });
      for (const observation of ordered) {
        expect(observation.orderPlayerIds).toContain(owner);
        expect(observation.presentation.visibleObjects).toBeGreaterThan(0);
      }
    }
    expect(ordered[0].presentation.visibleObjects).toBeGreaterThan(0);
    expect(ordered[1].presentation.visibleObjects).toBeGreaterThan(0);

    await guest.health.assertHealthy();
    const guestStorage = await guest.context.storageState();
    await guest.context.close();
    guest = await newClient(browser, guestStorage);
    await openMultiplayer(guest.page, "Guest Warden", { clearStorage: false });
    await guest.page.getByRole("button", { name: "Join", exact: true }).click();
    await guest.page.getByTestId("room-code").fill(roomCode);
    await guest.page.getByTestId("reconnect-room").click();
    await waitForRunningMatch(guest.page);

    const reconnected = await waitForAlignedClients(host.page, guest.page, { timeout: 30_000 });
    expect(reconnected[1].localPlayerId).toBe(1);
    expect(reconnected[0].hash).toBe(reconnected[1].hash);
    await expect(guest.page.getByLabel("Live multiplayer status")).toContainText("LIVE");

    await host.health.assertHealthy();
    await guest.health.assertHealthy();
  } finally {
    await Promise.allSettled([host.context.close(), guest.context.close()]);
  }
});

import { expect, type Page } from "@playwright/test";

export type MapArchetype = "heartland" | "broken-crown" | "highland-basin";
export type DebugScenario =
  | "structures"
  | "battle"
  | "battle-minimum"
  | "reinforcement"
  | "capture-before"
  | "capture"
  | "developed-capture"
  | "elimination"
  | "interior-build"
  | "victory"
  | "defeat";

export interface TestTile {
  id: string;
  q: number;
  r: number;
  owner: number | null;
  troops: number;
  terrain: "meadow" | "muster" | "plains" | "forest" | "hills" | "water";
  structure: {
    type: "farm" | "barracks" | "turret";
    status: "constructing" | "active" | "seized" | "repairing";
    integrity: number;
  } | null;
}

export interface TestStack {
  id: number;
  troops: number;
  owner: number;
  path: string[];
  pathIndex: number;
  segmentProgress: number;
  segmentDuration: number;
}

export interface TestBattle {
  id: number;
  tileId: string;
  actualControl: number;
  attacker: number;
  defender: number;
}

export interface HexDominionTestApi {
  tick: number;
  config: {
    aiCount: number;
    archetype: MapArchetype;
    seed: string;
    difficulty: "easy" | "normal" | "hard";
    playerName: string;
    localPlayerId?: number;
    multiplayer?: boolean;
    debug?: boolean;
  };
  map: {
    landCount: number;
    archetype: MapArchetype;
    seed: string;
    spawnClusters: string[][];
    tiles: TestTile[];
  };
  players: Array<{
    id: number;
    name: string;
    isHuman: boolean;
    tiles: number;
    eliminated: boolean;
    eliminatedBy: number | null;
    supplyMilli: number;
    enemiesEliminated: number;
  }>;
  events: Array<{
    id: number;
    type: string;
    playerId?: number;
    tileId?: string;
    amount?: number;
    message: string;
  }>;
  paused: boolean;
  selectedTile: string | null;
  stacks: TestStack[];
  battles: TestBattle[];
  stateHash: string;
  winner: number | null;
  selectTile(tileId: string): void;
  hoverTile(tileId: string | null): void;
  cancelSelection(): void;
  getPresentation(): TestPresentation;
  inspectStateAt(tick: number): unknown;
  loadScenario(scenario: DebugScenario): void;
}

export interface TestPresentation {
  stacks: Array<{ id: number; x: number; y: number; targetX: number; targetY: number }>;
  battles: Array<{
    id: number;
    actual: number;
    displayed: number;
    ghost: number;
    pulse: number;
  }>;
  visibleObjects: number;
}

declare global {
  interface Window {
    __HEX_DOMINION__?: HexDominionTestApi;
  }
}

export interface StartMatchOptions {
  aiCount?: number;
  archetype?: MapArchetype;
  seed?: string;
  playerName?: string;
  difficulty?: "easy" | "normal" | "hard";
  graphics?: "low" | "medium" | "high";
}

export interface BrowserHealth {
  assertHealthy(): Promise<void>;
}

/** Installs observers before navigation so worker/module failures are included. */
export function observeBrowserHealth(
  page: Page,
  options: { allowedRuntimeOrigins?: string[] } = {},
): BrowserHealth {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const badResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  return {
    async assertHealthy() {
      await expect.poll(() => consoleErrors, { timeout: 500 }).toEqual([]);
      expect(pageErrors, "uncaught page errors").toEqual([]);
      expect(failedRequests, "failed browser requests").toEqual([]);
      expect(badResponses, "HTTP error responses").toEqual([]);

      const remoteRuntimeAssets = await page.evaluate(
        (allowedOrigins) =>
          performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) => {
              if (!/^https?:/.test(name)) return false;
              const origin = new URL(name).origin;
              return origin !== location.origin && !allowedOrigins.includes(origin);
            }),
        options.allowedRuntimeOrigins ?? [],
      );
      expect(remoteRuntimeAssets, "remote runtime asset requests").toEqual([]);
    },
  };
}

export async function openTitle(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/?debug=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("title-screen")).toBeVisible();
  await expect(page.getByRole("heading", { name: /hex dominion/i })).toBeVisible();

  // Prove React hydration before screenshots apply temporary caret styles to
  // server-rendered inputs. Returning to Solo keeps callers on the default UI.
  const multiplayerTab = page.getByTestId("multiplayer-tab");
  await expect
    .poll(async () => {
      if ((await multiplayerTab.getAttribute("aria-selected")) !== "true") {
        await multiplayerTab.click();
      }
      return multiplayerTab.getAttribute("aria-selected");
    })
    .toBe("true");
  const singleTab = page.getByTestId("single-tab");
  await singleTab.click();
  await expect(singleTab).toHaveAttribute("aria-selected", "true");
}

async function setRangeValue(page: Page, testId: string, value: number): Promise<void> {
  const range = page.getByTestId(testId);
  await range.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Native input value setter is unavailable");
    setter.call(input, String(nextValue));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await expect(range).toHaveValue(String(value));
}

export async function startSinglePlayer(
  page: Page,
  options: StartMatchOptions = {},
): Promise<HexDominionTestApi> {
  const settings = {
    aiCount: options.aiCount ?? 3,
    archetype: options.archetype ?? "heartland",
    seed: options.seed ?? "E2E-CROWN",
    playerName: options.playerName ?? "Browser Warden",
    difficulty: options.difficulty ?? "normal",
    graphics: options.graphics ?? "high",
  } as const;

  await openTitle(page);
  await page.getByTestId(`map-${settings.archetype}`).click();
  await expect(page.getByTestId(`map-${settings.archetype}`)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await setRangeValue(page, "ai-count", settings.aiCount);
  await page.getByTestId("difficulty").selectOption(settings.difficulty);
  await page.getByTestId("player-name").fill(settings.playerName);
  await page.getByTestId("seed").fill(settings.seed);
  await page.getByLabel("Graphics quality").selectOption(settings.graphics);

  const sound = page.getByRole("button", { name: "Sound", exact: true });
  if ((await sound.getAttribute("aria-pressed")) === "true") await sound.click();

  await page.getByTestId("start-match").click();
  await expect(page.getByTestId("game-screen")).toBeVisible();
  await expect(page.getByTestId("loading-overlay")).toBeHidden({ timeout: 45_000 });
  await expect(page.getByRole("application", { name: "Hex Dominion battlefield" })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForFunction(
    () =>
      Boolean(
        window.__HEX_DOMINION__ &&
        window.__HEX_DOMINION__.stateHash &&
        window.__HEX_DOMINION__.map.tiles.length > 0,
      ),
    undefined,
    { timeout: 45_000 },
  );
  await page.waitForFunction(() => (window.__HEX_DOMINION__?.tick ?? 0) > 0, undefined, {
    timeout: 10_000,
  });

  return getTestApiSnapshot(page);
}

export async function getTestApiSnapshot(page: Page): Promise<HexDominionTestApi> {
  return page.evaluate(() => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    const snapshot = { ...api } as unknown as Record<string, unknown>;
    for (const method of [
      "selectTile",
      "hoverTile",
      "cancelSelection",
      "getPresentation",
      "loadScenario",
    ]) {
      delete snapshot[method];
    }
    return snapshot as unknown as HexDominionTestApi;
  });
}

export async function getPresentation(page: Page): Promise<TestPresentation> {
  return page.evaluate(() => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    return api.getPresentation();
  });
}

export async function pauseSimulation(page: Page): Promise<void> {
  const pause = page.getByTestId("pause-toggle");
  if ((await pause.getAttribute("aria-pressed")) !== "true") await pause.click();
  await expect(pause).toHaveAttribute("aria-pressed", "true");
}

export async function resumeSimulation(page: Page): Promise<void> {
  const pause = page.getByTestId("pause-toggle");
  if ((await pause.getAttribute("aria-pressed")) === "true") await pause.click();
  await expect(pause).toHaveAttribute("aria-pressed", "false");
}

export async function loadDebugScenario(
  page: Page,
  scenario: DebugScenario,
): Promise<HexDominionTestApi> {
  const previous = await getTestApiSnapshot(page);
  await page.evaluate((name) => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    api.loadScenario(name);
  }, scenario);
  await page.waitForFunction(
    ({ hash, tick }) => {
      const api = window.__HEX_DOMINION__;
      return Boolean(api && api.paused && api.stateHash !== hash && api.tick > tick);
    },
    { hash: previous.stateHash, tick: previous.tick },
    { timeout: 5_000 },
  );
  return getTestApiSnapshot(page);
}

function axialDistance(left: TestTile, right: TestTile): number {
  return Math.max(
    Math.abs(left.q - right.q),
    Math.abs(left.r - right.r),
    Math.abs(left.q + left.r - right.q - right.r),
  );
}

export async function findFriendlyPair(
  page: Page,
): Promise<{ sourceId: string; destinationId: string; sourceTroops: number }> {
  const snapshot = await getTestApiSnapshot(page);
  const localPlayerId = snapshot.config.localPlayerId ?? 0;
  const cluster = snapshot.map.spawnClusters[localPlayerId] ?? [];
  const clusterTiles = cluster
    .map((id) => snapshot.map.tiles.find((tile) => tile.id === id))
    .filter((tile): tile is TestTile => Boolean(tile && tile.owner === localPlayerId));
  let best: { source: TestTile; destination: TestTile; distance: number } | null = null;

  for (const source of clusterTiles) {
    if (source.troops <= 1) continue;
    for (const destination of clusterTiles) {
      if (destination.id === source.id) continue;
      const distance = axialDistance(source, destination);
      if (!best || distance > best.distance) best = { source, destination, distance };
    }
  }

  if (!best) throw new Error("No deterministic friendly route exists in the local spawn cluster");
  return {
    sourceId: best.source.id,
    destinationId: best.destination.id,
    sourceTroops: best.source.troops,
  };
}

export async function findHostilePair(
  page: Page,
): Promise<{ sourceId: string; destinationId: string }> {
  const snapshot = await getTestApiSnapshot(page);
  const localPlayerId = snapshot.config.localPlayerId ?? 0;
  for (const source of snapshot.map.tiles) {
    if (source.owner !== localPlayerId || source.troops <= 1) continue;
    const destination = snapshot.map.tiles.find(
      (tile) => tile.owner !== localPlayerId && axialDistance(source, tile) === 1,
    );
    if (destination) return { sourceId: source.id, destinationId: destination.id };
  }
  throw new Error("No deterministic hostile border route is currently available");
}

export async function selectTile(page: Page, tileId: string): Promise<void> {
  await page.evaluate((id) => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    api.selectTile(id);
  }, tileId);
}

export interface BattleObservation {
  pair: { sourceId: string; destinationId: string };
  battle: TestBattle;
  presentation: TestPresentation["battles"][number];
}

export async function issueHostileBattle(page: Page): Promise<BattleObservation> {
  const pair = await findHostilePair(page);
  await selectTile(page, pair.sourceId);
  await page.waitForFunction(
    (sourceId) => window.__HEX_DOMINION__?.selectedTile === sourceId,
    pair.sourceId,
  );
  const seventyFive = page.locator(".send-control button").filter({ hasText: "75%" });
  await seventyFive.click();
  await expect(seventyFive).toHaveAttribute("aria-pressed", "true");
  await selectTile(page, pair.destinationId);

  const observationHandle = await page.waitForFunction(
    (tileId) => {
      const api = window.__HEX_DOMINION__;
      const battle = api?.battles.find(
        (candidate) => candidate.tileId === tileId && candidate.actualControl === 5_000,
      );
      if (!api || !battle) return false;
      const presentation = api
        .getPresentation()
        .battles.find((candidate) => candidate.id === battle.id);
      return presentation ? { battle, presentation } : false;
    },
    pair.destinationId,
    { timeout: 5_000 },
  );
  const observation = (await observationHandle.jsonValue()) as Omit<BattleObservation, "pair">;
  return { pair, ...observation };
}

export async function reinforceBattle(
  page: Page,
  battle: Pick<TestBattle, "id" | "tileId">,
): Promise<Omit<BattleObservation, "pair">> {
  const snapshot = await getTestApiSnapshot(page);
  const localPlayerId = snapshot.config.localPlayerId ?? 0;
  const target = snapshot.map.tiles.find((tile) => tile.id === battle.tileId);
  if (!target) throw new Error("Battle target is missing from debug map state");
  const source = snapshot.map.tiles
    .filter((tile) => tile.owner === localPlayerId && tile.troops > 1)
    .sort((left, right) => axialDistance(left, target) - axialDistance(right, target))[0];
  if (!source) throw new Error("No owned garrison can reinforce the active battle");

  await selectTile(page, source.id);
  await page.waitForFunction((id) => window.__HEX_DOMINION__?.selectedTile === id, source.id);
  await selectTile(page, battle.tileId);
  const observationHandle = await page.waitForFunction(
    (battleId) => {
      const api = window.__HEX_DOMINION__;
      const current = api?.battles.find((candidate) => candidate.id === battleId);
      const presentation = api
        ?.getPresentation()
        .battles.find((candidate) => candidate.id === battleId);
      if (
        !current ||
        !presentation ||
        presentation.pulse <= 0 ||
        Math.abs(presentation.displayed - presentation.ghost) <= 0.001
      ) {
        return false;
      }
      return { battle: current, presentation };
    },
    battle.id,
    { timeout: 6_000 },
  );
  return (await observationHandle.jsonValue()) as Omit<BattleObservation, "pair">;
}

export async function issueFriendlyMove(
  page: Page,
  percent: 25 | 50 | 75 | 100 = 75,
): Promise<{
  pair: Awaited<ReturnType<typeof findFriendlyPair>>;
  stack: TestStack;
  presentation: TestPresentation["stacks"][number];
}> {
  const pair = await findFriendlyPair(page);
  await selectTile(page, pair.sourceId);
  await page.waitForFunction(
    (sourceId) => window.__HEX_DOMINION__?.selectedTile === sourceId,
    pair.sourceId,
  );
  await expect(page.getByTestId("tile-inspector")).toBeVisible();

  const percentageButton = page.locator(".send-control button").filter({ hasText: `${percent}%` });
  await percentageButton.click();
  await expect(percentageButton).toHaveAttribute("aria-pressed", "true");

  await page.evaluate((destinationId) => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    api.hoverTile(destinationId);
    api.selectTile(destinationId);
  }, pair.destinationId);
  const observationHandle = await page.waitForFunction(
    ({ sourceId, destinationId }) => {
      const api = window.__HEX_DOMINION__;
      const stack = api?.stacks.find(
        (candidate) =>
          candidate.owner === (api.config.localPlayerId ?? 0) &&
          candidate.path[0] === sourceId &&
          candidate.path[candidate.path.length - 1] === destinationId &&
          candidate.segmentProgress > 0 &&
          candidate.segmentProgress < candidate.segmentDuration,
      );
      if (!api || !stack) return false;
      const presentation = api
        .getPresentation()
        .stacks.find((candidate) => candidate.id === stack.id);
      if (!presentation) return false;
      return { stack, presentation };
    },
    pair,
    { timeout: 5_000 },
  );
  const observation = (await observationHandle.jsonValue()) as {
    stack: TestStack;
    presentation: TestPresentation["stacks"][number];
  };
  return { pair, ...observation };
}

export async function selectAnyOwnedTile(page: Page): Promise<string> {
  const snapshot = await getTestApiSnapshot(page);
  const localPlayerId = snapshot.config.localPlayerId ?? 0;
  const tile = snapshot.map.tiles.find(
    (candidate) => candidate.owner === localPlayerId && candidate.troops > 1,
  );
  if (!tile) throw new Error("No selectable owned garrison is available");
  await selectTile(page, tile.id);
  await page.waitForFunction((id) => window.__HEX_DOMINION__?.selectedTile === id, tile.id);
  return tile.id;
}

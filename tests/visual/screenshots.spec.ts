import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  findFriendlyPair,
  issueFriendlyMove,
  loadDebugScenario,
  observeBrowserHealth,
  openTitle,
  pauseSimulation,
  selectAnyOwnedTile,
  selectTile,
  startSinglePlayer,
  type MapArchetype,
} from "../e2e/support";

const SCREENSHOT_DIRECTORY = path.resolve(process.cwd(), "docs/screenshots");

async function capture(
  page: Page,
  filename: string,
  options: { fullPage?: boolean; hideDebug?: boolean; baseline?: string } = {},
): Promise<void> {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  if (options.hideDebug) {
    await page.getByTestId("debug-overlay").evaluate((element) => {
      (element as HTMLElement).style.display = "none";
    });
  }
  const waitForPaint = () =>
    page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      );
    });
  await waitForPaint();
  const hasLiveCanvas = await page.locator("canvas.game-canvas").isVisible();
  const screenshotOptions = {
    fullPage: options.fullPage,
    // Chromium can blank unrelated HTML layers when it pauses animations
    // while compositing WebGL. Live captures are curated, not pixel-diffed.
    animations: hasLiveCanvas ? ("allow" as const) : ("disabled" as const),
    caret: "hide" as const,
  };

  // A discarded composite readback prevents intermittent partial WebGL/HTML
  // frames on the first screenshot after a Pixi camera/state transition.
  if (hasLiveCanvas) {
    await page.screenshot(screenshotOptions);
    await page.waitForTimeout(75);
    await waitForPaint();
  }
  const screenshotPath = path.join(SCREENSHOT_DIRECTORY, filename);
  await page.screenshot({
    ...screenshotOptions,
    path: screenshotPath,
  });
  expect(
    (await stat(screenshotPath)).size,
    `${filename} should contain rendered pixels`,
  ).toBeGreaterThan(10_000);
  if (options.baseline) {
    await expect(page).toHaveScreenshot(options.baseline, {
      fullPage: options.fullPage,
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.005,
    });
  }
}

test.describe.configure({ mode: "serial" });

test("captures the title and complete setup surface", async ({ page }) => {
  const health = observeBrowserHealth(page);
  await openTitle(page);
  await capture(page, "title-setup.png", {
    fullPage: true,
    baseline: "title-setup-baseline.png",
  });
  await health.assertHealthy();
});

for (const archetype of ["heartland", "broken-crown", "highland-basin"] as const) {
  test(`captures the live ${archetype} archetype`, async ({ page }) => {
    test.setTimeout(75_000);
    const health = observeBrowserHealth(page);
    const seed = `VISUAL-${archetype.toUpperCase()}`;
    await startSinglePlayer(page, {
      aiCount: 3,
      archetype: archetype as MapArchetype,
      seed,
      playerName: "Gallery Warden",
    });
    await pauseSimulation(page);
    await capture(page, `map-${archetype}.png`, { hideDebug: true });
    await health.assertHealthy();
  });
}

test("captures the required twenty-AI overview with telemetry", async ({ page }) => {
  test.setTimeout(90_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 20,
    archetype: "heartland",
    seed: "VISUAL-TWENTY-AI",
    playerName: "Twenty Warden",
    graphics: "low",
  });
  await pauseSimulation(page);
  await capture(page, "twenty-ai-overview.png");
  await health.assertHealthy();
});

test("captures an active match with a moving squad and selected tile", async ({ page }) => {
  test.setTimeout(75_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "broken-crown",
    seed: "VISUAL-ACTIVE",
    playerName: "Active Warden",
  });
  await issueFriendlyMove(page, 75);
  await pauseSimulation(page);
  await selectAnyOwnedTile(page);
  await expect(page.getByTestId("tile-inspector")).toBeVisible();
  await capture(page, "active-game.png", { hideDebug: true });
  await health.assertHealthy();
});

test("captures selected-tile and legal path-preview feedback", async ({ page }) => {
  test.setTimeout(75_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "heartland",
    seed: "VISUAL-PATH-PREVIEW",
    playerName: "Path Warden",
  });
  const pair = await findFriendlyPair(page);
  await pauseSimulation(page);
  await selectTile(page, pair.sourceId);
  await page.waitForFunction((id) => window.__HEX_DOMINION__?.selectedTile === id, pair.sourceId);
  await page.evaluate((id) => window.__HEX_DOMINION__?.hoverTile(id), pair.destinationId);
  await expect(page.getByTestId("tile-inspector")).toBeVisible();
  await capture(page, "selected-path-preview.png", { hideDebug: true });
  await health.assertHealthy();
});

test("captures two simultaneously moving stacks", async ({ page }) => {
  test.setTimeout(75_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "heartland",
    seed: "VISUAL-MULTIPLE-STACKS",
    playerName: "Column Warden",
  });
  const friendly = page.getByTestId("debug-friendly-order");
  await expect(friendly).toBeEnabled();
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="debug-friendly-order"]',
    );
    if (!button) throw new Error("Friendly debug order is unavailable");
    button.click();
    button.click();
  });
  await page.waitForFunction(
    () => {
      const api = window.__HEX_DOMINION__;
      return (
        (api?.stacks.filter((stack) => stack.owner === (api.config.localPlayerId ?? 0)).length ??
          0) >= 2 && (api?.getPresentation().stacks.length ?? 0) >= 2
      );
    },
    undefined,
    { timeout: 4_000 },
  );
  await pauseSimulation(page);
  await capture(page, "multiple-stacks.png", { hideDebug: true });
  await health.assertHealthy();
});

test("captures deterministic structures, combat, capture, victory, and defeat fixtures", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "heartland",
    seed: "debug-scenario-test",
    playerName: "Scenario Warden",
  });

  const structures = await loadDebugScenario(page, "structures");
  expect(
    structures.map.tiles
      .filter(
        (tile) =>
          tile.owner === (structures.config.localPlayerId ?? 0) &&
          tile.structure?.status === "active",
      )
      .map((tile) => tile.structure!.type)
      .sort(),
  ).toEqual(["barracks", "farm", "turret"]);
  await capture(page, "structures.png", { hideDebug: true });

  const battle = await loadDebugScenario(page, "battle");
  expect(battle.battles[0]).toMatchObject({
    actualControl: 5_000,
    attacker: 56,
    defender: 56,
  });
  await page.waitForFunction(
    (battleId) =>
      window.__HEX_DOMINION__
        ?.getPresentation()
        .battles.some(
          (candidate) =>
            candidate.id === battleId &&
            candidate.actual === 0.5 &&
            Math.abs(candidate.displayed - 0.5) < 0.001,
        ),
    battle.battles[0]!.id,
  );
  await capture(page, "battle-50-50.png", { hideDebug: true });

  const reinforced = await loadDebugScenario(page, "reinforcement");
  expect(reinforced.battles[0]).toMatchObject({
    id: battle.battles[0]!.id,
    actualControl: 5_800,
    attacker: 96,
    defender: 56,
  });
  await page.waitForFunction((battleId) => {
    const seam = window.__HEX_DOMINION__
      ?.getPresentation()
      .battles.find((candidate) => candidate.id === battleId);
    return Boolean(seam && seam.pulse > 0 && Math.abs(seam.displayed - seam.ghost) > 0.001);
  }, reinforced.battles[0]!.id);
  await capture(page, "battle-reinforcement.png", { hideDebug: true });

  const captureBefore = await loadDebugScenario(page, "capture-before");
  expect(captureBefore.battles[0]?.actualControl).toBe(9_900);
  await page.waitForFunction(
    (battleId) =>
      window.__HEX_DOMINION__
        ?.getPresentation()
        .battles.some((candidate) => candidate.id === battleId && candidate.actual === 0.99),
    captureBefore.battles[0]!.id,
  );
  const captured = await loadDebugScenario(page, "capture");
  expect(captured.battles).toHaveLength(0);
  await capture(page, "capture-transition.png", { hideDebug: true });

  const victory = await loadDebugScenario(page, "victory");
  expect(victory.winner).toBe(victory.config.localPlayerId ?? 0);
  await expect(page.getByTestId("victory-screen")).toBeVisible();
  await capture(page, "victory.png", { hideDebug: true });

  const defeat = await loadDebugScenario(page, "defeat");
  expect(defeat.winner).not.toBe(defeat.config.localPlayerId ?? 0);
  await expect(page.getByTestId("defeat-screen")).toBeVisible();
  await capture(page, "defeat.png", { hideDebug: true });
  await health.assertHealthy();
});

test("captures portrait setup and landscape active tablet layouts", async ({ page }) => {
  test.setTimeout(90_000);
  const health = observeBrowserHealth(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await openTitle(page);
  await capture(page, "tablet-title.png", {
    fullPage: true,
    baseline: "tablet-title-baseline.png",
  });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId("map-highland-basin").click();
  await page.getByTestId("ai-count").evaluate((element) => {
    const input = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Native input value setter is unavailable");
    setter.call(input, "3");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByTestId("player-name").fill("Tablet Warden");
  await page.getByTestId("seed").fill("VISUAL-TABLET");
  const sound = page.getByRole("button", { name: "Sound", exact: true });
  if ((await sound.getAttribute("aria-pressed")) === "true") await sound.click();
  await page.getByTestId("start-match").click();
  await expect(page.getByTestId("loading-overlay")).toBeHidden({ timeout: 45_000 });
  await page.waitForFunction(() => (window.__HEX_DOMINION__?.tick ?? 0) > 0, undefined, {
    timeout: 20_000,
  });
  await pauseSimulation(page);
  await capture(page, "tablet-active-game.png", { hideDebug: true });
  await health.assertHealthy();
});

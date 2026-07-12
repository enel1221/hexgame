import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  findFriendlyPair,
  getTestApiSnapshot,
  issueFriendlyMove,
  loadDebugScenario,
  observeBrowserHealth,
  openTitle,
  pauseSimulation,
  selectAnyOwnedTile,
  selectTile,
  startSinglePlayer,
  startSinglePlayerPlacement,
  type MapArchetype,
} from "../e2e/support";

const SCREENSHOT_DIRECTORY = path.resolve(process.cwd(), "docs/screenshots");

async function capture(
  page: Page,
  filename: string,
  options: {
    fullPage?: boolean;
    hideDebug?: boolean;
    baseline?: string;
    transient?: boolean;
    hideCanvas?: boolean;
  } = {},
): Promise<void> {
  await mkdir(SCREENSHOT_DIRECTORY, { recursive: true });
  // Chromium can intermittently omit DOM compositor layers above WebGL when
  // several translucent surfaces use backdrop blur. The capture stylesheet
  // preserves each surface's own fill while removing only that blur effect.
  await page.addStyleTag({
    content: `
      * { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
      html.visual-capture-frozen *,
      html.visual-capture-frozen *::before,
      html.visual-capture-frozen *::after {
        animation-play-state: paused !important;
        transition: none !important;
      }
    `,
  });
  const canvas = page.locator("canvas.game-canvas");
  const canvasWasLive = await canvas.isVisible();
  if (canvasWasLive) {
    await page.evaluate(() => {
      const api = window.__HEX_DOMINION__;
      if (!api) throw new Error("Hex Dominion debug API is unavailable");
      api.setTransientCapture(true);
      document.documentElement.classList.add("visual-capture-frozen");
    });
  }
  if (options.hideDebug) {
    await page.getByTestId("debug-overlay").evaluate((element) => {
      (element as HTMLElement).style.display = "none";
    });
  }
  if (canvasWasLive && !options.hideCanvas) {
    const rasterLength = await page.evaluate(async () => {
      const api = window.__HEX_DOMINION__;
      const source = document.querySelector<HTMLCanvasElement>("canvas.game-canvas");
      if (!api || !source) throw new Error("Hex Dominion capture surface is unavailable");
      const dataUrl = await api.captureFrame();
      const image = new Image();
      image.dataset.visualCaptureCanvas = "true";
      image.alt = "";
      image.ariaHidden = "true";
      image.style.position = "absolute";
      image.style.inset = "0";
      image.style.width = "100%";
      image.style.height = "100%";
      image.style.display = "block";
      image.src = dataUrl;
      await image.decode();
      source.style.visibility = "hidden";
      source.insertAdjacentElement("afterend", image);
      return dataUrl.length;
    });
    expect(rasterLength, `${filename} should rasterize the Pixi frame`).toBeGreaterThan(10_000);
  } else if (options.hideCanvas) {
    await canvas.evaluate((element) => {
      (element as HTMLElement).style.visibility = "hidden";
    });
  }
  const overlaySelectors = [".victory-stats > span", ".victory-actions > button"];
  let overlayIndex = 0;
  for (const selector of overlaySelectors) {
    const matches = page.locator(selector);
    for (let matchIndex = 0; matchIndex < (await matches.count()); matchIndex += 1) {
      const overlay = matches.nth(matchIndex);
      if (!(await overlay.isVisible())) continue;
      const box = await overlay.boundingBox();
      if (!box) continue;
      const buffer = await overlay.screenshot({ animations: "allow", caret: "hide" });
      await overlay.evaluate(
        (element, replacement) => {
          const original = element as HTMLElement;
          const image = new Image();
          image.dataset.visualCaptureOverlay = "true";
          image.alt = "";
          image.ariaHidden = "true";
          image.style.position = "fixed";
          image.style.left = `${replacement.box.x}px`;
          image.style.top = `${replacement.box.y}px`;
          image.style.width = `${replacement.box.width}px`;
          image.style.height = `${replacement.box.height}px`;
          image.style.zIndex = String(50 + replacement.index);
          image.style.pointerEvents = "none";
          image.src = replacement.dataUrl;
          original.dataset.visualCaptureVisibility = original.style.visibility;
          original.style.visibility = "hidden";
          document.querySelector(".game-screen")?.appendChild(image);
        },
        {
          box,
          index: overlayIndex,
          dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
        },
      );
      overlayIndex += 1;
    }
  }
  await page.locator('[data-visual-capture-overlay="true"]').evaluateAll(async (elements) => {
    await Promise.all(elements.map((element) => (element as HTMLImageElement).decode()));
  });
  const waitForPaint = (frameCount = 3) =>
    page.evaluate(async (frames) => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => {
        const paint = (remaining: number) => {
          if (remaining <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(() => paint(remaining - 1));
        };
        paint(frames);
      });
    }, frameCount);
  await waitForPaint(options.transient ? 1 : 3);
  const screenshotOptions = {
    fullPage: options.fullPage,
    // The live Pixi frame is frozen into an ordinary image before capture, so
    // HTML and battlefield pixels share one stable browser compositing path.
    animations: canvasWasLive ? ("allow" as const) : ("disabled" as const),
    caret: "hide" as const,
  };
  const gameSurface = page.getByTestId("game-screen");
  const hasGameSurface = await gameSurface.isVisible();
  const takeScreenshot = (outputPath?: string) =>
    hasGameSurface
      ? gameSurface.screenshot({
          animations: screenshotOptions.animations,
          caret: screenshotOptions.caret,
          path: outputPath,
        })
      : page.screenshot({ ...screenshotOptions, path: outputPath });

  // Discarded readbacks prevent a partial frame immediately after the frozen
  // battlefield image or a modal replaces its prior compositor layer.
  if (canvasWasLive || options.hideCanvas) {
    for (let readback = 0; readback < 2; readback += 1) {
      await takeScreenshot();
      await page.waitForTimeout(75);
      await waitForPaint();
    }
  }
  const screenshotPath = path.join(SCREENSHOT_DIRECTORY, filename);
  await takeScreenshot(screenshotPath);
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
  if (canvasWasLive) {
    await page.locator('[data-visual-capture-canvas="true"]').evaluateAll((elements) => {
      for (const element of elements) element.remove();
    });
    await canvas.evaluate((element) => {
      (element as HTMLElement).style.visibility = "";
    });
    await page.evaluate(() => {
      window.__HEX_DOMINION__?.setTransientCapture(false);
      document.documentElement.classList.remove("visual-capture-frozen");
    });
  }
  await page.locator('[data-visual-capture-overlay="true"]').evaluateAll((elements) => {
    for (const element of elements) element.remove();
  });
  await page.locator("[data-visual-capture-visibility]").evaluateAll((elements) => {
    for (const element of elements) {
      const original = element as HTMLElement;
      original.style.visibility = original.dataset.visualCaptureVisibility ?? "";
      delete original.dataset.visualCaptureVisibility;
    }
  });
}

async function fitOverview(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = window.__HEX_DOMINION__;
    if (!api) throw new Error("Hex Dominion debug API is unavailable");
    api.fitOverview();
  });
}

async function inspectTile(page: Page, tileId: string): Promise<void> {
  await page.evaluate(() => window.__HEX_DOMINION__?.cancelSelection());
  await page.waitForFunction(() => window.__HEX_DOMINION__?.selectedTile === null);
  await selectTile(page, tileId);
  await page.waitForFunction((id) => window.__HEX_DOMINION__?.selectedTile === id, tileId);
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

test("captures neutral spawn selection with visible provisional footprints", async ({ page }) => {
  const health = observeBrowserHealth(page);
  const placement = await startSinglePlayerPlacement(page, {
    aiCount: 3,
    seed: "VISUAL-PLACEMENT",
    playerName: "Placement Warden",
  });
  const localPlayerId = placement.config.localPlayerId ?? 0;
  await page.waitForFunction(
    (playerId) =>
      window.__HEX_DOMINION__?.placement.placements.every(
        (entry) => entry.playerId === playerId || entry.locked,
      ),
    localPlayerId,
    { timeout: 8_000 },
  );
  const centerId = await page.evaluate(
    () => window.__HEX_DOMINION__?.placement.recommendedPlacementCenter,
  );
  expect(centerId).toBeTruthy();
  await page.evaluate((id) => window.__HEX_DOMINION__?.selectTile(id!), centerId);
  await page.waitForFunction(
    ({ playerId, id }) => window.__HEX_DOMINION__?.placement.placements[playerId]?.centerId === id,
    { playerId: localPlayerId, id: centerId },
  );
  await capture(page, "placement-selection.png", { hideDebug: true });
  await health.assertHealthy();
});

test("captures the center-first opening handoff before the six-hex ring", async ({ page }) => {
  const health = observeBrowserHealth(page);
  const placement = await startSinglePlayerPlacement(page, {
    aiCount: 3,
    seed: "VISUAL-OPENING",
    playerName: "Opening Warden",
  });
  const localPlayerId = placement.config.localPlayerId ?? 0;
  await page.waitForFunction(
    (playerId) =>
      window.__HEX_DOMINION__?.placement.placements.every(
        (entry) => entry.playerId === playerId || entry.locked,
      ),
    localPlayerId,
    { timeout: 8_000 },
  );
  const centerId = await page.evaluate(
    () => window.__HEX_DOMINION__?.placement.recommendedPlacementCenter,
  );
  expect(centerId).toBeTruthy();
  await page.evaluate((id) => window.__HEX_DOMINION__?.selectTile(id!), centerId);
  await page.waitForFunction(
    ({ playerId, id }) => window.__HEX_DOMINION__?.placement.placements[playerId]?.centerId === id,
    { playerId: localPlayerId, id: centerId },
  );
  await page.getByTestId("lock-placement").click();
  await page.waitForFunction(
    ({ playerId, center }) => {
      const api = window.__HEX_DOMINION__;
      if (!api || api.phase !== "opening") return false;
      const cluster = new Set(api.map.spawnClusters[playerId] ?? []);
      const captures = api.getPresentation().captures.filter((entry) => cluster.has(entry.tileId));
      const centerCapture = captures.find((entry) => entry.tileId === center);
      return (
        api.getPresentation().focusTileId === center &&
        captures.length === 7 &&
        (centerCapture?.age ?? 0) > 0.15 &&
        captures
          .filter((entry) => entry.tileId !== center)
          .every((entry) => centerCapture && entry.age < 0 && centerCapture.age > entry.age)
      );
    },
    { playerId: localPlayerId, center: centerId },
    { timeout: 900 },
  );
  await capture(page, "opening-handoff.png", { hideDebug: true, transient: true });
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
    await fitOverview(page);
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
  await fitOverview(page);
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

test("captures aggregate Multi sources, numbered targets, and route fans", async ({ page }) => {
  test.setTimeout(75_000);
  const health = observeBrowserHealth(page);
  const opening = await startSinglePlayer(page, {
    aiCount: 3,
    seed: "VISUAL-MULTI-PREVIEW",
    playerName: "Multi Warden",
  });
  await pauseSimulation(page);
  const localPlayerId = opening.config.localPlayerId ?? 0;
  const owned = opening.map.tiles.filter((tile) => tile.owner === localPlayerId && tile.troops > 1);
  expect(owned.length).toBeGreaterThanOrEqual(4);
  await page.getByRole("button", { name: "Start Multi movement selection" }).click();
  for (const source of owned.slice(0, 2)) {
    await selectTile(page, source.id);
  }
  await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.sourceIds.length === 2);
  await page.getByRole("button", { name: "Choose Targets" }).click();
  for (const target of owned.slice(2, 4)) {
    await selectTile(page, target.id);
  }
  await page.waitForFunction(
    () =>
      window.__HEX_DOMINION__?.multi.sourceIds.length === 2 &&
      window.__HEX_DOMINION__?.multi.destinationIds.length === 2,
  );
  const staged = await getTestApiSnapshot(page);
  expect(staged.multi).toMatchObject({ phase: "targets" });
  await capture(page, "multi-route-preview.png", { hideDebug: true });
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

test("captures deterministic structures, combat, capture, and victory fixtures", async ({
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
  const pendingStructure = structures.map.tiles.find(
    (tile) => tile.structure?.pendingProgressTicks !== null && tile.structure !== null,
  );
  expect(pendingStructure).toBeTruthy();
  await selectTile(page, pendingStructure!.id);
  await expect(page.getByTestId("structure-progress-text")).toContainText(/Construction 50%/i);
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

  const captureBefore = await loadDebugScenario(page, "capture-before");
  expect(captureBefore.battles[0]?.actualControl).toBe(9_900);
  await page.waitForFunction(
    (battleId) =>
      window.__HEX_DOMINION__
        ?.getPresentation()
        .battles.some(
          (candidate) =>
            candidate.id === battleId &&
            (candidate.segments?.length ?? 0) === 2 &&
            candidate.actual > 0.5,
        ),
    captureBefore.battles[0]!.id,
  );
  const captured = await loadDebugScenario(page, "capture");
  expect(captured.battles).toHaveLength(0);
  await capture(page, "capture-transition.png", { hideDebug: true, transient: true });

  const nWay = await loadDebugScenario(page, "elimination");
  expect(nWay.battles[0]?.participants).toHaveLength(3);
  await inspectTile(page, nWay.battles[0]!.tileId);
  await expect(page.getByTestId("battle-participant-roster").getByRole("listitem")).toHaveCount(3);
  await capture(page, "battle-three-factions.png", { hideDebug: true });

  const enclosure = await loadDebugScenario(page, "interior-build");
  expect(enclosure.enclosures).toHaveLength(1);
  await inspectTile(page, enclosure.enclosures[0]!.tileIds[0]!);
  await expect(page.getByTestId("enclosure-status")).toContainText(/ticks?.*seconds remaining/i);
  await capture(page, "encirclement-countdown.png", { hideDebug: true });

  const victory = await loadDebugScenario(page, "victory");
  expect(victory.winner).toBe(victory.config.localPlayerId ?? 0);
  await expect(page.getByTestId("victory-screen")).toBeVisible();
  await capture(page, "victory.png", {
    hideDebug: true,
    hideCanvas: true,
  });
  await health.assertHealthy();
});

test("captures the deterministic reinforcement fixture in a fresh compositor", async ({ page }) => {
  test.setTimeout(75_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "heartland",
    seed: "debug-reinforcement-test",
    playerName: "Scenario Warden",
  });
  const battle = await loadDebugScenario(page, "battle");
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
  await capture(page, "battle-reinforcement.png", { hideDebug: true, transient: true });
  await health.assertHealthy();
});

test("captures the deterministic defeat fixture in a fresh compositor", async ({ page }) => {
  test.setTimeout(75_000);
  const health = observeBrowserHealth(page);
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "heartland",
    seed: "debug-defeat-test",
    playerName: "Scenario Warden",
  });
  const defeat = await loadDebugScenario(page, "defeat");
  expect(defeat.winner).not.toBe(defeat.config.localPlayerId ?? 0);
  await expect(page.getByTestId("defeat-screen")).toBeVisible();
  await capture(page, "defeat.png", {
    hideDebug: true,
    hideCanvas: true,
  });
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
  await startSinglePlayer(page, {
    aiCount: 3,
    archetype: "highland-basin",
    seed: "VISUAL-TABLET",
    playerName: "Tablet Warden",
  });
  await pauseSimulation(page);
  await capture(page, "tablet-active-game.png", { hideDebug: true });
  await health.assertHealthy();
});

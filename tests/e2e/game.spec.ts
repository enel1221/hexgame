import { expect, test, type Page } from "@playwright/test";
import { BALANCE } from "../../src/shared/balance";
import {
  getPresentation,
  getTestApiSnapshot,
  getTileClientPoint,
  issueFriendlyMove,
  issueHostileBattle,
  loadDebugScenario,
  observeBrowserHealth,
  openTitle,
  reinforceBattle,
  resumeSimulation,
  startSinglePlayer,
  startSinglePlayerPlacement,
} from "./support";

async function inspectDebugTile(page: Page, tileId: string): Promise<void> {
  await page.evaluate(() => window.__HEX_DOMINION__?.cancelSelection());
  await page.waitForFunction(() => window.__HEX_DOMINION__?.selectedTile === null);
  await page.evaluate((id) => window.__HEX_DOMINION__?.selectTile(id), tileId);
  await page.waitForFunction((id) => window.__HEX_DOMINION__?.selectedTile === id, tileId);
}

test.describe("Hex Dominion browser flows", () => {
  test("title setup exposes the supported configuration without dead controls", async ({
    page,
  }) => {
    const health = observeBrowserHealth(page);
    await openTitle(page);

    await expect(page.getByTestId("single-tab")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("ai-count")).toHaveAttribute("min", "3");
    await expect(page.getByTestId("ai-count")).toHaveAttribute("max", "20");
    await expect(page.getByTestId("ai-count")).toHaveValue("5");
    await expect(page.getByTestId("difficulty")).toHaveValue("normal");

    for (const archetype of ["heartland", "broken-crown", "highland-basin"] as const) {
      const option = page.getByTestId(`map-${archetype}`);
      await option.click();
      await expect(option).toHaveAttribute("aria-checked", "true");
    }
    await expect(page.getByTestId("map-heartland")).toContainText("River Gates");
    await expect(page.getByTestId("map-broken-crown")).toContainText("Shattered Crown");
    await expect(page.getByTestId("map-highland-basin")).toContainText("Highland Passes");
    await expect(page.getByText("312", { exact: true })).toBeVisible();

    await page.getByTestId("player-name").fill("");
    await expect(page.getByTestId("start-match")).toBeDisabled();
    await page.getByTestId("player-name").fill("Setup Warden");
    await page.getByTestId("seed").fill("");
    await expect(page.getByTestId("start-match")).toBeDisabled();
    await page.getByTestId("seed").fill("TITLE-E2E");
    await expect(page.getByTestId("start-match")).toBeEnabled();

    await page.getByTestId("multiplayer-tab").click();
    await expect(page.getByTestId("multiplayer-setup")).toBeVisible();
    await expect(page.getByTestId("room-action")).toBeVisible();
    await page.getByTestId("single-tab").click();
    await expect(page.getByRole("radiogroup", { name: "Map archetype" })).toBeVisible();

    await health.assertHealthy();
  });

  test("keeps tick zero neutral while placement relocates, locks, and hands off the opening", async ({
    page,
  }) => {
    const health = observeBrowserHealth(page);
    let placement = await startSinglePlayerPlacement(page, {
      aiCount: 3,
      seed: "E2E-PLACEMENT",
      playerName: "Placement Warden",
    });
    const localPlayerId = placement.config.localPlayerId ?? 0;
    expect(placement.phase).toBe("placement");
    expect(placement.tick).toBe(0);
    expect(placement.map.tiles.every((tile) => tile.owner === null)).toBe(true);
    await expect(page.getByTestId("placement-panel")).toBeVisible();
    await expect(page.locator(".placement-roster > div")).toHaveCount(4);

    await page.waitForFunction(
      (playerId) =>
        window.__HEX_DOMINION__?.placement.placements.every(
          (entry) => entry.playerId === playerId || entry.locked,
        ),
      localPlayerId,
      { timeout: 8_000 },
    );
    placement = await getTestApiSnapshot(page);
    const byId = new Map(placement.map.tiles.map((tile) => [tile.id, tile]));
    const occupied = placement.placement.placements
      .filter((entry) => entry.playerId !== localPlayerId)
      .map((entry) => byId.get(entry.centerId!))
      .filter(Boolean);
    const distance = (left: { q: number; r: number }, right: { q: number; r: number }) =>
      Math.max(
        Math.abs(left.q - right.q),
        Math.abs(left.r - right.r),
        Math.abs(left.q + left.r - right.q - right.r),
      );
    const choices = placement.placement.selectableCandidates.filter((id) => {
      const candidate = byId.get(id)!;
      return occupied.every((other) => other && distance(candidate, other) >= 6);
    });
    expect(choices.length).toBeGreaterThan(1);
    const clickableChoices: string[] = [];
    for (const centerId of choices) {
      const point = await getTileClientPoint(page, centerId);
      const hitsCanvas = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("game-canvas") ?? false,
        point,
      );
      if (hitsCanvas) clickableChoices.push(centerId);
      if (clickableChoices.length === 2) break;
    }
    expect(clickableChoices).toHaveLength(2);
    for (const centerId of clickableChoices) {
      const point = await getTileClientPoint(page, centerId);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(
        ({ playerId, id }) =>
          window.__HEX_DOMINION__?.placement.placements[playerId]?.centerId === id,
        { playerId: localPlayerId, id: centerId },
      );
    }
    expect((await getTestApiSnapshot(page)).tick).toBe(0);
    await expect(page.getByTestId("lock-placement")).toBeEnabled();
    await page.getByTestId("lock-placement").click();
    await expect(page.getByTestId("opening-banner")).toBeVisible({ timeout: 3_000 });
    await page.waitForFunction(
      ({ centerId, playerId }) => {
        const api = window.__HEX_DOMINION__;
        if (!api || api.phase !== "opening") return false;
        const cluster = new Set(api.map.spawnClusters[playerId] ?? []);
        const localCaptures = api
          .getPresentation()
          .captures.filter((capture) => cluster.has(capture.tileId));
        const center = localCaptures.find((capture) => capture.tileId === centerId);
        const ring = localCaptures.filter((capture) => capture.tileId !== centerId);
        return (
          api.getPresentation().focusTileId === centerId &&
          localCaptures.length === 7 &&
          Boolean(center && ring.length === 6 && ring.every((capture) => center.age > capture.age))
        );
      },
      { centerId: clickableChoices[1]!, playerId: localPlayerId },
      { timeout: 900 },
    );
    const openingPresentation = await getPresentation(page);
    expect(openingPresentation.focusTileId).toBe(clickableChoices[1]);
    await page.waitForFunction(
      () => window.__HEX_DOMINION__?.phase === "running" && window.__HEX_DOMINION__.tick > 0,
      undefined,
      { timeout: 5_000 },
    );
    expect((await getTestApiSnapshot(page)).config.startingCenters?.[localPlayerId]).toBe(
      clickableChoices[1],
    );
    await health.assertHealthy();
  });

  test("starts a three-AI match and publishes worker, map, and HUD state", async ({ page }) => {
    const health = observeBrowserHealth(page);
    const snapshot = await startSinglePlayer(page, {
      aiCount: 3,
      archetype: "heartland",
      seed: "E2E-THREE-AI",
      playerName: "Three Warden",
    });

    expect(snapshot.config.aiCount).toBe(3);
    expect(snapshot.players).toHaveLength(4);
    expect(snapshot.players.filter((player) => player.isHuman)).toHaveLength(1);
    expect(snapshot.map.archetype).toBe("heartland");
    expect(snapshot.map.seed).toBe("E2E-THREE-AI");
    expect(snapshot.map.landCount).toBe(208);
    expect(snapshot.map.spawnClusters).toHaveLength(4);
    expect(snapshot.map.spawnClusters.every((cluster) => cluster.length === 7)).toBe(true);
    expect(snapshot.stateHash).toMatch(/^[0-9a-f]{16}$/);

    await expect(page.getByTestId("supply")).toContainText(/\d/);
    await expect(page.getByTestId("land-control")).toContainText(/7\s*\/\s*208/);
    await expect(page.getByTestId("debug-overlay")).toContainText("FIELD TELEMETRY");
    await expect(page.getByTestId("debug-overlay")).toContainText("E2E-THREE-AI");
    await health.assertHealthy();
  });

  test("single-player pause freezes simulation ticks and resumes cleanly", async ({ page }) => {
    const health = observeBrowserHealth(page);
    await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-PAUSE",
      playerName: "Pause Warden",
    });
    const pause = page.getByTestId("pause-toggle");
    await pause.click();
    await expect(pause).toHaveAttribute("aria-pressed", "true");
    await expect(pause).toHaveAttribute("aria-label", "Resume simulation");
    await page.waitForTimeout(250);
    const frozenTick = (await getTestApiSnapshot(page)).tick;
    await page.waitForTimeout(400);
    expect((await getTestApiSnapshot(page)).tick).toBe(frozenTick);

    await pause.click();
    await expect(pause).toHaveAttribute("aria-pressed", "false");
    await page.waitForFunction((tick) => (window.__HEX_DOMINION__?.tick ?? 0) > tick, frozenTick, {
      timeout: 2_000,
    });
    await health.assertHealthy();
  });

  test("starts the required twenty-AI configuration and remains worker-responsive", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const health = observeBrowserHealth(page);
    const snapshot = await startSinglePlayer(page, {
      aiCount: 20,
      archetype: "broken-crown",
      seed: "E2E-TWENTY-AI",
      playerName: "Scale Warden",
      graphics: "low",
    });

    expect(snapshot.config.aiCount).toBe(20);
    expect(snapshot.players).toHaveLength(21);
    expect(snapshot.map.landCount).toBe(1_092);
    expect(snapshot.map.spawnClusters).toHaveLength(21);
    expect(snapshot.stateHash).toMatch(/^[0-9a-f]{16}$/);
    const startingTick = snapshot.tick;
    await page.waitForFunction(
      (tick) => (window.__HEX_DOMINION__?.tick ?? 0) > tick,
      startingTick,
      {
        timeout: 30_000,
      },
    );

    await expect(page.getByTestId("land-control")).toContainText(/7\s*\/\s*1092/);
    await expect(page.getByTestId("debug-overlay")).toContainText("E2E-TWENTY-AI");
    await health.assertHealthy();
  });

  test("selects a garrison, changes dispatch strength, and observes intermediate movement", async ({
    page,
  }) => {
    const health = observeBrowserHealth(page);
    await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-FRIENDLY-MOVE",
      playerName: "March Warden",
    });

    const { pair, stack, presentation } = await issueFriendlyMove(page, 75);
    const expectedTroops = Math.min(
      pair.sourceTroops - 1,
      Math.floor((pair.sourceTroops * 75) / 100),
    );
    expect(stack.troops).toBe(expectedTroops);
    expect(stack.path.length).toBeGreaterThan(1);
    expect(stack.segmentProgress).toBeGreaterThan(0);
    expect(stack.segmentProgress).toBeLessThan(stack.segmentDuration);
    await expect(page.getByTestId("tile-inspector")).toBeHidden();

    expect(Number.isFinite(presentation.x)).toBe(true);
    expect(Number.isFinite(presentation.y)).toBe(true);
    const movedHandle = await page.waitForFunction(
      ({ id, x, y }) => {
        const current = window.__HEX_DOMINION__
          ?.getPresentation()
          .stacks.find((candidate) => candidate.id === id);
        return current && Math.hypot(current.x - x, current.y - y) > 0.05 ? current : false;
      },
      { id: stack.id, x: presentation.x, y: presentation.y },
      { timeout: 2_000 },
    );
    const moved = (await movedHandle.jsonValue()) as { x: number; y: number };
    expect(Math.hypot(moved.x - presentation.x, moved.y - presentation.y)).toBeGreaterThan(0.05);

    const after = await getTestApiSnapshot(page);
    expect(after.selectedTile).toBeNull();
    await health.assertHealthy();
  });

  test("submits one desktop Shift Multi order and cancels safely on lost focus", async ({
    page,
  }) => {
    const health = observeBrowserHealth(page);
    const opening = await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-MULTI-SHIFT",
      playerName: "Column Warden",
    });
    const localPlayerId = opening.config.localPlayerId ?? 0;
    const owned = opening.map.tiles.filter(
      (tile) => tile.owner === localPlayerId && tile.troops > 1,
    );
    const localStacksBefore = opening.stacks.filter(
      (stack) => stack.owner === localPlayerId,
    ).length;
    expect(owned.length).toBeGreaterThanOrEqual(3);

    await page.keyboard.down("Shift");
    await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.phase === "sources");
    const firstSourcePoint = await getTileClientPoint(page, owned[0]!.id);
    await page.mouse.click(firstSourcePoint.x, firstSourcePoint.y);
    await page.waitForFunction(
      (id) => window.__HEX_DOMINION__?.multi.sourceIds.includes(id),
      owned[0]!.id,
    );
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.phase === "idle");
    expect(
      (await getTestApiSnapshot(page)).stacks.filter((stack) => stack.owner === localPlayerId),
    ).toHaveLength(localStacksBefore);

    await page.keyboard.down("Shift");
    await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.phase === "sources");
    const cancelPoint = await getTileClientPoint(page, owned[1]!.id);
    await page.locator("canvas.game-canvas").dispatchEvent("pointerdown", {
      pointerId: 73,
      pointerType: "mouse",
      clientX: cancelPoint.x,
      clientY: cancelPoint.y,
      button: 0,
    });
    await page.locator("canvas.game-canvas").dispatchEvent("pointercancel", {
      pointerId: 73,
      pointerType: "mouse",
      clientX: cancelPoint.x,
      clientY: cancelPoint.y,
      button: 0,
    });
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.phase === "idle");

    await page.keyboard.down("Shift");
    await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.phase === "sources");
    for (const source of owned.slice(0, 2)) {
      const point = await getTileClientPoint(page, source.id);
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(
        (id) => window.__HEX_DOMINION__?.multi.sourceIds.includes(id),
        source.id,
      );
    }
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => window.__HEX_DOMINION__?.multi.phase === "targets");
    const targetPoint = await getTileClientPoint(page, owned[2]!.id);
    await page.mouse.click(targetPoint.x, targetPoint.y);
    await page.waitForFunction(
      (playerId) =>
        window.__HEX_DOMINION__?.multi.phase === "idle" &&
        (window.__HEX_DOMINION__?.stacks.some((stack) => stack.owner === playerId) ?? false),
      localPlayerId,
    );
    const issued = await getTestApiSnapshot(page);
    const localStacks = issued.stacks.filter((stack) => stack.owner === localPlayerId);
    expect(localStacks.length).toBeGreaterThan(localStacksBefore);
    expect(localStacks.reduce((sum, stack) => sum + stack.troops, 0)).toBeGreaterThan(0);
    await health.assertHealthy();
  });

  test("operates Multi end to end with the keyboard hex cursor", async ({ page }) => {
    const health = observeBrowserHealth(page);
    const opening = await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-MULTI-KEYBOARD",
      playerName: "Keyboard Warden",
    });
    const localPlayerId = opening.config.localPlayerId ?? 0;
    const centerId = opening.map.spawnClusters[localPlayerId]![0]!;
    const canvas = page.locator("canvas.game-canvas");

    await page.getByRole("button", { name: "Start Multi movement selection" }).click();
    await canvas.focus();
    await expect(canvas).toHaveAttribute("tabindex", "0");
    await expect(canvas).toHaveAttribute("aria-label", /arrow keys.*Enter or Space/i);
    await canvas.press("Enter");
    await page.waitForFunction(
      (id) => window.__HEX_DOMINION__?.multi.sourceIds.includes(id),
      centerId,
    );

    await canvas.press("ArrowRight");
    const neighborId = (await getPresentation(page)).keyboardTileId;
    expect(neighborId).toBeTruthy();
    if (!neighborId) throw new Error("Keyboard navigation did not select a neighboring tile");
    expect(neighborId).not.toBe(centerId);
    await canvas.press("Enter");
    await page.waitForFunction(
      (id) => window.__HEX_DOMINION__?.multi.sourceIds.includes(id),
      neighborId,
    );

    await page.getByRole("button", { name: "Choose Targets" }).click();
    await canvas.focus();
    await canvas.press("Enter");
    await page.waitForFunction(
      (id) =>
        window.__HEX_DOMINION__?.multi.destinationIds.includes(id) &&
        !window.__HEX_DOMINION__?.multi.sourceIds.includes(id),
      neighborId,
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(
      (playerId) => window.__HEX_DOMINION__?.stacks.some((stack) => stack.owner === playerId),
      localPlayerId,
    );
    await health.assertHealthy();
  });

  test("touch Multi controls stage multiple targets before explicit Send", async ({ page }) => {
    const health = observeBrowserHealth(page);
    await page.setViewportSize({ width: 520, height: 820 });
    const opening = await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-MULTI-TOUCH",
      playerName: "Touch Warden",
      graphics: "low",
    });
    const localPlayerId = opening.config.localPlayerId ?? 0;
    const owned = opening.map.tiles.filter(
      (tile) => tile.owner === localPlayerId && tile.troops > 1,
    );
    expect(owned.length).toBeGreaterThanOrEqual(4);

    await page.getByRole("button", { name: "Start Multi movement selection" }).click();
    const canvas = page.locator("canvas.game-canvas");
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error("Battlefield canvas has no bounds");
    const pinchY = canvasBounds.y + canvasBounds.height / 2;
    const pinchLeft = canvasBounds.x + canvasBounds.width / 2 - 36;
    const pinchRight = canvasBounds.x + canvasBounds.width / 2 + 36;
    await canvas.dispatchEvent("pointerdown", {
      pointerId: 91,
      pointerType: "touch",
      clientX: pinchLeft,
      clientY: pinchY,
      button: 0,
    });
    await canvas.dispatchEvent("pointerdown", {
      pointerId: 92,
      pointerType: "touch",
      clientX: pinchRight,
      clientY: pinchY,
      button: 0,
    });
    await canvas.dispatchEvent("pointermove", {
      pointerId: 92,
      pointerType: "touch",
      clientX: pinchRight + 24,
      clientY: pinchY,
      button: 0,
    });
    for (const [id, x] of [
      [91, pinchLeft],
      [92, pinchRight + 24],
    ] as const) {
      await canvas.dispatchEvent("pointerup", {
        pointerId: id,
        pointerType: "touch",
        clientX: x,
        clientY: pinchY,
        button: 0,
      });
    }
    expect((await getTestApiSnapshot(page)).multi).toMatchObject({
      phase: "sources",
      sourceIds: [],
      destinationIds: [],
    });
    let pointerId = 100;
    const tapTile = async (tileId: string) => {
      const point = await getTileClientPoint(page, tileId);
      pointerId += 1;
      await canvas.dispatchEvent("pointerdown", {
        pointerId,
        pointerType: "touch",
        clientX: point.x,
        clientY: point.y,
        button: 0,
      });
      await canvas.dispatchEvent("pointerup", {
        pointerId,
        pointerType: "touch",
        clientX: point.x,
        clientY: point.y,
        button: 0,
      });
    };
    for (const source of owned.slice(0, 2)) {
      await tapTile(source.id);
      await page.waitForFunction(
        (id) => window.__HEX_DOMINION__?.multi.sourceIds.includes(id),
        source.id,
      );
    }
    await page.getByRole("button", { name: "Choose Targets" }).click();
    for (const target of owned.slice(2, 4)) {
      await tapTile(target.id);
      await page.waitForFunction(
        (id) => window.__HEX_DOMINION__?.multi.destinationIds.includes(id),
        target.id,
      );
    }
    await expect(page.getByTestId("multi-panel")).toContainText("2 sources · 2 targets");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(
      (playerId) =>
        window.__HEX_DOMINION__?.multi.phase === "idle" &&
        (window.__HEX_DOMINION__?.stacks.some((stack) => stack.owner === playerId) ?? false),
      localPlayerId,
    );
    await health.assertHealthy();
  });

  test("live hostile combat exposes normalized factions and a delayed reinforcement seam", async ({
    page,
  }) => {
    const health = observeBrowserHealth(page);
    await startSinglePlayer(page, {
      aiCount: 3,
      archetype: "highland-basin",
      seed: "E2E-HOSTILE-ORDER",
      playerName: "Battle Warden",
    });

    const observed = await issueHostileBattle(page);
    expect(observed.battle.attacker).toBeGreaterThan(0);
    expect(observed.battle.defender).toBeGreaterThan(0);
    const segments = observed.presentation.segments ?? [];
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.reduce((total, segment) => total + segment.actual, 0)).toBeCloseTo(1, 4);
    expect(segments.every((segment) => segment.troops > 0)).toBe(true);
    await expect(page.getByTestId("debug-overlay")).toContainText(/BATTLES\s+[1-9]/);

    const reinforced = await reinforceBattle(page, observed.battle);
    expect(reinforced.presentation.pulse).toBeGreaterThan(0);
    expect(
      Math.abs(reinforced.presentation.displayed - reinforced.presentation.ghost),
    ).toBeGreaterThan(0.001);
    await health.assertHealthy();
  });

  test("debug-only acceptance fixtures cover structures, combat, capture, and match outcomes", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const health = observeBrowserHealth(page);
    const opening = await startSinglePlayer(page, {
      aiCount: 3,
      seed: "debug-scenario-test",
      playerName: "Scenario Warden",
    });
    const localPlayerId = opening.config.localPlayerId ?? 0;
    expect(opening.config.debug).toBe(true);

    const structures = await loadDebugScenario(page, "structures");
    expect(
      structures.map.tiles
        .filter((tile) => tile.owner === localPlayerId && tile.structure?.status === "active")
        .map((tile) => tile.structure!.type)
        .sort(),
    ).toEqual(["archery-range", "barracks", "wizard-tower"]);

    const structureTiles = structures.map.tiles.filter(
      (tile) => tile.owner === localPlayerId && tile.structure,
    );
    for (const tile of structureTiles) {
      await inspectDebugTile(page, tile.id);
      const progress = page.getByTestId("structure-progress-text");
      if (tile.structure!.type === "archery-range") {
        await expect(progress).toHaveText("Construction 50%");
      } else if (tile.structure!.type === "barracks") {
        await expect(progress).toHaveText("Barracks Melee training cycle 50%");
        await expect(page.getByTestId("rally-queued-status")).toHaveText(
          "4 Melee, 0 Ranged, 0 Wizard queued",
        );
      } else {
        await expect(progress).toHaveText("Wizard Tower Wizard training cycle 0%");
        await expect(page.getByTestId("typed-support-status")).toHaveText(
          "Wizard Tower x99 ready; no eligible nearby battle",
        );
      }
      await expect(page.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        tile.structure!.type === "wizard-tower" ? "0" : "50",
      );
    }

    const battle = await loadDebugScenario(page, "battle");
    expect(battle.battles).toHaveLength(1);
    expect(battle.battles[0]).toMatchObject({
      actualControl: 5_000,
      attacker: 56,
      defender: 56,
    });
    await inspectDebugTile(page, battle.battles[0]!.tileId);
    const battleRoster = page.getByTestId("battle-participant-roster");
    await expect(battleRoster.getByRole("listitem")).toHaveCount(2);
    for (const participant of battle.battles[0]!.participants) {
      const row = page.getByTestId(`battle-participant-${participant.playerId ?? "neutral"}`);
      const name =
        participant.playerId === null
          ? "Neutral defenders"
          : battle.players.find((player) => player.id === participant.playerId)!.name;
      await expect(row).toContainText(name);
      await expect(row).toContainText(`${participant.troops} units`);
      await expect(row.getByLabel(/Melee.*Ranged.*Wizard/i)).toBeVisible();
      await expect(row).toContainText(/Type (?:advantage|disadvantage|matchup even)/i);
      await expect(row).toContainText(/\d+\.\d{2}% effective share/);
      if (participant.playerId === battle.battles[0]!.incumbentOwner) {
        await expect(row).toContainText("incumbent");
      }
    }
    const displayedShares = (await battleRoster.getByRole("listitem").allTextContents()).map(
      (text) => Number(text.match(/([\d.]+)% effective share/)?.[1]),
    );
    expect(displayedShares.every(Number.isFinite)).toBe(true);
    expect(displayedShares.reduce((total, share) => total + share, 0)).toBeCloseTo(100, 2);
    await page.waitForFunction((battleId) => {
      const seam = window.__HEX_DOMINION__
        ?.getPresentation()
        .battles.find((candidate) => candidate.id === battleId);
      return Boolean(
        seam &&
        seam.actual > 0.5 &&
        Math.abs(seam.displayed - seam.actual) < 0.001 &&
        Math.abs(seam.ghost - seam.actual) < 0.001 &&
        seam.segments?.some((segment) => segment.rpsMultiplierPermille > 1000),
      );
    }, battle.battles[0]!.id);

    const reinforcement = await loadDebugScenario(page, "reinforcement");
    expect(reinforcement.battles).toHaveLength(1);
    expect(reinforcement.battles[0]).toMatchObject({
      id: battle.battles[0]!.id,
      actualControl: 5_800,
      attacker: 96,
      defender: 56,
    });
    await page.waitForFunction(
      (battleId) => {
        const seam = window.__HEX_DOMINION__
          ?.getPresentation()
          .battles.find((candidate) => candidate.id === battleId);
        return Boolean(seam && seam.pulse > 0 && Math.abs(seam.displayed - seam.ghost) > 0.001);
      },
      reinforcement.battles[0]!.id,
      { timeout: 3_000 },
    );

    const captureBefore = await loadDebugScenario(page, "capture-before");
    expect(captureBefore.battles).toHaveLength(1);
    expect(captureBefore.battles[0]).toMatchObject({
      actualControl: 9_900,
      attacker: 96,
      defender: 24,
    });
    const capturedTileId = captureBefore.battles[0]!.tileId;

    const captured = await loadDebugScenario(page, "capture");
    expect(captured.battles).toHaveLength(0);
    expect(captured.map.tiles.find((tile) => tile.id === capturedTileId)?.owner).toBe(
      localPlayerId,
    );
    expect(captured.players.find((player) => player.id === localPlayerId)?.tiles).toBe(8);
    await expect(page.locator(".event-feed")).toContainText(
      `+${BALANCE.captureRewardMilli / 1000} Supply for hostile capture`,
    );

    const victory = await loadDebugScenario(page, "victory");
    expect(victory.winner).toBe(localPlayerId);
    const victoryScreen = page.getByTestId("victory-screen");
    await expect(victoryScreen).toBeVisible();
    await expect(victoryScreen).toContainText("Dominion secured");
    await expect(victoryScreen.locator(".victory-stats")).toBeVisible();
    await expect(victoryScreen.locator(".victory-actions button")).toHaveCount(3);

    const defeat = await loadDebugScenario(page, "defeat");
    expect(defeat.winner).not.toBe(localPlayerId);
    const defeatScreen = page.getByTestId("defeat-screen");
    await expect(defeatScreen).toBeVisible();
    await expect(defeatScreen).toContainText("Your banners have fallen");
    await expect(defeatScreen.locator(".victory-stats")).toBeVisible();
    await expect(defeatScreen.locator(".victory-actions button")).toHaveCount(3);
    await health.assertHealthy();
  });

  test("debug fixtures enforce minimum combat time, developed seizure rewards, and elimination attribution", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const health = observeBrowserHealth(page);
    const opening = await startSinglePlayer(page, {
      aiCount: 3,
      seed: "debug-acceptance-rules",
      playerName: "Rules Warden",
    });
    const localPlayerId = opening.config.localPlayerId ?? 0;

    const minimum = await loadDebugScenario(page, "battle-minimum");
    const battleStartTick = minimum.tick;
    expect(minimum.paused).toBe(true);
    expect(minimum.battles[0]).toMatchObject({ actualControl: 9_900, attacker: 96, defender: 1 });
    await resumeSimulation(page);
    await page.waitForFunction(
      (targetTick) => (window.__HEX_DOMINION__?.tick ?? 0) >= targetTick,
      battleStartTick + BALANCE.minimumBattleTicks,
      { timeout: 8_000 },
    );
    const timingFrames = (await page.evaluate(
      ({ beforeTick, resolutionTick }) => {
        const api = window.__HEX_DOMINION__;
        if (!api) throw new Error("Hex Dominion debug API is unavailable");
        return [api.inspectStateAt(beforeTick), api.inspectStateAt(resolutionTick)];
      },
      {
        beforeTick: battleStartTick + BALANCE.minimumBattleTicks - 1,
        resolutionTick: battleStartTick + BALANCE.minimumBattleTicks,
      },
    )) as Array<{ battles: unknown[]; tick: number } | null>;
    expect(timingFrames[0]).toMatchObject({ tick: battleStartTick + 34 });
    expect(timingFrames[0]?.battles).toHaveLength(1);
    expect(timingFrames[1]).toMatchObject({ tick: battleStartTick + 35 });
    expect(timingFrames[1]?.battles).toHaveLength(0);

    const developed = await loadDebugScenario(page, "developed-capture");
    const developedBattle = developed.battles[0]!;
    const playerBeforeCapture = developed.players.find((player) => player.id === localPlayerId)!;
    expect(
      developed.map.tiles.find((tile) => tile.id === developedBattle.tileId)?.structure,
    ).toMatchObject({
      type: "archery-range",
      status: "active",
      integrity: BALANCE.fullIntegrity,
    });
    await resumeSimulation(page);
    await page.waitForFunction(
      ({ tileId, owner }) => {
        const tile = window.__HEX_DOMINION__?.map.tiles.find(
          (candidate) => candidate.id === tileId,
        );
        return tile?.owner === owner && tile.structure?.status === "seized";
      },
      { tileId: developedBattle.tileId, owner: localPlayerId },
      { timeout: 3_000 },
    );
    const captured = await getTestApiSnapshot(page);
    const capturedStructure = captured.map.tiles.find(
      (tile) => tile.id === developedBattle.tileId,
    )?.structure;
    expect(capturedStructure).toMatchObject({
      type: "archery-range",
      status: "seized",
      integrity: BALANCE.seizedIntegrity,
    });
    const structureCaptureReward =
      BALANCE.captureRewardMilli + BALANCE.archeryRangeCaptureRewardMilli;
    const playerAfterCapture = captured.players.find((player) => player.id === localPlayerId)!;
    const earnedDuringCapture =
      playerAfterCapture.supplyEarnedMilli - playerBeforeCapture.supplyEarnedMilli;
    const trainingSpentDuringCapture =
      (playerAfterCapture.troopsTrained - playerBeforeCapture.troopsTrained) * 1_000;
    expect(earnedDuringCapture).toBeGreaterThanOrEqual(structureCaptureReward);
    expect(playerAfterCapture.supplyMilli).toBe(
      playerBeforeCapture.supplyMilli + earnedDuringCapture - trainingSpentDuringCapture,
    );
    expect(captured.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reward",
          playerId: localPlayerId,
          tileId: developedBattle.tileId,
          amount: structureCaptureReward,
        }),
        expect.objectContaining({ type: "structure-seized", tileId: developedBattle.tileId }),
      ]),
    );
    const elimination = await loadDebugScenario(page, "elimination");
    const defeated = elimination.players.find((player) => player.id !== localPlayerId)!;
    const eliminator = elimination.players.find((player) => player.id === localPlayerId)!;
    const eliminationReward = BALANCE.eliminationRewardMilli + BALANCE.eliminationTransferCapMilli;
    expect(defeated).toMatchObject({
      eliminated: true,
      eliminatedBy: localPlayerId,
      supplyMilli: 0,
    });
    expect(eliminator).toMatchObject({
      enemiesEliminated: 1,
      supplyMilli: BALANCE.startingSupplyMilli + eliminationReward,
    });
    expect(elimination.events.at(-1)).toMatchObject({
      type: "elimination",
      playerId: localPlayerId,
      amount: eliminationReward,
    });
    expect(elimination.battles[0]?.participants).toHaveLength(3);
    await inspectDebugTile(page, elimination.battles[0]!.tileId);
    await expect(page.getByTestId("battle-participant-roster").getByRole("listitem")).toHaveCount(
      3,
    );
    await expect(page.locator(".event-feed")).toContainText(/eliminated/i);
    await health.assertHealthy();
  });

  test("invalid Archery Range placement reports a recoverable user-facing error", async ({
    page,
  }) => {
    const health = observeBrowserHealth(page);
    await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-BUILD-ERROR",
      playerName: "Builder Warden",
    });

    const snapshot = await getTestApiSnapshot(page);
    const localPlayerId = snapshot.config.localPlayerId ?? 0;
    const invalid =
      snapshot.map.tiles.find(
        (tile) => tile.owner === localPlayerId && tile.terrain !== "meadow" && !tile.structure,
      ) ??
      snapshot.map.tiles.find((tile) => tile.owner === localPlayerId && Boolean(tile.structure));
    expect(
      invalid,
      "the deterministic spawn should include invalid Archery Range land",
    ).toBeDefined();

    const range = page.getByTestId("build-archery-range");
    await range.click();
    await expect(range).toHaveAttribute("aria-pressed", "true");
    await page.evaluate((tileId) => {
      const api = window.__HEX_DOMINION__;
      if (!api) throw new Error("Hex Dominion debug API is unavailable");
      api.hoverTile(tileId);
      api.selectTile(tileId);
    }, invalid!.id);
    await expect(page.getByRole("alert")).toContainText(
      /Archery Ranges require (?:a )?Fertile Meadow|already contains a structure/,
    );
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 4_000 });
    await health.assertHealthy();
  });

  test("invalid Barracks placement reports the Muster Ground requirement", async ({ page }) => {
    const health = observeBrowserHealth(page);
    const snapshot = await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-BARRACKS-ERROR",
      playerName: "Barracks Warden",
    });
    const localPlayerId = snapshot.config.localPlayerId ?? 0;
    const invalid = snapshot.map.tiles.find(
      (tile) => tile.owner === localPlayerId && tile.terrain !== "muster" && !tile.structure,
    );
    expect(invalid, "the spawn should expose owned non-Muster land").toBeDefined();

    const barracks = page.getByTestId("build-barracks");
    await barracks.click();
    await expect(barracks).toHaveAttribute("aria-pressed", "true");
    await page.evaluate((tileId) => {
      const api = window.__HEX_DOMINION__;
      if (!api) throw new Error("Hex Dominion debug API is unavailable");
      api.hoverTile(tileId);
      api.selectTile(tileId);
    }, invalid!.id);
    await expect(page.getByRole("alert")).toContainText(/Barracks require (?:a )?Muster Ground/);
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 4_000 });
    await health.assertHealthy();
  });

  test("builds a Wizard Tower on a fully enclosed interior owned tile", async ({ page }) => {
    const health = observeBrowserHealth(page);
    await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-INTERIOR-WIZARD",
      playerName: "Interior Warden",
    });
    const fixture = await loadDebugScenario(page, "interior-build");
    const localPlayerId = fixture.config.localPlayerId ?? 0;
    const enclosure = fixture.enclosures[0]!;
    await inspectDebugTile(page, enclosure.tileIds[0]!);
    const enclosureStatus = page.getByTestId("enclosure-status");
    await expect(enclosureStatus).toContainText(
      `Encirclement by ${fixture.players.find((player) => player.id === enclosure.captorId)!.name}`,
    );
    await expect(enclosureStatus).toContainText("1-tile pocket · 1 tick · 0.1 seconds remaining");
    await expect(page.getByTestId(`enclosure-summary-${enclosure.id}`)).toContainText(
      "1 tick · 0.1s",
    );
    const byCoordinate = new Map(fixture.map.tiles.map((tile) => [`${tile.q},${tile.r}`, tile]));
    const directions = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ] as const;
    const interior = fixture.map.tiles.find(
      (tile) =>
        tile.owner === localPlayerId &&
        !tile.structure &&
        directions.every(
          ([dq, dr]) => byCoordinate.get(`${tile.q + dq},${tile.r + dr}`)?.owner === localPlayerId,
        ),
    );
    expect(interior, "the fixture should expose a six-neighbor owned interior tile").toBeDefined();

    const playerBeforeBuild = fixture.players.find((player) => player.id === localPlayerId)!;
    const tower = page.getByTestId("build-wizard-tower");
    await tower.click();
    await expect(tower).toHaveAttribute("aria-pressed", "true");
    await page.evaluate((tileId) => window.__HEX_DOMINION__?.selectTile(tileId), interior!.id);
    await resumeSimulation(page);
    await page.waitForFunction(
      (tileId) =>
        window.__HEX_DOMINION__?.map.tiles.find((tile) => tile.id === tileId)?.structure?.type ===
        "wizard-tower",
      interior!.id,
      { timeout: 3_000 },
    );
    const built = await getTestApiSnapshot(page);
    expect(built.map.tiles.find((tile) => tile.id === interior!.id)?.structure).toMatchObject({
      type: "wizard-tower",
      completedCount: 0,
      status: null,
      pendingProgressTicks: expect.any(Number),
    });
    const playerAfterBuild = built.players.find((player) => player.id === localPlayerId)!;
    const incomeDuringBuild =
      playerAfterBuild.supplyEarnedMilli - playerBeforeBuild.supplyEarnedMilli;
    const trainingSpentDuringBuild =
      (playerAfterBuild.troopsTrained - playerBeforeBuild.troopsTrained) * 1_000;
    expect(playerAfterBuild.supplyMilli).toBe(
      playerBeforeBuild.supplyMilli -
        BALANCE.wizardTower.costMilli +
        incomeDuringBuild -
        trainingSpentDuringBuild,
    );
    await health.assertHealthy();
  });

  for (const fixture of [
    { type: "archery-range", seed: "E2E-BUILD-ARCHERY", terrain: "meadow", cost: 75 },
    { type: "barracks", seed: "BUILD-2", terrain: "muster", cost: 70 },
    { type: "wizard-tower", seed: "E2E-BUILD-WIZARD", terrain: null, cost: 90 },
  ] as const) {
    test(`builds a ${fixture.type} on legal owned terrain`, async ({ page }) => {
      const health = observeBrowserHealth(page);
      const snapshot = await startSinglePlayer(page, {
        aiCount: 3,
        seed: fixture.seed,
        playerName: "Structure Warden",
      });
      const localPlayerId = snapshot.config.localPlayerId ?? 0;
      const tile = snapshot.map.tiles.find(
        (candidate) =>
          candidate.owner === localPlayerId &&
          (!candidate.structure ||
            (candidate.structure.type === fixture.type &&
              candidate.structure.pendingProgressTicks === null &&
              candidate.structure.completedCount < BALANCE.maxStructureCount)) &&
          (fixture.terrain === null || candidate.terrain === fixture.terrain),
      );
      expect(tile, `${fixture.seed} should expose legal ${fixture.type} terrain`).toBeDefined();
      const completedBefore = tile!.structure?.completedCount ?? 0;

      const playerBeforeBuild = snapshot.players.find((player) => player.id === localPlayerId)!;
      const build = page.getByTestId(`build-${fixture.type}`);
      await build.click();
      await expect(build).toHaveAttribute("aria-pressed", "true");
      await page.evaluate((tileId) => window.__HEX_DOMINION__?.selectTile(tileId), tile!.id);
      await page.waitForFunction(
        ({ tileId, type, completedCount }) => {
          const structure = window.__HEX_DOMINION__?.map.tiles.find(
            (candidate) => candidate.id === tileId,
          )?.structure;
          return (
            structure?.type === type &&
            structure.completedCount === completedCount &&
            structure.pendingProgressTicks !== null
          );
        },
        { tileId: tile!.id, type: fixture.type, completedCount: completedBefore },
        { timeout: 3_000 },
      );

      const after = await getTestApiSnapshot(page);
      const structure = after.map.tiles.find((candidate) => candidate.id === tile!.id)?.structure;
      expect(structure?.type).toBe(fixture.type);
      expect(structure?.completedCount).toBe(completedBefore);
      expect(structure?.pendingProgressTicks).not.toBeNull();
      const playerAfterBuild = after.players.find((player) => player.id === localPlayerId)!;
      const incomeDuringBuild =
        playerAfterBuild.supplyEarnedMilli - playerBeforeBuild.supplyEarnedMilli;
      const trainingSpentDuringBuild =
        (playerAfterBuild.troopsTrained - playerBeforeBuild.troopsTrained) * 1_000;
      expect(playerAfterBuild.supplyMilli).toBe(
        playerBeforeBuild.supplyMilli -
          fixture.cost * 1_000 +
          incomeDuringBuild -
          trainingSpentDuringBuild,
      );
      await health.assertHealthy();
    });
  }
});

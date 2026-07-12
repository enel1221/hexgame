import { expect, test } from "@playwright/test";
import { BALANCE } from "../../src/shared/balance";
import {
  getTestApiSnapshot,
  issueFriendlyMove,
  issueHostileBattle,
  loadDebugScenario,
  observeBrowserHealth,
  openTitle,
  reinforceBattle,
  resumeSimulation,
  startSinglePlayer,
} from "./support";

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
    expect(snapshot.map.landCount).toBe(380);
    expect(snapshot.map.spawnClusters).toHaveLength(4);
    expect(snapshot.map.spawnClusters.every((cluster) => cluster.length === 7)).toBe(true);
    expect(snapshot.stateHash).toMatch(/^[0-9a-f]{16}$/);

    await expect(page.getByTestId("supply")).toContainText(/\d/);
    await expect(page.getByTestId("land-control")).toContainText(/7\s*\/\s*380/);
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
    expect(snapshot.map.landCount).toBe(1_995);
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

    await expect(page.getByTestId("land-control")).toContainText(/7\s*\/\s*1995/);
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

  test("hostile combat starts at 50/50 and reinforcement creates a delayed seam", async ({
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
    expect(observed.presentation.actual).toBe(0.5);
    expect(observed.presentation.displayed).toBeCloseTo(0.5, 2);
    expect(observed.presentation.ghost).toBeCloseTo(0.5, 2);
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
    ).toEqual(["barracks", "farm", "turret"]);

    const battle = await loadDebugScenario(page, "battle");
    expect(battle.battles).toHaveLength(1);
    expect(battle.battles[0]).toMatchObject({
      actualControl: 5_000,
      attacker: 56,
      defender: 56,
    });
    await page.waitForFunction((battleId) => {
      const seam = window.__HEX_DOMINION__
        ?.getPresentation()
        .battles.find((candidate) => candidate.id === battleId);
      return Boolean(
        seam &&
        seam.actual === 0.5 &&
        Math.abs(seam.displayed - 0.5) < 0.001 &&
        Math.abs(seam.ghost - 0.5) < 0.001,
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
    await expect(page.locator(".event-feed")).toContainText("+3 Supply for hostile capture");

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
    const supplyBefore = developed.players.find(
      (player) => player.id === localPlayerId,
    )!.supplyMilli;
    expect(
      developed.map.tiles.find((tile) => tile.id === developedBattle.tileId)?.structure,
    ).toMatchObject({ type: "farm", status: "active", integrity: BALANCE.fullIntegrity });
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
      type: "farm",
      status: "seized",
      integrity: BALANCE.seizedIntegrity,
    });
    const structureCaptureReward = BALANCE.captureRewardMilli + BALANCE.farmCaptureRewardMilli;
    expect(captured.players.find((player) => player.id === localPlayerId)?.supplyMilli).toBe(
      supplyBefore + structureCaptureReward,
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
    await expect(page.locator(".event-feed")).toContainText("+9 Supply for hostile capture");

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
    await expect(page.locator(".event-feed")).toContainText(/eliminated/i);
    await health.assertHealthy();
  });

  test("invalid Farm placement reports a recoverable user-facing error", async ({ page }) => {
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
    expect(invalid, "the deterministic spawn should include invalid Farm land").toBeDefined();

    const farm = page.getByTestId("build-farm");
    await farm.click();
    await expect(farm).toHaveAttribute("aria-pressed", "true");
    await page.evaluate((tileId) => {
      const api = window.__HEX_DOMINION__;
      if (!api) throw new Error("Hex Dominion debug API is unavailable");
      api.hoverTile(tileId);
      api.selectTile(tileId);
    }, invalid!.id);
    await expect(page.getByRole("alert")).toContainText(
      /Farms require a Fertile Meadow|already contains a structure/,
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
    await page.evaluate((tileId) => window.__HEX_DOMINION__?.selectTile(tileId), invalid!.id);
    await expect(page.getByRole("alert")).toContainText("Barracks require a Muster Ground");
    await expect(page.getByRole("alert")).toBeHidden({ timeout: 4_000 });
    await health.assertHealthy();
  });

  test("builds a Turret on a fully enclosed interior owned tile", async ({ page }) => {
    const health = observeBrowserHealth(page);
    await startSinglePlayer(page, {
      aiCount: 3,
      seed: "E2E-INTERIOR-TURRET",
      playerName: "Interior Warden",
    });
    const fixture = await loadDebugScenario(page, "interior-build");
    const localPlayerId = fixture.config.localPlayerId ?? 0;
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

    const supplyBefore = fixture.players.find((player) => player.id === localPlayerId)!.supplyMilli;
    const turret = page.getByTestId("build-turret");
    await turret.click();
    await expect(turret).toHaveAttribute("aria-pressed", "true");
    await page.evaluate((tileId) => window.__HEX_DOMINION__?.selectTile(tileId), interior!.id);
    await resumeSimulation(page);
    await page.waitForFunction(
      (tileId) =>
        window.__HEX_DOMINION__?.map.tiles.find((tile) => tile.id === tileId)?.structure?.type ===
        "turret",
      interior!.id,
      { timeout: 3_000 },
    );
    const built = await getTestApiSnapshot(page);
    expect(built.map.tiles.find((tile) => tile.id === interior!.id)?.structure).toMatchObject({
      type: "turret",
      status: "constructing",
    });
    const supplyAfter = built.players.find((player) => player.id === localPlayerId)!.supplyMilli;
    expect(supplyAfter).toBeLessThan(supplyBefore);
    expect(supplyAfter).toBeLessThanOrEqual(supplyBefore - BALANCE.turret.costMilli + 1_000);
    await health.assertHealthy();
  });

  for (const fixture of [
    { type: "farm", seed: "E2E-BUILD-FARM", terrain: "meadow", cost: 45 },
    { type: "barracks", seed: "BUILD-2", terrain: "muster", cost: 70 },
    { type: "turret", seed: "E2E-BUILD-TURRET", terrain: null, cost: 90 },
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
          !candidate.structure &&
          (fixture.terrain === null || candidate.terrain === fixture.terrain),
      );
      expect(tile, `${fixture.seed} should expose legal ${fixture.type} terrain`).toBeDefined();

      const supplyBefore = Number.parseFloat(await page.getByTestId("supply").innerText());
      const build = page.getByTestId(`build-${fixture.type}`);
      await build.click();
      await expect(build).toHaveAttribute("aria-pressed", "true");
      await page.evaluate((tileId) => window.__HEX_DOMINION__?.selectTile(tileId), tile!.id);
      await page.waitForFunction(
        ({ tileId, type }) =>
          window.__HEX_DOMINION__?.map.tiles.find((candidate) => candidate.id === tileId)?.structure
            ?.type === type,
        { tileId: tile!.id, type: fixture.type },
        { timeout: 3_000 },
      );

      const after = await getTestApiSnapshot(page);
      const structure = after.map.tiles.find((candidate) => candidate.id === tile!.id)?.structure;
      expect(structure?.type).toBe(fixture.type);
      expect(["constructing", "active"]).toContain(structure?.status);
      const supplyAfter = Number.parseFloat(await page.getByTestId("supply").innerText());
      expect(supplyAfter).toBeLessThanOrEqual(supplyBefore - fixture.cost + 0.5);
      await health.assertHealthy();
    });
  }
});

import "pixi.js/unsafe-eval";
import { Application, BitmapFont, BitmapText, Container, Graphics, Rectangle } from "pixi.js";
import {
  barracksRallyPath,
  canPlaceStructure,
  isBarracksRallyBlocked,
  isStructureOperational,
} from "@/src/core/buildings";
import { battlePresentation } from "@/src/core/combat";
import { placementPresentationSignature } from "../placementSignature";
import { axialKey, axialToPixel, neighbors, pixelToAxial } from "@/src/core/hex";
import { eligibleSpawnCenters } from "@/src/core/map";
import type { MultiMovePlan } from "@/src/core/movement";
import { validateSpawnChoicePreview } from "@/src/core/placement";
import { BALANCE, PLAYER_COLORS, TERRAIN_COLORS } from "@/src/shared/balance";
import type {
  GameState,
  MovingStack,
  StructureState,
  StructureType,
  TileState,
} from "@/src/shared/types";
import { bindWebGlContextRecovery, type RendererContextStatus } from "./contextRecovery";

const HEX_SIZE = 36;
const BAR_WIDTH = 92;
const BAR_HEIGHT = 12;

type TileCallback = (tileId: string | null) => void;

interface RendererCallbacks {
  onTileClick: TileCallback;
  onTileHover: TileCallback;
  onCancel: () => void;
  onZoom?: (zoom: number) => void;
  onContextStatus?: (status: RendererContextStatus) => void;
}

interface RendererOptions {
  quality: "low" | "medium" | "high";
  colorPatterns: boolean;
  fullCounts: boolean;
  localPlayerId: number;
}

interface StackVisual {
  container: Container;
  squad: SoldierVisual[];
  dust: Graphics;
  badge: BitmapText;
  lastX: number;
  lastY: number;
  targetX: number;
  targetY: number;
  facingAngle: number;
}

interface SoldierVisual {
  container: Container;
  leftLeg: Graphics;
  rightLeg: Graphics;
  weapon: Graphics;
  phase: number;
}

interface StructureVisual {
  container: Container;
  animated: Graphics | null;
  pendingRing: Graphics | null;
  type: StructureType;
  status: StructureState["status"];
  progress: number;
  signature: string;
  aimAngle: number | null;
  volleyPulse: number;
}

interface BattleSegmentVisual {
  playerId: number | null;
  color: number;
  target: number;
  displayed: number;
  ghost: number;
  troops: number;
  turretSupportCount: number;
}

interface BattleVisual {
  container: Container;
  frame: Graphics;
  counts: BitmapText;
  fighters: SoldierVisual[];
  combatEffects: Graphics;
  tileId: string;
  incumbentOwner: number | null;
  segments: BattleSegmentVisual[];
  reinforcementSignature: string;
  pulse: number;
  amount: number;
  baseCounts: string;
  resolving: number | null;
}

interface CaptureVisual {
  graphics: Graphics;
  tileId: string;
  owner: number | null;
  previousOwner: number | null;
  age: number;
  angle: number;
}

interface PopupVisual {
  container: Container;
  age: number;
  baseY: number;
}

interface TurretVolleyVisual {
  graphics: Graphics;
  age: number;
  duration: number;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  color: number;
}

let badgeFontInstalled = false;

function darken(color: number, factor: number): number {
  const red = ((color >> 16) & 255) * factor;
  const green = ((color >> 8) & 255) * factor;
  const blue = (color & 255) * factor;
  return ((red & 255) << 16) | ((green & 255) << 8) | (blue & 255);
}

function lighten(color: number, amount: number): number {
  const red = Math.min(255, ((color >> 16) & 255) + amount);
  const green = Math.min(255, ((color >> 8) & 255) + amount);
  const blue = Math.min(255, (color & 255) + amount);
  return (red << 16) | (green << 8) | blue;
}

function hexPoints(size = HEX_SIZE, offsetY = 0): number[] {
  const points: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const angle = ((60 * index - 30) * Math.PI) / 180;
    points.push(Math.cos(angle) * size, Math.sin(angle) * size + offsetY);
  }
  return points;
}

function tilePosition(tile: TileState): { x: number; y: number } {
  return axialToPixel(tile, HEX_SIZE);
}

function formatTroops(value: number): string {
  if (value <= 999) return String(value);
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}

function garrisonTier(troops: number): number {
  if (troops >= 96) return 5;
  if (troops >= 48) return 4;
  if (troops >= 20) return 3;
  if (troops >= 8) return 2;
  return 1;
}

function createBadge(text: string, size = 12): BitmapText {
  const badge = new BitmapText({
    text,
    style: {
      fontFamily: "HexDominionBadge",
      fontSize: size,
      align: "center",
    },
  });
  badge.anchor.set(0.5);
  return badge;
}

function structureBuildTicks(type: StructureType): number {
  return type === "farm"
    ? BALANCE.farm.buildTicks
    : type === "barracks"
      ? BALANCE.barracks.buildTicks
      : BALANCE.turret.buildTicks;
}

function structurePendingProgress(structure: StructureState): number {
  if (structure.pendingProgressTicks === null) return 0;
  return Math.max(
    0,
    Math.min(1, structure.pendingProgressTicks / structureBuildTicks(structure.type)),
  );
}

function drawPendingRing(graphics: Graphics, structure: StructureState): void {
  graphics.clear();
  if (structure.pendingProgressTicks === null || structure.completedCount <= 0) return;
  const progress = structurePendingProgress(structure);
  graphics
    .arc(0, 0, 27, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.025, progress))
    .stroke({ color: 0xffdf8b, width: 2.6, alpha: 0.9 });
}

function drawBattleSegmentPattern(
  graphics: Graphics,
  startX: number,
  width: number,
  pattern: number,
  color: number,
): void {
  if (width < 2.5 || pattern % 7 === 0) return;
  const endX = startX + width;
  const top = -BAR_HEIGHT / 2;
  const bottom = BAR_HEIGHT / 2;
  const ink = darken(color, 0.42);
  const stroke = { color: ink, width: 1, alpha: 0.46 };
  const mode = pattern % 7;
  if (mode === 1 || mode === 5) {
    for (let origin = startX - BAR_HEIGHT; origin < endX; origin += 6) {
      const fromX = Math.max(startX, origin);
      const toX = Math.min(endX, origin + BAR_HEIGHT);
      graphics
        .moveTo(fromX, top + (fromX - origin))
        .lineTo(toX, top + (toX - origin))
        .stroke(stroke);
    }
  }
  if (mode === 2 || mode === 5) {
    for (let origin = startX; origin < endX + BAR_HEIGHT; origin += 6) {
      const fromX = Math.max(startX, origin - BAR_HEIGHT);
      const toX = Math.min(endX, origin);
      graphics
        .moveTo(fromX, bottom - (fromX - (origin - BAR_HEIGHT)))
        .lineTo(toX, bottom - (toX - (origin - BAR_HEIGHT)))
        .stroke(stroke);
    }
  }
  if (mode === 3) {
    for (let x = startX + 3; x < endX; x += 5) {
      graphics.moveTo(x, top).lineTo(x, bottom).stroke(stroke);
    }
  } else if (mode === 4) {
    for (let y = top + 3; y < bottom; y += 4) {
      graphics.moveTo(startX, y).lineTo(endX, y).stroke(stroke);
    }
  } else if (mode === 6) {
    for (let x = startX + 3; x < endX; x += 6) {
      graphics.circle(x, Math.round((x - startX) / 6) % 2 === 0 ? -2.5 : 2.5, 1).fill({
        color: ink,
        alpha: 0.5,
      });
    }
  }
}

function drawTerrainTile(
  graphics: Graphics,
  tile: TileState,
  quality: RendererOptions["quality"],
): void {
  const { x, y } = tilePosition(tile);
  const color = TERRAIN_COLORS[tile.terrain];

  graphics
    .poly(hexPoints(HEX_SIZE + 1).map((point, index) => point + (index % 2 === 0 ? x + 3 : y + 8)))
    .fill({ color: 0x071018, alpha: tile.terrain === "water" ? 0.45 : 0.58 });
  graphics
    .poly(hexPoints(HEX_SIZE).map((point, index) => point + (index % 2 === 0 ? x : y + 5)))
    .fill({ color: darken(color, 0.48), alpha: 1 });
  graphics
    .poly(hexPoints(HEX_SIZE).map((point, index) => point + (index % 2 === 0 ? x : y)))
    .fill({ color, alpha: 1 })
    .stroke({ color: lighten(color, 22), width: 1.1, alpha: 0.58 });
  graphics
    .poly(hexPoints(HEX_SIZE - 3).map((point, index) => point + (index % 2 === 0 ? x : y - 1)))
    .stroke({ color: 0xf6e7bc, width: 0.65, alpha: tile.terrain === "water" ? 0.08 : 0.16 });

  const seed = tile.decorationSeed >>> 0;
  const wobble = (seed % 7) - 3;
  if (tile.terrain === "meadow") {
    const rowColor = 0xc9d68b;
    for (let row = -2; row <= 2; row += 1) {
      const rowY = y + row * 6 + wobble * 0.25;
      graphics
        .moveTo(x - 19, rowY)
        .bezierCurveTo(x - 7, rowY - 2, x + 8, rowY + 3, x + 20, rowY)
        .stroke({ color: rowColor, width: 1.1, alpha: 0.43 });
    }
    if (quality !== "low") {
      for (let flower = 0; flower < 5; flower += 1) {
        const fx = x - 18 + ((seed >>> (flower * 3)) % 35);
        const fy = y - 18 + ((seed >>> (flower * 2 + 1)) % 33);
        graphics
          .star(fx, fy, 4, 1.6, 0.55)
          .fill({ color: flower % 2 ? 0xf1d08b : 0xf2b6c2, alpha: 0.82 });
      }
    }
  } else if (tile.terrain === "muster") {
    graphics
      .moveTo(x - 25, y + 12)
      .bezierCurveTo(x - 8, y + 4, x + 7, y - 4, x + 25, y - 13)
      .stroke({ color: 0x71634f, width: 5, alpha: 0.46 });
    graphics
      .moveTo(x - 19, y - 19)
      .bezierCurveTo(x - 5, y - 8, x + 7, y + 6, x + 21, y + 20)
      .stroke({ color: 0x7c6a52, width: 4, alpha: 0.44 });
    graphics.circle(x + 10, y - 8, 6).fill({ color: 0x74624b, alpha: 0.95 });
    graphics.circle(x + 10, y - 8, 3.5).fill({ color: 0xbda477, alpha: 0.9 });
    graphics.rect(x + 8.6, y - 20, 2.8, 13).fill({ color: 0x594939 });
    graphics.poly([x + 11, y - 20, x + 21, y - 16, x + 11, y - 12]).fill({ color: 0xd6b063 });
  } else if (tile.terrain === "forest") {
    const clusters = quality === "low" ? 3 : 5;
    for (let tree = 0; tree < clusters; tree += 1) {
      const tx = x - 19 + ((seed >>> (tree * 4)) % 39);
      const ty = y - 13 + ((seed >>> (tree * 3 + 2)) % 27);
      const scale = 0.82 + ((seed >>> (tree + 5)) % 5) * 0.06;
      graphics.rect(tx - 1.5, ty + 2, 3, 10).fill({ color: 0x3f382d, alpha: 0.88 });
      graphics
        .poly([tx, ty - 14 * scale, tx - 9 * scale, ty + 5, tx + 9 * scale, ty + 5])
        .fill({ color: tree % 2 ? 0x294c3e : 0x355b43, alpha: 1 })
        .stroke({ color: 0x6f8a5b, width: 0.8, alpha: 0.35 });
      graphics
        .poly([tx - 1, ty - 9 * scale, tx - 7 * scale, ty + 9, tx + 7 * scale, ty + 9])
        .fill({ color: tree % 2 ? 0x355d45 : 0x2a4f3a, alpha: 0.96 });
    }
  } else if (tile.terrain === "hills") {
    graphics
      .poly([x - 26, y + 15, x - 10, y - 15, x + 2, y + 14])
      .fill({ color: 0x706c5f })
      .stroke({ color: 0xc2b69b, width: 1, alpha: 0.45 });
    graphics
      .poly([x - 12, y + 16, x + 8, y - 18, x + 27, y + 16])
      .fill({ color: 0x777162 })
      .stroke({ color: 0xd0c4aa, width: 1, alpha: 0.42 });
    graphics
      .poly([x + 1, y - 7, x + 8, y - 18, x + 15, y - 5, x + 8, y - 9])
      .fill({ color: 0xd7d0be, alpha: 0.75 });
  } else if (tile.terrain === "plains") {
    for (let tuft = 0; tuft < (quality === "high" ? 5 : 3); tuft += 1) {
      const gx = x - 22 + ((seed >>> (tuft * 4)) % 44);
      const gy = y - 14 + ((seed >>> (tuft * 3 + 1)) % 30);
      graphics
        .moveTo(gx, gy + 5)
        .lineTo(gx - 3, gy)
        .moveTo(gx, gy + 5)
        .lineTo(gx + 1, gy - 2)
        .moveTo(gx, gy + 5)
        .lineTo(gx + 4, gy + 1)
        .stroke({ color: 0xc4bf78, width: 1, alpha: 0.58 });
    }
    graphics.ellipse(x + 16, y + 11, 5, 2.5).fill({ color: 0x6e6b56, alpha: 0.44 });
  } else if (tile.terrain === "water") {
    const waveCount = quality === "low" ? 2 : 4;
    for (let wave = 0; wave < waveCount; wave += 1) {
      const waveY = y - 15 + wave * 10 + (seed % 3);
      graphics
        .moveTo(x - 21, waveY)
        .bezierCurveTo(x - 12, waveY - 3, x - 6, waveY + 3, x + 2, waveY)
        .bezierCurveTo(x + 9, waveY - 3, x + 15, waveY + 2, x + 22, waveY - 1)
        .stroke({ color: 0x91c1c3, width: 1.2, alpha: 0.3 });
    }
  }
}

function makeSoldier(color: number, phase: number, scale = 1): SoldierVisual {
  const container = new Container();
  container.scale.set(scale);
  const shadow = new Graphics().ellipse(0, 8, 7, 2.6).fill({ color: 0x061016, alpha: 0.48 });
  const leftLeg = new Graphics().roundRect(-4, 2, 3, 9, 1.2).fill({ color: 0x2b3440 });
  leftLeg.pivot.set(-2.5, 3);
  const rightLeg = new Graphics().roundRect(1, 2, 3, 9, 1.2).fill({ color: 0x242d37 });
  rightLeg.pivot.set(2.5, 3);
  const cloak = new Graphics()
    .poly([-7, 4, -4, -8, 4, -8, 8, 5, 0, 8])
    .fill({ color: darken(color, 0.72) })
    .stroke({ color: 0x121923, width: 1.1 });
  const torso = new Graphics()
    .roundRect(-4.5, -8, 9, 11, 3)
    .fill({ color })
    .stroke({ color: lighten(color, 30), width: 1, alpha: 0.58 });
  const head = new Graphics()
    .circle(0, -12, 4.2)
    .fill({ color: 0xe1bd91 })
    .stroke({ color: 0x1c2730, width: 1.2 });
  const helm = new Graphics()
    .arc(0, -12, 4.4, Math.PI, Math.PI * 2)
    .stroke({ color: 0x99a9ad, width: 3.2 });
  const shield = new Graphics()
    .poly([-9, -7, -3, -9, -2, -1, -6, 3, -10, -1])
    .fill({ color: darken(color, 0.85) })
    .stroke({ color: 0xd9c38c, width: 1.2 });
  const weapon = new Graphics()
    .moveTo(6, 7)
    .lineTo(6, -16)
    .stroke({ color: 0x564735, width: 1.5 })
    .poly([6, -19, 3.5, -14, 8.5, -14])
    .fill({ color: 0xc8d2cf });
  weapon.pivot.set(6, 2);
  container.addChild(shadow, leftLeg, rightLeg, cloak, torso, head, helm, shield, weapon);
  return { container, leftLeg, rightLeg, weapon, phase };
}

function drawFoundation(type: StructureType): Container {
  const container = new Container();
  const base = new Graphics()
    .ellipse(0, 9, 21, 8)
    .fill({ color: 0x281f19, alpha: 0.42 })
    .poly([-19, 7, -12, -6, 13, -6, 20, 7, 11, 13, -11, 13])
    .fill({ color: 0x8a7a62 })
    .stroke({ color: 0xc7b08a, width: 1 });
  const scaffold = new Graphics();
  scaffold
    .moveTo(-15, 10)
    .lineTo(-11, -12)
    .moveTo(14, 10)
    .lineTo(10, -12)
    .moveTo(-13, -5)
    .lineTo(12, -5)
    .moveTo(-14, 3)
    .lineTo(14, 3)
    .stroke({ color: 0x5f4933, width: 2 });
  scaffold.moveTo(-11, -12).lineTo(10, -12).stroke({ color: 0xc29358, width: 1.5 });
  const marker = createBadge(type === "farm" ? "F" : type === "barracks" ? "B" : "T", 9);
  marker.position.set(0, 4);
  container.addChild(base, scaffold, marker);
  return container;
}

function createStructureVisual(structure: StructureState, color: number): StructureVisual {
  const signature = `${structure.type}:${structure.completedCount}:${structure.status}:${structure.pendingProgressTicks !== null}`;
  if (structure.completedCount === 0 && structure.pendingProgressTicks !== null) {
    const progress = structurePendingProgress(structure);
    const container = drawFoundation(structure.type);
    container.scale.set(0.76 + progress * 0.24, 0.58 + progress * 0.42);
    container.alpha = 0.58 + progress * 0.42;
    return {
      container,
      animated: null,
      pendingRing: null,
      type: structure.type,
      status: structure.status,
      progress,
      signature,
      aimAngle: null,
      volleyPulse: 0,
    };
  }

  const container = new Container();
  let animated: Graphics | null = null;
  const shadow = new Graphics().ellipse(0, 12, 22, 8).fill({ color: 0x071017, alpha: 0.48 });
  container.addChild(shadow);

  if (structure.type === "farm") {
    const field = new Graphics();
    for (let row = -2; row <= 2; row += 1) {
      field
        .moveTo(-23, 7 + row * 3)
        .lineTo(-7, 1 + row * 3)
        .stroke({ color: 0xd0b65d, width: 1.6, alpha: 0.85 });
    }
    const barn = new Graphics()
      .roundRect(-9, -9, 20, 21, 2)
      .fill({ color: 0xa44f3e })
      .stroke({ color: 0xf0c79c, width: 1.2 })
      .poly([-12, -8, 1, -20, 14, -8])
      .fill({ color: 0x593d32 })
      .stroke({ color: 0xc18d62, width: 1 })
      .roundRect(-2, 2, 7, 10, 1)
      .fill({ color: 0x4b352b });
    const tower = new Graphics()
      .roundRect(13, -13, 6, 24, 2)
      .fill({ color: 0xc9b98f })
      .stroke({ color: 0x5c5142, width: 1 });
    const blades = new Graphics();
    for (let blade = 0; blade < 4; blade += 1) {
      const angle = blade * (Math.PI / 2) - Math.PI / 2;
      const tipX = Math.cos(angle) * 10;
      const tipY = Math.sin(angle) * 10;
      const wingX = Math.cos(angle + 0.38) * 7;
      const wingY = Math.sin(angle + 0.38) * 7;
      blades.poly([0, 0, tipX, tipY, wingX, wingY]).fill({ color: 0xe5d4a7, alpha: 0.95 });
    }
    blades.position.set(16, -11);
    animated = blades;
    container.addChild(field, barn, tower, blades);
  } else if (structure.type === "barracks") {
    const yard = new Graphics()
      .poly([-22, 11, -17, -9, 17, -9, 22, 11])
      .fill({ color: 0x796047 })
      .stroke({ color: 0xd4bc8e, width: 1.1 });
    for (let post = -18; post <= 18; post += 6) {
      yard.poly([post - 2, 8, post, -13, post + 2, 8]).fill({ color: 0x5c4430 });
    }
    const keep = new Graphics()
      .roundRect(-11, -12, 22, 25, 3)
      .fill({ color: 0x74726d })
      .stroke({ color: 0xd2c5aa, width: 1.2 })
      .poly([-13, -10, 0, -21, 13, -10])
      .fill({ color: 0x4e4036 })
      .roundRect(-3, 3, 7, 10, 1)
      .fill({ color: 0x262a2a });
    const flag = new Graphics()
      .rect(0, -29, 1.7, 18)
      .fill({ color: 0xe7d6a6 })
      .poly([2, -28, 15, -23, 2, -17])
      .fill({ color })
      .stroke({ color: lighten(color, 35), width: 0.8 });
    animated = flag;
    container.addChild(yard, keep, flag);
  } else {
    const tower = new Graphics()
      .poly([-15, 12, -12, -10, -7, -15, 8, -15, 13, -10, 16, 12])
      .fill({ color: 0x777b79 })
      .stroke({ color: 0xd0c7ad, width: 1.3 })
      .rect(-16, -17, 32, 7)
      .fill({ color: 0x555b59 })
      .stroke({ color: 0xb7ae98, width: 1 })
      .rect(-13, -22, 6, 7)
      .fill({ color: 0x646a68 })
      .rect(-2, -22, 6, 7)
      .fill({ color: 0x646a68 })
      .rect(9, -22, 6, 7)
      .fill({ color: 0x646a68 });
    const cannon = new Graphics()
      .roundRect(-2, -4, 24, 5, 2)
      .fill({ color: 0x333c40 })
      .circle(-2, -1.5, 6)
      .fill({ color: darken(color, 0.7) })
      .stroke({ color, width: 1.5 });
    cannon.pivot.set(-2, -1.5);
    cannon.position.set(0, -15);
    animated = cannon;
    const flag = new Graphics()
      .rect(-1, -31, 2, 11)
      .fill({ color: 0xd7c9a5 })
      .poly([1, -31, 12, -27, 1, -23])
      .fill({ color });
    container.addChild(tower, cannon, flag);
  }

  if (structure.status === "seized" || structure.status === "repairing") {
    const damage = new Graphics()
      .moveTo(-9, -11)
      .lineTo(-2, -3)
      .lineTo(-7, 5)
      .stroke({ color: 0x2c211c, width: 2.3, alpha: 0.9 })
      .circle(8, -13, 5)
      .fill({ color: 0x45433e, alpha: 0.45 })
      .circle(12, -20, 7)
      .fill({ color: 0x5b5a55, alpha: 0.25 });
    container.addChild(damage);
  }
  if (structure.completedCount > 1) {
    const multiplier = createBadge(`x${structure.completedCount}`, 10);
    multiplier.position.set(19, -22);
    const plate = new Graphics()
      .roundRect(2, -30, 34, 16, 7)
      .fill({ color: 0x081117, alpha: 0.94 })
      .stroke({ color: 0xf2d68b, width: 1.1, alpha: 0.9 });
    container.addChild(plate, multiplier);
  }
  let pendingRing: Graphics | null = null;
  if (structure.pendingProgressTicks !== null) {
    pendingRing = new Graphics();
    drawPendingRing(pendingRing, structure);
    const pending = createBadge("+1", 9);
    pending.position.set(structure.completedCount > 1 ? -20 : 19, -22);
    const pendingPlate = new Graphics()
      .roundRect(structure.completedCount > 1 ? -34 : 5, -30, 28, 16, 7)
      .fill({ color: 0x081117, alpha: 0.94 })
      .stroke({ color: 0x8fd8cd, width: 1.1, alpha: 0.92 });
    container.addChild(pendingRing, pendingPlate, pending);
  }
  container.alpha = 0.55 + (structure.integrity / 1000) * 0.45;
  return {
    container,
    animated,
    pendingRing,
    type: structure.type,
    status: structure.status,
    progress: 1,
    signature,
    aimAngle: null,
    volleyPulse: 0,
  };
}

export class GameRenderer {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly terrainLayer = new Graphics();
  private readonly ownershipLayer = new Graphics();
  private readonly placementLayer = new Graphics();
  private readonly enclosureLayer = new Graphics();
  private readonly rallyLayer = new Graphics();
  private readonly routeLayer = new Graphics();
  private readonly multiLayer = new Graphics();
  private readonly multiLabelLayer = new Container();
  private readonly worldLabelLayer = new Container();
  private readonly highlightLayer = new Graphics();
  private readonly garrisonLayer = new Container();
  private readonly structureLayer = new Container();
  private readonly stackLayer = new Container();
  private readonly battleLayer = new Container();
  private readonly effectLayer = new Container();
  private readonly callbacks: RendererCallbacks;
  private readonly options: RendererOptions;
  private readonly host: HTMLElement;
  private placementSignature: string | null = null;
  private state: GameState | null = null;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private keyboardTileId: string | null = null;
  private keyboardCursorVisible = false;
  private lastFocusedTileId: string | null = null;
  private buildMode: StructureType | null = null;
  private route: { path: string[]; valid: boolean } | null = null;
  private multiPreview: {
    sourceIds: string[];
    destinationIds: string[];
    plan: MultiMovePlan | null;
  } | null = null;
  private labels = new Map<
    string,
    {
      container: Container;
      plate: Graphics;
      text: BitmapText;
      troops: number;
      owner: number | null;
      tier: number;
      baseY: number;
      phase: number;
    }
  >();
  private structures = new Map<string, StructureVisual>();
  private stacks = new Map<number, StackVisual>();
  private battles = new Map<number, BattleVisual>();
  private captures: CaptureVisual[] = [];
  private popups: PopupVisual[] = [];
  private turretVolleys: TurretVolleyVisual[] = [];
  private lastEventId = 0;
  private displayOwners = new Map<string, number | null>();
  private pointerStart: {
    x: number;
    y: number;
    worldX: number;
    worldY: number;
    button: number;
  } | null = null;
  private panning = false;
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private elapsed = 0;
  private initialized = false;
  private contextLost = false;
  private unbindContextRecovery: (() => void) | null = null;
  private mapBounds = new Rectangle(0, 0, 1, 1);

  constructor(host: HTMLElement, options: RendererOptions, callbacks: RendererCallbacks) {
    this.host = host;
    this.options = options;
    this.callbacks = callbacks;
  }

  async init(): Promise<void> {
    if (!badgeFontInstalled) {
      BitmapFont.install({
        name: "HexDominionBadge",
        style: {
          fontFamily: "Arial",
          fontSize: 16,
          fontWeight: "700",
          fill: 0xf8f2df,
          stroke: { color: 0x111921, width: 3 },
        },
        chars: [["0", "9"], ["A", "Z"], ["a", "z"], " .,:+-/%⚔·"],
        resolution: 2,
        padding: 3,
      });
      badgeFontInstalled = true;
    }
    await this.app.init({
      resizeTo: this.host,
      antialias: true,
      background: 0x081117,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: "high-performance",
    });
    this.app.canvas.className = "game-canvas";
    this.app.canvas.tabIndex = 0;
    this.app.canvas.setAttribute(
      "aria-label",
      "Hex Dominion battlefield. Use arrow keys to move the hex cursor, Enter or Space to select, and Escape to cancel.",
    );
    this.app.canvas.setAttribute("role", "application");
    this.host.appendChild(this.app.canvas);
    this.world.addChild(
      this.terrainLayer,
      this.ownershipLayer,
      this.placementLayer,
      this.enclosureLayer,
      this.rallyLayer,
      this.routeLayer,
      this.multiLayer,
      this.highlightLayer,
      this.structureLayer,
      this.garrisonLayer,
      this.stackLayer,
      this.battleLayer,
      this.effectLayer,
      this.multiLabelLayer,
      this.worldLabelLayer,
    );
    this.app.stage.addChild(this.world);
    this.bindInput();
    this.app.ticker.add(this.animate);
    this.initialized = true;
    this.unbindContextRecovery = bindWebGlContextRecovery(this.app.canvas, {
      onLost: this.handleContextLost,
      onRestored: this.handleContextRestored,
    });
  }

  setState(state: GameState): void {
    const first =
      !this.state ||
      this.state.map.seed !== state.map.seed ||
      this.state.map.archetype !== state.map.archetype;
    const previous = this.state;
    this.state = state;
    if (
      !this.keyboardTileId ||
      !state.map.tiles[this.keyboardTileId] ||
      (previous?.phase === "placement" && state.phase !== "placement")
    ) {
      this.keyboardTileId = this.defaultKeyboardTile(state);
      this.updateCanvasAccessibilityLabel();
    }
    if (this.contextLost) return;
    if (first) {
      this.lastEventId = 0;
      for (const popup of this.popups) popup.container.destroy({ children: true });
      this.popups = [];
      for (const volley of this.turretVolleys) volley.graphics.destroy();
      this.turretVolleys = [];
      this.drawMap();
      this.drawOwnership();
      this.fitMap();
    }
    this.captureOwnerChanges(previous, state);
    this.consumeWorldEvents(state);
    this.updateStructures();
    this.updateGarrisons();
    this.updateStacks();
    this.updateBattles();
    this.drawPlacement();
    this.drawRallies();
    this.drawEnclosures();
    this.drawMultiPreview();
    this.drawHighlights();
  }

  setSelected(tileId: string | null): void {
    this.selectedId = tileId;
    if (tileId && this.state?.map.tiles[tileId]) {
      this.keyboardTileId = tileId;
      this.updateCanvasAccessibilityLabel();
    }
    if (!this.contextLost) this.drawHighlights();
  }

  setBuildMode(mode: StructureType | null): void {
    this.buildMode = mode;
    if (!this.contextLost) this.drawHighlights();
  }

  setRoutePreview(path: string[] | null, valid = true): void {
    this.route = path ? { path, valid } : null;
    if (!this.contextLost) this.drawRoute();
  }

  setMultiPreview(
    preview: {
      sourceIds: string[];
      destinationIds: string[];
      plan: MultiMovePlan | null;
    } | null,
  ): void {
    this.multiPreview = preview;
    if (!this.contextLost) this.drawMultiPreview();
  }

  fitMap(): void {
    if (!this.initialized || this.mapBounds.width <= 1) return;
    const padding = 90;
    const scale = Math.min(
      (this.host.clientWidth - padding * 2) / this.mapBounds.width,
      (this.host.clientHeight - padding * 2) / this.mapBounds.height,
      1,
    );
    this.world.scale.set(Math.max(0.16, scale));
    this.world.position.set(
      this.host.clientWidth / 2 -
        (this.mapBounds.x + this.mapBounds.width / 2) * this.world.scale.x,
      this.host.clientHeight / 2 -
        (this.mapBounds.y + this.mapBounds.height / 2) * this.world.scale.y,
    );
    this.callbacks.onZoom?.(this.world.scale.x);
  }

  /** Debug visual-capture hook; authoritative simulation continues independently. */
  setCaptureMode(active: boolean): void {
    if (!this.initialized || this.contextLost) return;
    if (active) {
      this.app.ticker.stop();
      this.app.render();
    } else {
      this.app.ticker.start();
    }
  }

  /** Render a stable viewport-sized PNG without relying on WebGL's transient front buffer. */
  async captureFrameDataUrl(): Promise<string> {
    if (!this.initialized || this.contextLost) return "";
    this.app.render();
    return this.app.renderer.extract.base64({
      target: this.app.stage,
      frame: new Rectangle(0, 0, this.app.screen.width, this.app.screen.height),
      resolution: 1,
      clearColor: 0x081117,
      antialias: true,
    });
  }

  centerOn(tileId: string): void {
    const tile = this.state?.map.tiles[tileId];
    if (!tile) return;
    const point = tilePosition(tile);
    this.world.position.set(
      this.host.clientWidth / 2 - point.x * this.world.scale.x,
      this.host.clientHeight / 2 - point.y * this.world.scale.y,
    );
  }

  focusOn(tileId: string, scale = 0.82): void {
    this.lastFocusedTileId = tileId;
    this.world.scale.set(Math.max(0.42, Math.min(1.35, scale)));
    this.centerOn(tileId);
    this.clampCamera();
    this.callbacks.onZoom?.(this.world.scale.x);
  }

  /** Debug/E2E bridge for exercising real canvas hit-testing at a known tile. */
  clientPointFor(tileId: string): { x: number; y: number } | null {
    const tile = this.state?.map.tiles[tileId];
    if (!tile) return null;
    const point = tilePosition(tile);
    const bounds = this.app.canvas.getBoundingClientRect();
    return {
      x: bounds.left + this.world.x + point.x * this.world.scale.x,
      y: bounds.top + this.world.y + point.y * this.world.scale.y,
    };
  }

  inspectPresentation(): {
    stacks: Array<{ id: number; x: number; y: number; targetX: number; targetY: number }>;
    battles: Array<{
      id: number;
      actual: number;
      displayed: number;
      ghost: number;
      pulse: number;
      segments: Array<{
        playerId: number | null;
        actual: number;
        displayed: number;
        troops: number;
        turretSupportCount: number;
      }>;
    }>;
    captures: Array<{ tileId: string; age: number }>;
    focusTileId: string | null;
    keyboardTileId: string | null;
    visibleObjects: number;
  } {
    return {
      stacks: [...this.stacks.entries()].map(([id, visual]) => ({
        id,
        x: visual.container.x,
        y: visual.container.y,
        targetX: visual.targetX,
        targetY: visual.targetY,
      })),
      battles: [...this.battles.entries()].map(([id, visual]) => ({
        id,
        actual: visual.segments[0]?.target ?? 0,
        displayed: visual.segments[0]?.displayed ?? 0,
        ghost: visual.segments[0]?.ghost ?? 0,
        pulse: visual.pulse,
        segments: visual.segments.map((segment) => ({
          playerId: segment.playerId,
          actual: segment.target,
          displayed: segment.displayed,
          troops: segment.troops,
          turretSupportCount: segment.turretSupportCount,
        })),
      })),
      captures: this.captures.map((capture) => ({ tileId: capture.tileId, age: capture.age })),
      focusTileId: this.lastFocusedTileId,
      keyboardTileId: this.keyboardTileId,
      visibleObjects:
        (this.state?.map.tileIds.length ?? 0) +
        this.labels.size +
        this.structures.size +
        [...this.stacks.values()].reduce((total, visual) => total + visual.squad.length + 1, 0) +
        [...this.battles.values()].reduce(
          (total, visual) => total + visual.fighters.length + 2,
          0,
        ) +
        this.captures.length +
        this.popups.length +
        this.turretVolleys.length +
        this.multiLabelLayer.children.length +
        this.worldLabelLayer.children.length,
    };
  }

  destroy(): void {
    if (!this.initialized) return;
    this.app.ticker.remove(this.animate);
    this.unbindContextRecovery?.();
    this.unbindContextRecovery = null;
    this.unbindInput();
    this.app.destroy({ removeView: true }, { children: true });
    this.initialized = false;
  }

  private handleContextLost = (): void => {
    if (!this.initialized) return;
    this.contextLost = true;
    this.app.ticker.stop();
    this.callbacks.onContextStatus?.("lost");
  };

  private handleContextRestored = (): void => {
    if (!this.initialized || !this.contextLost) return;
    this.contextLost = false;
    this.redrawRetainedState();
    this.app.ticker.start();
    this.app.render();
    this.callbacks.onContextStatus?.("restored");
  };

  private redrawRetainedState(): void {
    if (!this.state) return;
    const clear = (container: Container): void => {
      for (const child of container.removeChildren()) child.destroy({ children: true });
    };
    clear(this.garrisonLayer);
    clear(this.structureLayer);
    clear(this.stackLayer);
    clear(this.battleLayer);
    clear(this.effectLayer);
    clear(this.multiLabelLayer);
    clear(this.worldLabelLayer);
    this.labels.clear();
    this.structures.clear();
    this.stacks.clear();
    this.battles.clear();
    this.captures = [];
    this.popups = [];
    this.turretVolleys = [];
    this.lastEventId = this.state.events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
    this.drawMap();
    this.drawOwnership();
    this.updateStructures();
    this.updateGarrisons();
    this.updateStacks();
    this.updateBattles();
    this.drawPlacement();
    this.drawRallies();
    this.drawEnclosures();
    this.drawMultiPreview();
    this.drawHighlights();
  }

  private drawMap(): void {
    if (!this.state) return;
    this.placementSignature = null;
    this.terrainLayer.clear();
    this.displayOwners.clear();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const tileId of this.state.map.tileIds) {
      const tile = this.state.map.tiles[tileId]!;
      drawTerrainTile(this.terrainLayer, tile, this.options.quality);
      this.displayOwners.set(tileId, tile.owner);
      const point = tilePosition(tile);
      minX = Math.min(minX, point.x - HEX_SIZE - 8);
      minY = Math.min(minY, point.y - HEX_SIZE - 8);
      maxX = Math.max(maxX, point.x + HEX_SIZE + 8);
      maxY = Math.max(maxY, point.y + HEX_SIZE + 13);
    }
    this.mapBounds = new Rectangle(minX, minY, maxX - minX, maxY - minY);
    this.terrainLayer.boundsArea = this.mapBounds;
  }

  private drawOwnership(): void {
    if (!this.state) return;
    this.ownershipLayer.clear();
    for (const tileId of this.state.map.landIds) {
      const tile = this.state.map.tiles[tileId]!;
      const owner = this.displayOwners.get(tileId) ?? null;
      if (owner === null) continue;
      const { x, y } = tilePosition(tile);
      const color =
        this.state.players[owner]?.color ?? PLAYER_COLORS[owner % PLAYER_COLORS.length]!;
      this.ownershipLayer
        .poly(hexPoints(HEX_SIZE - 1).map((point, index) => point + (index % 2 === 0 ? x : y)))
        .fill({ color, alpha: 0.2 });
      const border = neighbors(tile).some((neighbor) => {
        const adjacent = this.state!.map.tiles[axialKey(neighbor)];
        return !adjacent || (this.displayOwners.get(adjacent.id) ?? adjacent.owner) !== owner;
      });
      if (border) {
        this.ownershipLayer
          .poly(hexPoints(HEX_SIZE - 1).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .stroke({ color, width: 3.2, alpha: 0.94 });
      }
      if (this.options.colorPatterns) {
        const pattern = this.state.players[owner]?.pattern ?? owner % 4;
        if (pattern % 2 === 1) {
          for (let line = -18; line <= 18; line += 9) {
            this.ownershipLayer
              .moveTo(x + line - 8, y + 21)
              .lineTo(x + line + 12, y + 1)
              .stroke({ color, width: 1, alpha: 0.18 });
          }
        }
      }
    }
  }

  private drawPlacement(): void {
    const signature = this.state
      ? placementPresentationSignature(this.state, this.options.localPlayerId)
      : "no-state";
    if (signature === this.placementSignature) return;
    this.placementSignature = signature;
    this.placementLayer.clear();
    if (!this.state || this.state.phase !== "placement") return;
    for (const tileId of eligibleSpawnCenters(this.state.map)) {
      if (!validateSpawnChoicePreview(this.state, this.options.localPlayerId, tileId).ok) continue;
      const tile = this.state.map.tiles[tileId];
      if (!tile) continue;
      const { x, y } = tilePosition(tile);
      this.placementLayer
        .poly(hexPoints(HEX_SIZE - 7).map((point, index) => point + (index % 2 === 0 ? x : y)))
        .stroke({ color: 0xd5c79f, width: 0.8, alpha: 0.18 });
    }
    for (const placement of this.state.placement.placements) {
      if (!placement.centerId) continue;
      const center = this.state.map.tiles[placement.centerId];
      if (!center) continue;
      const color =
        this.state.players[placement.playerId]?.color ??
        PLAYER_COLORS[placement.playerId % PLAYER_COLORS.length]!;
      const footprint = [center.id, ...neighbors(center).map(axialKey)].filter(
        (tileId) => this.state!.map.tiles[tileId]?.terrain !== "water",
      );
      for (const tileId of footprint) {
        const tile = this.state.map.tiles[tileId]!;
        const { x, y } = tilePosition(tile);
        this.placementLayer
          .poly(hexPoints(HEX_SIZE - 2).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .fill({ color, alpha: placement.locked ? 0.52 : 0.16 })
          .stroke({
            color: placement.locked ? lighten(color, 55) : color,
            width: tileId === center.id ? (placement.locked ? 4 : 3) : 1.5,
            alpha: placement.locked ? 0.94 : 0.68,
          });
      }
    }
  }

  private drawRallies(): void {
    this.rallyLayer.clear();
    if (!this.state || this.state.phase !== "running") return;
    for (const tileId of this.state.map.landIds) {
      const tile = this.state.map.tiles[tileId]!;
      const structure = tile.structure;
      if (structure?.type !== "barracks" || !structure.rallyTargetId) continue;
      const path = barracksRallyPath(this.state, tile, structure);
      const blocked = isBarracksRallyBlocked(this.state, tile, structure);
      const drawPath = path ?? [tile.id, structure.rallyTargetId];
      const color = blocked ? 0xe26a5f : (this.state.players[tile.owner ?? 0]?.accent ?? 0xf0d47f);
      for (let index = 0; index < drawPath.length - 1; index += 1) {
        const from = this.state.map.tiles[drawPath[index]!];
        const to = this.state.map.tiles[drawPath[index + 1]!];
        if (!from || !to) continue;
        const a = tilePosition(from);
        const b = tilePosition(to);
        if (blocked) {
          for (let dash = 0; dash < 4; dash += 1) {
            const start = dash / 4;
            const end = Math.min(1, start + 0.13);
            this.rallyLayer
              .moveTo(a.x + (b.x - a.x) * start, a.y + (b.y - a.y) * start)
              .lineTo(a.x + (b.x - a.x) * end, a.y + (b.y - a.y) * end)
              .stroke({ color, width: 2.2, alpha: 0.72 });
          }
        } else {
          this.rallyLayer
            .moveTo(a.x, a.y)
            .lineTo(b.x, b.y)
            .stroke({ color, width: 2.8, alpha: 0.48 });
        }
      }
      const destination = this.state.map.tiles[structure.rallyTargetId];
      if (destination) {
        const point = tilePosition(destination);
        this.rallyLayer
          .circle(point.x, point.y, 12)
          .stroke({ color, width: 2.2, alpha: 0.9 })
          .poly([point.x, point.y - 13, point.x + 5, point.y - 4, point.x, point.y + 1])
          .fill({ color, alpha: 0.86 });
        if (blocked) {
          this.rallyLayer
            .moveTo(point.x - 6, point.y - 6)
            .lineTo(point.x + 6, point.y + 6)
            .moveTo(point.x + 6, point.y - 6)
            .lineTo(point.x - 6, point.y + 6)
            .stroke({ color: 0xffd3bd, width: 2, alpha: 0.95 });
        }
      }
    }
  }

  private drawEnclosures(): void {
    this.enclosureLayer.clear();
    for (const child of this.worldLabelLayer.removeChildren()) child.destroy({ children: true });
    if (!this.state || this.state.phase !== "running") return;
    for (const enclosure of this.state.enclosures) {
      const color =
        this.state.players[enclosure.captorId]?.accent ??
        PLAYER_COLORS[enclosure.captorId % PLAYER_COLORS.length]!;
      for (const tileId of enclosure.boundaryIds) {
        const tile = this.state.map.tiles[tileId];
        if (!tile) continue;
        const { x, y } = tilePosition(tile);
        this.enclosureLayer
          .poly(hexPoints(HEX_SIZE + 1).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .stroke({ color, width: 3.4, alpha: 0.52 + Math.sin(this.elapsed * 3) * 0.12 });
      }
      for (const tileId of enclosure.tileIds) {
        const tile = this.state.map.tiles[tileId];
        if (!tile) continue;
        const { x, y } = tilePosition(tile);
        this.enclosureLayer
          .poly(hexPoints(HEX_SIZE - 3).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .fill({ color, alpha: 0.07 });
      }
      const points = enclosure.tileIds
        .map((tileId) => this.state!.map.tiles[tileId])
        .filter((tile): tile is TileState => Boolean(tile))
        .map(tilePosition);
      if (points.length > 0) {
        const label = createBadge(
          `${Math.max(0, Math.ceil((BALANCE.encirclementTicks - enclosure.progressTicks) / 10))}s`,
          11,
        );
        label.position.set(
          points.reduce((sum, point) => sum + point.x, 0) / points.length,
          Math.min(...points.map((point) => point.y)) - HEX_SIZE - (points.length === 1 ? 36 : 14),
        );
        label.tint = color;
        this.worldLabelLayer.addChild(label);
      }
    }
  }

  private drawMultiPreview(): void {
    this.multiLayer.clear();
    for (const child of this.multiLabelLayer.removeChildren()) child.destroy({ children: true });
    if (!this.state || !this.multiPreview) return;
    const color = this.state.players[this.options.localPlayerId]?.accent ?? 0xffdf86;
    for (const tileId of this.multiPreview.sourceIds) {
      const tile = this.state.map.tiles[tileId];
      if (!tile) continue;
      const { x, y } = tilePosition(tile);
      this.multiLayer
        .poly(hexPoints(HEX_SIZE + 3).map((point, index) => point + (index % 2 === 0 ? x : y)))
        .stroke({ color, width: 4, alpha: 0.96 });
    }
    const valid = this.multiPreview.plan?.ok !== false;
    const routeColor = valid ? color : 0xec675f;
    for (const dispatch of this.multiPreview.plan?.dispatches ?? []) {
      for (let index = 0; index < dispatch.path.length - 1; index += 1) {
        const from = this.state.map.tiles[dispatch.path[index]!];
        const to = this.state.map.tiles[dispatch.path[index + 1]!];
        if (!from || !to) continue;
        const a = tilePosition(from);
        const b = tilePosition(to);
        this.multiLayer
          .moveTo(a.x, a.y)
          .lineTo(b.x, b.y)
          .stroke({ color: routeColor, width: 2.8, alpha: 0.5 });
      }
    }
    if (this.multiPreview.plan?.ok === false) {
      for (const sourceId of this.multiPreview.sourceIds) {
        const source = this.state.map.tiles[sourceId];
        if (!source) continue;
        const a = tilePosition(source);
        for (const destinationId of this.multiPreview.destinationIds) {
          const destination = this.state.map.tiles[destinationId];
          if (!destination) continue;
          const b = tilePosition(destination);
          for (let dash = 0; dash < 5; dash += 1) {
            const start = dash / 5;
            const end = Math.min(1, start + 0.11);
            this.multiLayer
              .moveTo(a.x + (b.x - a.x) * start, a.y + (b.y - a.y) * start)
              .lineTo(a.x + (b.x - a.x) * end, a.y + (b.y - a.y) * end)
              .stroke({ color: routeColor, width: 2.2, alpha: 0.46 });
          }
        }
      }
    }
    this.multiPreview.destinationIds.forEach((tileId, index) => {
      const tile = this.state!.map.tiles[tileId];
      if (!tile) return;
      const { x, y } = tilePosition(tile);
      this.multiLayer
        .circle(x, y, 16)
        .fill({ color: 0x081117, alpha: 0.82 })
        .stroke({ color: routeColor, width: 3, alpha: 0.95 });
      const marker = createBadge(String(index + 1), 12);
      marker.position.set(x, y);
      this.multiLabelLayer.addChild(marker);
      const quota = this.multiPreview?.plan?.destinationQuotas.find(
        (candidate) => candidate.destinationId === tileId,
      );
      if (this.multiPreview?.plan?.ok && quota) {
        const projection = createBadge(`+${formatTroops(quota.troops)}`, 8);
        projection.position.set(x, y + 21);
        projection.tint = 0xe8d38f;
        this.multiLabelLayer.addChild(projection);
      }
    });
  }

  private drawHighlights(): void {
    this.highlightLayer.clear();
    if (!this.state) return;
    if (this.keyboardCursorVisible && this.keyboardTileId) {
      const keyboardTile = this.state.map.tiles[this.keyboardTileId];
      if (keyboardTile?.terrain !== "water") {
        const { x, y } = tilePosition(keyboardTile);
        this.highlightLayer
          .poly(hexPoints(HEX_SIZE + 5).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .stroke({ color: 0xffedaa, width: 3.5, alpha: 0.98 });
        this.highlightLayer.circle(x, y, 4).fill({ color: 0xffedaa, alpha: 0.96 });
      }
    }
    if (this.buildMode) {
      for (const tileId of this.state.map.landIds) {
        const tile = this.state.map.tiles[tileId]!;
        const eligible = canPlaceStructure(
          this.state,
          this.options.localPlayerId,
          tileId,
          this.buildMode,
        ).ok;
        const { x, y } = tilePosition(tile);
        this.highlightLayer
          .poly(hexPoints(HEX_SIZE - 3).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .fill({ color: eligible ? 0xf5d37a : 0x071017, alpha: eligible ? 0.12 : 0.34 });
        if (eligible) {
          this.highlightLayer
            .poly(hexPoints(HEX_SIZE - 4).map((point, index) => point + (index % 2 === 0 ? x : y)))
            .stroke({ color: 0xffe4a0, width: 1.7, alpha: 0.82 });
        }
      }
    }
    if (this.hoveredId) {
      const hovered = this.state.map.tiles[this.hoveredId];
      if (hovered) {
        const { x, y } = tilePosition(hovered);
        this.highlightLayer
          .poly(hexPoints(HEX_SIZE - 2).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .stroke({ color: 0xf7edcf, width: 2, alpha: 0.74 });
      }
    }
    if (this.selectedId) {
      const selected = this.state.map.tiles[this.selectedId];
      if (selected) {
        const { x, y } = tilePosition(selected);
        this.highlightLayer
          .poly(hexPoints(HEX_SIZE + 2).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .stroke({ color: 0xffe08a, width: 4.5, alpha: 0.98 });
        this.highlightLayer
          .poly(hexPoints(HEX_SIZE - 5).map((point, index) => point + (index % 2 === 0 ? x : y)))
          .stroke({ color: 0xffffff, width: 1.1, alpha: 0.65 });
      }
    }
    this.drawRoute();
  }

  private drawRoute(): void {
    this.routeLayer.clear();
    if (!this.state || !this.route || this.route.path.length < 2) return;
    const color = this.route.valid
      ? (this.state.players[this.options.localPlayerId]?.accent ?? 0xffdf86)
      : 0xf05a5a;
    for (let index = 0; index < this.route.path.length - 1; index += 1) {
      const from = this.state.map.tiles[this.route.path[index]!];
      const to = this.state.map.tiles[this.route.path[index + 1]!];
      if (!from || !to) continue;
      const a = tilePosition(from);
      const b = tilePosition(to);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const sx = a.x + Math.cos(angle) * 15;
      const sy = a.y + Math.sin(angle) * 15;
      const ex = b.x - Math.cos(angle) * 15;
      const ey = b.y - Math.sin(angle) * 15;
      this.routeLayer
        .moveTo(sx, sy)
        .lineTo(ex, ey)
        .stroke({
          color,
          width: this.route.valid ? 4 : 3,
          alpha: 0.72,
          cap: "round",
        });
      const mx = sx + (ex - sx) * 0.68;
      const my = sy + (ey - sy) * 0.68;
      this.routeLayer
        .poly([
          mx + Math.cos(angle) * 7,
          my + Math.sin(angle) * 7,
          mx + Math.cos(angle + 2.45) * 6,
          my + Math.sin(angle + 2.45) * 6,
          mx + Math.cos(angle - 2.45) * 6,
          my + Math.sin(angle - 2.45) * 6,
        ])
        .fill({ color, alpha: 0.92 });
    }
  }

  private updateGarrisons(): void {
    if (!this.state) return;
    const wanted = new Set<string>();
    for (const tileId of this.state.map.landIds) {
      const tile = this.state.map.tiles[tileId]!;
      if (tile.troops <= 0) continue;
      const shouldRender =
        tile.owner !== null ||
        this.options.fullCounts ||
        tileId === this.selectedId ||
        (tile.troops > 1 && this.world.scale.x >= 0.72);
      if (!shouldRender) continue;
      wanted.add(tileId);
      let visual = this.labels.get(tileId);
      const tier = tile.owner === null ? 0 : garrisonTier(tile.troops);
      if (visual && (visual.owner !== tile.owner || visual.tier !== tier)) {
        visual.container.destroy({ children: true });
        this.labels.delete(tileId);
        visual = undefined;
      }
      if (!visual) {
        const container = new Container();
        const plate = new Graphics()
          .poly([-16, -8, -11, -13, 11, -13, 16, -8, 13, 7, 0, 11, -13, 7])
          .fill({ color: 0x101921, alpha: 0.9 })
          .stroke({ color: 0xe7d3a3, width: 1.1, alpha: 0.76 });
        const ownerColor =
          tile.owner === null
            ? 0x9a9a8f
            : (this.state.players[tile.owner]?.color ??
              PLAYER_COLORS[tile.owner % PLAYER_COLORS.length]!);
        const sentinels: Container[] = [];
        for (let index = 0; index < tier; index += 1) {
          const sentinel = makeSoldier(
            ownerColor,
            (tile.decorationSeed % 11) + index,
            tier > 3 ? 0.24 : 0.29,
          );
          sentinel.container.position.set((index - (tier - 1) / 2) * 5.2, -17 - (index % 2) * 2.2);
          sentinels.push(sentinel.container);
        }
        const text = createBadge(formatTroops(tile.troops), 11);
        text.position.set(0, -2);
        const pin = new Graphics()
          .poly([-4, -15, 0, -21, 4, -15])
          .fill({ color: 0xf0d28c, alpha: 0.9 });
        container.addChild(...sentinels, plate, pin, text);
        const position = tilePosition(tile);
        const baseY = position.y + (tile.structure ? 26 : 15);
        container.position.set(position.x, baseY);
        this.garrisonLayer.addChild(container);
        visual = {
          container,
          plate,
          text,
          troops: tile.troops,
          owner: tile.owner,
          tier,
          baseY,
          phase: (tile.decorationSeed % 17) * 0.37,
        };
        this.labels.set(tileId, visual);
      }
      if (visual.troops !== tile.troops) {
        visual.troops = tile.troops;
        visual.text.text = formatTroops(tile.troops);
      }
      const owner = tile.owner;
      const color =
        owner === null
          ? 0xa7a394
          : (this.state.players[owner]?.color ?? PLAYER_COLORS[owner % PLAYER_COLORS.length]!);
      visual.plate.tint = color;
      const desiredBaseY = tilePosition(tile).y + (tile.structure ? 26 : 15);
      visual.baseY = desiredBaseY;
      visual.container.visible =
        tile.owner === null
          ? this.options.fullCounts ||
            tileId === this.selectedId ||
            (tile.troops > 1 && this.world.scale.x >= 0.72)
          : this.options.fullCounts ||
            this.world.scale.x >= 0.29 ||
            tileId === this.selectedId ||
            this.isBorderTile(tile);
      visual.container.scale.set(this.world.scale.x < 0.3 ? 1.22 : 1);
    }
    for (const [tileId, visual] of this.labels) {
      if (!wanted.has(tileId)) {
        visual.container.destroy({ children: true });
        this.labels.delete(tileId);
      }
    }
  }

  private turretAimAngle(tile: TileState): number | null {
    if (
      !this.state ||
      tile.owner === null ||
      tile.structure?.type !== "turret" ||
      !isStructureOperational(tile.structure)
    ) {
      return null;
    }
    const adjacentIds = new Set(neighbors(tile).map(axialKey));
    const ownerParticipates = (battle: GameState["battles"][number]): boolean =>
      battle.participants.some(
        (participant) => participant.playerId === tile.owner && participant.troops > 0,
      );
    const ownBattle = this.state.battles.find((battle) => battle.tileId === tile.id);
    const candidates = (
      ownBattle
        ? ownerParticipates(ownBattle)
          ? [ownBattle]
          : []
        : this.state.battles.filter(
            (battle) => adjacentIds.has(battle.tileId) && ownerParticipates(battle),
          )
    ).sort((left, right) => {
      const leftTile = this.state!.map.tiles[left.tileId];
      const rightTile = this.state!.map.tiles[right.tileId];
      if (leftTile && rightTile) return leftTile.q - rightTile.q || leftTile.r - rightTile.r;
      return left.tileId.localeCompare(right.tileId);
    });
    const target = candidates[0] ? this.state.map.tiles[candidates[0].tileId] : undefined;
    if (!target) return null;
    const sourcePoint = tilePosition(tile);
    const targetPoint = tilePosition(target);
    return Math.atan2(targetPoint.y - sourcePoint.y, targetPoint.x - sourcePoint.x);
  }

  private updateStructures(): void {
    if (!this.state) return;
    const wanted = new Set<string>();
    for (const tileId of this.state.map.landIds) {
      const tile = this.state.map.tiles[tileId]!;
      if (!tile.structure) continue;
      wanted.add(tileId);
      const existing = this.structures.get(tileId);
      const signature = `${tile.structure.type}:${tile.structure.completedCount}:${tile.structure.status}:${tile.structure.pendingProgressTicks !== null}`;
      if (existing && existing.signature === signature) {
        if (tile.structure.completedCount === 0 && tile.structure.pendingProgressTicks !== null) {
          existing.progress = structurePendingProgress(tile.structure);
          existing.container.scale.set(
            0.76 + existing.progress * 0.24,
            0.58 + existing.progress * 0.42,
          );
          existing.container.alpha = 0.58 + existing.progress * 0.42;
        } else {
          existing.container.alpha = 0.55 + (tile.structure.integrity / 1000) * 0.45;
          if (existing.pendingRing) drawPendingRing(existing.pendingRing, tile.structure);
        }
        if (existing.volleyPulse <= 0) existing.aimAngle = this.turretAimAngle(tile);
        continue;
      }
      existing?.container.destroy({ children: true });
      if (existing) this.structures.delete(tileId);
      const ownerColor =
        tile.owner === null
          ? 0xb7aa8e
          : (this.state.players[tile.owner]?.color ??
            PLAYER_COLORS[tile.owner % PLAYER_COLORS.length]!);
      const visual = createStructureVisual(tile.structure, ownerColor);
      visual.aimAngle = this.turretAimAngle(tile);
      const position = tilePosition(tile);
      visual.container.position.set(position.x, position.y - 1);
      this.structureLayer.addChild(visual.container);
      this.structures.set(tileId, visual);
    }
    for (const [tileId, visual] of this.structures) {
      if (!wanted.has(tileId)) {
        visual.container.destroy({ children: true });
        this.structures.delete(tileId);
      }
    }
  }

  private updateStacks(): void {
    if (!this.state) return;
    const wanted = new Set<number>();
    for (const stack of this.state.stacks) {
      wanted.add(stack.id);
      const point = this.stackPoint(stack);
      let visual = this.stacks.get(stack.id);
      if (!visual) {
        const container = new Container();
        const dust = new Graphics();
        container.addChild(dust);
        const squad: SoldierVisual[] = [];
        const count = Math.max(3, Math.min(6, 2 + Math.ceil(Math.log2(Math.max(2, stack.troops)))));
        const color =
          this.state.players[stack.owner]?.color ??
          PLAYER_COLORS[stack.owner % PLAYER_COLORS.length]!;
        for (let index = 0; index < count; index += 1) {
          const soldier = makeSoldier(color, index * 1.31, 0.67);
          soldier.container.position.set((index % 3) * 8 - 8, Math.floor(index / 3) * 7 - 5);
          container.addChild(soldier.container);
          squad.push(soldier);
        }
        const banner = new Graphics()
          .rect(-1, -26, 2, 24)
          .fill({ color: 0xe3d6b5 })
          .poly([1, -26, 16, -21, 1, -15])
          .fill({ color })
          .stroke({ color: 0xf4e4bb, width: 0.7 });
        const badgeBack = new Graphics()
          .roundRect(-17, 9, 34, 16, 7)
          .fill({ color: 0x0b141c, alpha: 0.94 })
          .stroke({ color, width: 1.5 });
        const badge = createBadge(String(stack.troops), 11);
        badge.position.set(0, 17);
        container.addChild(banner, badgeBack, badge);
        container.position.set(point.x, point.y);
        this.stackLayer.addChild(container);
        visual = {
          container,
          squad,
          dust,
          badge,
          lastX: point.x,
          lastY: point.y,
          targetX: point.x,
          targetY: point.y,
          facingAngle: 0,
        };
        this.stacks.set(stack.id, visual);
      }
      visual.lastX = visual.container.x;
      visual.lastY = visual.container.y;
      visual.targetX = point.x;
      visual.targetY = point.y;
      visual.badge.text = String(stack.troops);
      const dx = visual.targetX - visual.lastX;
      const dy = visual.targetY - visual.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 0.01) {
        visual.facingAngle = Math.atan2(dy, dx);
        for (const soldier of visual.squad) {
          soldier.container.scale.x = Math.abs(soldier.container.scale.x) * (dx < 0 ? -1 : 1);
          soldier.container.rotation = Math.sin(visual.facingAngle) * 0.09;
        }
      }
    }
    for (const [id, visual] of this.stacks) {
      if (!wanted.has(id)) {
        visual.container.destroy({ children: true });
        this.stacks.delete(id);
      }
    }
  }

  private updateBattles(): void {
    if (!this.state) return;
    const wanted = new Set<number>();
    for (const battle of this.state.battles) {
      wanted.add(battle.id);
      const presentation = battlePresentation(this.state, battle);
      let visual = this.battles.get(battle.id);
      if (!visual) {
        const container = new Container();
        const fighters: SoldierVisual[] = [];
        const combatEffects = new Graphics();
        const frame = new Graphics();
        const counts = createBadge("", 10);
        counts.position.set(0, -2);
        const sideCount = this.options.quality === "low" ? 1 : 2;
        for (let index = 0; index < sideCount; index += 1) {
          const leftParticipant = presentation[index % Math.max(1, presentation.length)];
          const rightParticipant = presentation[(index + 1) % Math.max(1, presentation.length)];
          const leftColor =
            leftParticipant?.playerId === null
              ? 0x9d9889
              : (this.state.players[leftParticipant?.playerId ?? 0]?.color ?? 0x4f7bb7);
          const rightColor =
            rightParticipant?.playerId === null
              ? 0x9d9889
              : (this.state.players[rightParticipant?.playerId ?? 0]?.color ?? 0xd95b5b);
          const defender = makeSoldier(leftColor, index * 1.7, 0.46);
          defender.container.position.set(-18 - index * 7, 40 + index * 2);
          const attacker = makeSoldier(rightColor, 0.8 + index * 1.7, 0.46);
          attacker.container.scale.x *= -1;
          attacker.container.position.set(18 + index * 7, 40 + index * 2);
          container.addChild(defender.container, attacker.container);
          fighters.push(defender, attacker);
        }
        container.addChild(combatEffects, frame, counts);
        const tile = this.state.map.tiles[battle.tileId];
        if (tile) {
          const point = tilePosition(tile);
          container.position.set(point.x, point.y - 47);
        }
        visual = {
          container,
          frame,
          counts,
          fighters,
          combatEffects,
          tileId: battle.tileId,
          incumbentOwner: battle.incumbentOwner,
          segments: presentation.map((participant) => ({
            playerId: participant.playerId,
            color:
              participant.playerId === null
                ? 0x9d9889
                : (this.state!.players[participant.playerId]?.color ??
                  PLAYER_COLORS[participant.playerId % PLAYER_COLORS.length]!),
            target: participant.sharePermyriad / 10_000,
            displayed: participant.sharePermyriad / 10_000,
            ghost: participant.sharePermyriad / 10_000,
            troops: participant.troops,
            turretSupportCount: participant.turretSupportCount,
          })),
          reinforcementSignature: presentation
            .map((participant) => {
              const source = battle.participants.find(
                (candidate) => candidate.playerId === participant.playerId,
              );
              return `${participant.playerId ?? "n"}:${source?.lastReinforcementTick ?? 0}:${source?.reinforcementAmount ?? 0}`;
            })
            .join("|"),
          pulse: 0,
          amount: 0,
          baseCounts: "",
          resolving: null,
        };
        this.battleLayer.addChild(container);
        this.battles.set(battle.id, visual);
      }
      visual.resolving = null;
      visual.incumbentOwner = battle.incumbentOwner;
      const prior = new Map(visual.segments.map((segment) => [segment.playerId, segment]));
      visual.segments = presentation.map((participant) => {
        const existing = prior.get(participant.playerId);
        return {
          playerId: participant.playerId,
          color:
            participant.playerId === null
              ? 0x9d9889
              : (this.state!.players[participant.playerId]?.color ??
                PLAYER_COLORS[participant.playerId % PLAYER_COLORS.length]!),
          target: participant.sharePermyriad / 10_000,
          displayed: existing?.displayed ?? 0,
          ghost: existing?.ghost ?? 0,
          troops: participant.troops,
          turretSupportCount: participant.turretSupportCount,
        };
      });
      const shown = presentation
        .slice(0, 4)
        .map(
          (participant) =>
            `${participant.troops}${participant.turretSupportCount > 0 ? `+T${participant.turretSupportCount}` : ""}`,
        );
      visual.baseCounts = `${shown.join(" · ")}${presentation.length > 4 ? ` · +${presentation.length - 4}` : ""}`;
      const reinforcementSignature = presentation
        .map((participant) => {
          const source = battle.participants.find(
            (candidate) => candidate.playerId === participant.playerId,
          );
          return `${participant.playerId ?? "n"}:${source?.lastReinforcementTick ?? 0}:${source?.reinforcementAmount ?? 0}`;
        })
        .join("|");
      if (reinforcementSignature !== visual.reinforcementSignature) {
        visual.reinforcementSignature = reinforcementSignature;
        visual.pulse = 1;
        visual.amount = Math.max(
          0,
          ...battle.participants.map((participant) => participant.reinforcementAmount),
        );
      }
    }
    for (const [id, visual] of this.battles) {
      if (!wanted.has(id) && visual.resolving === null) {
        const owner = this.state.map.tiles[visual.tileId]?.owner;
        let winner = visual.segments.find((segment) => segment.playerId === owner);
        if (!winner) {
          winner = {
            playerId: owner ?? null,
            color:
              owner === null
                ? 0x9d9889
                : (this.state.players[owner]?.color ??
                  PLAYER_COLORS[owner % PLAYER_COLORS.length]!),
            target: 1,
            displayed: 0,
            ghost: 0,
            troops: this.state.map.tiles[visual.tileId]?.troops ?? 0,
            turretSupportCount: 0,
          };
          visual.segments.push(winner);
        }
        for (const segment of visual.segments) segment.target = segment === winner ? 1 : 0;
        visual.resolving = 0;
      }
    }
  }

  private captureOwnerChanges(previous: GameState | null, next: GameState): void {
    if (!previous || previous.map.seed !== next.map.seed) return;
    const enclosureWaveDelay = new Map<string, number>();
    const enclosureWaveSource = new Map<string, string>();
    for (const event of next.events) {
      if (
        event.id <= this.lastEventId ||
        event.type !== "encirclement-complete" ||
        !event.tileIds?.length
      ) {
        continue;
      }
      const pocket = new Set(event.tileIds);
      const depth = new Map<string, number>();
      const queue: string[] = [];
      for (const tileId of event.tileIds) {
        const tile = next.map.tiles[tileId];
        if (!tile) continue;
        const outsideId = neighbors(tile)
          .map(axialKey)
          .find((neighborId) => !pocket.has(neighborId) && next.map.tiles[neighborId]);
        if (outsideId) {
          depth.set(tileId, 0);
          enclosureWaveSource.set(tileId, outsideId);
          queue.push(tileId);
        }
      }
      for (let index = 0; index < queue.length; index += 1) {
        const tileId = queue[index]!;
        const tile = next.map.tiles[tileId];
        const tileDepth = depth.get(tileId) ?? 0;
        if (!tile) continue;
        for (const neighbor of neighbors(tile)) {
          const neighborId = axialKey(neighbor);
          if (!pocket.has(neighborId) || depth.has(neighborId)) continue;
          depth.set(neighborId, tileDepth + 1);
          enclosureWaveSource.set(neighborId, tileId);
          queue.push(neighborId);
        }
      }
      for (const tileId of event.tileIds) {
        enclosureWaveDelay.set(tileId, Math.min(0.5, (depth.get(tileId) ?? 0) * 0.08));
      }
    }
    for (const tileId of next.map.landIds) {
      const before = previous.map.tiles[tileId]?.owner;
      const after = next.map.tiles[tileId]?.owner;
      if (before === after || this.captures.some((capture) => capture.tileId === tileId)) continue;
      const tile = next.map.tiles[tileId]!;
      const point = tilePosition(tile);
      const battle = previous.battles.find((candidate) => candidate.tileId === tileId);
      const entrant = battle?.participants.find((participant) => participant.playerId === after);
      const waveSourceId = enclosureWaveSource.get(tileId);
      const entryTile = waveSourceId
        ? next.map.tiles[waveSourceId]
        : entrant
          ? previous.map.tiles[entrant.entryFrom]
          : undefined;
      const entryPoint = entryTile ? tilePosition(entryTile) : { x: point.x - 1, y: point.y };
      const angle = Math.atan2(entryPoint.y - point.y, entryPoint.x - point.x);
      const color =
        after === null
          ? 0xb1a993
          : (next.players[after]?.color ?? PLAYER_COLORS[after % PLAYER_COLORS.length]!);
      const graphics = new Graphics()
        .poly(hexPoints(HEX_SIZE + 1))
        .fill({ color, alpha: 0.28 })
        .stroke({ color: lighten(color, 65), width: 4, alpha: 0.95 });
      graphics.pivot.set(HEX_SIZE, 0);
      graphics.position.set(
        point.x + Math.cos(angle) * HEX_SIZE,
        point.y + Math.sin(angle) * HEX_SIZE,
      );
      graphics.scale.set(0.04, 1);
      graphics.rotation = angle;
      this.effectLayer.addChild(graphics);
      this.displayOwners.set(tileId, before ?? null);
      this.captures.push({
        graphics,
        tileId,
        owner: after ?? null,
        previousOwner: before ?? null,
        age:
          previous.phase === "placement" &&
          next.phase === "opening" &&
          next.config.startingCenters?.includes(tileId) !== true
            ? -0.22
            : -(enclosureWaveDelay.get(tileId) ?? 0),
        angle,
      });
    }
  }

  private beginTurretVolley(state: GameState, sourceTileId: string, targetTileId: string): void {
    const source = state.map.tiles[sourceTileId];
    const target = state.map.tiles[targetTileId];
    if (!source || !target) return;
    const sourcePoint = tilePosition(source);
    const targetPoint = tilePosition(target);
    const owner = source.owner;
    const color =
      owner === null
        ? 0xffd36f
        : (state.players[owner]?.accent ?? PLAYER_COLORS[owner % PLAYER_COLORS.length]!);
    const graphics = new Graphics();
    this.effectLayer.addChild(graphics);
    this.turretVolleys.push({
      graphics,
      age: 0,
      duration: this.options.quality === "low" ? 0.2 : 0.42,
      sourceX: sourcePoint.x,
      sourceY: sourcePoint.y - 15,
      targetX: targetPoint.x,
      targetY: targetPoint.y,
      color,
    });
    const structure = this.structures.get(sourceTileId);
    if (structure?.type === "turret") {
      structure.aimAngle = Math.atan2(targetPoint.y - sourcePoint.y, targetPoint.x - sourcePoint.x);
      structure.volleyPulse = 1;
    }
  }

  private consumeWorldEvents(state: GameState): void {
    const renderedVolleys = new Set<string>();
    for (const event of state.events) {
      if (event.id <= this.lastEventId) continue;
      this.lastEventId = Math.max(this.lastEventId, event.id);
      if (event.type === "turret-volley" && event.sourceTileId && event.tileId) {
        const volleyKey = `${event.tick}:${event.sourceTileId}`;
        if (!renderedVolleys.has(volleyKey)) {
          renderedVolleys.add(volleyKey);
          this.beginTurretVolley(state, event.sourceTileId, event.tileId);
        }
        continue;
      }
      if ((event.type !== "reward" && event.type !== "capture") || !event.tileId) continue;
      const tile = state.map.tiles[event.tileId];
      if (!tile) continue;
      const point = tilePosition(tile);
      const label =
        event.type === "reward"
          ? `+${Math.round((event.amount ?? 0) / 1000)} SUPPLY`
          : "TERRITORY CLAIMED";
      const text = createBadge(label, event.type === "reward" ? 11 : 9);
      text.tint = event.type === "reward" ? 0xffe18c : 0xf4edcf;
      const back = new Graphics()
        .roundRect(-42, -10, 84, 20, 8)
        .fill({ color: 0x071017, alpha: 0.9 })
        .stroke({ color: event.type === "reward" ? 0xf0c75e : 0xc9b98d, width: 1.2 });
      const container = new Container();
      container.addChild(back, text);
      container.position.set(point.x, point.y + (event.type === "reward" ? -78 : 40));
      this.effectLayer.addChild(container);
      this.popups.push({ container, age: 0, baseY: container.y });
    }
  }

  private stackPoint(stack: MovingStack): { x: number; y: number } {
    if (!this.state) return { x: 0, y: 0 };
    const from =
      this.state.map.tiles[stack.path[Math.min(stack.pathIndex, stack.path.length - 1)]!];
    const to =
      this.state.map.tiles[stack.path[Math.min(stack.pathIndex + 1, stack.path.length - 1)]!];
    if (!from || !to) return { x: 0, y: 0 };
    const a = tilePosition(from);
    const b = tilePosition(to);
    const t = Math.max(0, Math.min(1, stack.segmentProgress / Math.max(1, stack.segmentDuration)));
    const eased = t * t * (3 - 2 * t);
    const laneX = ((stack.lane % 3) - 1) * 3;
    const laneY = (((stack.lane + 1) % 3) - 1) * 2;
    return { x: a.x + (b.x - a.x) * eased + laneX, y: a.y + (b.y - a.y) * eased + laneY - 5 };
  }

  private isBorderTile(tile: TileState): boolean {
    if (!this.state) return false;
    return neighbors(tile).some(
      (neighbor) => this.state!.map.tiles[axialKey(neighbor)]?.owner !== tile.owner,
    );
  }

  private animate = (ticker: { deltaMS: number }): void => {
    const dt = Math.min(50, ticker.deltaMS) / 1000;
    this.elapsed += dt;
    const cameraSpeed = (580 * dt) / Math.max(0.25, this.world.scale.x);
    if (this.keys.has("w") || this.keys.has("arrowup"))
      this.world.y += cameraSpeed * this.world.scale.x;
    if (this.keys.has("s") || this.keys.has("arrowdown"))
      this.world.y -= cameraSpeed * this.world.scale.x;
    if (this.keys.has("a") || this.keys.has("arrowleft"))
      this.world.x += cameraSpeed * this.world.scale.x;
    if (this.keys.has("d") || this.keys.has("arrowright"))
      this.world.x -= cameraSpeed * this.world.scale.x;

    for (const visual of this.structures.values()) {
      if (!visual.animated) continue;
      if (visual.type === "farm") visual.animated.rotation += dt * 0.7;
      else if (visual.type === "barracks")
        visual.animated.scale.x = 0.93 + Math.sin(this.elapsed * 2.2) * 0.07;
      else {
        visual.volleyPulse = Math.max(0, visual.volleyPulse - dt * 4.5);
        visual.animated.rotation =
          (visual.aimAngle ?? Math.sin(this.elapsed * 0.8) * 0.23) -
          Math.sin(visual.volleyPulse * Math.PI) * 0.05;
        visual.animated.scale.x = 1 - Math.sin(visual.volleyPulse * Math.PI) * 0.12;
      }
    }
    for (const visual of this.stacks.values()) {
      visual.container.x += (visual.targetX - visual.container.x) * Math.min(1, dt * 12);
      visual.container.y += (visual.targetY - visual.container.y) * Math.min(1, dt * 12);
      for (const soldier of visual.squad) {
        const walk = Math.sin(this.elapsed * 12 + soldier.phase);
        soldier.leftLeg.rotation = walk * 0.5;
        soldier.rightLeg.rotation = -walk * 0.5;
        soldier.weapon.rotation = -walk * 0.16;
        soldier.container.y += (walk * 0.45 - (soldier.container.y % 1)) * 0.15;
      }
      visual.dust.clear();
      const moving =
        Math.hypot(visual.targetX - visual.container.x, visual.targetY - visual.container.y) > 0.08;
      if (moving && this.options.quality !== "low") {
        for (let mote = 0; mote < 4; mote += 1) {
          const phase = (this.elapsed * 2.8 + mote * 0.23) % 1;
          const distance = 8 + phase * 20;
          visual.dust
            .circle(
              -Math.cos(visual.facingAngle) * distance + Math.sin(mote * 3.1) * 4,
              -Math.sin(visual.facingAngle) * distance + 7 + Math.cos(mote * 2.2) * 2,
              2 + phase * 2.5,
            )
            .fill({ color: 0xc2aa7c, alpha: (1 - phase) * 0.22 });
        }
      }
    }
    for (const visual of this.labels.values()) {
      visual.container.y = visual.baseY + Math.sin(this.elapsed * 1.75 + visual.phase) * 0.75;
    }
    for (const [id, visual] of this.battles) {
      if (visual.resolving !== null) {
        visual.resolving += dt;
        if (visual.resolving >= 0.64) {
          visual.container.destroy({ children: true });
          this.battles.delete(id);
          continue;
        }
      }
      const mainSpeed = visual.pulse > 0 ? 8 : 4.5;
      for (const segment of visual.segments) {
        segment.displayed += (segment.target - segment.displayed) * Math.min(1, dt * mainSpeed);
        segment.ghost +=
          (segment.displayed - segment.ghost) *
          Math.min(1, dt * (visual.pulse > 0.4 ? 0.45 : 1.35));
      }
      visual.pulse = Math.max(0, visual.pulse - dt * 0.9);
      const clash = Math.sin(this.elapsed * 9.5);
      for (let index = 0; index < visual.fighters.length; index += 1) {
        const fighter = visual.fighters[index]!;
        const defender = index % 2 === 0;
        const rank = Math.floor(index / 2);
        const strike = Math.max(0, Math.sin(this.elapsed * 8.5 + fighter.phase));
        fighter.container.x =
          (defender ? -18 - rank * 7 : 18 + rank * 7) + (defender ? strike * 4 : -strike * 4);
        fighter.container.y = 40 + rank * 2 + Math.abs(clash) * 0.8;
        fighter.weapon.rotation = (defender ? -1 : 1) * strike * 0.42;
        fighter.leftLeg.rotation = clash * 0.22;
        fighter.rightLeg.rotation = -clash * 0.22;
      }
      visual.combatEffects.clear();
      const impact = (Math.sin(this.elapsed * 17) + 1) / 2;
      for (let mote = 0; mote < (this.options.quality === "high" ? 4 : 2); mote += 1) {
        const phase = (this.elapsed * (18 + mote * 2.3) + mote * 1.7) % 1;
        visual.combatEffects
          .circle(
            (mote - 1.5) * 4 + Math.sin(this.elapsed * 7 + mote) * 3,
            42 - phase * 14,
            1.2 + phase,
          )
          .fill({ color: mote % 2 ? 0xd9b66f : 0xb59a71, alpha: (1 - phase) * 0.55 });
      }
      if (impact > 0.92) {
        visual.combatEffects
          .star(0, 36, 6, 5 + impact * 3, 1.8)
          .fill({ color: 0xffe2a0, alpha: (impact - 0.92) * 9 });
      }
      this.drawBattleBar(visual);
    }
    let ownershipChanged = false;
    for (let index = this.captures.length - 1; index >= 0; index -= 1) {
      const capture = this.captures[index]!;
      capture.age += dt;
      const progress = Math.max(0, Math.min(1, capture.age / 0.55));
      const eased = 1 - Math.pow(1 - progress, 3);
      capture.graphics.scale.set(0.04 + eased * 0.96, 1 + Math.sin(progress * Math.PI) * 0.08);
      capture.graphics.alpha = progress < 0.72 ? 1 : 1 - (progress - 0.72) / 0.28;
      capture.graphics.rotation = capture.angle + (1 - eased) * -0.08;
      if (progress >= 1) {
        this.displayOwners.set(capture.tileId, capture.owner);
        capture.graphics.destroy();
        this.captures.splice(index, 1);
        ownershipChanged = true;
      }
    }
    for (let index = this.popups.length - 1; index >= 0; index -= 1) {
      const popup = this.popups[index]!;
      popup.age += dt;
      const progress = Math.min(1, popup.age / 1.2);
      popup.container.y = popup.baseY - progress * 25;
      popup.container.alpha = progress < 0.62 ? 1 : 1 - (progress - 0.62) / 0.38;
      popup.container.scale.set(0.84 + Math.min(1, progress * 5) * 0.16);
      if (progress >= 1) {
        popup.container.destroy({ children: true });
        this.popups.splice(index, 1);
      }
    }
    for (let index = this.turretVolleys.length - 1; index >= 0; index -= 1) {
      const volley = this.turretVolleys[index]!;
      volley.age += dt;
      const progress = Math.min(1, volley.age / volley.duration);
      volley.graphics.clear();
      const flashAlpha = Math.max(0, 1 - progress * 2.5);
      volley.graphics
        .circle(volley.sourceX, volley.sourceY, 4 + progress * 5)
        .fill({ color: 0xffe6a0, alpha: flashAlpha });
      if (this.options.quality !== "low") {
        const head = Math.min(1, progress * 1.45);
        const tail = Math.max(0, head - 0.32);
        const headX = volley.sourceX + (volley.targetX - volley.sourceX) * head;
        const headY = volley.sourceY + (volley.targetY - volley.sourceY) * head;
        const tailX = volley.sourceX + (volley.targetX - volley.sourceX) * tail;
        const tailY = volley.sourceY + (volley.targetY - volley.sourceY) * tail;
        volley.graphics
          .moveTo(tailX, tailY)
          .lineTo(headX, headY)
          .stroke({ color: volley.color, width: 2.6, alpha: 1 - progress * 0.72 })
          .circle(headX, headY, 2.8)
          .fill({ color: 0xfff0b6, alpha: 1 - progress * 0.62 });
      }
      if (progress >= 1) {
        volley.graphics.destroy();
        this.turretVolleys.splice(index, 1);
      }
    }
    if (ownershipChanged) this.drawOwnership();
    this.clampCamera();
  };

  private drawBattleBar(visual: BattleVisual): void {
    visual.frame.clear();
    visual.frame
      .roundRect(-BAR_WIDTH / 2 - 6, -BAR_HEIGHT / 2 - 8, BAR_WIDTH + 12, BAR_HEIGHT + 22, 7)
      .fill({ color: 0x111820, alpha: 0.96 })
      .stroke({ color: 0xb9a879, width: 1.5, alpha: 0.9 });
    visual.frame
      .roundRect(-BAR_WIDTH / 2 - 2, -BAR_HEIGHT / 2 - 2, BAR_WIDTH + 4, BAR_HEIGHT + 4, 4)
      .fill({ color: 0x070d12 });
    const total = Math.max(
      0.0001,
      visual.segments.reduce((sum, segment) => sum + Math.max(0, segment.displayed), 0),
    );
    let cursor = -BAR_WIDTH / 2;
    visual.segments.forEach((segment, index) => {
      const remaining = BAR_WIDTH / 2 - cursor;
      const width =
        index === visual.segments.length - 1
          ? remaining
          : Math.min(remaining, (Math.max(0, segment.displayed) / total) * BAR_WIDTH);
      if (width > 0.1) {
        visual.frame
          .rect(cursor, -BAR_HEIGHT / 2, width, BAR_HEIGHT)
          .fill({ color: segment.color });
        if (this.options.colorPatterns) {
          const pattern =
            segment.playerId === null
              ? 6
              : (this.state?.players[segment.playerId]?.pattern ?? segment.playerId % 7);
          drawBattleSegmentPattern(visual.frame, cursor, width, pattern, segment.color);
        }
      }
      cursor += width;
      if (index < visual.segments.length - 1) {
        visual.frame
          .rect(cursor - 0.7, -BAR_HEIGHT / 2, 1.4, BAR_HEIGHT)
          .fill({ color: 0xf8df9a, alpha: 0.92 });
      }
    });
    const incumbent = visual.segments.find((segment) => segment.playerId === visual.incumbentOwner);
    if (incumbent) {
      visual.frame
        .poly([-BAR_WIDTH / 2 - 10, -7, -BAR_WIDTH / 2 - 3, -10, -BAR_WIDTH / 2 - 3, 8])
        .fill({ color: incumbent.color })
        .stroke({ color: 0xe8dab2, width: 1 });
    }
    visual.counts.text = visual.baseCounts;
    if (visual.pulse > 0) {
      visual.frame.circle(0, 0, 10 + (1 - visual.pulse) * 8).stroke({
        color: 0xffefae,
        width: 2.5,
        alpha: visual.pulse,
      });
      if (visual.amount > 0) visual.counts.text = `${visual.baseCounts}  +${visual.amount}`;
    }
    visual.counts.position.y = 13;
  }

  private bindInput(): void {
    const canvas = this.app.canvas;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("keydown", this.onCanvasKeyDown);
    canvas.addEventListener("focus", this.onCanvasFocus);
    canvas.addEventListener("blur", this.onCanvasBlur);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private unbindInput(): void {
    const canvas = this.app.canvas;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("keydown", this.onCanvasKeyDown);
    canvas.removeEventListener("focus", this.onCanvasFocus);
    canvas.removeEventListener("blur", this.onCanvasBlur);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.keyboardCursorVisible = false;
    try {
      this.app.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A detached/lost canvas may reject capture; the cancel path still clears input.
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinching = this.pointers.size === 2;
    if (pinching) {
      const values = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(values[0]!.x - values[1]!.x, values[0]!.y - values[1]!.y);
    }
    this.pointerStart = {
      x: event.clientX,
      y: event.clientY,
      worldX: this.world.x,
      worldY: this.world.y,
      button: event.button,
    };
    this.panning = pinching || event.button === 1;
  };

  private onPointerMove = (event: PointerEvent): void => {
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      const values = [...this.pointers.values()];
      const distance = Math.hypot(values[0]!.x - values[1]!.x, values[0]!.y - values[1]!.y);
      if (this.pinchDistance > 0)
        this.zoomAt(
          (values[0]!.x + values[1]!.x) / 2,
          (values[0]!.y + values[1]!.y) / 2,
          distance / this.pinchDistance,
        );
      this.pinchDistance = distance;
      return;
    }
    if (this.pointerStart) {
      const dx = event.clientX - this.pointerStart.x;
      const dy = event.clientY - this.pointerStart.y;
      if (this.panning || Math.hypot(dx, dy) > 7) {
        this.panning = true;
        this.world.position.set(this.pointerStart.worldX + dx, this.pointerStart.worldY + dy);
        return;
      }
    }
    const tileId = this.tileAtClient(event.clientX, event.clientY);
    if (tileId !== this.hoveredId) {
      this.hoveredId = tileId;
      this.callbacks.onTileHover(tileId);
      this.drawHighlights();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinchDistance = 0;
    const start = this.pointerStart;
    if (start && !this.panning) {
      if (start.button === 2) this.callbacks.onCancel();
      else this.callbacks.onTileClick(this.tileAtClient(event.clientX, event.clientY));
    }
    this.pointerStart = null;
    this.panning = false;
    try {
      this.app.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.pointers.clear();
    this.pointerStart = null;
    this.panning = false;
    this.pinchDistance = 0;
    try {
      if (this.app.canvas.hasPointerCapture(event.pointerId)) {
        this.app.canvas.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Browser cancellation may have already released capture.
    }
    this.callbacks.onCancel();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0012));
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    this.callbacks.onCancel();
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const tileId = this.tileAtClient(event.clientX, event.clientY);
    if (tileId) this.centerOn(tileId);
  };

  private onCanvasFocus = (): void => {
    if (this.state && !this.keyboardTileId)
      this.keyboardTileId = this.defaultKeyboardTile(this.state);
    this.keyboardCursorVisible = true;
    this.updateCanvasAccessibilityLabel();
    this.drawHighlights();
  };

  private onCanvasBlur = (): void => {
    this.keyboardCursorVisible = false;
    this.drawHighlights();
  };

  private onCanvasKeyDown = (event: KeyboardEvent): void => {
    if (!this.state) return;
    const direction: Record<string, { q: number; r: number }> = {
      ArrowLeft: { q: -1, r: 0 },
      ArrowRight: { q: 1, r: 0 },
      ArrowUp: { q: 0, r: -1 },
      ArrowDown: { q: 0, r: 1 },
    };
    if (event.key in direction) {
      event.preventDefault();
      event.stopPropagation();
      const currentId = this.keyboardTileId ?? this.defaultKeyboardTile(this.state);
      const current = currentId ? this.state.map.tiles[currentId] : null;
      const delta = direction[event.key]!;
      const nextId = current ? axialKey({ q: current.q + delta.q, r: current.r + delta.r }) : null;
      if (nextId && this.state.map.tiles[nextId]?.terrain !== "water") {
        this.keyboardTileId = nextId;
        this.hoveredId = nextId;
        this.keyboardCursorVisible = true;
        this.callbacks.onTileHover(nextId);
        this.updateCanvasAccessibilityLabel();
        this.drawHighlights();
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onTileClick(this.keyboardTileId ?? this.defaultKeyboardTile(this.state));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.callbacks.onCancel();
    }
  };

  private defaultKeyboardTile(state: GameState): string | null {
    const localId = this.options.localPlayerId;
    return (
      this.selectedId ??
      state.placement.placements[localId]?.centerId ??
      state.map.spawnCenters[localId] ??
      (state.phase === "placement" ? eligibleSpawnCenters(state.map)[0] : null) ??
      state.map.landIds[0] ??
      null
    );
  }

  private updateCanvasAccessibilityLabel(): void {
    const tile = this.keyboardTileId ? this.state?.map.tiles[this.keyboardTileId] : null;
    const owner =
      tile?.owner === null || tile?.owner === undefined
        ? "neutral"
        : (this.state?.players[tile.owner]?.name ?? `player ${tile.owner + 1}`);
    const current = tile
      ? ` Current hex ${tile.id}, ${tile.terrain}, ${owner}, ${tile.troops} troops.`
      : "";
    this.app.canvas.setAttribute(
      "aria-label",
      `Hex Dominion battlefield.${current} Use arrow keys to move the hex cursor, Enter or Space to select, and Escape to cancel.`,
    );
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.matches("input, select, textarea, button")) return;
    this.keys.add(event.key.toLowerCase());
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  private onWindowBlur = (): void => {
    this.keys.clear();
    this.pointers.clear();
    this.pointerStart = null;
    this.panning = false;
    this.pinchDistance = 0;
    this.callbacks.onCancel();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") this.onWindowBlur();
  };

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = this.app.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const old = this.world.scale.x;
    const next = Math.max(0.16, Math.min(1.6, old * factor));
    const wx = (x - this.world.x) / old;
    const wy = (y - this.world.y) / old;
    this.world.scale.set(next);
    this.world.position.set(x - wx * next, y - wy * next);
    this.callbacks.onZoom?.(next);
    this.updateGarrisons();
  }

  private tileAtClient(clientX: number, clientY: number): string | null {
    if (!this.state) return null;
    const rect = this.app.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const wx = (sx - this.world.x) / this.world.scale.x;
    const wy = (sy - this.world.y) / this.world.scale.y;
    const axial = pixelToAxial({ x: wx, y: wy }, HEX_SIZE);
    const id = axialKey(axial);
    return this.state.map.tiles[id] ? id : null;
  }

  private clampCamera(): void {
    const margin = 110;
    const scale = this.world.scale.x;
    const left = this.mapBounds.x * scale + this.world.x;
    const right = (this.mapBounds.x + this.mapBounds.width) * scale + this.world.x;
    const top = this.mapBounds.y * scale + this.world.y;
    const bottom = (this.mapBounds.y + this.mapBounds.height) * scale + this.world.y;
    if (right < margin) this.world.x += margin - right;
    if (left > this.host.clientWidth - margin)
      this.world.x -= left - (this.host.clientWidth - margin);
    if (bottom < margin) this.world.y += margin - bottom;
    if (top > this.host.clientHeight - margin)
      this.world.y -= top - (this.host.clientHeight - margin);
  }
}

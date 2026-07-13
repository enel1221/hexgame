# Visual QA

Visual QA is a review process, not a screenshot-existence check. `npm run test:visual` creates the deterministic captures below in `docs/screenshots/`; a reviewer must open them at full size, record findings, repair defects, rerun the suite, and inspect the replacements.

## Automated capture matrix

| File                         | Viewport | Seed/scenario                                                                        | Review purpose                                                      |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `title-setup.png`            | 1440×900 | Fresh local storage, default setup                                                   | Brand, hierarchy, realm cards, ledger, focus/spacing                |
| `placement-selection.png`    | 1440×900 | `VISUAL-PLACEMENT`, neutral map with human and AI provisional/locked footprints      | Candidate clarity, roster/status, seven-hex footprint hierarchy     |
| `opening-handoff.png`        | 1440×900 | `VISUAL-OPENING`, center claim before the delayed surrounding ring                   | Local camera focus and center-first radial opening timing           |
| `map-heartland.png`          | 1440×900 | `VISUAL-HEARTLAND`, 3 AI, first paused live state                                    | River Gates seam, two-hex crossing, fitted framing                  |
| `map-broken-crown.png`       | 1440×900 | `VISUAL-BROKEN-CROWN`, 3 AI, first paused live state                                 | Shattered Crown one-hex gate and water/land readability             |
| `map-highland-basin.png`     | 1440×900 | `VISUAL-HIGHLAND-BASIN`, 3 AI, first paused live state                               | Highland Passes seam, terrain density, and two-hex crossing         |
| `twenty-ai-overview.png`     | 1440×900 | `VISUAL-TWENTY-AI`, 20 AI, first responsive ticks                                    | 1,092-land overview, 21 colors, gates, fitted camera, HUD load      |
| `active-game.png`            | 1440×900 | `VISUAL-ACTIVE`, 3 AI, captured during a human stack move with another tile selected | Squad/count, selection, tile inspector, command dock                |
| `selected-path-preview.png`  | 1440×900 | `VISUAL-PATH-PREVIEW`, selected source plus hovered friendly destination             | Selection ring, route arrows, inspector, count layering             |
| `multi-route-preview.png`    | 1440×900 | `VISUAL-MULTI-PREVIEW`, two aggregate sources and two staged targets                 | Source rings, numbered quotas, route fans, and Multi status         |
| `multiple-stacks.png`        | 1440×900 | `VISUAL-MULTIPLE-STACKS`, two same-tick legal orders                                 | Multiple squad separation, exact badges, lane readability           |
| `structures.png`             | 1440×900 | `debug-scenario-test`, frozen `structures` fixture                                   | Barracks, Archery Range, Wizard Tower, typed plates, stacking       |
| `battle-rps-counter.png`     | 1440×900 | Frozen pure counter battle fixture                                                   | Typed strip, exact M/R/W counts, explicit RPS advantage             |
| `battle-typed-support.png`   | 1440×900 | Frozen defended producer battle                                                      | Local/adjacent typed support and effective-power explanation        |
| `battle-reinforcement.png`   | 1440×900 | Same battle ID after a deterministic +40 attacker reinforcement                      | Reinforcement halo/count and delayed ghost/main seam separation     |
| `battle-mixed-n-way.png`     | 1440×900 | Frozen three-participant mixed-composition fixture                                   | Independent factions, typed mixes, patterns, and inspector detail   |
| `encirclement-countdown.png` | 1440×900 | Frozen active enclosure around a developed interior                                  | Perimeter, offset countdown, structure/garrison legibility          |
| `capture-transition.png`     | 1440×900 | Sequential `capture-before` then `capture` fixture                                   | Directional edge wipe and world-space capture/reward labels         |
| `victory.png`                | 1440×900 | Frozen local-player `victory` fixture                                                | Crown treatment, result hierarchy, statistics, actions              |
| `defeat.png`                 | 1440×900 | Frozen local-player `defeat` fixture                                                 | Defeat treatment, opponent attribution, statistics, actions         |
| `tablet-title.png`           | 768×1024 | Fresh setup                                                                          | Stacked setup layout, touch sizes, clipping/scroll                  |
| `tablet-active-game.png`     | 1024×768 | `VISUAL-TABLET`, 3 AI, first paused live state                                       | Compact HUD/dock, standings/events behavior, battlefield visibility |

The table records browser viewports. Because setup captures are full-page, the generated `title-setup.png` is 1440×931 and `tablet-title.png` is 768×1544; the taller tablet file is the expected scrollable document, not viewport overflow.

The title and portrait-tablet setup also use Playwright `toHaveScreenshot` baselines with CSS animation disabled and a 0.5% maximum differing-pixel ratio. Live-canvas captures use fixed seeds plus early, inspected simulation states; PixiJS ambient animation and Worker scheduling can still differ by a small frame/tick phase, so those named images remain curated review artifacts instead of pixel-diff baselines.

The development-only deterministic debug API exposes map tiles, spawn clusters, selected tile, stacks and their segment progress, battles and actual control, renderer stack coordinates and battle seams, visible-object count, recent Worker publications, players, winner, tick, and state hash. Selection/hover/cancel calls still route through the normal UI command pipeline. Debug matches additionally expose frozen presentation fixtures that deliberately replace Worker state, making short-lived combat, reinforcement, capture, victory, and defeat states reliable to capture. The Worker rejects fixture requests unless `config.debug` is true, and production builds ignore the debug URL flag entirely.

## Review checklist

Open every PNG at 100% and inspect the following.

### Layout and interface

- [ ] No clipped headings, labels, values, hotkeys, or button text.
- [ ] Setup cards align and the active realm is unmistakable.
- [ ] Focus, hover, pressed, selected, and disabled states have distinct contrast.
- [ ] Top HUD and command dock do not cover the same usable battlefield region.
- [ ] Selected-tile inspector does not collide with the command dock.
- [ ] Tablet setup remains comfortably scrollable without horizontal overflow.
- [ ] Tablet HUD preserves Supply, land, pause, selection, and dispatch controls.
- [ ] Touch targets are not tiny or crowded.
- [ ] A 21-player standings panel is compact/collapsible and does not dominate the map.
- [ ] Placement lists every participant name and locked/unlocked state without relying on color alone.
- [ ] The 30-second multiplayer placement countdown remains readable without covering candidate hexes.
- [ ] Multi mode exposes its source/target phase, counts, percentage, projected quotas, Send, and Cancel on keyboard and touch layouts.

### Battlefield readability

- [ ] Pointy-top hexes show depth, bevel, contact shadow, and consistent lighting.
- [ ] Meadow, Muster, Plains, Forest, Hills, and Water are distinguishable without labels.
- [ ] Terrain remains visible through ownership tint.
- [ ] Adjacent ruler colors and borders are distinct in the 20-AI capture.
- [ ] Color-pattern assistance remains supplementary and unobtrusive when tested manually.
- [ ] Fitted maps are centered with useful margins and cannot appear lost offscreen.
- [ ] Starting clusters, neutral land, and water boundaries remain readable at overview zoom.
- [ ] Every archetype's impassable seam and one/two-hex gate read as intentional strategic topology rather than a rendering gap.
- [ ] Selected and build-eligible tiles are obvious without hiding garrisons.
- [ ] Provisional seven-hex footprints are translucent, locked footprints are solid, and overlapping/unsafe centers never look selectable.
- [ ] The opening handoff claims the center first, expands to the six neighbors, and focuses the local camera without resembling seven simultaneous captures.
- [ ] Multi source rings, numbered destination markers, valid/invalid route fans, and quota previews remain distinguishable on dense maps.
- [ ] Active/blocked producer rally paths are persistent but visually quieter than a selected movement preview.
- [ ] Encirclement perimeters and 150-tick countdowns identify the pocket and breach state without implying progressive authoritative capture.

### Units, structures, and effects

- [ ] Stationary and moving M/R/W counts are crisp, exact, and high contrast.
- [ ] Moving stacks read as small marching squads rather than static icons.
- [ ] Sword, bow, and crystal composition glyphs remain distinguishable without emoji, letters, or color-only meaning.
- [ ] Barracks, Archery Range, and Wizard Tower silhouettes are distinguishable at normal zoom.
- [ ] Construction, seized damage, and repair state are visibly different when exercised.
- [ ] x1 has no multiplier badge; x2 through x99 stay legible beside the structure and in the inspector.
- [ ] A pending addition, completed count, integrity, typed production/rally state, and battle support are not conflated.
- [ ] Battle bars show one player color/pattern segment per faction, exact typed composition, and integer segment targets totaling 10,000.
- [ ] RPS advantage uses an explicit up/down cue and percentage; local/adjacent support is labeled as power rather than real units.
- [ ] A late third/fourth faction expands smoothly as itself rather than appearing inside a two-side coalition.
- [ ] Reinforcement motion and impact remain visually separable from ordinary share easing.
- [ ] Typed building support remains visually subordinate to actual units and never implies that a structure can fight alone.
- [ ] Reinforcement halo/`+N`, combat effects, capture edge wipe, and reward labels do not cover counts.
- [ ] Victory and defeat overlays are visually distinct, legible, and expose usable actions.
- [ ] No jagged scaling, incorrect facing, excessive particles, or inconsistent light direction.

### Finish and originality

- [ ] No emoji, icon-font building, labeled rectangle, flat placeholder tile, or remote image appears.
- [ ] Empty terrain still has controlled detail without becoming noisy.
- [ ] Title and HUD look authored rather than like default form controls.
- [ ] Ornament, line weight, corner treatment, shadows, and spacing feel consistent.
- [ ] The game remains legible in grayscale/low saturation and with pattern assistance.

## Quality-setting differences

All qualities preserve map geometry, gates, ownership, typed units, structures, orders, battle bars, and capture feedback.

| Detail                      | Low     | Medium         | High           |
| --------------------------- | ------- | -------------- | -------------- |
| Meadow flowers              | omitted | 5 seeded marks | 5 seeded marks |
| Forest clusters per tile    | 3       | 5              | 5              |
| Plains tufts per tile       | 3       | 3              | 5              |
| Water wave strokes per tile | 2       | 4              | 4              |

Use Low for the 20-AI case if a device cannot maintain acceptable interaction, but do not accept a quality mode that removes exact counts or essential state feedback.

## Performance observations

The automated 20-AI visual case requires the Worker to generate a 21-ruler, 1,092-land chokepoint map, publish a non-empty state hash, mount the canvas, and advance at least one tick within the Playwright test timeout. That is a readiness smoke check, not a frame-rate benchmark.

Direct deterministic generation measurements for the 21-ruler cap on this Mac were 453 ms for River Gates, 442 ms for Shattered Crown, and 424 ms for Highland Passes. Every result contained exactly 1,092 land tiles, passed the full fairness report, and exposed 727–750 eligible spawn centers. These are single-run local diagnostics, not device-independent performance guarantees. The browser readiness case and full visual suite passed; no new frame-rate benchmark is claimed for this revision.

## Review log

Add a dated entry after inspecting generated images:

```text
YYYY-MM-DD — commit/working tree identifier — reviewer
Captures inspected:
Findings:
Repairs made:
Remaining deliberate tradeoffs:
Performance observations:
```

### 2026-07-11 — uncommitted `main` working tree — Codex

Captures inspected: all 16 curated PNGs in `docs/screenshots/` at original resolution, plus both Darwin title baselines.

Findings:

- Desktop and scrollable tablet setup preserve hierarchy, selection, labels, controls, and touch-sized spacing without horizontal overflow.
- Heartland, Broken Crown, and Highland Basin remain centered and visually distinct; water, meadow, muster, forest, hills, garrisons, and ownership borders remain readable.
- The 1,995-land, 21-ruler overview fits the battlefield, preserves distinct player outlines/counts, and keeps telemetry and the collapsed standings rail compact.
- Selected, moving, and simultaneous-stack states preserve exact badges and usable HUD/inspector separation.
- Farm, Barracks, and Turret silhouettes are distinct together, with garrison badges offset from the structures.
- The battle fixture shows exact 56-versus-56 parity, paired fighters, and a centered 50/50 seam. The +40 fixture clearly separates the bright main seam, delayed ghost trail, pulse, and `+40` count.
- Capture and `+3 Supply` labels are separated from the resolving battle area. Victory and defeat identify the correct ruler, retain readable statistics, and expose all three actions.
- No clipped primary control, placeholder rectangle, remote image, jagged canvas edge, or effect obscuring an exact troop count was found in these captures.

Repairs made before the final pass: moved structure garrison badges and capture reward labels away from their focal art; made the visual harness prove React hydration before applying screenshot caret styles; and stabilized mixed WebGL/HTML captures with a warm composite readback while leaving live animation enabled. The final baseline-verifying `npm run test:visual` run passed 10/10.

Remaining deliberate tradeoffs: live PixiJS captures remain curated artifacts instead of pixel baselines because ambient effects and Worker publication phase can vary; only the two deterministic setup pages use pixel-diff baselines. Low quality reduces decorative density but preserves essential counts and state feedback. The collapsed standings rail is intentional at overview scale.

Performance observations: the automated 20-AI readiness/capture case passed. The separate visible 20-AI benchmark and headless Hard stress results are recorded above; no tick debt occurred, and fixed-rate Worker publication improved 4× rendering while preserving 40 simulation ticks per second.

No broader visual state than the listed captures is claimed by this review.

### 2026-07-12 — uncommitted `main` working tree — Codex

Captures inspected: all 21 curated PNGs in `docs/screenshots/` at original resolution, plus both deterministic setup baselines.

Findings:

- Desktop and tablet setup preserve realm selection, challenger controls, ledger hierarchy, touch sizing, and scroll behavior without horizontal overflow.
- Placement clearly separates the human provisional footprint from locked AI footprints, lists every participant state, and leaves the highlighted candidates readable beneath the roster.
- The opening handoff shows the center-first claim and the delayed surrounding ring while keeping the local camera and opening banner legible.
- Heartland, Broken Crown, Highland Basin, and the 1,995-land 21-ruler overview all fit the viewport with distinct terrain, ownership outlines, garrisons, telemetry, and a compact standings rail.
- Selected paths, atomic Multi routes, simultaneous stacks, stacked structures, and the inspector/command dock retain exact counts and avoid collisions.
- Two- and three-faction battles, deterministic reinforcement, encirclement, capture, supply reward, victory, and defeat states preserve their transient labels, statistics, and controls without blank compositor regions.
- The landscape tablet game view keeps the compact HUD and dispatch/build dock usable while leaving the selected starting cluster visible.

Repairs made before the final pass: added an overview-fit debug capture; extracted the frozen PixiJS stage through the renderer's supported API for deterministic visual review; isolated short-lived reinforcement and defeat fixtures on fresh pages; stabilized the small result-stat and action layers; and offset the enclosure countdown from the structure and troop badges. The final `npm run test:visual` run passed 15/15.

Remaining deliberate tradeoffs: live PixiJS states remain curated review artifacts rather than broad pixel-diff baselines; the extraction and frozen-layer path is development-only visual-test support. Low quality reduces decorative terrain density but preserves authoritative counts, ownership, routes, combat, structures, and result state.

Performance observations: the 21-ruler readiness case passed. The placement-center cache measured 43.94 ms on its cold 21-player calculation and 0.0018 ms on the steady cached path. The longer visible-browser and headless stress observations remain recorded above.

No broader visual state than the listed captures is claimed by this review.

### 2026-07-12 — `codex/troop-counter-chokepoints` working tree — Codex

Captures inspected: all 22 current curated PNGs in `docs/screenshots/` at original resolution, plus both deterministic setup baselines.

Findings:

- Desktop and tablet setup present River Gates, Shattered Crown, Highland Passes, the 180–1,092 land scale, and B/R/T controls without clipping or horizontal overflow.
- Placement, opening, all three four-ruler maps, and the 1,092-land overview show intentional water seams and controlled one/two-hex crossings while preserving readable terrain, ownership, and exact M/R/W plates.
- Selected routes, Multi staging, simultaneous moving stacks, producer stacking, rally state, and the inspector/command dock remain separated and legible.
- Pure-counter, typed-support, three-faction, and reinforcement fixtures expose exact composition, explicit RPS percentages, effective power, and support as power rather than real units.
- Encirclement, capture, `+5 Supply`, victory, and defeat effects preserve their labels and controls without blank compositor regions or obscured unit counts.
- No stale Farm/Turret control, 1,995-land HUD, remote image, placeholder rectangle, jagged canvas edge, or clipped primary control remains in the current capture set.

Repairs made before the final pass: regenerated the entire suite after the rules/UI migration; replaced the old 50/50 and three-faction battle evidence with RPS-counter, typed-support, and mixed N-way captures; corrected 44px camera fitting; and preserved code-native sword, bow, crystal, and producer silhouettes. The final `npm run test:visual` run passed 15/15.

Remaining deliberate tradeoffs: the 21-ruler overview is intentionally dense, world-space battle labels stay compact while the inspector carries full arithmetic, and deterministic water seams have a visibly regular strategic shape. Live PixiJS states remain curated review artifacts rather than broad pixel-diff baselines.

Performance observations: direct 21-ruler generation measured 424–453 ms across the three archetypes on this Mac; all produced 1,092 fair connected land tiles and the automated browser readiness case passed.

No broader visual state than the listed captures is claimed by this review.

# Art direction

Hex Dominion uses an original stylized tabletop-diorama language: natural terrain remains readable, raised pointy-top hexes feel like crafted board pieces, and saturated ruler colors are reserved for ownership, banners, badges, highlights, and combat state.

## Perspective and shape language

- The camera reads as top-down with a light three-quarter miniature treatment rather than strict orthographic map symbols.
- Hexes have a top face, darker offset edge, contact shadow, inset line, and selective ownership border.
- Structures use compact silhouettes that fit inside one hex and remain recognizable at fitted-map zoom.
- Soldiers are representative animated squads, not one sprite per troop. Exact strength always comes from the count badge.
- UI silhouettes use clipped corners, crests, pins, flags, and restrained geometric ornament instead of default browser controls.

Pointy-top geometry is the spatial contract. World details may overlap vertically inside a tile, but interactive centers and borders must never appear to change the underlying axial grid.

## Lighting

Use one soft, consistent upper-left key light:

- top and upper-left edges receive warm desaturated highlights;
- lower/right extruded edges and contact shadows are cool and dark;
- structures share the same light direction as terrain;
- outlines separate forms but do not become thick black stickers;
- combat flashes may briefly break the palette, but important counts and seams stay readable.

Ambient darkness belongs around and beneath the diorama, not over the terrain surface. Bloom and large translucent effects are avoided.

## Palette

The base terrain palette is deliberately muted:

| Surface        | Hex       |
| -------------- | --------- |
| Fertile Meadow | `#7fae62` |
| Muster Ground  | `#b79a72` |
| Plains         | `#9ca56b` |
| Forest         | `#416b4c` |
| Hills          | `#8a806a` |
| Water          | `#315f73` |

The interface uses deep blue-green/charcoal grounds, parchment text, brass-gold focus accents, and sparing red for destructive/error states. Terrain decoration varies value and temperature within its biome instead of introducing unrelated hues.

## Ruler colors and accessibility

Twenty-one curated ruler colors live in `src/shared/balance.ts`. They are applied to:

- a low-alpha ownership wash so terrain remains visible;
- strong borders only where ownership changes;
- flag and banner cloth;
- troop badge trim;
- opposing battle-bar halves;
- scoreboard swatches.

Do not tint entire terrain faces to full saturation. Light parchment text sits on dark count plates rather than directly on ruler colors. Color-pattern assistance overlays a deterministic per-ruler line pattern on eligible ownership regions; patterns supplement color and may not obscure terrain, troops, or borders.

## Terrain construction

All decoration is seed-derived and stable for a map seed.

- Meadows use curved crop rows and, above Low quality, small flower marks.
- Muster Grounds use worn crossing tracks, a stone/rally circle, and a planted marker.
- Plains use sparse grass tufts and stones.
- Forests use layered trunks and conifer clusters, with fewer clusters on Low.
- Hills use overlapping rock faces and a pale cap/highlight.
- Water uses repeated low-alpha wave strokes, reduced on Low.

Terrain must remain identifiable after ownership tint, selection, build eligibility, and garrison labels are layered. Build mode uses a pale gold inset glow on valid tiles and a dark subdued wash on invalid tiles.

## Soldiers and motion

Each moving stack shows a 3–6-member squad assembled from locally authored PixiJS vector geometry: legs, cloak, torso, head/helm, shield, weapon, banner, shadow, and exact-count plate. The squad count varies logarithmically with strength; the numeric badge is authoritative.

Movement principles:

- interpolate between tile centers with smoothstep rule progress;
- ease the visible container toward each fresh 10 Hz target;
- alternate limbs and weapon motion while marching;
- use only a slight facing/lean adjustment so labels do not rotate into illegibility;
- keep lane offsets small and deterministic when stacks share a route;
- never replace movement with a tile-center teleport or sliding static icon.

Stationary garrisons use a compact shield-shaped plate and pin. At distant zoom, non-border counts may hide to protect overview readability; selected and frontier counts remain visible.

## Structures

Structures are hand-authored composite vector forms in `GameRenderer.ts`, not emoji, icon fonts, labeled rectangles, or remote art.

- **Farm:** field/barn/mill language with a rotating ambient component. Warm timber and crop colors distinguish economy.
- **Barracks:** palisade/camp/flag language with a breathing flag animation. Its starting placement marks each spawn center.
- **Turret:** compact defensive tower/weapon silhouette with a slow scan/aim motion.

Construction uses a foundation/scaffold state. Captured completed buildings become visibly damaged/seized at 40% integrity, then repair toward full opacity. Structure silhouettes and state damage must remain legible beneath garrison badges.

## Battle bar layers

The battlefield battle indicator is a designed, camera-anchored PixiJS object with these layers, back to front:

1. dark clipped frame with brass outline;
2. inset dark track;
3. one canonical color/pattern segment per active faction;
4. eased segment boundaries and a subtle delayed reinforcement trail;
5. compact incumbent and Turret-support markers;
6. exact participant counts where space permits;
7. reinforcement halo and temporary `+N` count.

Segment targets are authoritative effective-power shares whose integer widths total exactly 10,000. A late third or fourth faction appears as its own smoothly expanding segment, never as part of a fake coalition. Small segments move detail into hover and the semantic tile inspector rather than rendering illegible labels. This must not be restyled as a generic HTML progress element.

## UI and responsive composition

- Title/setup uses a centered brand, realm cards, compact ledger, and subtle procedural backdrop.
- In-match HUD reserves the top edge for resources/time, the lower edge for command controls, the left for a collapsible standings panel, and the right for recent events.
- Panels use translucent dark surfaces with enough opacity for contrast but do not hide large permanent areas of the map.
- Focus-visible, hover, pressed, selected, disabled, and error states must remain distinct.
- At tablet widths, secondary resource detail and event density reduce before primary controls shrink.
- Touch targets stay large enough to operate; text may collapse to icons only when accessible names remain.

## Animation principles

- Authoritative timing comes from simulation ticks; presentation timing may ease between snapshots.
- Prefer short anticipation, readable action, and quick settle over perpetual motion.
- Use deterministic placement but not synchronized-looking phases across every object.
- Capture transitions expand across one tile for roughly half a second before committing the display owner.
- Limit particles and flashes so troop counts, battle seams, and build eligibility stay visible.
- Reduced decoration at Low quality must not remove essential order, battle, capture, or ownership feedback.

## Editable asset pipeline

The shipped visual sources are repository-owned TypeScript/CSS plus one generated social raster:

- terrain, soldiers, structures, borders, badges, battles, and effects are authored as retained PixiJS vector geometry in `src/client/render/GameRenderer.ts`;
- title, HUD, responsive ornament, and interaction states are authored in `app/globals.css`;
- the social preview key art is the local `public/og.png`; all in-game art remains editable code-native geometry;
- sound cues are synthesized locally with Web Audio in `src/client/audio/AudioDirector.ts`.

There is no remote runtime image, font, or audio dependency. If raster atlases are introduced later, keep the editable vector source, document generation commands, use lossless/reasonable compression, and preserve deterministic asset names.

## Prohibited placeholder patterns

Do not ship:

- flat single-color hexes with no edge/depth/detail;
- circles, triangles, letters, emoji, or static dots standing in for soldiers;
- generic rectangles or text labels standing in for buildings;
- icon-font or unlicensed asset-pack art;
- remote hot-linked images, fonts, or audio;
- inconsistent perspective or light direction;
- full-strength ownership paint that erases terrain;
- unreadable troop counts or color-only battle meaning;
- static sliding units, instant ownership swaps, or plain progress bars;
- excessive glow, particles, camera shake, or effects that cover decisions.

Visual changes are accepted only after running the capture suite and completing the checklist in [VISUAL_QA.md](VISUAL_QA.md).

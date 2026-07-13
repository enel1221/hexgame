# Balance reference

`src/shared/balance.ts` is the source of truth. The tables below translate its integer/fixed-point values into player-facing units. One second is 10 simulation ticks and one Supply is 1,000 milli-Supply.

## Match and map

| Parameter               |              Value | Notes                                                     |
| ----------------------- | -----------------: | --------------------------------------------------------- |
| Starting Supply         |                100 | Per ruler                                                 |
| Starting troops         |         24 (8/8/8) | Equal Melee/Ranged/Wizard composition over the cluster    |
| Starting owned tiles    |                  7 | Connected center plus its six neighbors                   |
| Free starting structure |         1 Barracks | Active, on the center Muster Ground                       |
| Placement padding       |           radius 2 | Footprint/local expansion cannot touch water or an edge   |
| Minimum center distance |            4 hexes | Applies to provisional and locked centers                 |
| Multiplayer placement   |   300 ticks / 30 s | Missing starts are assigned deterministically             |
| AI placement lock       | <=42 ticks / 4.2 s | Relay start floor is 5 s so locked bot centers never move |
| Target land per ruler   |                 30 | Before clamping                                           |
| Minimum playable land   |                128 | Two/three-player floor                                    |
| Maximum playable land   |                630 | Safety cap and current 21-player target                   |
| Supported AI opponents  |               3–20 | 4–21 total rulers in single-player                        |
| Recent event retention  |                 24 | UI/state event ring length                                |
| Autosave interval       |   150 ticks / 15 s | Single-player local snapshot cadence                      |

Generated cell count is chosen so playable land remains 72–82% of all cells. The terrain shares below are per mille of playable land; Plains receive the remainder after the four allocated biomes.

| Terrain        | Configured share |             Defense |                                                   Movement | Build rules                   |
| -------------- | ---------------: | ------------------: | ---------------------------------------------------------: | ----------------------------- |
| Fertile Meadow |       18.0–23.0% |              normal |                            9 ticks / 0.9 s per entered hex | Archery Range or Wizard Tower |
| Muster Ground  |        8.0–12.0% |              normal |                                            9 ticks / 0.9 s | Barracks or Wizard Tower      |
| Plains         |        remainder |              normal |                                            9 ticks / 0.9 s | Wizard Tower                  |
| Forest         |       10.5–14.5% | +12% defender power |                                            9 ticks / 0.9 s | Wizard Tower                  |
| Hills          |        9.5–15.5% | +25% defender power | 115% movement-cost multiplier, rounded to 11 ticks / 1.1 s | Wizard Tower                  |
| Water          |         excluded |                 n/a |                                                 impassable | none                          |

Every archetype carves a deterministic impassable-water seam while preserving the exact land target and one connected traversable landmass. River Gates and Highland Passes use controlled two-tile gates; Shattered Crown uses controlled one-tile gates. A qualifying gate must separate substantial regions, uncontrolled articulation bridges are rejected, and spawn centers remain at least three hexes from a gate. Fairness also requires seven connected owned spawn tiles, the 8/8/8 opening army, two Meadows and one Muster Ground within radius two, at least two open expansion tiles, center distance of at least four, and bounded local-area/neutral-defense variance. A final vector is distance-balanced only when its largest nearest-opponent distance is at most twice its smallest.

## Economy and structures

| Parameter                               |                                    Value |
| --------------------------------------- | ---------------------------------------: |
| Copies of one type per tile             |                                     1–99 |
| Simultaneous pending additions          |                               1 per tile |
| Passive income per ruler                |                             1.0 Supply/s |
| Income per owned land tile              |                            0.05 Supply/s |
| Barracks (Melee) cost / build           |                     70 Supply / 80 ticks |
| Archery Range (Ranged) cost / build     |                     75 Supply / 90 ticks |
| Wizard Tower (Wizard) cost / build      |                    90 Supply / 100 ticks |
| Aggregate training interval             |       25 ticks / 2.5 s at full integrity |
| Output per cycle                        | up to completed count in one typed batch |
| Unit training cost                      |                            1 Supply/unit |
| Local and blocked-rally troop storage   |                                 Uncapped |
| Local typed support                     |     2/copy, capped at 12 per source tile |
| Adjacent typed support                  |      1/copy, capped at 6 per source tile |
| Adjacent support cap                    |         12 per faction in any one battle |
| Construction cancellation refund        |                     65% of one copy cost |
| Captured structure integrity            |                                      40% |
| Captured structure seized/disabled time |                           60 ticks / 6 s |
| Automatic repair time                   |        120 ticks / 12 s from 40% to 100% |

Only active or repairing completed copies are operational. A contested tile pauses pending construction and production. Existing copies continue operating while the next copy constructs. Throughput and support scale with integrity while repairing. Capture destroys the pending copy, seizes every completed copy together at 40% integrity, and clears its rally.

Every producer accumulates one shared integrity-scaled cycle and trains its own type: Barracks train Melee, Archery Ranges train Ranged, and Wizard Towers train Wizards. A valid rally dispatches only the new typed batch; without a valid route, production keeps accumulating locally without a troop cap and a blocked rally retries later. Same-type copies stack to x99, while structure types never mix on one tile.

Local support adds the building's typed virtual power to its home battle. Otherwise, adjacent support is divided deterministically among eligible neighboring battles and capped per source and faction. Support never creates a participant or captures territory by itself; its owner must have at least one real unit in the battle.

Economy settles once each simulation second. A fresh seven-tile ruler earns `1.0 + 7 × 0.05 = 1.35 Supply/s`, replacing the previous Farm-dependent opening economy.

## Movement and dispatch

Dispatch choices are 25%, 50%, 75%, and 100%. Each source contributes `min(total units - 1, floor(total units × percent / 100))`, so every issued source retains at least one real unit. Melee/Ranged/Wizard counts are split with deterministic largest remainders and conserved independently through movement, interruption, arrival, and Multi allocation. Hills use the entered tile's 1.15 movement multiplier. Friendly routes can cross owned land and take one final hostile step; they cannot path through hostile territory or water.

An atomic Multi command accepts at most 64 sources and 16 destinations. It pools every still-eligible source contribution, assigns equal destination quotas (integer remainders in canonical axial order), and solves one deterministic minimum-cost reachable allocation from the pre-mutation state. An infeasible allocation rejects without deductions or stack creation. A due multiplayer command may omit stale sources and replan, but it still executes completely or not at all.

## Combat timing and power

| Parameter                      |                                           Value |
| ------------------------------ | ----------------------------------------------: |
| Per-participant control range  |                                        0–10,000 |
| Initial participant control    |                                           5,000 |
| Presentation-share total       |                                          10,000 |
| Warmup                         |                                 8 ticks / 0.8 s |
| Combat round interval          |                                 2 ticks / 0.2 s |
| Minimum battle duration        |                                35 ticks / 3.5 s |
| Base control change per round  |                               100 control units |
| Advantage contribution         |                         up to 225 control units |
| Reinforcement immediate impact |               20 units per troop, capped at 800 |
| Outgoing pressure per round    | `floor(effective power / 200)` milli-casualties |
| One accumulated casualty       |                          1,000 milli-casualties |

The counter cycle is Wizard > Melee, Ranged > Wizard, and Melee > Ranged. A unit receives 1,500-per-mille power against the type it counters and 1,000 otherwise. Against a mixed or N-faction battle, each type's modifier is weighted against the aggregate hostile composition. Thus equal pure counter armies begin at 60/40 effective power, while identical mixed formations remain equal.

Every faction arriving at an active battle immediately joins or reinforces its canonical participant. A round snapshots exact typed units, incumbent terrain, local building power, and adjacent typed support. Outgoing pressure derives from that faction's RPS-adjusted power and is allocated across hostile faction/type targets with canonical remainder rules. Typed casualties and independent participant-control changes apply simultaneously, so participant or battle array order cannot change the result. The single battle bar normalizes effective-power shares to exactly 10,000 and labels wide-enough faction segments with their weighted `x1.xx` type multiplier; the inspector separately exposes exact composition and typed support.

Two-party fights retain the 8-tick warmup, 2-tick round, and 35-tick minimum. A total-elimination tie chooses the survivor by pre-round effective power, then incumbent ownership, then stable player ID.

## Encirclement

| Parameter                |                      Value |
| ------------------------ | -------------------------: |
| Required closed duration |           150 ticks / 15 s |
| Authoritative takeover   | One transition at tick 150 |

A pocket is one connected component of non-captor playable land whose complete land boundary is owned and uncontested by one captor. Touching water, the shoreline, or a missing map-edge neighbor disqualifies it; a shared-color ring or contested boundary breaches it. Neutral and several hostile colors may share the interior. No ownership changes before completion, and any breach resets progress. Disjoint completions resolve in canonical captor/tile order; before each completion, its exact captor and tile set are revalidated against any earlier same-tick takeover, so a stale nested or overlapping pocket cannot capture territory back. Completed copies are seized, pending copies are destroyed, and normal per-tile/per-copy rewards and elimination checks run independently in canonical order.

## Capture and elimination rewards

| Reward/guard                     |            Value |
| -------------------------------- | ---------------: |
| Neutral tile reward              |         2 Supply |
| Hostile tile base reward         |         5 Supply |
| Captured Barracks bonus / copy   |        +8 Supply |
| Captured Archery Range / copy    |        +8 Supply |
| Captured Wizard Tower / copy     |       +10 Supply |
| Required prior hostile ownership | 200 ticks / 20 s |
| Per-tile reward cooldown         | 450 ticks / 45 s |
| Elimination base bounty          |        50 Supply |
| Defeated Supply transfer         |              25% |
| Transfer cap                     |        50 Supply |
| Maximum elimination payout       |       100 Supply |

Neutral land pays once when first claimed. Hostile rewards retain the prior-ownership guard and tile cooldown to limit deliberate ping-pong farming. A captured structure stack pays its bonus once per completed copy without an aggregate cap. Elimination is credited when the defeated ruler owns no land; their remaining stacks and battle participant are removed, and the eliminator receives the bounty plus the bounded stored-Supply transfer.

## Victory

| Parameter              |                 Value |
| ---------------------- | --------------------: |
| Land-control threshold | 80% of non-water land |
| Continuous hold        |      150 ticks / 15 s |
| Alternate victory      |  Sole surviving ruler |

Dropping below 80% resets the leader and hold counter immediately. Victory stops subsequent simulation ticks. Water never contributes to either the numerator or denominator.

## AI difficulty

Difficulty changes search behavior only; it grants no Supply, troops, combat, construction, or movement bonus.

| Difficulty | Decision interval | Candidate cap | Reserve | Attack power threshold | Default send | Score jitter |
| ---------- | ----------------: | ------------: | ------: | ---------------------: | -----------: | -----------: |
| Easy       |    30 ticks / 3 s |            14 |       2 | 150% of defender power |          50% |         0–80 |
| Normal     |    20 ticks / 2 s |            28 |       2 |                 122.5% |          75% |         0–40 |
| Hard       |    10 ticks / 1 s |            48 |       1 |                 102.5% |          75% |         0–16 |

## Tuning rationale

- Seven starting tiles and an exact 8/8/8 army make every counter choice available without allowing immediate elimination.
- Compact maps and water gates make each tile strategically important while keeping all land connected and every route deterministic.
- Passive plus per-tile income funds all three military producers; neutral and hostile capture rewards keep expansion economically meaningful without a dedicated Farm.
- Typed producers are local logistics: continuous local production is limited economically by per-unit Supply cost, while rally paths move new batches toward the front instead of materializing them globally.
- A 50% counter bonus is large enough to swing the battle bar visibly, but identical or balanced compositions retain neutral power.
- Building support is typed and capped, so a defended gate matters without allowing an x99 stack to contribute unbounded virtual force.
- The 3.5-second resolution floor guarantees visible combat; power-weighted control movement lets mismatches resolve sooner than near-even fights.
- Capture bonuses make developed enemy tiles attractive, while the 20-second ownership requirement and 45-second cooldown damp repeated trades.
- The 80%/15-second victory condition gives every surviving ruler a clear interruption window and avoids wins from a momentary border swing.

When tuning changes, update `src/shared/balance.ts`, the relevant deterministic tests, and this document in the same change.

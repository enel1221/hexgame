# Balance reference

`src/shared/balance.ts` is the source of truth. The tables below translate its integer/fixed-point values into player-facing units. One second is 10 simulation ticks and one Supply is 1,000 milli-Supply.

## Match and map

| Parameter               |              Value | Notes                                                     |
| ----------------------- | -----------------: | --------------------------------------------------------- |
| Starting Supply         |                100 | Per ruler                                                 |
| Starting troops         |                 24 | Deterministically distributed over the starting cluster   |
| Starting owned tiles    |                  7 | Connected center plus its six neighbors                   |
| Free starting structure |         1 Barracks | Active, on the center Muster Ground                       |
| Placement padding       |           radius 2 | Footprint/local expansion cannot touch water or an edge   |
| Minimum center distance |            6 hexes | Applies to provisional and locked centers                 |
| Multiplayer placement   |   300 ticks / 30 s | Missing starts are assigned deterministically             |
| AI placement lock       | <=42 ticks / 4.2 s | Relay start floor is 5 s so locked bot centers never move |
| Target land per ruler   |                 95 | Before clamping                                           |
| Minimum playable land   |                380 | Four-player floor                                         |
| Maximum playable land   |              2,100 | Safety cap; 21 players currently target 1,995             |
| Supported AI opponents  |               3–20 | 4–21 total rulers in single-player                        |
| Recent event retention  |                 24 | UI/state event ring length                                |
| Autosave interval       |   150 ticks / 15 s | Single-player local snapshot cadence                      |

Generated cell count is chosen so playable land remains 72–82% of all cells. The terrain shares below are per mille of playable land; Plains receive the remainder after the four allocated biomes.

| Terrain        | Configured share |             Defense |                                                   Movement | Build rules        |
| -------------- | ---------------: | ------------------: | ---------------------------------------------------------: | ------------------ |
| Fertile Meadow |       18.0–23.0% |              normal |                            9 ticks / 0.9 s per entered hex | Farm or Turret     |
| Muster Ground  |        8.0–12.0% |              normal |                                            9 ticks / 0.9 s | Barracks or Turret |
| Plains         |        remainder |              normal |                                            9 ticks / 0.9 s | Turret             |
| Forest         |       10.5–14.5% | +12% defender power |                                            9 ticks / 0.9 s | Turret             |
| Hills          |        9.5–15.5% | +25% defender power | 115% movement-cost multiplier, rounded to 11 ticks / 1.1 s | Turret             |
| Water          |         excluded |                 n/a |                                                 impassable | none               |

Fairness generation also requires connected land, no one-tile articulation bridge, seven connected owned spawn tiles, 24 starting troops, two Meadows within radius two, one Muster Ground within radius two, at least two open expansion tiles, spawn-center distance of at least six, and bounded local-area/neutral-defense variance. A final vector is distance-balanced only when its largest nearest-opponent distance is at most twice its smallest. Human choices are accepted only when the pure deterministic completion can preserve that rule and the complete map-fairness report.

## Economy and structures

| Parameter                               |                                    Value |
| --------------------------------------- | ---------------------------------------: |
| Copies of one type per tile             |                                     1–99 |
| Simultaneous pending additions          |                               1 per tile |
| Base income per owned land tile         |                           0.035 Supply/s |
| Farm cost per copy                      |                                45 Supply |
| Farm construction per copy              |                           60 ticks / 6 s |
| Active Farm income per copy             |           1.1 Supply/s at full integrity |
| Barracks cost per copy                  |                                70 Supply |
| Barracks construction per copy          |                           80 ticks / 8 s |
| Barracks aggregate training interval    |       25 ticks / 2.5 s at full integrity |
| Barracks output per cycle               | up to completed count in one batch/stack |
| Barracks troop cost                     |                           1 Supply/troop |
| Barracks no-rally local target          |                    40 troops on its tile |
| Turret cost per copy                    |                                90 Supply |
| Turret construction per copy            |                         100 ticks / 10 s |
| Turret virtual defenders per copy       |           3 at full integrity, home only |
| Turret organic-garrison bonus           |      +18% +2%/extra copy, capped at +50% |
| Turret casualty shot                    |     30 full-integrity turret-ticks / 3 s |
| Construction cancellation refund        |                     65% of one copy cost |
| Captured structure integrity            |                                      40% |
| Captured structure seized/disabled time |                           60 ticks / 6 s |
| Automatic repair time                   |        120 ticks / 12 s from 40% to 100% |

Only active or repairing completed copies are operational. A contested tile pauses pending construction and ordinary Farm/Barracks output. Existing completed copies continue operating while the next copy constructs. Farm output, Barracks throughput, Turret virtual defenders, and the organic-garrison bonus scale with shared integrity while repairing. Capture destroys the one pending copy, seizes every completed copy together at 40% integrity, and clears a Barracks rally.

Farm income is `completedCount × 1,100 × integrity / 1,000` milli-Supply per second. Barracks accumulate one shared integrity-scaled production cycle and train `min(completedCount, affordableTroops)` as one batch. A valid rally dispatches only that new batch; a blocked route retains it locally up to the 40-troop cap and automatically retries later.

Turret home power keeps the virtual force outside the percentage multiplier:

```text
integrity factor = integrity / 1,000
virtual = completedCount × 3 × integrity factor
organic bonus = min(50%, 18% + 2% × (completedCount - 1)) × integrity factor
home power = terrain multiplier × (organic troops × (1 + organic bonus) + virtual)
```

Thus one Plains defender with x3 full-integrity Turrets begins at about `1 × 1.22 + 9 = 10.22` troop-equivalents. The one stack accumulator gains `completedCount × integrity` only while it has an eligible own/adjacent battle; each 30,000 accumulated units produces one simultaneous real casualty. An idle stack cannot bank a future volley.

Economy settles once each simulation second. This keeps rates exact without adding fractional carry fields to state. Barracks stop training at the local target, when paused, when contested, or when the owner cannot pay the troop cost.

## Movement and dispatch

Dispatch choices are 25%, 50%, 75%, and 100%. Each source contributes `min(troops - 1, floor(troops * percent / 100))`, so every issued source retains at least one troop. Hills use the entered tile's 1.15 movement multiplier. Friendly routes can cross owned land and take one final hostile step; they cannot path through hostile territory.

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

Every faction arriving at an active battle immediately joins or reinforces its canonical participant. A round snapshots every participant's troops, incumbent/terrain benefit, and supporting Turrets. Each faction's outgoing pressure comes only from its own effective power and is divided among every other participant in proportion to those opponents' pre-round troop counts. Casualties and independent participant-control changes apply simultaneously, so participant-array or battle-array order cannot change the result. The battle bar separately normalizes current effective-power shares to exactly 10,000 with stable remainder assignment.

Two-party fights retain the 8-tick warmup, 2-tick round, and 35-tick minimum. A total-elimination tie chooses the survivor by pre-round effective power, then incumbent ownership, then stable player ID. Turret shots use the same pre-round proportional hostile targeting and can fire only when their owner already has troops in that battle.

## Encirclement

| Parameter                |                      Value |
| ------------------------ | -------------------------: |
| Required closed duration |           150 ticks / 15 s |
| Authoritative takeover   | One transition at tick 150 |

A pocket is one connected component of non-captor playable land whose complete land boundary is owned and uncontested by one captor. Touching water, the shoreline, or a missing map-edge neighbor disqualifies it; a shared-color ring or contested boundary breaches it. Neutral and several hostile colors may share the interior. No ownership changes before completion, and any breach resets progress. Disjoint completions resolve in canonical captor/tile order; before each completion, its exact captor and tile set are revalidated against any earlier same-tick takeover, so a stale nested or overlapping pocket cannot capture territory back. Completed copies are seized, pending copies are destroyed, and normal per-tile/per-copy rewards and elimination checks run independently in canonical order.

## Capture and elimination rewards

| Reward/guard                     |                 Value |
| -------------------------------- | --------------------: |
| Hostile tile base reward         |              3 Supply |
| Captured Farm bonus              |   +6 Supply (9 total) |
| Captured Barracks bonus          | +10 Supply (13 total) |
| Captured Turret bonus            |  +8 Supply (11 total) |
| Required prior hostile ownership |      200 ticks / 20 s |
| Per-tile reward cooldown         |      450 ticks / 45 s |
| Elimination base bounty          |             50 Supply |
| Defeated Supply transfer         |                   25% |
| Transfer cap                     |             50 Supply |
| Maximum elimination payout       |            100 Supply |

Neutral captures do not pay the hostile-capture reward. The prior-ownership guard and tile cooldown limit deliberate ping-pong farming. A captured stack pays its structure bonus once per completed copy without an aggregate cap. Elimination is credited when the defeated ruler owns no land; their remaining stacks and battle participant are removed, and the eliminator receives the bounty plus the bounded stored-Supply transfer.

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

- Seven starting tiles and 24 local troops make an opening order meaningful without allowing immediate player elimination.
- Very small per-tile income rewards expansion while Farms remain the primary economic choice.
- Farms pay back their 45-Supply cost in roughly 41 active seconds before base tile income, making developed territory worth fighting for without instant snowballing.
- Barracks are local logistics: their 40-troop cap and per-troop Supply cost force armies to be moved rather than globally materialized.
- Turrets add three virtual home defenders per copy and a capped organic-garrison bonus. The x3 fixture is about 10.22 initial Plains equivalents and roughly three real shots over three seconds, keeping 10 attackers insufficient while 13–14 remains the intended near-minimum range.
- The 3.5-second resolution floor guarantees visible combat; power-weighted control movement lets mismatches resolve sooner than near-even fights.
- Capture bonuses make developed enemy tiles attractive, while the 20-second ownership requirement and 45-second cooldown damp repeated trades.
- The 80%/15-second victory condition gives every surviving ruler a clear interruption window and avoids wins from a momentary border swing.

When tuning changes, update `src/shared/balance.ts`, the relevant deterministic tests, and this document in the same change.

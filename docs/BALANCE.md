# Balance reference

`src/shared/balance.ts` is the source of truth. The tables below translate its integer/fixed-point values into player-facing units. One second is 10 simulation ticks and one Supply is 1,000 milli-Supply.

## Match and map

| Parameter               |            Value | Notes                                                   |
| ----------------------- | ---------------: | ------------------------------------------------------- |
| Starting Supply         |              100 | Per ruler                                               |
| Starting troops         |               24 | Deterministically distributed over the starting cluster |
| Starting owned tiles    |                7 | Connected center plus its six neighbors                 |
| Free starting structure |       1 Barracks | Active, on the center Muster Ground                     |
| Target land per ruler   |               95 | Before clamping                                         |
| Minimum playable land   |              380 | Four-player floor                                       |
| Maximum playable land   |            2,100 | Safety cap; 21 players currently target 1,995           |
| Supported AI opponents  |             3–20 | 4–21 total rulers in single-player                      |
| Recent event retention  |               24 | UI/state event ring length                              |
| Autosave interval       | 150 ticks / 15 s | Single-player local snapshot cadence                    |

Generated cell count is chosen so playable land remains 72–82% of all cells. The terrain shares below are per mille of playable land; Plains receive the remainder after the four allocated biomes.

| Terrain        | Configured share |             Defense |                                                   Movement | Build rules        |
| -------------- | ---------------: | ------------------: | ---------------------------------------------------------: | ------------------ |
| Fertile Meadow |       18.0–23.0% |              normal |                            9 ticks / 0.9 s per entered hex | Farm or Turret     |
| Muster Ground  |        8.0–12.0% |              normal |                                            9 ticks / 0.9 s | Barracks or Turret |
| Plains         |        remainder |              normal |                                            9 ticks / 0.9 s | Turret             |
| Forest         |       10.5–14.5% | +12% defender power |                                            9 ticks / 0.9 s | Turret             |
| Hills          |        9.5–15.5% | +25% defender power | 115% movement-cost multiplier, rounded to 11 ticks / 1.1 s | Turret             |
| Water          |         excluded |                 n/a |                                                 impassable | none               |

Fairness generation also requires connected land, no one-tile articulation bridge, seven connected owned spawn tiles, 24 starting troops, two Meadows within radius two, one Muster Ground within radius two, at least two open expansion tiles, spawn-center distance of at least six, and bounded local-area/neutral-defense variance.

## Economy and structures

| Parameter                               |                              Value |
| --------------------------------------- | ---------------------------------: |
| Base income per owned land tile         |                     0.035 Supply/s |
| Farm cost                               |                          45 Supply |
| Farm construction                       |                     60 ticks / 6 s |
| Active Farm income                      |     1.1 Supply/s at full integrity |
| Barracks cost                           |                          70 Supply |
| Barracks construction                   |                     80 ticks / 8 s |
| Barracks training interval              | 25 ticks / 2.5 s at full integrity |
| Barracks troop cost                     |                           1 Supply |
| Barracks local target                   |              40 troops on its tile |
| Turret cost                             |                          90 Supply |
| Turret construction                     |                   100 ticks / 10 s |
| Turret virtual defenders                |               12 at full integrity |
| Turret defense multiplier               |             +18% at full integrity |
| Construction cancellation refund        |                        65% of cost |
| Captured structure integrity            |                                40% |
| Captured structure seized/disabled time |                     60 ticks / 6 s |
| Automatic repair time                   |  120 ticks / 12 s from 40% to 100% |

Only active or repairing structures are operational. A contested tile pauses construction, Farm output, and Barracks training. Farm output, Barracks training cadence, Turret virtual defenders, and Turret multiplier scale with integrity while repairing. An unfinished structure is destroyed on capture; a completed one transfers in seized state.

Economy settles once each simulation second. This keeps rates exact without adding fractional carry fields to state. Barracks stop training at the local target, when paused, when contested, or when the owner cannot pay the troop cost.

## Movement and dispatch

Dispatch choices are 25%, 50%, 75%, and 100%. The sent amount is `min(troops - 1, floor(troops * percent / 100))`, so every issued source retains at least one troop. Hills use the entered tile's 1.15 movement multiplier. Friendly routes can cross owned land and take one final hostile step; they cannot path through hostile territory.

## Combat timing and power

| Parameter                      |                                  Value |
| ------------------------------ | -------------------------------------: |
| Battle-control range           |                               0–10,000 |
| Initial control                |                          5,000 (50/50) |
| Warmup                         |                        8 ticks / 0.8 s |
| Combat round interval          |                        2 ticks / 0.2 s |
| Minimum battle duration        |                       35 ticks / 3.5 s |
| Base seam movement per round   |                 100 control units / 1% |
| Advantage contribution         |      up to 225 units / 2.25% per round |
| Reinforcement immediate impact | 20 units per troop, capped at 800 / 8% |
| Defender casualty check        |            Every 20 ticks after warmup |
| Attacker casualty check        |            Every 60 ticks after warmup |

Attacker power is troop count × 1,000. Defender power adds integrity-scaled Turret virtual defenders, applies terrain, then applies the integrity-scaled Turret multiplier. Each combat round moves control toward the stronger side by `100 + floor(225 * relativePowerDifference)`. Exact power ties favor the defender so a battle cannot remain permanently tied. Reaching an endpoint cannot resolve the battle before the 35-tick minimum.

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

Neutral captures do not pay the hostile-capture reward. The prior-ownership guard and tile cooldown limit deliberate ping-pong farming. Elimination is credited when the defeated ruler owns no land; their remaining stacks and attacker-side battles are removed, and the eliminator receives the bounty plus the bounded stored-Supply transfer.

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
- Turrets combine a large fixed defender contribution with a modest multiplier. Integrity scaling and the 90-Supply opportunity cost keep them strong but overwhelmable.
- The 3.5-second resolution floor guarantees visible combat; power-weighted control movement lets mismatches resolve sooner than near-even fights.
- Capture bonuses make developed enemy tiles attractive, while the 20-second ownership requirement and 45-second cooldown damp repeated trades.
- The 80%/15-second victory condition gives every surviving ruler a clear interruption window and avoids wins from a momentary border swing.

When tuning changes, update `src/shared/balance.ts`, the relevant deterministic tests, and this document in the same change.

# Mech Royale bot: project brief (read this first)

Real-time, fault-tolerant autonomous bot for **Mech Royale (Builders Buildathon)**, protocol `mechfight/1`.
Public repo, `https://github.com/bsrikumar855-dot/Mech-Royale.git`. TypeScript, compiled with esbuild, run with plain `node`.

## Mission and scoring

- **Objective:** top of the practice leaderboard (1 vs 15 built-in house bots) AND robust in the finals (16-mech FFA against other teams' bots, unseen seeds).
- **Score** = `mean(16 - place)` over all matches. Placement is the order mechs die; last alive = 1st = 15 points; ties share a place; if the clock (480 s) runs out, survivors rank by HP.
- **Practice: kills are placement** (the 15 house bots hunt us as one squad and never fight each other, so our score = how many of them die before us; ghostHold scored -2.79). **FFA (finals): survival-first** (other mechs kill each other). The FFA policy is gated on `world.lobby` (`src/world/lobby.ts`).
- Baseline to beat: **1.28** (Python starter).
- **Deadlines (IST):** Sat 3:00 PM teammate handoff (parallel split) · Sun 2026-11-22 4:00 PM feature freeze · Sun 7:00 PM final candidate lock · Sun 9:30 PM hard cutoff.
- **Submission cap: 6 per hour.** Scorer builders-4: 96 fresh random seeds per submission; identical code keeps its first score (SE about +-0.4). Changes are decided by the local A/B (below), not the board.
- **Code reuse:** excessive reuse, including another team's entry, may lead to disqualification. Write all bot code ourselves; never copy another team's code into `src/` (ideas are fine).

## Hard constraints (non-negotiable)

| Area | Rule |
| --- | --- |
| Tick | 50 ms wall-clock per decision (server clock from sending `obs` to reading our line). Echo `tick`. Late = dropped. |
| Late/no answer | Mech keeps the *continuous* parts of its last action (`move`, `boost`, `aim`), drops one-shots (`fire`, `jump`, `reload`, `pick`, `take`, `drop`); after `coast_s` = 1.0 s of misses it idles. |
| Crash | Process exit = mech idles for the rest of the match (a sitting target that still scores). **Never crash.** |
| Transport | JSON lines, UTF-8, `\n`-terminated, <= 65536 bytes/line (raw, trailing spaces count). stdout = protocol only. stderr = logs (matches do NOT show stderr; check.py failures show its tail). |
| Sandbox | linux/amd64 Docker, `uid 65534:65534`, no network, 1 CPU, 512 MB (no swap), <= 128 procs/threads, read-only rootfs, writable `/tmp` 64 MB, map read-only at `/arena`. |
| Build | `Dockerfile` at repo root, network ON at build, <= 10 min, pin ALL versions, commit the lockfile. |
| Repo | PUBLIC, <= 20 MB at every submitted commit. `_kit/` is gitignored. |
| Gate | Every commit must pass `_kit/check/check.py` **inside the full sandbox flags** before submission. |

## Local simulator (outside the repo), no match logs

`check.py` replays 300 recorded observations that **do not react to our actions**: it proves protocol compliance and latency, not play quality. Scored matches return no stderr.

Play quality is measured with the public sim-lite simulator, a TEST TOOL kept OUTSIDE the repo (never committed, vendored or imported): `git clone https://github.com/anthonyteti/buildathon-mech-royale ../at-sim`; worktrees `../wt-base` (A) and `../wt-cand` (B); `../at-config.json` = the hello `config` from `_kit/check/stream.jsonl.gz`; `../opponents.json` maps `base`/`cand` to `node dist/index.js` in each worktree. `bash scripts/ab.sh practice <seed>` runs 96 paired practice matches; `bash scripts/ab.sh ffa <seed> 96 <n>` runs FFA (8 seats each). The sim is deterministic (A/A delta 0.00) and scores about 2 below official: trust paired deltas only. On Windows the sim needs `fileURLToPath` instead of `URL.pathname` (local patch). Keep rule and results: `EXPERIMENTS.md` "builders-4: local A/B protocol". Unit tests still cover every behaviour. **Docker is not usable on the dev PC:** the pre-submit gate is `npm run check` + native `python _kit/check/check.py -- node dist/index.js` + `python scripts/bench.py --pin-cpu 0 -- node dist/index.js` (decision p99 < 10 ms).

## Architecture (v3-real)

```
stdin ─► LineSplitter ─► Session ─► Bot.decide ─► sendMessage ─► stdout
                          │            │
                  hello: load /arena,  world.update ─► economy ─► combat ─► locomotion ─► arbiter
                  build index, warm up        (each module is individually fault-isolated)
                  JIT, THEN send ready
```

| Path | Owner | Role |
| --- | --- | --- |
| `src/index.ts` | **A** | stdin/stdout loop, queue skipping, EOF/EPIPE exit. Thin: all logic is in `session.ts`. |
| `src/session.ts`, `src/bot.ts`, `src/warmup.ts`, `src/runtime/*` | **A** | Protocol state machine, per-tick `Deadline`, framed I/O (`sendMessage` is the only stdout writer), bounded stderr logging. |
| `src/types/mechfight.ts` | **A, GENERATED** | From `schema/mechfight.schema.json` via `npm run gen:types`. Never hand-edit. |
| `src/types/contracts.ts` | **A, frozen before 3 PM** | Cross-owner interfaces (`LootTarget`, `MoveConstraint`, `EconomyOutput`, `CombatOutput`, `LocomotionOutput`, `TickContext`). |
| `src/world/` | **A** | `WorldModel` (config, tracks, sounds, damage, zone interpolation) and `MapQuery` (terrain + prisms + trees). |
| `src/locomotion/` | **A** | `WorldModel` + `MapQuery` + `LootTarget[]` -> `{ move, boost, jump }`. |
| `src/arbiter.ts` | **A (single owner)** | Merges the three module outputs into one schema-valid action and enforces every safety invariant. |
| `src/economy/` | **B** | Offer `pick`, weapon `take`/`drop`, and `LootTarget[]`. |
| `src/combat/` | **B** | `aim`, `fire`, `reload`, `moveConstraint`, `hasTarget`, `threatBearing`. |
| `src/config/` | split | `locomotion.ts` + `rules.ts` (A), `combat.ts` + `economy.ts` (B), `index.ts` re-exports. **Zero magic numbers outside `src/config/`; game mechanics are read from `hello.config`, never hardcoded.** |

### Engineering invariants (enforced by tests in `test/`)

1. **Stdout purity:** one writer (`sendMessage` in `runtime/io.ts`, synchronous `writeSync` to fd 1). No `console.log` anywhere (a test scans `src/`). Diagnostics go to stderr behind `MECH_DEBUG=1`; warnings are rate-limited so an unread stderr pipe can never block a tick.
2. **Total fault isolation:** per-module `try/catch` with a neutral output; per-tick `try/catch` in `Session`; a failed tick answers with the **crash fallback**: the last validated finite `move` and `aim` (deep-copied), `boost: false`, and NO one-shots (`fire`/`jump`/`reload`/`pick`/`take`/`drop`), so the mech coasts like the server's own no-answer path; only if no valid action exists yet (first tick) is it the bare `{"tick": N}`. `ready` is sent even if the map fails to load. Malformed lines are skipped. EPIPE/EOF exit 0.
3. **Zero runtime transpilation:** esbuild bundles to a single `dist/index.js` (+ `dist/package.json` `{"type":"module"}`); runtime is `node /bot/dist/index.js` with `NODE_OPTIONS=--max-old-space-size=384`.
4. **Read-only safety:** no filesystem writes anywhere in `src/` (a test scans); the map is read strictly from `hello.map.dir`.
5. **No premature optimization:** no typed-array rewrites of decision loops until profiling shows p99 > `COMPUTE_BUDGET_MS`. (The terrain `Int16Array` is the one native-binary exception.)
6. **Survival first** in every module contract.

### Phase gates

- **Phase 0 (scaffold, commit `bcf9f9a`):** inert stubs, tests, Docker, bench. Done when sandboxed `check.py` passes (NOT yet run: no Docker locally; submit it to the platform to verify the build).
- **Phase 1 (rules, implemented, v1 candidate):** zone survival, kiting, wall feeler, short safe loot detour, gun lead with a slew-tolerance fire gate, lightning-only weapon take, 22-upgrade priority, defensive facing. Submit v1 **twice** (same commit) to measure score noise.
- **Phase 2 (DEFERRED until v1 is scored):** utility grid scoring + hysteresis, advanced combat, weapon-triangle play.
- `best-known-good` git tag advances only after sandboxed `check.py` passes AND the score beats the measured noise threshold.

## Commands

```powershell
npm ci                    # install pinned dev dependencies
npm run check             # typecheck + 131 unit tests + build  (run before every commit)
npm test                  # unit tests only (real-map tests need _kit/arena or ARENA_DIR)
npm run gen:types         # regenerate src/types/mechfight.ts from schema/mechfight.schema.json
npm run bench             # latency bench of dist/index.js (local, unpinned)
bash scripts/sandbox-check.sh   # Docker build + check.py + bench INSIDE the full sandbox flags
python _kit/check/check.py -- node dist/index.js   # kit check without Docker (fast inner loop only)
```


### Phase 1 rules (what v1 actually does; all constants in `src/config/`)

| Module | Rule |
| --- | --- |
| Economy | `pick` = best-ranked offer choice by `ECONOMY.upgradePriority` (all 22 ids ranked, survival/mobility first: armor, plating, nanites, servos, reactor, capacitor, jets, gyros, sensors, then gun, lightning, laser, mortar). `take` ONLY `lightning`, ONLY into an empty slot, within `loot.pickup_radius` (4 m) and 4 m vertically. Mortar (cook-off exposure, no ballistics yet) and laser are skipped. `LootTarget[]` = visible cubes + wanted lightning pickups, value = base / (1 + dist/20). |
| Combat | Target = best visible enemy **mech** with `hasShotLOS` in range (score = dist x (0.5 + hp fraction), lower wins). Drones only within 35 m and only when no enemy mech is visible at all. Aim = linear lead from the real muzzle to centre of mass using the gun's upgraded speed. **Fire only when the ACTUAL slewed aim is within 0.15 rad of the lead aim**, with ammo and not mid-reload. Lightning (any slot): LOS, in range, target inside the 30 deg cone of the actual yaw, energy > 15. Reload when empty, or when no enemy mech has LOS and ammo <= 6. No target -> `hasTarget: false` + `threatBearing` (damage bearing > listed-but-unshootable enemy > last seen enemy > nearest combat sound) so the Arbiter faces the threat. |
| Locomotion | Priority: (1) outside the zone, or outside 85% of the current/`zoneAt(t+10)` radius -> head to the upcoming centre, boost only when actually outside the zone and energy > 20; (2) enemy mech within 40 m while safely inside -> back away with a 0.35 strafe toward the safe side, bent inward if it would leave the safe zone; (3) no enemy mech within 35 m -> walk to the best-value loot target within 25 m (inside the safe zone); (4) otherwise **stand still** (silent). Every heading passes a wall feeler: probe 2 m and 4 m ahead with `MapQuery.isBlockedAt` + slope + map edge, then try +-30, 60, 90, 120 deg. Never jumps in v1. |

Known v1 limits (deliberate): no mortar/laser play, no jump over ledges, no zone-aware pathfinding (the feeler is local), no crate or supply-drop looting, no hysteresis (headings can flip between ticks), fire gate is a fixed angle (not distance-scaled), lead assumes constant target velocity, stands still when nothing is happening.

---

## Protocol & Kit Facts

Verified line by line against `_kit/` (kit contents: `README.md`, `protocol.md`, `mechfight.schema.json`, `python/`, `ts/`, `check/check.py` + `check/stream.jsonl.gz`, `arena/v2/`).

### Lifecycle (protocol.md §2, check.py)

`hello` once -> bot `ready` within `bot.hello_budget_ms` = **20000 ms** (covers container start) -> `obs` every 2 sim ticks (**10 per match-second**, sim = 20 Hz) -> bot answers each with `{tick: N, ...}` within **50 ms** -> `end {place, kills}` -> stdin closes -> exit. **One process per match** (the protocol describes a single hello/end); we still reset on every `hello` and on any tick regression, so reuse would be safe. After our mech dies we get no more `obs`, only `end`. Matches are lock-step; scored matches run faster than real time and a fast bot is never at a disadvantage.

Our init (map load + index + 2 warm-up ticks) takes ~75 ms, so the 20 s window is not a constraint.

### hello.config (recorded values; balance changes between matches, so read them at runtime)

Top-level keys: `match, bot, mech, vision, sound, weapons{gun,mortar,laser,lightning}, projectile, cubes, crates, loot, npc, drops, zone, replay, debug, upgrades[22]`.

- `match`: `tick_hz 20, decide_every 2, duration_s 480, mechs 16, spawn_min_separation 130, spawn_zone_fraction 0.8, arena_margin 30`
- `bot`: `tick_budget_ms 50, hello_budget_ms 20000, coast_s 1, offer_timeout_s 5, max_line_bytes 65536`
- `mech`: `radius 2.5, height 9, eye_height 8, muzzle_height 7, hp 1400, walk_speed 11.7, boost_speed 19.5, ground_accel 58.5, air_accel 12, gravity 22, jump_speed 11, jet_accel 34, max_rise_speed 10, step_up 1.2, max_slope_deg 50, energy 100, energy_regen 18, energy_regen_delay 0.6, boost_drain 17, jet_drain 15, turn_rate 4, pitch_rate 3, min_pitch -0.7, max_pitch 1.3, regen_delay 5, regen_per_s 45, charge_move_mult 0.5, self_damage_mult 0.5, armor 0, rear_mult 1.5, front_arc_deg 180, near_range_bonus 0, vision_bonus 0, hearing 1`
- `vision`: `range 200, fov_deg 120 (yaw wedge, horizontal only), near_range 45, canopy_blocks true, show_enemy_hp true, memory_s 5`
- `sound`: `bearing_noise_deg 7, near 60, mid 160, step_speed 5, step_every 0.6`, ranges `step 40, boost 90, reload 60, gun 320, mortar 420, explosion 420, laser_charge 140, laser 380, lightning 160, jet 90, death 600, crate 220, npc_gun 200, drop 600`
- `weapons`: **gun** `damage 45, cooldown 0.24, speed 252, range 230, spread_deg 0.6, mag 12, reload 2.4` (projectile, no drop) · **mortar** `damage 200, splash 160, splash_radius 7, splash_edge 0.3, cooldown 2.6, speed 72, gravity 22, ttl 7, knock 16, knock_up 9, drain 45` · **laser** `damage 315, charge 0.75, min_charge 0.15, min_frac 0.35, hold_s 2, cooldown 1.65, range 280, pierce 0, charge_turn_mult 1, cookoff 0.6` (hitscan) · **lightning** `damage 60, cooldown 0.25, range 45, cone_deg 30, chain 2, chain_range 14, chain_falloff 0.7, energy 3, short_s 2` (hitscan)
- `projectile`: `gun_radius 0.3, npc_radius 0.3` · `cubes`: `pickup_radius 3.5, hp_per_cube 0.04, damage_per_cube 0.04, stat_cap 10, death_drop_extra 2, size_per_cube 0.05, upgrade_thresholds [1,3,6,10,15,21,28,36,45]` · `crates`: `count 36, roof_fraction 0.25, hp 300, radius 1.4, height 2.4, cubes 1` · `loot`: `pickup_radius 4, equip_s 1, floor_count 40, floor_roof_fraction 0.25, crate_weapon_chance 0.5, death_drop 1, weights {gun 0, mortar 1, laser 1, lightning 1}` · `npc`: `count 12, hp 350, radius 1.8, height 3.5, speed 5, leash 30, chase_leash 60, aggro_range 45, deaggro_range 90, damage 25, cooldown 1, projectile_speed 90, spread_deg 2.5, cubes 2` · `drops`: `times [70,140,210], fall_s 25, radius 8, capture_s 4, cubes 3, repair 1, spread 0.7`
- `zone`: `start_center [41.3,-72.8], start_radius 560`, phases `{hold_s, shrink_s, radius, dps}`: `{60,50,380,20} {45,40,240,35} {35,35,140,60} {30,30,70,100} {25,25,25,160} {15,25,0,260}`
- `debug`: `max_lines 64, max_points 64, max_text 16, max_text_chars 80, max_bytes 8192, max_match_bytes 8000000, hold_s 0.5`
- **`upgrades[]` (22)**, each `{id, name, desc, requires?, max, effects[{path, mul|add}]}`:
  `plating` (+15% max HP, max 3) · `armor` (-8% dmg taken, max 3) · `servos` (+8% walk/boost speed, 3) · `capacitor` (+30 max energy, 3) · `reactor` (+30% energy regen, 3) · `jets` (-25% boost/jet drain, 2) · `nanites` (+60% regen, starts 1.5 s sooner, 2) · `gyros` (+30% turn/pitch rate, 2) · `sensors` (+15 m near range, +25 m vision, halves sound error, 2) · `gun_damage` (+15%, 3) · `gun_rate` (-13% cooldown, 3) · `gun_velocity` (+25% speed, +15% range, 2) · `gun_mag` (+8 rounds, -20% reload, 2) · `mortar_splash` (+30% radius, 2) · `mortar_reload` (-18% cooldown, 3) · `mortar_velocity` (+20% speed, 2) · `laser_charge` (-25% charge time, 2) · `laser_damage` (+18%, 3) · `laser_pierce` (+1 target, 1) · `lightning_chain` (+1 jump, 2) · `lightning_range` (+20% range and cone, 2) · `lightning_efficiency` (-35% energy cost, +10% damage, 2). Weapon upgrades need that weapon held when the offer is drawn; they persist on the mech if the weapon is dropped.

### Offers, cubes, loot (protocol.md §7, §10)

Offer thresholds at cubes 1, 3, 6, 10, 15, 21, 28, 36, 45; `pick` index 0-2; unanswered after `expires` (5 s) applies choice 0. Cubes: +4% max HP and +4% damage each up to 10, and +5% size each **uncapped** (bigger = easier to hit). Killed mechs drop all cubes + 2; drones drop 2; crates 1. Weapons are loot only (start with the gun); `take` within 4 m horizontal / 4 m vertical; both slots full needs `drop`; cannot hold two of a kind; **cannot drop or swap a laser that is charging**; a taken weapon cannot fire for `max(equip_s, cooldown)`. Supply drops are called at 70/140/210 s, land 25 s later, capture = stand alone in the 8 m ring for 4 s (+3 cubes, full HP and energy).

### Observation schema (all required unless noted; `schema/mechfight.schema.json`)

`obs`: `type, tick, t, alive, self, mechs[], projectiles[], crates[], cubes[], pickups[], sounds[], beams[], events[], zone, offer|null, drops[]`.
`self`: `id, pos[3] (FEET), vel[3], aim[yaw,pitch] (ACTUAL slewed), hp, max_hp, energy, max_energy, grounded, cubes, upgrades[], weapons[2] (null = empty slot), in_zone, stats{...mech after upgrades}`; `weapons[i]`: `kind, cooldown, stats`, gun `ammo, reload`, laser `charge`.
`mechs[]`: `id, kind mech|npc, pos, vel, aim`, optional `hp, max_hp, cubes, weapons[], charging` (enemy HP is shown while `vision.show_enemy_hp`).
`zone`: `center, radius, next_center, next_radius, shrink_start, shrink_end, dps` (always known). `drops[]` always known from the moment they are called. Events: `damaged{amount, weapon, bearing|null, by|null, rear?}, hit, effect, drop, kill, pickup, upgrade, took, dropped, take_failed`. Ids: mechs 0-15, NPCs 100+, crates 1000+, cubes 5000+, pickups 8000+, drops 20000+.
Sizes: recorded observations are 1.2-1.8 KB, nowhere near the 64 KiB line cap.

### Action schema

Only `tick` is required. `move[2]` (world frame, length clamped to 1, **default [0,0]**), `boost`, `jump`, `aim[yaw,pitch]` (default = last commanded aim), `fire[2]` (exactly two booleans; held for the next 2 ticks), `reload`, `pick`, `take`, `drop`, `debug`. **Minimal valid action: `{"tick": N}`** (it resets `move` to [0,0], so we only use it before any valid action exists; later crashes replay the last move/aim, see invariant 2).
Coordinates: **x east, y north, z up**, meters/seconds/radians; yaw 0 = east, counter-clockwise; pitch up-positive; direction = `[cos(p)cos(y), cos(p)sin(y), sin(p)]`. Mech = vertical cylinder r 2.5 m, h 9 m; eyes `z+8`, muzzle `z+7`, mortar tube `z+9.5`; shots leave 3.0 m out along the aim.

### Map files (`/arena`, read-only; identical every match; spawns/crates/NPCs/loot/zone/drops are random)

- `v2/terrain.i16`: **raw little-endian int16, NO header**, centimeters, `1070 x 724 = 774,680` samples = **1,549,360 bytes**, row-major, index `j*nx + i` at `x = minX + i*step, y = minY + j*step` with `minX -513, minY -334, step 1 m`; heights span -9.61 m to 49.17 m. Sample bilinearly (`MapQuery.heightAt`).
- `v2/world.json` (300 KB): top keys `version, origin, frame, bounds, rules, terrain, prisms, blocks, stadium, trees, cars, parking, water, barriers, stats`.
  - `bounds`: x -512.38..555.08, y -333.09..388.64. `origin`: lat 40.0005, lon -83.0165. `terrain`: grid descriptor (`file, format, minX, minY, step, nx, ny, scale 0.01`).
  - `prisms[259]` = 223 `building` + 27 `stadium` + 9 `bridge`; each `{kind, block, base, top, ring, holes}`. `ring` is a flat `[x0,y0,x1,y1,...]` **open** polygon (last point does NOT repeat the first; 3-312 points); `holes` is a **list of flat rings** (59 prisms have holes, e.g. courtyards). `base` -8.75..14.13, `top` -0.63..71.49. Of the 9 bridges, 4 are low decks (base about -1.7 to -1.9 m, only 0 to 3.6 m above the terrain beneath, so they act as walls to a 9 m mech) and 5 are elevated (base 6.59, 8.91, 9.65, 14.13, 14.13; headroom 6.4 to 11.4 m above the ground probed beneath each, and only those with at least 9 m can be walked under). Bridges abut buildings, so ground under a bridge is often blocked by the neighbouring wall.
  - `trees`: `fields = [x,y,z,height,crownR,crownBase,trunkR,osm,crownX,crownY]`, **flat** `data` (stride 10; 1560 trees, 15,600 numbers). Trees block **vision only** (trunks stop sight, crowns attenuate it); never shots or movement.
  - `rules`: `maxStep 1.5, maxSlopeDeg 50, canopyDensity 0.35, canopyBlockT 0.25`. Scenery the server ignores: `blocks`(64), `stadium` (drawing only; its solid parts are the 27 `stadium` prisms), `cars`(446, `collide:false`), `parking`(37), `water`(2), `barriers`(185), `stats`.

### How the kit's `ts/mechfight.ts` behaves (and what we kept / changed)

- **Line buffering:** `process.stdin` `data` chunks are appended to a string `buf`; the first chunk schedules `setImmediate(flush)`, so every chunk that arrived while `act()` was running is read before the handler runs. `flush` splits on `\n`, keeps the unterminated tail in `buf`, drops blank lines. Malformed JSON is skipped silently.
- **Queued-obs skipping:** within one batch it remembers only the last `obs` and answers it once. (We replicate this in `Session.handleLines` and test it, including a single multi-line chunk.)
- **Flushing:** `process.stdout.write(JSON.stringify(o) + "\n")`. Fine on Linux pipes (synchronous) but it does not handle EPIPE. We use `fs.writeSync(1, ...)` with EAGAIN retry and exit 0 on EPIPE.
- **Exit:** `end` -> `process.exit(0)` immediately; stdin `end` flushes once but does not force an exit. We exit 0 on both.
- **Crash handling:** if `act()` throws it re-sends the last good `move/aim/boost` (the mech keeps coasting). **We match it except `boost` is forced off** (no energy burn) and one-shots are never repeated; bare `{"tick": N}` only before any valid action.
- `ready` name `String(bot.name).slice(0, 32)`; the kit sends `ready` even when the factory throws (we do too).
- The kit's TS `Dockerfile` runs **bun** (`oven/bun:1.4.4-slim`, `bun /bot/example.ts`), not node; the README says node 22.18+ also runs the `.ts` directly. We compile and run `node dist/index.js` instead. (The prompt names `ts/example_bot.ts`; the file is actually `ts/example.ts`.)

### Schema and check.py edge cases

- The schema never sets `additionalProperties: false` (unknown fields must be ignored) and types `tick`, `pick`, `take`, `drop` as `number`, not `integer`; check.py's validator is a small hand-rolled draft-07 subset (no `additionalProperties: false`, no `$id`), so it will not reject extra action fields. The server may be stricter: stick to the documented fields.
- `Config.match/bot/mech/projectile/crates/npc/replay` are untyped `Record<string, number>`; we read them through `world/rules.ts` with documented fallbacks for missing keys.
- `Config.drops` is optional in the schema ("absent = none"), `vision.memory_s` is optional; both handled. Generated type names for repeated `Vec2` references come out as `Vec2/Vec21/Vec22/...` (structurally identical tuples).
- **check.py semantics:** hello + 300 recorded obs; correctness failures (schema, wrong tick, bad line, bot exit) fail on the **first pass**; only lateness (> 2% of obs over 50 ms) is retried, up to 3 fresh passes, best counts. Every 25th observation three arrive back-to-back and only the answer for the newest counts. Exit more than 2 s after `end` is only a **warning**. Debug drawings over the caps are only a warning (the server truncates silently). `hello.map.dir` is overwritten by `--map-dir`.
- **check.py coverage gaps (it cannot catch these):** the recorded stream never contains an `offer`, `drops`, `pickups`, `beams`, or more than one visible mech, and only `damaged`/`hit` events. The pick/take/drop/laser paths are covered only by our own unit tests. The stream has tick gaps (4, 6, 8, 128) between some observations.
- check.py measures latency from the Python side of a pipe, so it includes harness scheduling, and prints p50/p90/p99/max (not p95).

---

## Benchmark (Step 2): measured 2026-11-21

Harness: `scripts/bench.py` (lock-step, same definition of latency as the server: obs written -> answer read). Machine: AMD Ryzen 7 4800H (8C/16T), Windows 11. **Docker is not installed on this machine**, so the real sandbox flags (`--cpus 1`, cgroup, `docker run` attach overhead, uid 65534, read-only rootfs) were NOT exercised. Proxy: Node **22.23.5** (the exact version the image pins) with the bot process pinned to ONE core (Windows affinity mask). 5 runs x 300 ticks = 1500 ticks.

| Bot | Cold start to `ready` (median) | p50 | p95 | p99 | max | late (>50 ms) |
| --- | --- | --- | --- | --- | --- | --- |
| **Ours** (`node dist/index.js`, Node 22.23.5, pinned 1 core) | **73 ms** (map load + index 8-20 ms, JIT warm-up ~2 ms, rest = Node startup + JSON of the 300 KB map) | **0.23 ms** | **0.37 ms** | **0.88 ms** | 3.73 ms | **0 (0.00%)** |
| Ours, unpinned | 70 ms | 0.22 | 0.40 | 0.65 | 1.07 | 0 |
| Kit TS starter (`node _kit/ts/example.ts`, type-stripped, pinned) | 109 ms | 0.35 | 0.50 | 0.77 | 1.60 | 0 |
| Kit Python starter (pinned) | 133 ms | 0.32 | 0.38 | 0.47 | 0.90 | 0 |

`MapQuery` (real arena, in `npm test`): load + index **8-20 ms**; `hasShotLOS` over 150 m **~9-14 us/call**.

**Phase 1 (real rules) re-measured 2026-11-21**, same harness, Node 22.23.5: pinned to one core `ready` 76 ms, tick p50 0.25 / p95 0.57 / **p99 3.51** / p99.9 5.90 / max 6.08 ms, 0% late; unpinned p50 0.28 / p95 0.54 / p99 0.81 / max 1.34 ms; kit `check.py` PASS 300/300. Synthetic worst case in `npm test` (15 enemies, 80 cubes, 40 pickups, real map): `decide()` p50 0.09 / p99 0.24 / max 1.2 ms. The pinned p99 rose from 0.9 to 3.5 ms versus the empty-bot floor: cold (not yet JIT-compiled) paths in the first ticks of each 300-tick run are the likely cause (unverified); it is still about a tenth of the 34 ms budget.

**COMPUTE_BUDGET_MS = 50 - p99OverheadMs - safetyMarginMs = 50 - 1 - 15 = 34 ms** (`RUNTIME.computeBudgetMs`). The 15 ms safety margin is deliberately large because Docker's own pipe/cgroup overhead is unmeasured. It is a provisional number until `scripts/sandbox-check.sh` is run on a Docker machine.

**Hard-stop gate (>= 25 ms reliable compute, <= 2% late):** passes on the CPU-pinned proxy (34 ms budget, 0% late, no GC/startup stalls above 3.7 ms). **Not yet confirmed in the real 1-CPU sandbox.** Re-run `bash scripts/sandbox-check.sh` and update this table before the first submission.

---

## Open questions

1. ~~Crash fallback stops the mech~~ **Resolved 2026-11-21:** last validated move/aim, boost off, one-shots omitted (see invariant 2).
2. Does `obs.mechs` keep listing a mech for `vision.memory_s` after it leaves view (tracking its real position), or only while visible? `Track.lastListedT` assumes "listed = seen or remembered".
3. Canopy attenuation in `MapQuery.hasVisionLOS` is our interpretation of `canopyDensity` / `canopyBlockT` (optical depth model), unverified against the server. Use it for planning only.
4. `rules.maxStep` (1.5, viewer) vs `config.mech.step_up` (1.2, server): we use `config.mech`.
5. Is the practice leaderboard's 1.15 baseline an average over the same 48 matches? Unknown until the double-submit measures noise.
6. Docker overhead on the scorer (container start, attach pipe latency) is unmeasured; revisit `safetyMarginMs` after `scripts/sandbox-check.sh`.

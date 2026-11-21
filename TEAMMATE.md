# Person B onboarding (3:00 PM handoff)

You own **combat** and **economy**. Person A owns the I/O loop, world model, map, locomotion and the arbiter. We work in parallel and only meet at the interfaces below. Read `CLAUDE.md` first (constraints, protocol facts), then this page.

> **Survival first.** Score is `mean(16 - place)`. Placement counts; kills do not. Never take a risky trade for a kill. The 5 s of safety from facing a threat, or skipping a doomed fight, is worth more than 1 kill.

## What you own

| Path | What |
| --- | --- |
| `src/combat/` | `Combat.decide(ctx) -> CombatOutput` |
| `src/economy/` | `Economy.decide(ctx) -> EconomyOutput` |
| `src/config/combat.ts`, `src/config/economy.ts` | Your tunables. **Zero magic numbers outside `src/config/`.** |
| `test/combat*.test.ts`, `test/economy*.test.ts` | Your tests (create them; add synthetic-state replays). |

**Do not edit** `src/arbiter.ts`, `src/world/`, `src/locomotion/`, `src/session.ts`, `src/runtime/`, `src/types/`, `src/config/locomotion.ts` or `src/config/rules.ts` (Person A). If you need a field or helper, open a short PR/issue to A, or add it behind your own module.

Both modules currently hold **inert stubs** (`StubCombat`, `StubEconomy`). Replace the class body, keep the exported class names (or update `src/bot.ts`'s `stubModules()` in one tiny coordinated PR).

## Exact cross-owner interfaces (`src/types/contracts.ts`, frozen)

```ts
interface TickContext { world: WorldModel; map: MapQuery | null; deadline: Deadline }

// Economy -> Arbiter + Locomotion
interface EconomyOutput { pick?: number; take?: number; drop?: 0 | 1; lootTargets: LootTarget[] }
interface LootTarget { x: number; y: number; z: number; value: number; kind: "cube" | "crate" | "npc" | "weapon" | "supply_drop" }

// Combat -> Arbiter
interface CombatOutput {
  aim: [yaw, pitch]; fire: [boolean, boolean]; reload: boolean
  moveConstraint: "NONE" | "HOLD_POSITION" | "FACE_TARGET"
  hasTarget: boolean          // false => the Arbiter may turn the torso toward threatBearing
  threatBearing?: number      // world-frame yaw toward the main threat (damage bearing / sound)
}
```

- `LootTarget.value` is **your** unit; Locomotion only compares values and distances. Be consistent across kinds.
- `MoveConstraint`: `HOLD_POSITION` zeroes move/boost/jump (use for a mortar lob or a laser that must stay aimed). `FACE_TARGET` leaves the legs free but the torso aim stays yours. `NONE` is the default.
- **`hasTarget: false`** is how you hand the torso to the Arbiter's *defensive facing*: hits from outside the 180 deg front arc deal x1.5, so with nothing to shoot we turn toward `threatBearing`.
- The Arbiter enforces (you cannot override): no `drop`/`take` swap while a laser is charging; move length <= 1; pitch inside `[min_pitch, max_pitch]`; yaw wrapped; `pick` only for a real offer and a valid index; line <= 64 KiB.

## Reading the game state (never hardcode numbers)

Everything comes from `ctx.world` (`WorldModel`): `world.obs` (latest `Observation`), `world.self`, `world.config` (the server's `hello.config`: weapon stats, upgrades, zone...), `world.rules` (resolved mech/vision numbers), `world.tracks` / `enemies()` / `npcs()` (with bounded history), `world.estimateVelocity(track)`, `world.sounds`, `world.damage`, `world.recentThreatBearing(maxAgeS)`, `world.zoneAt(t)`, `world.selfStat(key, fallback)`. Weapon numbers **after our upgrades** are in `self.weapons[i].stats`.

Mechanics you must respect (full rules: `CLAUDE.md` and `_kit/protocol.md` sections 6-8):

- Shots leave along our **actual slewed** `self.aim`, not the aim we command. Torso turn rate is `self.stats.turn_rate` (4 rad/s at base).
- **gun**: projectile, 252 m/s, no drop, 12-round mag then 2.4 s reload. **Lead moving targets** (`track.vel` is the server's value).
- **mortar**: ballistic, gravity 22; `pitch` sets range; your own splash hurts you at 50% and concusses you.
- **laser**: hold the trigger to charge (0.75 s), **release** to fire (hitscan); half speed while charging; everyone sees `charging` and your aim. Never drop/swap it while charging.
- **lightning**: instant, 30 deg cone, 45 m, costs energy even with no target.
- Weapon triangle: laser beats mortar, mortar beats lightning, lightning beats laser; gun is neutral.
- `ctx.map` (`MapQuery`) gives `hasShotLOS(a, b)` (buildings/bridges/terrain stop shots; trees do not), `heightAt`, `roofHeightAt`, `isBlockedAt`, ... It can be `null` if the map failed to load: **degrade, never throw**.

### Time and failure rules

- You have **`ctx.deadline`**: call `ctx.deadline.hasTimeRemaining()` inside any loop that can grow. Total compute budget for a tick is **34 ms** (all modules together); keep yours to a few ms.
- A thrown exception in your module is caught and replaced by a neutral output (the bot still plays), but it is logged and costs you the module's value: tests should make throws impossible.
- **Never** `console.log` (stdout is the protocol; a test fails the build). Debug output: `import { debug } from "../runtime/log.ts"` (stderr, only when `MECH_DEBUG=1`).
- No filesystem writes (read-only rootfs; a test fails the build).

## Git workflow (avoid merge conflicts)

1. `git clone https://github.com/bsrikumar855-dot/Mech-Royale.git`, then unpack the kit: `mkdir _kit; tar -xzf mechfight-kit.tar.gz -C _kit --strip-components=1` (`_kit/` is gitignored; never commit it).
2. Branch per change: `git checkout -b b/combat-gun-lead` (prefix `b/`). Touch only your files.
3. Small commits, one idea each. Before every push: `npm run check` (typecheck + tests + build).
4. Rebase onto `main` before opening a PR: `git fetch origin; git rebase origin/main`. Person A merges; keep PRs under ~300 lines.
5. **Do not merge anything that has not passed the sandboxed check** if it is a submission candidate (below). Tags (`best-known-good`) are moved by Person A only.

## Local test + Docker commands

```powershell
npm ci
npm run check                                   # typecheck, unit tests (incl. real-map tests), build
npm test                                        # just the tests
python _kit/check/check.py -- node dist/index.js    # kit check, no Docker (fast inner loop)
bash scripts/sandbox-check.sh                   # REQUIRED for a submission: Docker build + check.py in the FULL sandbox + latency bench
```

The sandbox command is, spelled out (what `scripts/sandbox-check.sh` runs):

```powershell
docker build --platform linux/amd64 -t mech-royale-bot .
python _kit/check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "${PWD}/_kit/arena:/arena:ro" mech-royale-bot
```

`check.py` replays recorded observations that **do not react to our actions**: it proves we do not crash or stall, not that we play well. Test your logic with synthetic `Observation` fixtures (`test/fixtures/obs.json` has 26 real ones; `test/helpers.ts` has `fixtureHello()` / `fixtureObs()` and a tiny exact synthetic map).

## Phase 1 status (v1 rules are IMPLEMENTED in `src/combat/` and `src/economy/`)

Read the rule tables in `CLAUDE.md` ("Phase 1 rules") and the tests in `test/combat.test.ts` / `test/economy.test.ts` before changing anything: they pin the behaviour (slew gate, lightning-only take, NPC rule, reload rule, threat-bearing priority).

Next, in value order (each one a **separate single-variable submission**, see `EXPERIMENTS.md`):
1. Distance-scaled fire gate (a fixed 0.15 rad wastes shots at range: at 100 m it is a 15 m miss).
2. Crates and supply drops as `LootTarget`s (`obs.drops` is always known; capture needs 4 s alone in the 8 m ring).
3. Laser (hold to charge, release to fire; never drop it while charging) and the weapon triangle.
4. Mortar ballistics (pitch sets range, own splash 50%, concussion) before ever taking one again.
Phase 2 (utility scoring, hysteresis) stays deferred until v1 has a score and the noise is measured.

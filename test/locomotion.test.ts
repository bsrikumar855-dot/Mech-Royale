/**
 * Phase 2 tactical locomotion. Exact cases (crossfire, midpoint, FOV, hysteresis) go through `evaluate` with an
 * injected line-of-sight function; behavioural cases go through `decide` on synthetic maps and the real arena.
 */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LOCOMOTION as L } from "../src/config/index.ts"
import { generateCandidates } from "../src/locomotion/candidates.ts"
import { decideBoost } from "../src/locomotion/energy.ts"
import { makeWalk, TacticalLocomotion } from "../src/locomotion/index.ts"
import { bulletHits, predictMortars } from "../src/locomotion/projectiles.ts"
import { crossfirePenalty, evaluate, hpScale, type ScoreEnv } from "../src/locomotion/score.ts"
import { LocomotionState } from "../src/locomotion/state.ts"
import { fovMult, threatMult, weaponMult, type ThreatRules } from "../src/locomotion/threats.ts"
import type { Candidate, Scored, Threat } from "../src/locomotion/types.ts"
import { buildZone, zoneScore, type ZoneModel } from "../src/locomotion/zone.ts"
import { Deadline, NO_DEADLINE } from "../src/runtime/deadline.ts"
import type { LootTarget } from "../src/types/contracts.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { dist2d, yawTo } from "../src/world/geom.ts"
import { MapQuery, type WorldJson } from "../src/world/map.ts"
import { pointInRing } from "../src/world/polygon.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, enemy, fixtureHello, fixtureObs, HAS_ARENA, realMap } from "./helpers.ts"

// ------------------------------------------------------------------ fixtures

const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1]

/** Flat terrain (z = 0) over +-300 m with the given solid prisms. */
function flatMap(prisms: WorldJson["prisms"] = []): MapQuery {
  const n = 601
  return new MapQuery(
    {
      bounds: { minX: -300, maxX: 300, minY: -300, maxY: 300 },
      terrain: { minX: -300, minY: -300, step: 1, nx: n, ny: n, scale: 0.01 },
      rules: { maxStep: 1.5, maxSlopeDeg: 50, canopyDensity: 0.35, canopyBlockT: 0.25 },
      prisms,
      trees: { fields: [], data: [] },
    },
    new Int16Array(n * n),
  )
}

const OPEN = flatMap()
/** A 20 x 20 m, 20 m tall building at x 10..30, y -10..10. */
const BOX = flatMap([{ kind: "building", base: 0, top: 20, ring: rect(10, -10, 30, 10) }])
/** A 120 m long wall at x 10..14 (a wide building face). */
const WALL = flatMap([{ kind: "building", base: 0, top: 30, ring: rect(10, -60, 14, 60) }])

const setZone = (o: Observation, cx: number, cy: number, r: number, over: Partial<Observation["zone"]> = {}): void => {
  o.zone = { center: [cx, cy], radius: r, next_center: [cx, cy], next_radius: r, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20, ...over }
}

/** A calm scene: us at `pos`, a huge zone centred on us, few mechs alive (no dead-centre bias), full energy. */
function scene(pos: [number, number, number], patch: (o: Observation) => void = () => {}): Observation {
  return cleanObs((o) => {
    o.self.pos = pos
    o.alive = 3
    setZone(o, pos[0], pos[1], 2000)
    patch(o)
  })
}

function decide(map: MapQuery | null, obs: Observation, loot: LootTarget[] = [], loco = new TacticalLocomotion(), world = new WorldModel(fixtureHello())) {
  world.update(obs)
  const out = loco.decide({ world, map, deadline: NO_DEADLINE }, loot)
  return { out, ev: loco.last!, loco, world }
}

const exposedTo = (map: MapQuery, from: [number, number, number], x: number, y: number, z = 0): boolean => map.hasShotLOS([from[0], from[1], from[2] + 7], [x, y, z + 4.5])

// pure-scorer fixtures
const TR: ThreatRules = { nearRange: 45, fovDeg: 120, laserRange: 280, maxThreatRange: 322 }
const calmZone = (): ZoneModel => ({ curC: [0, 0], curR: 1000, nextC: [0, 0], nextR: 1000, safeNextR: 900, urgency: 0, dps: 20, alive: 3, activeC: [0, 0], activeR: 1000 })
const cand = (x: number, y: number, kind: Candidate["kind"] = "ring"): Candidate => ({ x, y, z: 0, dx: x, dy: y, dist: Math.hypot(x, y), kind })
const HOLD = cand(0, 0, "hold")
const threat = (id: number, x: number, y: number, over: Partial<Threat> = {}): Threat => ({
  id, x, y, z: 0, muzzleZ: 7, aimYaw: yawTo(x, y, 0, 0), charging: false, hasLaser: false, hasLightning: false, distToSelf: Math.hypot(x, y), ...over,
})
function env(over: Partial<ScoreEnv> = {}): ScoreEnv {
  return {
    self: { x: 0, y: 0, z: 0, hpFrac: 1 },
    body: { radius: 2.5, height: 9, stepUp: 1.2 },
    threats: [],
    tr: TR,
    los: () => true,
    groundZ: () => 0,
    zone: calmZone(),
    mortars: [],
    bullets: [],
    npcs: [],
    unseenBearings: [],
    loot: null,
    lootNearby: false,
    lastMoveDir: null,
    lastTargetPos: null,
    stuckTangent: null,
    escapeSide: null,
    ...over,
  }
}
const near = (b: readonly number[], x: number, y: number): boolean => Math.hypot((b[0] as number) - x, (b[1] as number) - y) < 0.01
const pick = (ev: { all: Scored[] }, x: number, y: number): Scored => ev.all.find((s) => near([s.c.x, s.c.y], x, y))!

// ------------------------------------------------------------------ candidates

describe("candidate generation", () => {
  test("hold is candidate 0; three rings + goal steps; ~36-45 candidates in the open", () => {
    const w = new WorldModel(fixtureHello())
    w.update(scene([0, 0, 0]))
    const cands = generateCandidates({ x: 0, y: 0, z: 0, walk: makeWalk(OPEN, w, 0, 0, 0, { radius: 2.5, height: 9, stepUp: 1.2 }), goal: [100 * Math.cos(0.26), 100 * Math.sin(0.26)], loot: [10, 10], deadline: NO_DEADLINE })
    assert.equal(cands[0]!.kind, "hold")
    assert.deepEqual([cands[0]!.dx, cands[0]!.dy], [0, 0])
    assert.equal(cands.filter((c) => c.kind === "ring").length, 32)
    assert.equal(cands.filter((c) => c.kind === "goal").length, 2)
    assert.equal(cands.filter((c) => c.kind === "loot").length, 1)
    assert.equal(cands.filter((c) => c.kind === "tangent").length, 0, "no tangents when the goal ray is open")
    assert.ok(cands.length >= 36 && cands.length <= 45, `${cands.length}`)
  })

  test("never offers a spot behind a wall: blocked rays are dropped or clamped to their last walkable point (>= 3 m)", () => {
    const w = new WorldModel(fixtureHello())
    w.update(scene([0, 0, 0]))
    const body = { radius: 2.5, height: 9, stepUp: 1.2 }
    const cands = generateCandidates({ x: 0, y: 0, z: 0, walk: makeWalk(WALL, w, 0, 0, 0, body), goal: null, loot: null, deadline: NO_DEADLINE })
    for (const c of cands) assert.ok(c.x < 10 - 2.5 + 1e-9, `candidate inside/behind the wall at ${c.x},${c.y}`)
    // 0-degree rays: 4.5 m is walkable as is; 11 m and 24 m clamp to the last walkable sample (6 m) and merge
    const east = cands.filter((c) => c.kind === "ring" && Math.abs(c.dy) < 1e-6 && c.dx > 0).map((c) => c.dist).sort((a, b) => a - b)
    assert.deepEqual(east, [4.5, 6])
  })

  test("a blocked goal ray adds wall-tangent slides (+-65, +-105 deg at 6 and 12 m)", () => {
    const w = new WorldModel(fixtureHello())
    w.update(scene([5, 0, 0]))
    const cands = generateCandidates({ x: 5, y: 0, z: 0, walk: makeWalk(WALL, w, 5, 0, 0, { radius: 2.5, height: 9, stepUp: 1.2 }), goal: [40, 0], loot: null, deadline: NO_DEADLINE })
    const tangents = cands.filter((c) => c.kind === "tangent")
    assert.ok(tangents.length >= 4, `${tangents.length} tangents`)
    for (const t of tangents) assert.ok(t.x < 7.5 + 1e-9, "tangents are walkable")
  })

  test("deadline: with no time left only the hold candidate exists", () => {
    const w = new WorldModel(fixtureHello())
    w.update(scene([0, 0, 0]))
    const expired = new Deadline(() => 0, 0, 0)
    const cands = generateCandidates({ x: 0, y: 0, z: 0, walk: makeWalk(OPEN, w, 0, 0, 0, { radius: 2.5, height: 9, stepUp: 1.2 }), goal: [100, 0], loot: null, deadline: expired })
    assert.equal(cands.length, 1)
  })
})

// ------------------------------------------------------------------ cover

describe("3D cover seeking", () => {
  test("exposed next to a building: walks to a spot the enemy cannot shoot, and boosts to get there", () => {
    const foe: [number, number, number] = [-60, 0, 0]
    assert.ok(exposedTo(BOX, foe, 40, 20), "precondition: we start exposed")
    const { out, ev } = decide(BOX, scene([40, 20, 0], (o) => (o.mechs = [enemy(5, foe)])))
    assert.ok(ev.self.exposedCount >= 1)
    assert.equal(ev.best.exposedCount, 0)
    assert.equal(exposedTo(BOX, foe, ev.best.c.x, ev.best.c.y), false, "independent LOS check agrees")
    assert.equal(out.boost, true, "tactical cover boost (energy 100)")
    assert.equal(out.jump, false)
  })

  test("real /arena buildings: from an exposed spot beside a wall, picks a covered candidate whenever one exists", { skip: !HAS_ARENA && "arena not found" }, () => {
    const { map } = realMap()
    let tested = 0
    for (const p of map.prisms) {
      if (tested >= 6) break
      if (p.kind !== "building" || p.holes.length > 0 || p.top - p.base < 12) continue
      const n = p.ring.length / 2
      for (let i = 0; i < n && tested < 6; i++) {
        const j = (i + 1) % n
        const ax = p.ring[2 * i]!, ay = p.ring[2 * i + 1]!, bx = p.ring[2 * j]!, by = p.ring[2 * j + 1]!
        const len = Math.hypot(bx - ax, by - ay)
        if (len < 15) continue
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        let nx = -(by - ay) / len, ny = (bx - ax) / len
        if (pointInRing(mx + nx * 0.5, my + ny * 0.5, p.ring)) { nx = -nx; ny = -ny }
        const sx = mx + nx * 4, sy = my + ny * 4
        const tx = (bx - ax) / len, ty = (by - ay) / len
        // enemy 70 m out along the wall line, diagonally away from it: it sees us, but the wall shadows the far side
        const ex = sx + (tx * 0.8 + nx * 0.6) * 70, ey = sy + (ty * 0.8 + ny * 0.6) * 70
        const sz = map.heightAt(sx, sy), ez = map.heightAt(ex, ey)
        if (!map.hasShotLOS([ex, ey, ez + 7], [sx, sy, sz + 4.5])) continue
        const obs = scene([sx, sy, sz], (o) => (o.mechs = [enemy(5, [ex, ey, ez], { aim: [yawTo(ex, ey, sx, sy), 0] })]))
        const { ev } = decide(map, obs)
        if (!ev.all.some((s) => s.exposedCount === 0)) continue // no reachable cover from this probe
        assert.equal(ev.best.exposedCount, 0, `prism top ${p.top}: had cover available but stayed exposed`)
        tested++
      }
    }
    assert.ok(tested >= 3, `only ${tested} real cover scenarios were usable`)
  })

  test("crossfire: strictly prefers a spot seen by 1 enemy over spots seen by 2", () => {
    const A = threat(1, -80, 0)
    const B = threat(2, 0, 80)
    const hidden = (a: readonly number[], b: readonly number[]): boolean => a[0] === -80 && near(b, 11, 0)
    const ev = evaluate(env({ threats: [A, B], los: (a, b) => !hidden(a, b) }), [HOLD, cand(0, -11), cand(11, 0)], NO_DEADLINE)
    assert.equal(ev.self.exposedCount, 2)
    assert.deepEqual([ev.best.c.x, ev.best.c.y], [11, 0])
    assert.equal(ev.best.exposedCount, 1)
  })

  test("crossfire penalty is super-linear in the number of enemies that see the spot", () => {
    assert.equal(crossfirePenalty(0), 0)
    assert.equal(crossfirePenalty(1), 0)
    assert.ok(crossfirePenalty(2) > 0)
    assert.ok(crossfirePenalty(3) > 2 * crossfirePenalty(2))
  })

  test("midpoint anti-suicide: prefers near cover over far cover whose path crosses open fire, even against hysteresis", () => {
    const A = threat(1, -80, 0)
    // N (0,11) and its midpoint (0,5.5) are hidden; F (0,-24) is hidden but its midpoint (0,-12) is in the open.
    const covered = [[0, 11], [0, 5.5], [0, -24]] as const
    const los = (_a: readonly number[], b: readonly number[]): boolean => !covered.some(([x, y]) => near(b, x, y))
    const base = { threats: [A], los, lastMoveDir: [0, -1] as [number, number] } // inertia favours the far one
    const ev = evaluate(env(base), [HOLD, cand(0, 11), cand(0, -24)], NO_DEADLINE)
    const N = pick(ev, 0, 11)
    const F = pick(ev, 0, -24)
    assert.equal(N.exposedCount, 0)
    assert.equal(F.exposedCount, 0)
    assert.ok(N.terms["midpoint"] === 0) // may be -0
    assert.ok(F.terms["midpoint"]! < 0)
    assert.deepEqual([ev.best.c.x, ev.best.c.y], [0, 11])
    // control: without the midpoint exposure the far spot would win (hysteresis), so the check is what decides it
    const ev2 = evaluate(env({ ...base, los: (_a, b) => !(covered.some(([x, y]) => near(b, x, y)) || near(b, 0, -12)) }), [HOLD, cand(0, 11), cand(0, -24)], NO_DEADLINE)
    assert.deepEqual([ev2.best.c.x, ev2.best.c.y], [0, -24])
  })

  test("low HP scales every exposure term up (1x at 75% HP, 2.5x at 30%)", () => {
    assert.equal(hpScale(1), 1)
    assert.equal(hpScale(0.75), 1)
    assert.ok(Math.abs(hpScale(0.3) - 2.5) < 1e-9)
    assert.ok(hpScale(0.5) > 1 && hpScale(0.5) < 2.5)
    const A = threat(1, -80, 0)
    const healthy = evaluate(env({ threats: [A] }), [HOLD], NO_DEADLINE).self.terms["cover"]!
    const hurt = evaluate(env({ threats: [A], self: { x: 0, y: 0, z: 0, hpFrac: 0.3 } }), [HOLD], NO_DEADLINE).self.terms["cover"]!
    assert.ok(hurt < healthy * 2.4)
  })

  test("regen discipline: wounded in the zone, every exposure costs extra", () => {
    const A = threat(1, -80, 0)
    const ev = evaluate(env({ threats: [A], self: { x: 0, y: 0, z: 0, hpFrac: 0.8 } }), [HOLD], NO_DEADLINE)
    assert.ok(ev.self.terms["regen"]! < 0)
    assert.equal(evaluate(env({ threats: [A] }), [HOLD], NO_DEADLINE).self.terms["regen"], 0)
  })
})

describe("enemy field of view and weapon danger", () => {
  const e = threat(1, 0, 0, { aimYaw: 0 }) // at the origin, torso facing east

  test("an enemy facing a spot is a bigger threat than one at the same distance facing 180 deg away (beyond 45 m)", () => {
    assert.equal(fovMult(e, 100, 0, TR), 1)
    assert.equal(fovMult(e, -100, 0, TR), L.fovDiscount)
    assert.ok(Math.abs(threatMult(e, -100, 0, TR) / threatMult(e, 100, 0, TR) - L.fovDiscount) < 1e-9)
  })
  test("inside near_range (45 m) every direction is full threat (proximity sensors)", () => {
    assert.equal(fovMult(e, -30, 0, TR), 1)
  })
  test("the fov wedge is 120 deg wide (60 deg each side of the aim)", () => {
    assert.equal(fovMult(e, 100 * Math.cos(1.0), 100 * Math.sin(1.0), TR), 1) // 57 deg
    assert.equal(fovMult(e, 100 * Math.cos(1.1), 100 * Math.sin(1.1), TR), L.fovDiscount) // 63 deg
  })
  test("weapon multipliers: charging laser > lightning up close > laser in range > gun", () => {
    assert.equal(weaponMult({ ...e, charging: true }, 200, TR), L.laserChargeMult)
    assert.equal(weaponMult({ ...e, hasLightning: true }, 40, TR), L.lightningMult)
    assert.equal(weaponMult({ ...e, hasLightning: true }, 60, TR), 1)
    assert.equal(weaponMult({ ...e, hasLaser: true }, 200, TR), L.laserHoldMult)
    assert.equal(weaponMult({ ...e, hasLaser: true }, 300, TR), 1)
    assert.equal(weaponMult(e, 10, TR), 1)
  })
})

// ------------------------------------------------------------------ emergencies

describe("laser-charge emergency dodge", () => {
  test("a charging laser drops all hysteresis, breaks line of sight and boosts even at low energy", () => {
    const loco = new TacticalLocomotion()
    const world = new WorldModel(fixtureHello())
    const foe: [number, number, number] = [-60, 0, 0]
    const calm = decide(BOX, scene([40, 20, 0], (o) => { o.self.energy = 20; o.mechs = [enemy(5, foe)] }), [], loco, world)
    assert.equal(calm.out.boost, false, "energy 20 is below the tactical boost start (35)")
    assert.ok(loco.state.lastMoveDir !== null, "precondition: we have inertia")
    const hot = decide(BOX, scene([40, 20, 0], (o) => { o.tick = 202; o.t = 10.1; o.self.energy = 20; o.mechs = [enemy(5, foe, { charging: true })] }), [], loco, world)
    assert.equal(hot.ev.emergency, true)
    assert.ok(hot.ev.self.chargingExposed > 0)
    for (const s of hot.ev.all) assert.equal(s.terms["hysteresis"], 0)
    assert.equal(hot.ev.best.exposedCount, 0)
    assert.equal(hot.out.boost, true, "emergency boost allowed down to 8 energy")
  })
})

describe("ballistic mortar dodge", () => {
  const phys = { gravity: 22, splashRadius: 7, ttl: 7 }

  test("predicts the landing point of an arcing shell", () => {
    const obs = scene([0, 0, 0], (o) => (o.projectiles = [{ id: 1, kind: "mortar", pos: [0, 0, 10], vel: [20, 0, 10] }]))
    const [m] = predictMortars(obs, phys, 2.5, (_x, _y, z) => z <= 0)
    // z(t) = 10 + 10t - 11t^2 = 0 -> t = 1.511 s -> x = 30.2 m
    assert.ok(m && Math.abs(m.x - 30.2) < 2.5 && Math.abs(m.y) < 1e-9, `impact ${m?.x}`)
    assert.equal(m.radius, 7 + 2.5 + L.mortarMarginM)
  })

  test("ignores shells that land beyond the horizon, and non-mortar projectiles", () => {
    const obs = scene([0, 0, 0], (o) => (o.projectiles = [{ id: 1, kind: "mortar", pos: [0, 0, 500], vel: [0, 0, 0] }, { id: 2, kind: "gun", pos: [0, 0, 1], vel: [100, 0, 0] }]))
    assert.equal(predictMortars(obs, phys, 2.5, (_x, _y, z) => z <= 0).length, 0)
  })

  test("a shell about to land on us: leaves the splash zone (overriding the silent hold) and boosts", () => {
    const { out, ev } = decide(OPEN, scene([0, 0, 0], (o) => (o.projectiles = [{ id: 1, kind: "mortar", pos: [0, 0, 20], vel: [0, 0, 0] }])))
    assert.equal(ev.selfInSplash, true)
    assert.equal(ev.best.inSplash, false)
    assert.ok(Math.hypot(out.move[0], out.move[1]) > 0.99)
    assert.equal(out.boost, true)
  })
})

describe("bullet corridors", () => {
  test("a spot in the bullet's path over the next 0.4 s is hit; one to the side is not", () => {
    const b = { ax: 0, ay: 0, az: 5, bx: 100, by: 0, bz: 5 }
    assert.equal(bulletHits(b, 50, 0, 0, 9, 3.5), true)
    assert.equal(bulletHits(b, 50, 6, 0, 9, 3.5), false)
    assert.equal(bulletHits(b, 150, 0, 0, 9, 3.5), false, "beyond the horizon")
    assert.equal(bulletHits(b, 50, 0, 20, 9, 3.5), false, "passes under a mech standing on a roof")
  })
  test("the scorer penalises standing in the corridor, which favours a perpendicular step", () => {
    const ev = evaluate(env({ bullets: [{ ax: -50, ay: 0, az: 4.5, bx: 50, by: 0, bz: 4.5 }] }), [HOLD, cand(11, 0), cand(0, 11)], NO_DEADLINE)
    assert.ok(ev.self.terms["bullets"]! < 0)
    assert.ok(pick(ev, 11, 0).terms["bullets"]! < 0)
    assert.equal(pick(ev, 0, 11).terms["bullets"], 0)
    assert.deepEqual([ev.best.c.x, ev.best.c.y], [0, 11])
  })
})

// ------------------------------------------------------------------ zone

describe("zone: rim hugging and shrink timing", () => {
  const z = (alive: number): ZoneModel => ({ ...calmZone(), curR: 100, activeR: 100, nextR: 100, safeNextR: 90, alive })

  test("plateau on the rim band, penalty at the dead centre (crowded) and beyond 85%", () => {
    assert.equal(zoneScore(z(10), 60, 0), 0)
    assert.equal(zoneScore(z(10), 40, 0), 0)
    assert.ok(zoneScore(z(10), 0, 0) < 0, "dead centre with 10 alive")
    assert.equal(zoneScore(z(3), 0, 0), 0, "endgame: the centre is fine")
    assert.ok(zoneScore(z(10), 95, 0) < 0)
    assert.ok(zoneScore(z(10), 120, 0) < zoneScore(z(10), 95, 0) - L.outsideCliff, "outside is a cliff")
  })

  test("outside the zone: sprints inward with an emergency boost; no boost at 5 energy", () => {
    const go = decide(OPEN, scene([200, 0, 0], (o) => { setZone(o, 0, 0, 100); o.self.in_zone = false; o.self.energy = 50 }))
    assert.ok(go.out.move[0] < -0.9, `${go.out.move}`)
    assert.equal(go.out.boost, true)
    const tired = decide(OPEN, scene([200, 0, 0], (o) => { setZone(o, 0, 0, 100); o.self.in_zone = false; o.self.energy = 5 }))
    assert.ok(tired.out.move[0] < -0.9)
    assert.equal(tired.out.boost, false)
  })

  test("hugs the rim: on the band it holds still; past 85% it steps inward; it never marches to the centre", () => {
    const band = decide(OPEN, scene([70, 0, 0], (o) => { setZone(o, 0, 0, 100); o.alive = 10 }))
    assert.deepEqual(band.out.move, [0, 0])
    const rim = decide(OPEN, scene([95, 0, 0], (o) => { setZone(o, 0, 0, 100); o.alive = 10 }))
    assert.ok(rim.out.move[0] < -0.5)
    assert.equal(rim.out.boost, false)
    const mid = decide(OPEN, scene([45, 0, 0], (o) => { setZone(o, 0, 0, 100); o.alive = 10 }))
    assert.deepEqual(mid.out.move, [0, 0])
  })

  test("leaves early enough to beat a closing shrink, and not earlier than needed", () => {
    const shrink = (endIn: number) => (o: Observation): void => {
      o.t = 10
      setZone(o, 0, 0, 600, { next_center: [300, 0], next_radius: 100, shrink_start: 1e6, shrink_end: 10 + endIn })
    }
    const w = new WorldModel(fixtureHello())
    w.update(scene([0, 0, 0], shrink(40)))
    const zone = buildZone(w, 0, 0, 11.7)
    assert.ok(zone.urgency > 0, "210 m to walk at 11.7 m/s (~18 s) + 8 s buffer is close to 40 s left")
    const soon = decide(OPEN, scene([0, 0, 0], shrink(40)))
    assert.ok(soon.out.move[0] > 0.9, `${soon.out.move}`)
    const later = decide(OPEN, scene([0, 0, 0], shrink(200)))
    assert.deepEqual(later.out.move, [0, 0], "plenty of time: stay quiet")
  })
})

// ------------------------------------------------------------------ walls and stuck

describe("wide walls and the anti-stuck detector", () => {
  test("a 120 m wall between us and the zone: slides along it (no walking into it, no side flipping)", () => {
    const loco = new TacticalLocomotion()
    const world = new WorldModel(fixtureHello())
    let pos: [number, number, number] = [5, 0, 0]
    let side = 0
    for (let k = 0; k < 6; k++) {
      const { out, ev } = decide(WALL, scene(pos, (o) => {
        o.tick = 200 + 2 * k
        o.t = 10 + 0.1 * k
        setZone(o, 60, 0, 40)
        o.self.in_zone = false
        o.self.energy = 50
      }), [], loco, world)
      assert.ok(Math.hypot(out.move[0], out.move[1]) > 0.99, "keeps moving")
      assert.ok(out.move[0] < 0.5, `tick ${k}: not into the wall (${out.move})`)
      const walk = makeWalk(WALL, world, pos[0], pos[1], 0, { radius: 2.5, height: 9, stepUp: 1.2 })
      assert.ok(walk(out.move[0], out.move[1], [3]).reach >= 3, "the chosen heading is walkable")
      if (k === 0) assert.ok(ev.all.some((s) => s.c.kind === "tangent"))
      const s = Math.sign(out.move[1])
      if (side === 0) side = s
      assert.equal(s, side, `tick ${k}: flipped sides`)
      pos = [pos[0] + out.move[0] * 2, pos[1] + out.move[1] * 2, 0]
    }
  })

  test("real /arena: with the zone behind a big building, the first step is walkable and not into the wall", { skip: !HAS_ARENA && "arena not found" }, () => {
    const { map } = realMap()
    let tested = 0
    for (const p of map.prisms) {
      if (tested >= 3) break
      if (p.kind !== "building" || p.holes.length > 0 || p.maxX - p.minX < 40 || p.maxY - p.minY < 25) continue
      const cy = (p.minY + p.maxY) / 2
      const sx = p.minX - 4
      if (!pointInRing(p.minX + 1, cy, p.ring)) continue // the west face is not at minX here
      const sz = map.heightAt(sx, cy)
      const w = new WorldModel(fixtureHello())
      const loco = new TacticalLocomotion()
      const obs = scene([sx, cy, sz], (o) => { setZone(o, p.maxX + 60, cy, 50); o.self.in_zone = false })
      const { out } = decide(map, obs, [], loco, w)
      if (Math.hypot(out.move[0], out.move[1]) < 0.5) continue // boxed in by neighbours: not this test's case
      const walk = makeWalk(map, w, sx, cy, sz, { radius: 2.5, height: 9, stepUp: 1.2 })
      assert.ok(walk(out.move[0], out.move[1], [3]).reach >= 3, "walkable")
      assert.ok(out.move[0] < 0.9, "not straight into the building")
      tested++
    }
    assert.ok(tested >= 1, "no usable big building probe")
  })

  test("stuck detector: commanded to move for 1.5 s without displacement -> a tangent bias for 1.5 s; reset() clears it", () => {
    const st = new LocomotionState()
    const w = new WorldModel(fixtureHello())
    for (let i = 0; i <= 20; i++) {
      w.update(scene([0, 0, 0], (o) => { o.tick = 200 + 2 * i; o.t = 10 + 0.1 * i }))
      st.sync(w)
      if (i === 20) break
      st.remember(w, [1, 0], [10, 0])
    }
    const bias = st.stuckBias(w.t)
    assert.ok(bias, "stuck detected")
    assert.ok(Math.abs(bias![0]) < 1e-9 && Math.abs(Math.abs(bias![1]) - 1) < 1e-9, "tangent to the blocked heading")
    st.reset()
    assert.equal(st.stuckBias(w.t), null)
    assert.equal(st.lastMoveDir, null)
  })

  test("no false stuck while holding still or while actually moving", () => {
    const st = new LocomotionState()
    const w = new WorldModel(fixtureHello())
    for (let i = 0; i <= 20; i++) {
      w.update(scene([i * 1.0, 0, 0], (o) => { o.tick = 200 + 2 * i; o.t = 10 + 0.1 * i }))
      st.sync(w)
      st.remember(w, [1, 0], [i + 10, 0])
    }
    assert.equal(st.stuckBias(w.t), null, "moving 1 m per decision is not stuck")
  })
})

// ------------------------------------------------------------------ spacing, unseen, loot

describe("spacing, drones, unseen threats and safe loot", () => {
  test("repelled by a close enemy mech, more when it holds lightning", () => {
    const plain = evaluate(env({ threats: [threat(1, 20, 0)] }), [HOLD, cand(-11, 0)], NO_DEADLINE)
    assert.ok(pick(plain, -11, 0).terms["spacing"]! > plain.self.terms["spacing"]!)
    const zap = evaluate(env({ threats: [threat(1, 20, 0, { hasLightning: true })] }), [HOLD], NO_DEADLINE)
    assert.ok(zap.self.terms["spacing"]! < plain.self.terms["spacing"]!)
  })
  test("drones only repel when we are below 80% HP", () => {
    const npcs = [{ x: 20, y: 0 }]
    assert.equal(evaluate(env({ npcs }), [HOLD], NO_DEADLINE).self.terms["spacing"], 0)
    assert.ok(evaluate(env({ npcs, self: { x: 0, y: 0, z: 0, hpFrac: 0.7 } }), [HOLD], NO_DEADLINE).self.terms["spacing"]! < 0)
  })
  test("wounded: avoids walking TOWARD unseen gunfire", () => {
    const ev = evaluate(env({ unseenBearings: [0], self: { x: 0, y: 0, z: 0, hpFrac: 0.6 } }), [HOLD, cand(11, 0), cand(-11, 0)], NO_DEADLINE)
    assert.ok(pick(ev, 11, 0).terms["unseen"]! < 0)
    assert.equal(pick(ev, -11, 0).terms["unseen"], 0)
    const healthy = evaluate(env({ unseenBearings: [0] }), [HOLD, cand(11, 0)], NO_DEADLINE)
    assert.equal(pick(healthy, 11, 0).terms["unseen"], 0, "healthy and unseen: no caution term")
  })
  test("loot only pulls when the spot is safe, unexposed and we are above 45% HP", () => {
    const loot = { x: 20, y: 0, value: 10 }
    const ok = evaluate(env({ loot, lootNearby: true }), [HOLD, cand(11, 0)], NO_DEADLINE)
    assert.ok(pick(ok, 11, 0).terms["loot"]! > 0)
    assert.deepEqual([ok.best.c.x, ok.best.c.y], [11, 0])
    const exposed = evaluate(env({ loot, threats: [threat(1, -80, 0)] }), [HOLD, cand(11, 0)], NO_DEADLINE)
    assert.equal(pick(exposed, 11, 0).terms["loot"], 0)
    const weak = evaluate(env({ loot, self: { x: 0, y: 0, z: 0, hpFrac: 0.4 } }), [HOLD, cand(11, 0)], NO_DEADLINE)
    assert.equal(pick(weak, 11, 0).terms["loot"], 0)
  })
  test("decide(): walks to a nearby cube from Economy when it is safe", () => {
    const { out } = decide(OPEN, scene([0, 0, 0]), [{ x: 20, y: 0, z: 0, value: 8, kind: "cube" }])
    assert.ok(out.move[0] > 0.9)
  })
})

// ------------------------------------------------------------------ hysteresis, hold, reset

describe("hysteresis, silent hold and reset", () => {
  test("symmetric candidates: inertia decides, and it flips with the last heading", () => {
    const c = [HOLD, cand(0, 11), cand(0, -11)]
    const lean = { lootNearby: true } // switches the silent-hold bonus off, so inertia is the only difference
    assert.deepEqual([evaluate(env({ ...lean, lastMoveDir: [0, 1] }), c, NO_DEADLINE).best.c.y], [11])
    assert.deepEqual([evaluate(env({ ...lean, lastMoveDir: [0, -1] }), c, NO_DEADLINE).best.c.y], [-11])
  })

  test("safe in cover with nothing going on: holds [0,0] silently tick after tick (hold bonus), no boost", () => {
    const loco = new TacticalLocomotion()
    const world = new WorldModel(fixtureHello())
    for (let k = 0; k < 3; k++) {
      const { out, ev } = decide(OPEN, scene([0, 0, 0], (o) => { o.tick = 200 + 2 * k; o.t = 10 + 0.1 * k }), [], loco, world)
      assert.deepEqual(out.move, [0, 0])
      assert.equal(out.boost, false)
      assert.equal(ev.best.terms["hold"], L.holdBonus)
    }
  })

  test("a world reset (new match) clears all locomotion memory", () => {
    const loco = new TacticalLocomotion()
    const world = new WorldModel(fixtureHello())
    decide(OPEN, scene([200, 0, 0], (o) => { setZone(o, 0, 0, 100); o.self.in_zone = false }), [], loco, world)
    assert.ok(loco.state.lastMoveDir)
    world.reset()
    const { ev } = decide(OPEN, scene([0, 0, 0], (o) => { o.tick = 0; o.t = 0 }), [], loco, world)
    for (const s of ev.all) assert.equal(s.terms["hysteresis"], 0)
    assert.equal(loco.state.isBoosting, false)
  })

  test("a backwards tick also resets", () => {
    const loco = new TacticalLocomotion()
    const world = new WorldModel(fixtureHello())
    decide(OPEN, scene([200, 0, 0], (o) => { setZone(o, 0, 0, 100); o.self.in_zone = false }), [], loco, world)
    const before = loco.state.epoch
    decide(OPEN, scene([200, 0, 0], (o) => { o.tick = 2; setZone(o, 0, 0, 100) }), [], loco, world)
    assert.ok(loco.state.epoch !== before || loco.state.history.length === 1)
  })
})

// ------------------------------------------------------------------ boost latch

describe("boost energy hysteresis", () => {
  const sc = (dist: number, exposedCount: number, extra: Partial<Scored> = {}): Scored => ({
    c: cand(dist, 0), score: 0, exposedCount, exposure: exposedCount, chargingExposed: 0, midExposed: 0, inSplash: false, terms: {}, ...extra,
  })
  const toCover = (energy: number, latch: { isBoosting: boolean }): boolean =>
    decideBoost({ best: sc(11, 0), self: sc(0, 1), outsideZone: false, selfInSplash: false, energy, nearest: null }, latch)

  test("tactical boost starts only at >= 35 energy, then holds down to 18 (no tapping)", () => {
    const latch = { isBoosting: false }
    assert.equal(toCover(30, latch), false, "30 < start")
    assert.equal(toCover(40, latch), true)
    assert.equal(toCover(25, latch), true, "latched: holds above 18")
    assert.equal(toCover(17, latch), false, "drops below hold")
    assert.equal(toCover(25, latch), false, "and does not restart until 35")
  })
  test("no reason to boost -> no boost, so energy refills", () => {
    const latch = { isBoosting: false }
    assert.equal(decideBoost({ best: sc(11, 0), self: sc(0, 0), outsideZone: false, selfInSplash: false, energy: 100, nearest: null }, latch), false)
    assert.equal(decideBoost({ best: sc(0, 0), self: sc(0, 1), outsideZone: true, selfInSplash: false, energy: 100, nearest: null }, latch), false, "holding: never boost")
  })
  test("emergencies boost down to 8 energy: outside the zone, leaving a charging laser, leaving a mortar splash", () => {
    const latch = { isBoosting: false }
    assert.equal(decideBoost({ best: sc(11, 0), self: sc(0, 0), outsideZone: true, selfInSplash: false, energy: 9, nearest: null }, latch), true)
    assert.equal(decideBoost({ best: sc(11, 0), self: sc(0, 1, { chargingExposed: 1 }), outsideZone: false, selfInSplash: false, energy: 9, nearest: null }, latch), true)
    assert.equal(decideBoost({ best: sc(11, 0), self: sc(0, 0), outsideZone: false, selfInSplash: true, energy: 9, nearest: null }, latch), true)
    assert.equal(decideBoost({ best: sc(11, 0), self: sc(0, 0), outsideZone: true, selfInSplash: false, energy: 8, nearest: null }, latch), false)
  })
  test("escaping a close enemy (< 28 m) counts as a tactical reason", () => {
    const nearest = threat(1, 20, 0)
    const latch = { isBoosting: false }
    assert.equal(decideBoost({ best: sc(-11, 0), self: sc(0, 0), outsideZone: false, selfInSplash: false, energy: 50, nearest }, latch), true)
  })
})

// ------------------------------------------------------------------ deadline + integration

describe("deadline and integration", () => {
  test("an expired deadline still yields a valid action (best so far = hold)", () => {
    const loco = new TacticalLocomotion()
    const world = new WorldModel(fixtureHello())
    world.update(scene([200, 0, 0], (o) => { setZone(o, 0, 0, 100); o.self.in_zone = false }))
    const out = loco.decide({ world, map: OPEN, deadline: new Deadline(() => 0, 0, 0) }, [])
    assert.equal(loco.last!.all.length, 1)
    assert.deepEqual(out.move, [0, 0])
    assert.equal(out.jump, false)
  })

  test("the scoring loop itself stops when the deadline runs out mid-loop and returns the best so far", () => {
    const cands = [HOLD, ...Array.from({ length: 30 }, (_, k) => cand(11 * Math.cos(k), 11 * Math.sin(k)))]
    let clock = 0
    // each hasTimeRemaining() call advances the clock 1 ms; budget 10 ms with a 3 ms reserve -> a handful of candidates
    const dl = new Deadline(() => clock++, 0, 10)
    const ev = evaluate(env(), cands, dl)
    assert.ok(ev.all.length > 1 && ev.all.length < cands.length, `scored ${ev.all.length} of ${cands.length}`)
    assert.ok(ev.all.includes(ev.best))
    assert.equal(evaluate(env(), cands, new Deadline(() => 0, 0, 0)).all.length, 1, "expired: hold only")
  })

  test("no map at all: still a valid action", () => {
    const { out } = decide(null, scene([200, 0, 0], (o) => { setZone(o, 0, 0, 100); o.self.in_zone = false }))
    assert.ok(out.move[0] < -0.9)
  })

  test("every recorded observation yields a finite, in-range action through the whole bot", async () => {
    const { Bot } = await import("../src/bot.ts")
    const bot = new Bot(new WorldModel(fixtureHello()), HAS_ARENA ? realMap().map : null)
    for (const o of fixtureObs()) {
      const a = bot.decide(o, NO_DEADLINE)
      assert.equal(a.tick, o.tick)
      assert.ok(a.move && Number.isFinite(a.move[0]) && Math.hypot(a.move[0], a.move[1]) <= 1 + 1e-9)
      assert.ok(a.aim && a.aim[1] >= -0.7 && a.aim[1] <= 1.3)
      assert.equal(a.jump, false)
      assert.doesNotThrow(() => JSON.stringify(a))
    }
  })

  test("distances helper sanity", () => {
    assert.equal(dist2d(0, 0, 3, 4), 5)
  })
})

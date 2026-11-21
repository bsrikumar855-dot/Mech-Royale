/** Locomotion v3: anti-lead A-D strafing, projectile / mortar / laser dodges, hops, zone, loot, patrol, wall feeler. */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LOCOMOTION as L } from "../src/config/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import { LocoState } from "../src/locomotion/state.ts"
import { blockedAhead, steer } from "../src/locomotion/steer.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import type { Observation, WeaponObs } from "../src/types/mechfight.ts"
import type { MapQuery } from "../src/world/map.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, enemy, fixtureHello, fixtureObs, HAS_ARENA, realMap, syntheticMap } from "./helpers.ts"

const hello = fixtureHello()
const mag = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!)
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]!
const laser = (charge = 0): WeaponObs => ({ kind: "laser", cooldown: 0, charge, stats: { ...(hello.config.weapons.laser as Record<string, number>) } })

/** A calm scene at the origin: huge zone, full HP/energy, grounded, nothing around. */
function scene(patch: (o: Observation) => void = () => {}): Observation {
  return cleanObs((o) => {
    o.self.grounded = true
    o.alive = 10
    patch(o)
  })
}

class Runner {
  loco = new EvasiveLocomotion()
  world = new WorldModel(hello)
  map: MapQuery | null
  t = 10
  constructor(map: MapQuery | null = null) {
    this.map = map
  }
  step(patch: (o: Observation) => void = () => {}, dt = 0.1) {
    const o = scene(patch)
    o.t = this.t
    o.tick = Math.round(this.t * 20)
    this.t += dt
    this.world.update(o)
    const out = this.loco.decide({ world: this.world, map: this.map, deadline: NO_DEADLINE }, [])
    return { out, mode: this.loco.lastMode, sense: this.loco.lastSense!, state: this.loco.state }
  }
}
const once = (patch: (o: Observation) => void = () => {}, map: MapQuery | null = null) => new Runner(map).step(patch)

describe("threat trigger: never a stationary target under threat (the 300/300 bug)", () => {
  test("an enemy mech at 139 m (far beyond the old 40 m kite radius) makes us move", () => {
    const r = once((o) => (o.mechs = [enemy(5, [139, 0, 0])]))
    assert.ok(mag(r.out.move) > 0.99, `move ${r.out.move}`)
  })
  test("recent damage alone (no visible shooter) makes us move", () => {
    const r = once((o) => (o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 1, by: 9 }]))
    assert.ok(mag(r.out.move) > 0.99)
    assert.ok(r.sense.damagedRecently)
  })
  test("a near/mid weapon sound alone makes us move; a far one or footsteps do not trigger", () => {
    assert.ok(mag(once((o) => (o.sounds = [{ kind: "gun", bearing: 2, dist: "mid", age: 0.1 }])).out.move) > 0.99)
    assert.equal(once((o) => (o.sounds = [{ kind: "gun", bearing: 2, dist: "far", age: 0.1 }])).sense.active, false)
    assert.equal(once((o) => (o.sounds = [{ kind: "step", bearing: 2, dist: "near", age: 0.1 }])).sense.active, false)
  })
  test("an enemy projectile within 140 m triggers; one at 200 m does not", () => {
    assert.equal(once((o) => (o.projectiles = [{ id: 1, kind: "gun", pos: [120, 0, 5], vel: [0, 252, 0] }])).sense.active, true)
    assert.equal(once((o) => (o.projectiles = [{ id: 1, kind: "gun", pos: [200, 0, 5], vel: [0, 252, 0] }])).sense.active, false)
  })
  test("every recorded real observation with a visible enemy produces movement", () => {
    const r = new Runner(HAS_ARENA ? realMap().map : null)
    let checked = 0
    for (const raw of fixtureObs()) {
      r.world.update(raw)
      const out = r.loco.decide({ world: r.world, map: r.map, deadline: NO_DEADLINE }, [])
      if (raw.mechs.some((m) => m.kind === "mech")) {
        checked++
        assert.ok(mag(out.move) > 0.3, `tick ${raw.tick}: stationary with an enemy in sight`)
      }
    }
    assert.ok(checked > 0)
  })
})

describe("A-D strafing with range control", () => {
  const towardEnemy = (x: number, y: number): [number, number] => [x / Math.hypot(x, y), y / Math.hypot(x, y)]

  test("1v1 sweet spot (42-95 m): pure perpendicular strafe", () => {
    const r = once((o) => (o.mechs = [enemy(5, [60, 0, 0])]))
    assert.equal(r.mode, "strafe")
    assert.ok(Math.abs(dot(r.out.move, towardEnemy(60, 0))) < 1e-9)
  })
  test("139 m, healthy, in the safe zone: perpendicular strafe with a mild approach", () => {
    const r = once((o) => (o.mechs = [enemy(5, [139, 0, 0])]))
    assert.equal(r.mode, "approach")
    const radial = dot(r.out.move, towardEnemy(139, 0))
    assert.ok(radial > 0.2 && radial < 0.35, `radial ${radial}`)
  })
  test("139 m but not healthy (60% HP): no approach, pure strafe", () => {
    const r = once((o) => { o.self.hp = o.self.max_hp * 0.6; o.mechs = [enemy(5, [139, 0, 0])] })
    assert.equal(r.mode, "strafe")
  })
  test("too close (< 42 m, or < 52 m against lightning): backpedal while strafing", () => {
    const r = once((o) => (o.mechs = [enemy(5, [30, 0, 0])]))
    assert.equal(r.mode, "backpedal")
    assert.ok(r.out.move[0] < -0.3)
    assert.equal(once((o) => (o.mechs = [enemy(5, [48, 0, 0], { weapons: ["gun", "lightning"] })])).mode, "backpedal")
    assert.equal(once((o) => (o.mechs = [enemy(5, [48, 0, 0])])).mode, "strafe")
  })
  test("strafe direction reverses every 0.75-1.15 s, not on a constant period", () => {
    const r = new Runner()
    const signs: number[] = []
    for (let i = 0; i < 60; i++) signs.push(Math.sign(r.step((o) => (o.mechs = [enemy(5, [60, 0, 0])])).out.move[1]))
    const flipsAt = signs.flatMap((s, i) => (i > 0 && s !== signs[i - 1] ? [i] : []))
    assert.ok(flipsAt.length >= 4 && flipsAt.length <= 8, `${flipsAt.length} reversals in 6 s`)
    const gaps = flipsAt.slice(1).map((v, i) => v - flipsAt[i]!)
    for (const g of gaps) assert.ok(g >= 7 && g <= 12, `gap ${g} decisions`)
    assert.ok(new Set(gaps).size > 1, "periods vary")
  })
})

describe("bullet, mortar and laser dodges", () => {
  test("a bullet ray about to pass through us snaps the strafe AWAY from its path", () => {
    // enemy east (bearing 0) -> strafe is +y (sign 1) or -y (sign -1)
    const below = once((o) => { o.mechs = [enemy(5, [100, 0, 0])]; o.projectiles = [{ id: 1, kind: "gun", pos: [100, -1, 5], vel: [-252, 0, 0] }] })
    assert.ok(below.out.move[1] > 0, "bullet passes just south of us: go north")
    const above = once((o) => { o.mechs = [enemy(5, [100, 0, 0])]; o.projectiles = [{ id: 1, kind: "gun", pos: [100, 1, 5], vel: [-252, 0, 0] }] })
    assert.ok(above.out.move[1] < 0, "bullet passes just north of us: go south")
  })
  test("a bullet that will miss by a wide margin does not snap anything", () => {
    assert.equal(once((o) => (o.projectiles = [{ id: 1, kind: "gun", pos: [100, 20, 5], vel: [-252, 0, 0] }])).sense.bulletEscape, null)
  })
  test("mortar: predicts the landing point and runs straight out of the splash with an emergency boost", () => {
    const r = once((o) => (o.projectiles = [{ id: 1, kind: "mortar", pos: [5, 0, 20], vel: [0, 0, 0] }]))
    assert.equal(r.mode, "mortar")
    assert.ok(r.out.move[0] < -0.99, "away from the impact at (5, 0)")
    assert.equal(r.out.boost, true)
    assert.equal(once((o) => { o.self.energy = 5; o.projectiles = [{ id: 1, kind: "mortar", pos: [5, 0, 20], vel: [0, 0, 0] }] }).out.boost, false)
  })
  test("mortar landing well away from us is not a dodge", () => {
    assert.notEqual(once((o) => (o.projectiles = [{ id: 1, kind: "mortar", pos: [40, 0, 20], vel: [0, 0, 0] }])).mode, "mortar")
  })
  test("an enemy charging a laser at us: perpendicular sprint with an emergency boost (not while our own laser charges)", () => {
    const r = once((o) => { o.self.energy = 50; o.mechs = [enemy(5, [100, 0, 0], { charging: true })] })
    assert.equal(r.mode, "laserDodge")
    assert.ok(Math.abs(r.out.move[0]) < 1e-9 && Math.abs(r.out.move[1]) > 0.99)
    assert.equal(r.out.boost, true)
    assert.equal(once((o) => { o.self.energy = 50; o.self.weapons = [o.self.weapons[0] ?? null, laser(0.3)]; o.mechs = [enemy(5, [100, 0, 0], { charging: true })] }).out.boost, false)
    assert.equal(once((o) => { o.self.energy = 10; o.mechs = [enemy(5, [100, 0, 0], { charging: true })] }).out.boost, false)
  })
  test("laser dodge picks the side that breaks the charger's line of sight (max 2 raycasts)", () => {
    const m = syntheticMap()
    let rays = 0
    const blockSouth = Object.assign(Object.create(Object.getPrototypeOf(m)), m, {
      hasShotLOS: (_a: readonly number[], b: readonly number[]) => { rays++; return !(b[1]! < -32) },
    }) as MapQuery
    const r = once((o) => { o.self.pos = [-30, -30, m.heightAt(-30, -30)]; o.mechs = [enemy(5, [30, -30, 3], { charging: true })] }, blockSouth)
    assert.ok(r.out.move[1] < -0.9, `takes the south side, behind cover: ${r.out.move}`)
    assert.ok(rays <= L.maxLosChecks + 2, `${rays} raycasts`)
  })
})

describe("anti-lead hops", () => {
  test("hop under fire when grounded, then wait the 1.8-2.4 s interval", () => {
    const r = new Runner()
    const jumps: number[] = []
    for (let i = 0; i < 50; i++) if (r.step((o) => (o.mechs = [enemy(5, [60, 0, 0])])).out.jump) jumps.push(i)
    assert.equal(jumps[0], 0, "first hop at once")
    const gaps = jumps.slice(1).map((v, i) => v - jumps[i]!)
    assert.ok(gaps.length >= 1)
    for (const g of gaps) assert.ok(g >= 18 && g <= 25, `gap ${g} decisions`)
  })
  test("no hop when airborne, while our laser charges, while dodging a mortar, or with no threat", () => {
    assert.equal(once((o) => { o.self.grounded = false; o.mechs = [enemy(5, [60, 0, 0])] }).out.jump, false)
    assert.equal(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser(0.2)]; o.mechs = [enemy(5, [60, 0, 0])] }).out.jump, false)
    assert.equal(once((o) => { o.mechs = [enemy(5, [60, 0, 0])]; o.projectiles = [{ id: 1, kind: "mortar", pos: [5, 0, 20], vel: [0, 0, 0] }] }).out.jump, false)
    assert.equal(once().out.jump, false)
  })
  test("recent damage (2 s window) also allows a hop", () => {
    assert.equal(once((o) => (o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 1, by: 9 }])).out.jump, true)
  })
})

describe("crossfire and wounded retreat with a latched boost", () => {
  test("2 enemies with line of sight: retreat (away from the nearest) with boost", () => {
    const r = once((o) => { o.self.energy = 50; o.mechs = [enemy(5, [100, 0, 0]), enemy(6, [0, 120, 0])] })
    assert.equal(r.mode, "retreat")
    assert.ok(r.out.move[0] < -0.3, "away from the nearest (east) threat")
    assert.equal(r.out.boost, true)
  })
  test("wounded (< 42% HP) 1v1 also retreats", () => {
    assert.equal(once((o) => { o.self.hp = o.self.max_hp * 0.4; o.mechs = [enemy(5, [60, 0, 0])] }).mode, "retreat")
  })
  test("boost latch: starts at >= 30 energy, holds down to 15, then stops", () => {
    const r = new Runner()
    const at = (e: number) => r.step((o) => { o.self.energy = e; o.mechs = [enemy(5, [100, 0, 0]), enemy(6, [0, 120, 0])] }).out.boost
    assert.equal(at(25), false, "25 < start")
    assert.equal(at(35), true)
    assert.equal(at(20), true, "latched")
    assert.equal(at(14), false)
    assert.equal(at(25), false, "no restart below 30")
  })
})

describe("zone", () => {
  test("outside the zone: run inward with boost (energy > 10)", () => {
    const r = once((o) => { o.self.pos = [600, 0, 0]; o.self.in_zone = false; o.self.energy = 50 })
    assert.equal(r.mode, "outside")
    assert.ok(r.out.move[0] < -0.99)
    assert.equal(r.out.boost, true)
  })
  test("under fire outside the zone: inward with a weave", () => {
    const r = once((o) => { o.self.pos = [600, 0, 0]; o.self.in_zone = false; o.mechs = [enemy(5, [700, 0, 0])] }) // threat east: strafe axis is y
    assert.ok(r.out.move[0] < -0.8 && Math.abs(r.out.move[1]) > 0.1)
  })
  test("shrink anticipation: leave for the next circle when walking there would otherwise be too late", () => {
    const patch = (endIn: number) => (o: Observation): void => {
      o.zone = { center: [0, 0], radius: 600, next_center: [300, 0], next_radius: 100, shrink_start: 1e6, shrink_end: 10 + endIn, dps: 20 }
    }
    const soon = once(patch(20))
    assert.equal(soon.mode, "shrink")
    assert.ok(soon.out.move[0] > 0.99)
    assert.notEqual(once(patch(200)).mode, "shrink")
  })
  test("near the rim (> 85%): steps inward; strafing never carries us out of the safe band", () => {
    assert.equal(once((o) => (o.self.pos = [460, 0, 0])).mode, "rim")
    // 1 m inside the 85% band (425 m); the first strafe goes +y, i.e. straight out of it without the rim check
    const r = once((o) => { o.self.pos = [0, 424, 0]; o.mechs = [enemy(5, [60, 424, 0])] })
    assert.ok(Math.hypot(0 + r.out.move[0] * 4, 424 + r.out.move[1] * 4) <= 500 * L.safeRadiusFrac + 1e-6, `move ${r.out.move}`)
  })
})

describe("active loot and supply drops", () => {
  const pick = (kind: "laser" | "lightning", x: number) => ({ id: 8001, kind, pos: [x, 0, 0] as [number, number, number] })
  /** 10 cubes + a laser: the v5 snowball gate is closed, the 1b29c35 loot ranges apply. */
  const snowballed = (o: Observation): void => {
    o.self.cubes = 10
    o.self.weapons = [o.self.weapons[0] ?? null, laser()]
  }
  test("walks to a laser up to 90 m away while the snowball gate is open (not 95 m)", () => {
    assert.equal(once((o) => (o.pickups = [pick("laser", 88)])).mode, "loot")
    assert.notEqual(once((o) => (o.pickups = [pick("laser", 95)])).mode, "loot")
  })
  test("gate closed by an enemy tracked within 50 m (no shot line): the laser reach is back to 80 m", () => {
    const map = syntheticMap()
    const me: [number, number, number] = [-20, 5, -2]
    const hidden = enemy(5, [20, 5, 2]) // behind building A, 40 m away
    const at = (dx: number) => new Runner(map).step((o) => { o.self.pos = [...me]; o.mechs = [hidden]; o.pickups = [{ id: 8001, kind: "laser", pos: [me[0] - dx, me[1], -2 - 0.1 * dx] }] })
    const r = at(85)
    assert.equal(r.sense.losCount, 0, "precondition: no shot line")
    assert.notEqual(r.mode, "loot", "85 m: beyond the closed-gate 80 m")
    assert.equal(at(75).mode, "loot")
  })
  test("lightning up to 55 m only with an empty slot and no laser; cubes up to 90 m pre-snowball (55 m once snowballed)", () => {
    assert.equal(once((o) => (o.pickups = [pick("lightning", 50)])).mode, "loot")
    assert.notEqual(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.pickups = [pick("lightning", 50)] }).mode, "loot")
    assert.equal(once((o) => (o.cubes = [{ id: 5001, pos: [85, 0, 0] }])).mode, "loot", "submission 23: widened from 65 m")
    assert.notEqual(once((o) => (o.cubes = [{ id: 5001, pos: [95, 0, 0] }])).mode, "loot")
    assert.equal(once((o) => { snowballed(o); o.cubes = [{ id: 5001, pos: [50, 0, 0] }] }).mode, "loot")
    assert.notEqual(once((o) => { snowballed(o); o.cubes = [{ id: 5001, pos: [60, 0, 0] }] }).mode, "loot")
  })
  test("already holding a laser: laser pickups are ignored", () => {
    assert.notEqual(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.pickups = [pick("laser", 30)] }).mode, "loot")
  })
  const drop = (over: Partial<Observation["drops"][number]> = {}) => ({ id: 20000, pos: [65, 0, 0] as [number, number, number], radius: 8, lands_in: 10, capture_s: 4, progress: 0, holder: null, ...over })
  test("submission 20: supply drops, uncontested, landing within 25 s, within 140 m (130 m once snowballed)", () => {
    const go = once((o) => (o.drops = [drop()]))
    assert.equal(go.mode, "loot")
    assert.ok(go.out.move[0] > 0.99)
    assert.notEqual(once((o) => (o.drops = [drop({ holder: 7 })])).mode, "loot")
  })
  test("reacts from the moment it's called: 25 s is the full fall_s, so there is no later-than-this (was 20 s, 12 s before that)", () => {
    assert.equal(once((o) => (o.drops = [drop({ lands_in: 24 })])).mode, "loot", "24 s: inside the widened window")
    assert.equal(once((o) => (o.drops = [drop({ lands_in: 25 })])).mode, "loot", "exactly at the new cap (= fall_s: the practical ceiling)")
    assert.notEqual(once((o) => (o.drops = [drop({ lands_in: 26 })])).mode, "loot", "past it (synthetic: lands_in never exceeds fall_s in a real match)")
  })
  test("pre-snowball (hunt gate open): reaches out to 140 m, not just 105 m (was 75 m before that)", () => {
    assert.equal(once((o) => (o.drops = [drop({ pos: [135, 0, 0] })])).mode, "loot")
    assert.notEqual(once((o) => (o.drops = [drop({ pos: [145, 0, 0] })])).mode, "loot", "past even the widened hunt range")
  })
  test("once snowballed: reaches out to 130 m, not just 95 m (was 70 m before that), but no farther than that", () => {
    assert.equal(once((o) => { snowballed(o); o.drops = [drop({ pos: [125, 0, 0] })] }).mode, "loot")
    assert.notEqual(once((o) => { snowballed(o); o.drops = [drop({ pos: [135, 0, 0] })] }).mode, "loot", "past the (smaller) snowballed range")
  })
  test("inside the capture ring: micro-strafes gently instead of standing still or leaving", () => {
    const r = once((o) => (o.drops = [drop({ pos: [3, 0, 0], lands_in: 0 })]))
    assert.equal(r.mode, "loot")
    assert.ok(Math.abs(mag(r.out.move) - L.dropMicroStrafe) < 1e-9)
    assert.ok(Math.abs(dot(r.out.move, [1, 0])) < 1e-9, "tangential to the ring")
  })
  test("under fire in a 1v1, healthy: still grabs very close loot (< 18 m) while weaving", () => {
    const r = once((o) => { o.mechs = [enemy(5, [60, 0, 0])]; o.cubes = [{ id: 5001, pos: [0, 15, 0] }] })
    assert.equal(r.mode, "loot")
  })
})

describe("idle: patrol when healthy, silent regen hold when wounded", () => {
  test("healthy with nothing around: patrols (never a sitting duck)", () => {
    const r = once()
    assert.equal(r.mode, "patrol")
    assert.ok(mag(r.out.move) > 0.99)
    assert.equal(r.out.boost, false)
  })
  test("wounded, safe and quiet: holds still so the regen runs", () => {
    const r = once((o) => (o.self.hp = o.self.max_hp * 0.7))
    assert.equal(r.mode, "hold")
    assert.deepEqual(r.out.move, [0, 0])
  })
  test("wounded but a gun was heard: strafe, not hold", () => {
    assert.equal(once((o) => { o.self.hp = o.self.max_hp * 0.7; o.sounds = [{ kind: "gun", bearing: 2, dist: "near", age: 0.1 }] }).mode, "strafe")
  })
  test("patrol stays in the next circle's 40-75% band", () => {
    const at = (x: number) => once((o) => { o.self.pos = [x, 0, 0]; o.zone = { center: [0, 0], radius: 500, next_center: [0, 0], next_radius: 200, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 } }).out.move
    assert.ok(at(30)[0] > 0, "too far in (15%): drift outward")
    assert.ok(at(190)[0] < 0, "too far out (95%): drift inward")
    assert.ok(Math.abs(at(115)[0]) < 0.05, "in the band: tangential")
  })
})

describe("wall feeler with side commitment", () => {
  const map = syntheticMap() // building A: x 0..10, y 0..10, top 20
  const worldAt = (x: number, y: number) => {
    const w = new WorldModel(hello)
    w.update(scene((o) => (o.self.pos = [x, y, map.heightAt(x, y)])))
    return w
  }
  test("a blocked heading is rotated to the nearest open one and the side is committed for 1.5 s", () => {
    const w = worldAt(-6, 5)
    const st = new LocoState()
    assert.ok(blockedAhead(map, w, [1, 0]))
    const r = steer(map, w, st, [1, 0])!
    assert.ok(r && !blockedAhead(map, w, r))
    const side = st.committedSide(w.t)
    assert.notEqual(side, 0)
    // a heading tilted slightly toward the OTHER side is still steered to the committed side
    const tilt: [number, number] = [Math.cos(-0.05 * side), Math.sin(-0.05 * side)]
    const r2 = steer(map, w, st, tilt)!
    assert.ok(Math.sign(r2[1]) === side, "no flip-flop around the wall")
    assert.equal(st.committedSide(w.t + L.wallCommitS + 0.01), 0, "commitment expires")
  })
  test("strafe side blocked within 5 m: flips to the open side at once", () => {
    // threat due south -> the +1 strafe side points east, straight into building A
    const r = new Runner(map).step((o) => { o.self.pos = [-6, 5, map.heightAt(-6, 5)]; o.mechs = [enemy(5, [-6, -55, -0.6])] })
    assert.ok(r.out.move[0] < 0, `strafes west, away from the wall: ${r.out.move}`)
  })
  test("boxed in on every heading: no move (rather than walking into a wall)", () => {
    const walled = Object.assign(Object.create(Object.getPrototypeOf(map)), map, { isBlockedAt: () => true }) as MapQuery
    const w = worldAt(-30, -30)
    assert.equal(steer(walled, w, new LocoState(), [1, 0]), null)
  })
})

describe("state reset", () => {
  test("a world reset (new match) clears strafe, hop and commitment memory, even with the clock moving forward", () => {
    const r = new Runner()
    for (let i = 0; i < 15; i++) r.step((o) => (o.mechs = [enemy(5, [60, 0, 0])]))
    assert.ok(r.loco.state.flips > 0 || r.loco.state.jumps > 0)
    r.world.reset() // as Session does after the warm-up ticks; the next tick is NOT earlier, so only resetCount can tell
    r.step()
    assert.equal(r.loco.state.flips, 0)
    assert.equal(r.loco.state.jumps, 0)
    assert.equal(r.loco.state.strafeSign, 1)
  })
  test("a backwards tick resets", () => {
    const r = new Runner()
    for (let i = 0; i < 15; i++) r.step((o) => (o.mechs = [enemy(5, [60, 0, 0])]))
    r.t = 1
    r.step()
    assert.equal(r.loco.state.jumps, 0)
  })
  test("a gap between observations (6.4 s, 50 m) is NOT a new match: memory survives", () => {
    const r = new Runner()
    for (let i = 0; i < 15; i++) r.step((o) => (o.mechs = [enemy(5, [60, 0, 0])]))
    const jumps = r.loco.state.jumps
    r.t += 6.4
    r.step((o) => (o.self.pos = [50, 0, 0]))
    assert.equal(r.loco.state.jumps, jumps)
  })
})

describe("integration", () => {
  test("every recorded observation yields a finite, in-range action through the whole bot", async () => {
    const { Bot } = await import("../src/bot.ts")
    const bot = new Bot(new WorldModel(hello), HAS_ARENA ? realMap().map : null)
    for (const o of fixtureObs()) {
      const a = bot.decide(o, NO_DEADLINE)
      assert.equal(a.tick, o.tick)
      assert.ok(a.move && Number.isFinite(a.move[0]) && Math.hypot(a.move[0], a.move[1]) <= 1 + 1e-9)
      assert.doesNotThrow(() => JSON.stringify(a))
    }
  })
})

// ------------------------------------------------------------------ v5: early snowball rush
describe("v5: crate and drone hunting (snowball gate)", () => {
  const crate = (x: number, y = 0) => ({ id: 1001, pos: [x, y, 0] as [number, number, number] })
  const drone = (x: number, y = 0) => ({ id: 101, kind: "npc" as const, pos: [x, y, 0] as [number, number, number], vel: [0, 0, 0] as [number, number, number], aim: [0, 0] as [number, number], hp: 350, max_hp: 350 })
  const fresh = (o: Observation): void => {
    o.self.cubes = 0
  }
  test("0 cubes, nobody around: walks toward a crate 65 m away...", () => {
    const r = once((o) => { fresh(o); o.crates = [crate(65)] })
    assert.equal(r.mode, "hunt")
    assert.ok(r.out.move[0] > 0.99, `toward the crate: ${r.out.move}`)
  })
  test("submission 23: crates and drones are now hunted out to 100 m, not just 75 m", () => {
    assert.equal(once((o) => { fresh(o); o.crates = [crate(95)] }).mode, "hunt")
    assert.notEqual(once((o) => { fresh(o); o.crates = [crate(105)] }).mode, "hunt")
    assert.equal(once((o) => { fresh(o); o.mechs = [drone(0, 95)] }).mode, "hunt")
    assert.notEqual(once((o) => { fresh(o); o.mechs = [drone(0, 105)] }).mode, "hunt")
  })
  test("...and holds at <= 38 m (muzzle to centre) so Combat breaks it; keeps walking at 40 m", () => {
    const hold = once((o) => { fresh(o); o.crates = [crate(37)] })
    assert.equal(hold.mode, "hunt")
    assert.deepEqual(hold.out.move, [0, 0], "in position: stand still while Combat shoots")
    assert.ok(once((o) => { fresh(o); o.crates = [crate(40)] }).out.move[0] > 0.99)
  })
  test("walks toward an NPC drone 65 m away and holds at <= 35 m; keeps walking at 37 m", () => {
    const go = once((o) => { fresh(o); o.mechs = [drone(0, 65)] })
    assert.equal(go.mode, "hunt")
    assert.ok(go.out.move[1] > 0.99, `toward the drone: ${go.out.move}`)
    assert.deepEqual(once((o) => { fresh(o); o.mechs = [drone(0, 34)] }).out.move, [0, 0])
    assert.ok(once((o) => { fresh(o); o.mechs = [drone(0, 37)] }).out.move[1] > 0.99)
  })
  test("stand-offs sit inside Combat's own engagement gates (drone 40 m, crate 45 m)", async () => {
    const { COMBAT } = await import("../src/config/index.ts")
    assert.ok(L.huntNpcStandoffM < COMBAT.npcEngageRangeM)
    assert.ok(L.huntCrateStandoffM < COMBAT.crateFarmRangeM)
  })
  test("no shot line from the stand-off: keep closing in instead of holding (Combat needs LOS)", () => {
    const map = syntheticMap()
    // building A (0..10 x 0..10) sits between us at (-20, 5) and a crate at (25, 5): 45 m, hidden
    const r = new Runner(map).step((o) => { fresh(o); o.self.pos = [-20, 5, -2]; o.crates = [{ id: 1001, pos: [17, 5, 1.7] }] })
    assert.equal(r.mode, "hunt")
    assert.ok(mag(r.out.move) > 0.99, `37 m but no line: keep moving (${r.out.move})`)
  })
  test("v14 heal before farming: below 85% HP no drone or crate hunting; above it, hunting as in 6afa909", () => {
    assert.notEqual(once((o) => { fresh(o); o.self.hp = 0.75 * o.self.max_hp; o.mechs = [drone(0, 60)] }).mode, "hunt", "75%: no drone hunt")
    assert.notEqual(once((o) => { fresh(o); o.self.hp = 0.75 * o.self.max_hp; o.crates = [crate(60)] }).mode, "hunt", "75%: no crate hunt")
    assert.equal(once((o) => { fresh(o); o.self.hp = 0.9 * o.self.max_hp; o.mechs = [drone(0, 60)] }).mode, "hunt", "90%: drone hunt")
    assert.equal(once((o) => { fresh(o); o.self.hp = 0.9 * o.self.max_hp; o.crates = [crate(60)] }).mode, "hunt", "90%: crate hunt")
  })
  test("v14: at 75% HP the bot holds still for regen instead of walking to a drone or crate", () => {
    const r = once((o) => { fresh(o); o.self.hp = 0.75 * o.self.max_hp; o.crates = [crate(60)]; o.mechs = [drone(0, 60)] })
    assert.equal(r.mode, "hold")
    assert.deepEqual(r.out.move, [0, 0])
  })
  test("v14: at 75% HP free loot is still scooped (no damage dealt): a cube and a weapon pickup", () => {
    assert.equal(once((o) => { fresh(o); o.self.hp = 0.75 * o.self.max_hp; o.cubes = [{ id: 5001, pos: [30, 0, 0] }]; o.crates = [crate(40)] }).mode, "loot")
    assert.equal(once((o) => { fresh(o); o.self.hp = 0.75 * o.self.max_hp; o.pickups = [{ id: 8001, kind: "laser", pos: [50, 0, 0] }] }).mode, "loot")
  })
  test("10 cubes + a laser: ignores distant crates and drones and patrols", () => {
    const done = (o: Observation): void => {
      o.self.cubes = 10
      o.self.weapons = [o.self.weapons[0] ?? null, laser()]
    }
    assert.equal(once((o) => { done(o); o.crates = [crate(65)] }).mode, "patrol")
    assert.equal(once((o) => { done(o); o.mechs = [drone(0, 65)] }).mode, "patrol")
    assert.equal(once((o) => { o.self.cubes = 10; o.crates = [crate(65)] }).mode, "hunt", "10 cubes but no laser yet: keep hunting")
    assert.equal(once((o) => { o.self.cubes = 3; o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.crates = [crate(65)] }).mode, "hunt", "laser but 3 cubes: keep hunting")
  })
  test("any enemy mech with a shot line overrides hunting at once", () => {
    const r = once((o) => { fresh(o); o.crates = [crate(40)]; o.mechs = [enemy(5, [0, 100, 0]), drone(0, 30)] })
    assert.ok(r.sense.losCount >= 1)
    assert.notEqual(r.mode, "hunt")
    assert.ok(["strafe", "approach", "backpedal", "retreat"].includes(r.mode), r.mode)
  })
  test("an enemy tracked within 50 m (no shot line) also closes the gate", () => {
    const map = syntheticMap()
    const r = new Runner(map).step((o) => { fresh(o); o.self.pos = [-20, 5, -2]; o.mechs = [enemy(5, [20, 5, 2])]; o.crates = [{ id: 1001, pos: [-20, -40, -2] }] })
    assert.equal(r.sense.losCount, 0)
    assert.notEqual(r.mode, "hunt")
  })
  test("outside the safe rim (still in the zone): no hunting, head inward", () => {
    const r = once((o) => { fresh(o); o.self.pos = [90, 0, 0]; o.zone = { center: [0, 0], radius: 100, next_center: [0, 0], next_radius: 100, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 }; o.crates = [crate(40)] })
    assert.equal(r.mode, "rim")
  })
  test("a laser pickup at 80 m beats a crate at 40 m when we hold no laser", () => {
    const r = once((o) => { fresh(o); o.crates = [crate(0, 40)]; o.pickups = [{ id: 8001, kind: "laser", pos: [80, 0, 0] }] })
    assert.equal(r.mode, "loot")
    assert.ok(r.out.move[0] > 0.99, `toward the laser (east), not the crate (north): ${r.out.move}`)
  })
  test("a free cube nearby is grabbed before walking to a drone", () => {
    const r = once((o) => { fresh(o); o.cubes = [{ id: 5001, pos: [-15, 0, 0] }]; o.mechs = [drone(0, 60)] })
    assert.equal(r.mode, "loot")
    assert.ok(r.out.move[0] < -0.99)
  })
})

describe("v5: post-kill cube scoop under fire", () => {
  const hitBy = { type: "damaged" as const, amount: 45, weapon: "gun", bearing: 1, by: 9 }
  test("no shot line on us (unseen shooter): scoops a cube 22 m away", () => {
    const r = once((o) => { o.events = [hitBy]; o.cubes = [{ id: 5001, pos: [0, -22, 0] }] })
    assert.equal(r.sense.losCount, 0)
    assert.equal(r.mode, "loot")
    assert.ok(r.out.move[1] < -0.5, `toward the cube: ${r.out.move}`)
    assert.notEqual(once((o) => { o.events = [hitBy]; o.cubes = [{ id: 5001, pos: [0, -28, 0] }] }).mode, "loot")
  })
  test("one shooter: a cube within 14 m is scooped above 45% HP (50% here); one at 16 m is not", () => {
    const at = (y: number, hp = 0.5) => once((o) => { o.self.hp = hp * o.self.max_hp; o.mechs = [enemy(5, [60, 0, 0])]; o.cubes = [{ id: 5001, pos: [0, y, 0] }] })
    assert.equal(at(12).mode, "loot")
    assert.notEqual(at(16).mode, "loot")
    assert.notEqual(at(12, 0.44).mode, "loot", "44%: no scoop")
  })
  test("two shooters: never scoops (crossfire retreat wins)", () => {
    const r = once((o) => { o.mechs = [enemy(5, [60, 0, 0]), enemy(6, [0, 60, 0])]; o.cubes = [{ id: 5001, pos: [0, -8, 0] }] })
    assert.equal(r.mode, "retreat")
  })
})

describe("v5: snowball upgrade order", () => {
  test("armor, plating, gun_rate, gun_damage, laser_damage, laser_charge, nanites lead; mortar_* are the last three", async () => {
    const { ECONOMY } = await import("../src/config/index.ts")
    const p = ECONOMY.upgradePriority
    assert.deepEqual([...p.slice(0, 7)].sort(), ["armor", "gun_damage", "gun_rate", "laser_charge", "laser_damage", "nanites", "plating"])
    assert.deepEqual([...p.slice(-3)].sort(), ["mortar_reload", "mortar_splash", "mortar_velocity"])
  })
})

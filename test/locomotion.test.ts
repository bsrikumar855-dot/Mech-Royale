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
  test("v11: 139 m vs a healthy enemy, even healthy ourselves: no approach (never chase)", () => {
    const r = once((o) => (o.mechs = [enemy(5, [139, 0, 0])]))
    assert.equal(r.mode, "strafe")
    assert.ok(dot(r.out.move, towardEnemy(139, 0)) <= 0.05)
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
  test("lightning up to 55 m only with an empty slot and no laser; cubes up to 65 m (55 m once snowballed)", () => {
    assert.equal(once((o) => (o.pickups = [pick("lightning", 50)])).mode, "loot")
    assert.notEqual(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.pickups = [pick("lightning", 50)] }).mode, "loot")
    assert.equal(once((o) => (o.cubes = [{ id: 5001, pos: [60, 0, 0] }])).mode, "loot")
    assert.notEqual(once((o) => (o.cubes = [{ id: 5001, pos: [68, 0, 0] }])).mode, "loot")
    assert.equal(once((o) => { snowballed(o); o.cubes = [{ id: 5001, pos: [50, 0, 0] }] }).mode, "loot")
    assert.notEqual(once((o) => { snowballed(o); o.cubes = [{ id: 5001, pos: [60, 0, 0] }] }).mode, "loot")
  })
  test("already holding a laser: laser pickups are ignored", () => {
    assert.notEqual(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.pickups = [pick("laser", 30)] }).mode, "loot")
  })
  const drop = (over: Partial<Observation["drops"][number]> = {}) => ({ id: 20000, pos: [65, 0, 0] as [number, number, number], radius: 8, lands_in: 10, capture_s: 4, progress: 0, holder: null, ...over })
  test("supply drops: uncontested, landing within 12 s, within 75 m (70 m once snowballed)", () => {
    const go = once((o) => (o.drops = [drop()]))
    assert.equal(go.mode, "loot")
    assert.ok(go.out.move[0] > 0.99)
    assert.notEqual(once((o) => (o.drops = [drop({ holder: 7 })])).mode, "loot")
    assert.notEqual(once((o) => (o.drops = [drop({ lands_in: 13 })])).mode, "loot")
    assert.equal(once((o) => (o.drops = [drop({ pos: [73, 0, 0] })])).mode, "loot")
    assert.notEqual(once((o) => (o.drops = [drop({ pos: [78, 0, 0] })])).mode, "loot")
    assert.notEqual(once((o) => { snowballed(o); o.drops = [drop({ pos: [73, 0, 0] })] }).mode, "loot")
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
  test("v11 patrol works the outer rim: from 15% it heads out, beyond 95% it comes back in", () => {
    const at = (x: number) => once((o) => { o.self.pos = [x, 0, 0]; o.zone = { center: [0, 0], radius: 500, next_center: [0, 0], next_radius: 200, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 } }).out.move
    assert.ok(at(30)[0] > 0.9, "15%: out toward the (east, nearest) rim sector")
    assert.ok(at(190)[0] < 0, "95%: back inside the 78-88% band")
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
  test("too wounded to hunt: drones need > 55% HP, crates > 65%", () => {
    assert.notEqual(once((o) => { fresh(o); o.self.hp = 0.5 * o.self.max_hp; o.mechs = [drone(0, 60)] }).mode, "hunt")
    assert.notEqual(once((o) => { fresh(o); o.self.hp = 0.6 * o.self.max_hp; o.crates = [crate(60)] }).mode, "hunt")
    assert.equal(once((o) => { fresh(o); o.self.hp = 0.6 * o.self.max_hp; o.mechs = [drone(0, 60)] }).mode, "hunt")
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

// ------------------------------------------------------------------ v11: macro quiet rim + threat map + no chase
const ring = (o: Observation, c: [number, number], nextR: number, curR = 500): void => {
  o.zone = { center: [c[0], c[1]], radius: curR, next_center: [c[0], c[1]], next_radius: nextR, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 }
}
const gunSound = (bearing: number, dist: "near" | "mid" | "far" = "mid") => ({ kind: "gun", bearing, dist, age: 0.1 })

describe("v11: decaying threat map", () => {
  test("ingests enemy sightings (one entry per id, updated in place) and weapon sounds at bucket range", () => {
    const r = new Runner()
    r.step((o) => { o.mechs = [enemy(5, [150, 0, 0])]; o.sounds = [gunSound(Math.PI / 2, "mid"), { kind: "step", bearing: 0, dist: "near", age: 0.1 }] })
    const e = r.loco.state.threats.entries
    assert.equal(e.length, 2, "the enemy + the gun sound (footsteps ignored)")
    const snd = e.find((x) => x.id === null)!
    assert.ok(Math.abs(snd.x) < 1e-9 && Math.abs(snd.y - L.threatSoundRangeM["mid"]!) < 1e-9, "mid gun sound placed 110 m north")
    r.step((o) => (o.mechs = [enemy(5, [140, 0, 0])]))
    assert.equal(r.loco.state.threats.entries.filter((x) => x.id === 5).length, 1, "same id: updated, not duplicated")
    assert.equal(r.loco.state.threats.entries.find((x) => x.id === 5)!.x, 140)
  })
  test("decays to nothing after 12 s and is capped at 16 entries", () => {
    const r = new Runner()
    r.step((o) => (o.sounds = [gunSound(0)]))
    const tm = r.loco.state.threats
    const s0 = tm.score(110, 0, 10.05)
    assert.ok(s0 > 0.5)
    assert.ok(Math.abs(tm.score(110, 0, 16.05) - s0 / 2) < 0.02, "half after 6 s")
    r.t += 12.5
    r.step()
    assert.equal(tm.entries.length, 0, "gone after 12 s")
    const many = new Runner()
    many.step((o) => (o.sounds = Array.from({ length: 25 }, (_, k) => gunSound(k * 0.2))))
    assert.equal(many.loco.state.threats.entries.length, L.threatMapCap)
  })
  test("cleared on a world reset (resetCount) and on a backwards tick", () => {
    const r = new Runner()
    r.step((o) => (o.sounds = [gunSound(0)]))
    r.world.reset()
    r.step()
    assert.equal(r.loco.state.threats.entries.length, 0)
    const b = new Runner()
    b.step((o) => (o.sounds = [gunSound(0)]))
    b.t = 1
    b.step()
    assert.equal(b.loco.state.threats.entries.length, 0)
  })
})

describe("v11: quiet outer-rim patrol", () => {
  const C: [number, number] = [0, 0]
  const R = 200
  test("enemy sightings on the east: patrol picks a walkable west rim sector at 78-88% of the next radius", () => {
    const r = new Runner()
    r.step((o) => { ring(o, C, R); o.mechs = [enemy(5, [150, 0, 0]), enemy(6, [120, 60, 0])] })
    r.t += 6 // sightings out of vision memory (5 s), still on the 12 s threat map
    const p = r.step((o) => ring(o, C, R))
    assert.equal(p.mode, "patrol")
    const k = r.loco.state.rimSector!
    const a = (k / L.rimSectors) * Math.PI * 2
    assert.ok(Math.cos(a) < -0.4, `west-ish sector, got ${k} (${a} rad)`)
    assert.ok(p.out.move[0] < -0.4, `heads west-ish from the centre: ${p.out.move}`)
  })
  test("gunfire sounds alone (no sighting) also push the patrol to the quiet side", () => {
    const r = new Runner()
    r.step((o) => { ring(o, C, R); o.sounds = [gunSound(0, "mid"), gunSound(0.3, "mid")] })
    r.t += 3 // past the 2 s sound alert, still on the threat map
    const p = r.step((o) => ring(o, C, R))
    assert.equal(p.mode, "patrol")
    assert.ok(Math.cos((r.loco.state.rimSector! / L.rimSectors) * Math.PI * 2) < -0.4)
  })
  test("never the centre: the chosen point sits in the 78-88% band and inside the current safe rim", () => {
    const r = new Runner()
    const p = r.step((o) => ring(o, C, R))
    assert.equal(p.mode, "patrol")
    const pick = r.loco.pickRimSector(r.world, null, () => true, { center: C, radius: 500 }, { c: C, R })!
    const d = Math.hypot(pick.x, pick.y)
    assert.ok(d >= 0.78 * R - 1e-9 && d <= 0.88 * R + 1e-9, `rim band: ${d}`)
    // a current zone barely bigger than the next circle forces the inner fraction (rimMarginM inside the radius)
    const tight = r.loco.pickRimSector(r.world, null, (x, y) => Math.hypot(x, y) <= 0.85 * 200, { center: C, radius: 200 }, { c: C, R })!
    assert.ok(Math.hypot(tight.x, tight.y) <= 200 - L.rimMarginM && Math.hypot(tight.x, tight.y) <= 0.85 * 200 + 1e-9)
    // a small 40 m zone: the 8 m storm margin (32 m) is stricter than the 85% safe rim (34 m) -> the 78% radius
    const small = r.loco.pickRimSector(r.world, null, (x, y) => Math.hypot(x, y) <= 0.85 * 40, { center: C, radius: 40 }, { c: C, R: 40 })!
    assert.ok(Math.hypot(small.x, small.y) <= 40 - L.rimMarginM + 1e-9, `inside radius - margin: ${Math.hypot(small.x, small.y)}`)
  })
  test("sectors whose rim points are inside a building are skipped (synthetic building A)", () => {
    // circle centred at (-20, 5), R 30: the east sector (angle 0) lands inside building A at every rim fraction
    const map = syntheticMap()
    const r = new Runner(map)
    r.step((o) => { o.self.pos = [-20, 5, -2]; ring(o, [-20, 5], 30) })
    r.loco.state.threats.entries.push({ x: -50, y: 5, t: r.t, w: 1, id: null }) // loud west: east would win if walkable
    const pick = r.loco.pickRimSector(r.world, map, () => true, { center: [-20, 5], radius: 500 }, { c: [-20, 5], R: 30 })!
    assert.notEqual(pick.k, 0)
    assert.equal(map.isBlockedAt(pick.x, pick.y, map.heightAt(pick.x, pick.y), { radius: 2.5, height: 9, stepUp: 1.2 }), false)
  })
  test("hysteresis: a committed sector is kept against a marginally better one", () => {
    const r = new Runner()
    r.step((o) => ring(o, C, R))
    const loco = r.loco
    const at = () => loco.pickRimSector(r.world, null, () => true, { center: C, radius: 500 }, { c: C, R })!.k
    assert.equal(at(), 0, "from the centre with no threats: the first sector")
    // a faint threat right at sector 0: it scores 12, its neighbours 7.6 (better, but by less than the 15 hysteresis)
    loco.state.threats.entries.push({ x: 0.88 * R, y: 0, t: r.world.t, w: 0.12, id: null })
    assert.equal(at(), 0, "committed: kept")
    loco.state.rimSector = null
    assert.notEqual(at(), 0, "control: uncommitted, the quieter neighbour wins")
  })
  test("rotating north -> south around a threat at the centre follows the rim arc, never across the centre", () => {
    const r = new Runner()
    r.step((o) => { o.self.pos = [0, 170, 0]; ring(o, C, R); o.mechs = [enemy(5, [0, 140, 0]), enemy(6, [0, 0, 0])] })
    r.t += 6
    const p = r.step((o) => { o.self.pos = [0, 170, 0]; ring(o, C, R) })
    assert.equal(p.mode, "patrol")
    const k = r.loco.state.rimSector!
    assert.ok(Math.sin((k / L.rimSectors) * Math.PI * 2) < -0.4, `a southern sector: ${k}`)
    assert.ok(Math.abs(p.out.move[0]) > 0.9, `tangential along the rim: ${p.out.move}`)
    assert.ok(p.out.move[1] > -0.3, "not straight down through the centre")
  })
})

describe("v11: no voluntary chase of healthy bots", () => {
  const radial = (x: number, patch: (o: Observation) => void = () => {}) => {
    const r = once((o) => { o.mechs = [enemy(5, [x, 0, 0], { hp: 1000 })]; patch(o) })
    return { r, radial: dot(r.out.move, [1, 0]) }
  }
  test("1v1 at 115 m vs a 1000 HP enemy: no forward approach (the centre drift points away)", () => {
    const s = radial(115)
    assert.equal(s.r.mode, "strafe")
    assert.ok(s.radial <= 0.05, `radial ${s.radial}`)
  })
  test("near the centre the >95 m strafe drifts toward the quiet rim (away from the shooter)", () => {
    assert.ok(radial(115).radial < -0.1)
  })
  test("1v1 at 115 m vs a 300 HP enemy while healthy: forward push (+0.35) to finish", () => {
    const s = radial(115, (o) => (o.mechs = [enemy(5, [115, 0, 0], { hp: 300 })]))
    assert.equal(s.r.mode, "approach")
    assert.ok(Math.abs(s.radial - 0.35 / Math.hypot(1, 0.35)) < 1e-9, `radial ${s.radial}`)
    assert.notEqual(radial(115, (o) => { o.self.hp = 0.5 * o.self.max_hp; o.mechs = [enemy(5, [115, 0, 0], { hp: 300 })] }).r.mode, "approach", "us at 50%: no push")
  })
})

describe("v11: threat-aware farming", () => {
  test("prefers a quiet crate over a closer one 40 m from fresh gunfire", () => {
    const r = once((o) => {
      o.self.cubes = 0
      o.sounds = [gunSound(0, "mid")] // ~ (110, 0)
      o.crates = [{ id: 1001, pos: [70, 0, 0], hp: 300 }, { id: 1002, pos: [-72, 0, 0], hp: 300 }]
    })
    assert.equal(r.mode, "hunt")
    assert.ok(r.out.move[0] < -0.9, `toward the quiet crate (west): ${r.out.move}`)
  })
  test("a crate 5 m from fresh gunfire is skipped outright even when its value would still win", () => {
    const r = once((o) => {
      o.self.cubes = 0
      o.sounds = [gunSound(0, "near")] // ~ (35, 0)
      o.crates = [{ id: 1001, pos: [30, 0, 0], hp: 300 }, { id: 1002, pos: [-74, 0, 0], hp: 300 }]
    })
    assert.equal(r.mode, "hunt")
    assert.ok(r.out.move[0] < -0.9, `the far quiet crate: ${r.out.move}`)
  })
  test("control: with no threat the closer crate wins", () => {
    const r = once((o) => { o.self.cubes = 0; o.crates = [{ id: 1001, pos: [70, 0, 0], hp: 300 }, { id: 1002, pos: [-72, 0, 0], hp: 300 }] })
    assert.ok(r.out.move[0] > 0.9)
  })
  test("pickups are down-weighted (not skipped) near threats: the quieter laser wins", () => {
    const r = once((o) => {
      o.sounds = [gunSound(0, "mid")]
      o.pickups = [{ id: 8001, kind: "laser", pos: [60, 0, 0] }, { id: 8002, kind: "laser", pos: [-70, 0, 0] }]
    })
    assert.equal(r.mode, "loot")
    assert.ok(r.out.move[0] < -0.9, `${r.out.move}`)
  })
})

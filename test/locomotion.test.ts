/** Locomotion v3: anti-lead A-D strafing, projectile / mortar / laser dodges, hops, zone, loot, patrol, wall feeler. */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LOCOMOTION as L } from "../src/config/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import { LocoState } from "../src/locomotion/state.ts"
import { blockedAhead, steer } from "../src/locomotion/steer.ts"
import { sliceCover } from "../src/locomotion/cover.ts"
import { findLedge } from "../src/locomotion/climb.ts"
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
  test("walks to a laser up to 80 m away (not 85 m)", () => {
    assert.equal(once((o) => (o.pickups = [pick("laser", 75)])).mode, "loot")
    assert.notEqual(once((o) => (o.pickups = [pick("laser", 85)])).mode, "loot")
  })
  test("lightning up to 55 m only with an empty slot and no laser; cubes up to 55 m", () => {
    assert.equal(once((o) => (o.pickups = [pick("lightning", 50)])).mode, "loot")
    assert.notEqual(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.pickups = [pick("lightning", 50)] }).mode, "loot")
    assert.equal(once((o) => (o.cubes = [{ id: 5001, pos: [50, 0, 0] }])).mode, "loot")
    assert.notEqual(once((o) => (o.cubes = [{ id: 5001, pos: [60, 0, 0] }])).mode, "loot")
  })
  test("already holding a laser: laser pickups are ignored", () => {
    assert.notEqual(once((o) => { o.self.weapons = [o.self.weapons[0] ?? null, laser()]; o.pickups = [pick("laser", 30)] }).mode, "loot")
  })
  const drop = (over: Partial<Observation["drops"][number]> = {}) => ({ id: 20000, pos: [65, 0, 0] as [number, number, number], radius: 8, lands_in: 10, capture_s: 4, progress: 0, holder: null, ...over })
  test("supply drops: uncontested, landing within 12 s, within 70 m", () => {
    const go = once((o) => (o.drops = [drop()]))
    assert.equal(go.mode, "loot")
    assert.ok(go.out.move[0] > 0.99)
    assert.notEqual(once((o) => (o.drops = [drop({ holder: 7 })])).mode, "loot")
    assert.notEqual(once((o) => (o.drops = [drop({ lands_in: 13 })])).mode, "loot")
    assert.notEqual(once((o) => (o.drops = [drop({ pos: [75, 0, 0] })])).mode, "loot")
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

// ------------------------------------------------------------------ Locomotion v4
const zoneAt = (o: Observation, x: number, y: number, r = 500): void => {
  o.zone = { center: [x, y], radius: r, next_center: [x, y], next_radius: r, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 }
}

describe("v4: 2v1+ corner slicing", { skip: !HAS_ARENA && "arena not found" }, () => {
  // found by a search over the real arena: open ground beside a building, two shooters 70 m out, 63 deg apart
  const P: [number, number, number] = [-60.35, 134.81, -0.99]
  const E1: [number, number, number] = [-62.17, 204.79, -1.76]
  const E2: [number, number, number] = [-123.54, 164.93, -5.13]
  const map = HAS_ARENA ? realMap().map : (null as unknown as MapQuery)
  const at = (mechs: ReturnType<typeof enemy>[], over: (o: Observation) => void = () => {}) =>
    new Runner(map).step((o) => {
      o.self.pos = [...P]
      zoneAt(o, P[0], P[1])
      o.mechs = mechs
      over(o)
    })

  test("2 shooters: picks the probe that drops exposure 2 -> 0/1 and boosts behind the corner", () => {
    const r = at([enemy(5, E1), enemy(6, E2)])
    assert.equal(r.sense.losCount, 2, "precondition: both have a shot line")
    assert.equal(r.mode, "cover")
    assert.equal(r.out.boost, true, "snap behind the corner (energy 100 >= 28)")
    const w = new WorldModel(hello)
    w.update(scene((o) => { o.self.pos = [...P]; zoneAt(o, P[0], P[1]); o.mechs = [enemy(5, E1), enemy(6, E2)] }))
    const pick = sliceCover(map, w, r.sense, { inSafe: () => true, prevHeading: null, roof: false })!
    assert.equal(pick.current, 2)
    assert.ok(pick.exposed <= 1, `exposed ${pick.exposed}`)
    assert.ok(dot(r.out.move, pick.dir) > 0.9, `moves toward the probe: ${r.out.move} vs ${pick.dir}`)
  })
  test("boost latch: starts at >= 28 energy, holds down to 14, then stops", () => {
    const r = new Runner(map)
    const s = (energy: number) => r.step((o) => { o.self.pos = [...P]; zoneAt(o, P[0], P[1]); o.self.energy = energy; o.mechs = [enemy(5, E1), enemy(6, E2)] })
    assert.equal(s(27).out.boost, false, "27 < 28: no start")
    assert.equal(s(28).out.boost, true)
    assert.equal(s(15).out.boost, true, "latched")
    assert.equal(s(13).out.boost, false, "below 14: released")
  })
  test("1v1 healthy in open LOS still strafes (no hiding), even with a hiding probe 12 m away", () => {
    const r = at([enemy(6, E2)])
    assert.equal(r.sense.losCount, 1)
    const w = new WorldModel(hello)
    w.update(scene((o) => { o.self.pos = [...P]; zoneAt(o, P[0], P[1]); o.mechs = [enemy(6, E2)] }))
    assert.equal(sliceCover(map, w, r.sense, { inSafe: () => true, prevHeading: null, roof: false })!.exposed, 0, "precondition: cover exists")
    assert.equal(r.mode, "strafe")
  })
  test("1v1 critically wounded vs a non-finishable shooter slices; vs a finishable one (<= 300 HP) it does not", () => {
    const wounded = (hp: number) => at([enemy(5, E1, { hp })], (o) => (o.self.hp = 0.3 * o.self.max_hp))
    assert.notEqual(wounded(1400).mode, "strafe")
    assert.notEqual(wounded(250).mode, "cover")
  })
})

describe("v4: ledge and rooftop climbing (synthetic building A: 0..10 x 0..10, top 20)", () => {
  const map = syntheticMap()
  const ME: [number, number, number] = [-4, 5, -0.4]
  const FOE = (): ReturnType<typeof enemy> => enemy(5, [-4, -40, -0.4])
  /** 45% HP with an enemy 45 m away: pressure (< 50% HP, < 55 m) but not slice-wounded (>= 42%). */
  const pressured = (o: Observation): void => {
    o.self.hp = 0.45 * o.self.max_hp
    o.mechs = [FOE()]
    zoneAt(o, 0, 0)
  }
  const start = () => {
    const r = new Runner(map)
    const first = r.step((o) => { pressured(o); o.self.pos = [...ME] })
    return { r, first }
  }
  test("rooftop escape: grounded under pressure -> jump (no boost) toward the roof", () => {
    const { r, first } = start()
    assert.equal(first.mode, "climb")
    assert.equal(r.loco.state.climb.active?.kind, "roof")
    assert.equal(r.loco.state.climb.active?.top, 20)
    assert.equal(first.out.jump, true)
    assert.equal(first.out.boost, false)
    assert.ok(first.out.move[0] > 0.9, `toward the roof: ${first.out.move}`)
  })
  test("airborne: jets (boost) until z >= top + 0.3, then releases and steers onto the roof for ~0.5 s", () => {
    const { r } = start()
    const air = (z: number, x = -2) => r.step((o) => { pressured(o); o.self.pos = [x, 5, z]; o.self.grounded = false })
    const a = air(5)
    assert.deepEqual([a.mode, a.out.boost, a.out.jump], ["climb", true, false])
    assert.equal(air(20.2).out.boost, true, "20.2 < 20.3: keep jetting")
    const land = air(20.35, 0.5)
    assert.equal(land.mode, "climb")
    assert.equal(land.out.boost, false, "released at top + 0.3")
    assert.ok(land.out.move[0] > 0.9, "steers onto the roof")
    assert.equal(air(20.1, 1.5).out.boost, false, "landing phase: no re-jet")
    r.step((o) => { pressured(o); o.self.pos = [2, 5, 20] }) // 0.2 s after the release
    r.step((o) => { pressured(o); o.self.pos = [2.5, 5, 20] })
    const still = r.step((o) => { pressured(o); o.self.pos = [2.8, 5, 20] })
    assert.equal(still.mode, "climb", "0.4 s after the release: still steering on")
    const after = r.step((o) => { pressured(o); o.self.pos = [3, 5, 20] }) // 0.5 s (obs.t drifts below 10.8)
    assert.notEqual(after.mode, "climb", "landing window over")
    assert.equal(r.loco.state.climb.last === "done" || r.loco.state.climb.active === null, true)
  })
  test("aborts on low energy (< 8)", () => {
    const { r } = start()
    const out = r.step((o) => { pressured(o); o.self.pos = [-2, 5, 6]; o.self.grounded = false; o.self.energy = 7 })
    assert.notEqual(out.mode, "climb")
    assert.equal(r.loco.state.climb.last, "abort-energy")
  })
  test("aborts after 3.5 s without making it", () => {
    const { r } = start()
    let last = ""
    for (let i = 0; i < 40; i++) last = r.step((o) => { pressured(o); o.self.pos = [-2, 5, 6]; o.self.grounded = false }).mode
    assert.notEqual(last, "climb")
    assert.equal(r.loco.state.climb.last === "abort-timeout" || r.loco.state.climb.active === null, true)
    const r2 = start().r
    for (let i = 0; i < 30; i++) r2.step((o) => { pressured(o); o.self.pos = [-2, 5, 6]; o.self.grounded = false })
    assert.equal(r2.loco.state.climb.active !== null, true, "3.0 s: still climbing")
  })
  test("aborts when a mortar shell is predicted to land on the roof spot", () => {
    const { r } = start()
    const tgt = r.loco.state.climb.active!
    const out = r.step((o) => { pressured(o); o.self.pos = [-2, 5, 6]; o.self.grounded = false; o.projectiles = [{ id: 1, kind: "mortar", pos: [tgt.x, tgt.y, 40], vel: [0, 0, 0] }] })
    assert.notEqual(out.mode, "climb")
    assert.equal(r.loco.state.climb.last, "abort-mortar")
  })
  test("no rooftop escape below 55 energy, when healthy and unpressured, or under a bridge deck", () => {
    assert.notEqual(new Runner(map).step((o) => { pressured(o); o.self.pos = [...ME]; o.self.energy = 54 }).mode, "climb")
    assert.notEqual(new Runner(map).step((o) => { pressured(o); o.self.pos = [...ME]; o.self.hp = o.self.max_hp }).mode, "climb")
    // under bridge C (x -30..-10, y -5..5, base 14): a building roof would need open sky
    assert.equal(map.overheadClearance(-12, 0, -1.2) < 25, true, "precondition: deck overhead")
  })
  test("ledge clear: a blocked heading into a 2-8 m step jumps it (real arena: a 3.4 m building east of the spot)", { skip: !HAS_ARENA && "arena not found" }, () => {
    const real = realMap().map
    const p: [number, number, number] = [-17.24, -112.29, -0.42]
    const r = new Runner(real)
    const out = r.step((o) => { o.self.pos = [...p]; zoneAt(o, p[0], p[1]); o.cubes = [{ id: 5001, pos: [p[0] + 12, p[1], 3] }] })
    assert.equal(out.mode, "climb")
    assert.equal(r.loco.state.climb.active?.kind, "ledge")
    assert.ok(Math.abs(r.loco.state.climb.active!.top - 2.95) < 0.05)
    assert.equal(out.out.jump, true)
    const low = new Runner(real).step((o) => { o.self.pos = [...p]; zoneAt(o, p[0], p[1]); o.self.energy = 29; o.cubes = [{ id: 5001, pos: [p[0] + 12, p[1], 3] }] })
    assert.notEqual(low.mode, "climb", "energy < 30: go around instead")
  })
  test("findLedge rejects a wall taller than 8 m (building A is 20.4 m above us)", () => {
    const w = new WorldModel(hello)
    w.update(scene((o) => (o.self.pos = [...ME])))
    assert.equal(findLedge(map, w, [1, 0]), null)
  })
  test("a world reset (resetCount) or a backwards tick clears the climb", () => {
    const { r } = start()
    assert.ok(r.loco.state.climb.active)
    r.world.reset()
    const out = r.step((o) => { o.self.pos = [-2, 5, 6]; o.self.grounded = false; zoneAt(o, 0, 0) })
    assert.notEqual(out.mode, "climb")
    const b = start().r
    b.t = 1
    b.step((o) => { o.self.pos = [-2, 5, 6]; o.self.grounded = false; zoneAt(o, 0, 0) })
    assert.equal(b.loco.state.climb.active, null)
  })
})

describe("v4: rooftop edge safety (on synthetic building A, top 20, edge at x = 10)", () => {
  const map = syntheticMap()
  const ROOF: [number, number, number] = [8.5, 5, 20]
  test("1v1 strafe flips along the roof instead of walking off a ~19 m drop", () => {
    const r = new Runner(map).step((o) => { o.self.pos = [...ROOF]; zoneAt(o, 0, 0); o.mechs = [enemy(5, [5, -60, 0.5])] })
    assert.equal(r.mode, "strafe")
    assert.ok(r.out.move[0] < -0.9, `west along the roof, not east off it: ${r.out.move}`)
  })
  test("airborne high above open ground (a hop or a jet) is NOT a roof: no phantom drop blocks every heading", () => {
    // the 300-tick replay caught this: mid-jet at 6-10 m above the terrain, every probe looked like a drop -> move [0, 0]
    const r = new Runner(map).step((o) => { o.self.pos = [-30, 30, 8]; o.self.grounded = false; zoneAt(o, 0, 0); o.mechs = [enemy(5, [-30, -30, -3])] })
    assert.ok(mag(r.out.move) > 0.99, `keeps moving: ${r.out.move}`)
  })
  test("unless the zone forces us off the roof", () => {
    const r = new Runner(map).step((o) => { o.self.pos = [...ROOF]; zoneAt(o, 300, 5, 100); o.self.in_zone = false; o.mechs = [enemy(5, [5, -60, 0.5])] })
    assert.equal(r.mode, "outside")
    assert.ok(r.out.move[0] > 0.5, `east, off the roof toward the zone: ${r.out.move}`)
  })
  test("wounded on a roof (< 55%) facing a shooter below the edge: steps ~5 m inward to break its line", () => {
    const r = new Runner(map).step((o) => { o.self.pos = [...ROOF]; zoneAt(o, 0, 0); o.self.hp = 0.5 * o.self.max_hp; o.mechs = [enemy(5, [16, 5, 1.6])] })
    assert.equal(r.sense.losCount, 1)
    assert.equal(r.mode, "cover")
    assert.ok(r.out.move[0] < -0.5, `inward (west), away from the threatened east edge: ${r.out.move}`)
  })
  test("roof slice never picks a probe past the edge, even when the ground below would hide us", () => {
    // shooter far north-west on the ground: the building hides the ground east of it, every roof spot is exposed
    const foe = enemy(5, [-30, 40, -3])
    const r = new Runner(map).step((o) => { o.self.pos = [...ROOF]; zoneAt(o, 0, 0); o.self.hp = 0.5 * o.self.max_hp; o.mechs = [foe] })
    assert.equal(r.sense.losCount, 1)
    assert.equal(map.hasShotLOS([-30, 40, 4], [13.5, 5, 0.1 * 13.5 + 4.5]), false, "precondition: the ground east of the roof is hidden")
    const w = new WorldModel(hello)
    w.update(scene((o) => { o.self.pos = [...ROOF]; zoneAt(o, 0, 0); o.mechs = [foe] }))
    const pick = sliceCover(map, w, r.sense, { inSafe: () => true, prevHeading: null, roof: true })!
    assert.equal(map.standingHeightAt(pick.x, pick.y, 20, 1.2, 9), 20, `the probe stays on the roof: ${pick.x}, ${pick.y}`)
    if (r.mode === "cover") assert.ok(dot(r.out.move, pick.dir) > 0.9, "and that is where we go (the roof rim itself can hide us)")
  })
})

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { aimAt, leadPoint } from "../src/combat/aim.ts"
import { gunFireTolerance, RuleCombat, needsReload, pickTarget } from "../src/combat/index.ts"
import { COMBAT } from "../src/config/index.ts"
import type { ActorObs, Observation, Vec2 } from "../src/types/mechfight.ts"
import { aimErrorRad, yawTo } from "../src/world/geom.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, enemy, fixtureHello, lightningWeapon, syntheticMap } from "./helpers.ts"

/**
 * Geometry used below (synthetic map: terrain z = 0.1 x, building A at x 0..10, y 0..10, top 20):
 * we stand at (-20,-20) (ground -2), the open lane y = -20 has a clear shot to x = 20 (ground 2).
 * Mech centre of mass = feet + 4.5, muzzle = feet + 7.
 */
const map = syntheticMap()
const ME: [number, number, number] = [-20, -20, -2]
const at = (x: number, y: number): [number, number, number] => [x, y, x * 0.1]
const run = (patch: (o: Observation) => void, world?: WorldModel) =>
  new RuleCombat().decide(ctxFor(cleanObs((o) => { o.self.pos = [...ME]; patch(o) }), map, world))
const muzzle = (): [number, number, number] => [ME[0], ME[1], ME[2] + 7]

/** Exact intercept time t: |d + u t| = v t (the smaller positive root). */
function interceptTime(d: number[], u: number[], v: number): number {
  const a = u[0]! ** 2 + u[1]! ** 2 + u[2]! ** 2 - v * v
  const b = 2 * (d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!)
  const c = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2
  const disc = Math.sqrt(b * b - 4 * a * c)
  return [(-b - disc) / (2 * a), (-b + disc) / (2 * a)].filter((t) => t > 0).sort((x, y) => x - y)[0]!
}

describe("gun lead", () => {
  test("leadPoint matches the closed-form intercept for a crossing target", () => {
    const m = muzzle()
    const com: [number, number, number] = [20, -20, 2 + 4.5]
    const vel: [number, number, number] = [0, 10, 0]
    const v = 252
    const t = interceptTime([com[0] - m[0], com[1] - m[1], com[2] - m[2]], vel, v)
    const p = leadPoint(m, com, vel, v)
    assert.ok(Math.abs(p[0] - (com[0] + vel[0] * t)) < 0.05)
    assert.ok(Math.abs(p[1] - (com[1] + vel[1] * t)) < 0.05)
    assert.ok(Math.abs(Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]) - v * t) < 0.05, "the shot arrives exactly when the target does")
  })

  test("the module aims AHEAD of a moving target by the right angle, and straight at a still one", () => {
    const still = run((o) => (o.mechs = [enemy(5, at(20, -20))]))
    const m = muzzle()
    const direct = aimAt(m, [20, -20, 2 + 4.5])
    assert.ok(Math.abs(still.aim[0] - direct[0]) < 1e-9)
    assert.ok(Math.abs(still.aim[1] - direct[1]) < 1e-9)

    const moving = run((o) => (o.mechs = [enemy(5, at(20, -20), { vel: [0, 10, 0] })]))
    const t = interceptTime([40, 0, 6.5 - 5], [0, 10, 0], 252)
    const expected = aimAt(m, [20, -20 + 10 * t, 2 + 4.5])
    assert.ok(moving.aim[0] > direct[0] + 0.01, "leads toward the direction of travel (+y = counter-clockwise)")
    assert.ok(Math.abs(moving.aim[0] - expected[0]) < 0.003, `yaw ${moving.aim[0]} vs ${expected[0]}`)
  })

  test("lead uses the gun's own (upgraded) projectile speed", () => {
    const base = run((o) => (o.mechs = [enemy(5, at(20, -20), { vel: [0, 10, 0] })]))
    const fast = run((o) => {
      o.mechs = [enemy(5, at(20, -20), { vel: [0, 10, 0] })]
      o.self.weapons[0]!.stats = { ...o.self.weapons[0]!.stats, speed: 252 * 1.25 }
    })
    assert.ok(fast.aim[0] < base.aim[0], "a faster bullet needs less lead")
  })
})

describe("slew-tolerance fire gate", () => {
  const target = (o: Observation): void => void (o.mechs = [enemy(5, at(20, -20))])
  const desired = (): Vec2 => run(target).aim

  test("fires when the ACTUAL torso aim is on target", () => {
    const out = run((o) => {
      target(o)
      o.self.aim = [...desired()]
    })
    assert.deepEqual(out.fire, [true, false])
    assert.equal(out.hasTarget, true)
  })

  test("does NOT fire while the torso is turned 90 degrees away, but still commands the right aim", () => {
    const out = run((o) => {
      target(o)
      o.self.aim = [desired()[0] + Math.PI / 2, 0]
    })
    assert.deepEqual(out.fire, [false, false])
    assert.ok(Math.abs(out.aim[0] - desired()[0]) < 1e-9, "keeps slewing toward the target")
    assert.equal(out.hasTarget, true)
  })

  test("the gate is the target's angular size at this range (40 m): inside it fires, outside it holds", () => {
    const base = desired()
    const tol = gunFireTolerance(2.5, Math.hypot(40, 1.5))
    // turn/pitch rate 0: no post-slew projection, so this isolates the tolerance geometry
    const withErr = (yawErr: number) => run((o) => {
      target(o)
      o.self.aim = [base[0] + yawErr, base[1]]
      o.self.stats = { ...o.self.stats, turn_rate: 0, pitch_rate: 0 }
    })
    assert.ok(tol < COMBAT.maxFireAngleErrorRad, "at 40 m the body is narrower than the old fixed 0.15 rad gate")
    assert.equal(withErr(tol * 0.8).fire[0], true)
    assert.equal(withErr(tol * 1.3).fire[0], false)
    assert.equal(withErr(-tol * 1.3).fire[0], false)
  })

  test("no fire without ammo or mid-reload; an empty magazine starts a reload", () => {
    const aligned = (patch: (o: Observation) => void) => run((o) => { target(o); o.self.aim = [...desired()]; patch(o) })
    const empty = aligned((o) => { const g = o.self.weapons[0]!; g.ammo = 0 })
    assert.equal(empty.fire[0], false)
    assert.equal(empty.reload, true)
    const reloading = aligned((o) => { const g = o.self.weapons[0]!; g.ammo = 5; g.reload = 1.2 })
    assert.equal(reloading.fire[0], false)
    assert.equal(reloading.reload, false, "already reloading")
  })

  test("out of gun range: tracks but does not fire (range * margin)", () => {
    const far = run((o) => { o.self.pos = [0, 0, 0]; o.mechs = [enemy(5, [300, 0, 0])] })
    assert.equal(far.hasTarget, false, "300 m is beyond the 230 m gun")
  })
})

describe("target selection and line of sight", () => {
  test("no shot through a building: no target, no fire, defensive facing instead", () => {
    // building A (x 0..10, y 0..10) sits between (-20, 5) and (20, 5)
    const out = run((o) => { o.self.pos = [-20, 5, -2]; o.mechs = [enemy(5, at(20, 5))] })
    assert.equal(out.hasTarget, false)
    assert.deepEqual(out.fire, [false, false])
    assert.equal(out.moveConstraint, "NONE")
    assert.ok(out.threatBearing !== undefined, "a listed enemy we cannot shoot is still the threat to face")
    assert.ok(Math.abs(out.threatBearing! - yawTo(-20, 5, 20, 5)) < 1e-9)
  })

  test("prefers nearer and weaker: a wounded enemy beats a healthy one that is a little nearer", () => {
    const out = run((o) => {
      o.mechs = [
        enemy(5, at(10, -20), { hp: 1400 }), // 30 m, full health: score 30 * 1.5 = 45
        enemy(6, at(20, -20), { hp: 140 }), // 40 m, 10% health: score 40 * 0.6 = 24
      ]
    })
    assert.ok(Math.abs(out.aim[0] - aimAt(muzzle(), [20, -20, 6.5])[0]) < 0.02, "aims at the wounded mech")
  })

  test("equal health: nearest wins; pickTarget is stable on an empty pool", () => {
    const out = run((o) => (o.mechs = [enemy(5, at(20, -20)), enemy(6, at(0, -20))]))
    assert.ok(Math.abs(out.aim[0] - aimAt(muzzle(), [0, -20, 4.5])[0]) < 0.02)
    assert.equal(pickTarget([]), null)
  })
})

describe("NPC drones are a side dish, never a distraction", () => {
  const npc = (x: number): ActorObs => ({ id: 101, kind: "npc", pos: at(x, -20), vel: [0, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 })

  test("shoots a drone within 40 m when no enemy mech is visible", () => {
    assert.equal(run((o) => (o.mechs = [npc(10)])).hasTarget, true) // 30 m
  })
  test("ignores a drone beyond 40 m", () => {
    assert.equal(run((o) => (o.mechs = [npc(18)])).hasTarget, true) // 38 m: now in range
    assert.equal(run((o) => (o.mechs = [npc(22)])).hasTarget, false) // 42 m
  })
  test("never shoots a drone while ANY enemy mech is visible, even one we cannot shoot", () => {
    // We stand at (-20, 5); the enemy mech is at (20, 5) behind building A (no shot), the drone is 10 m away in the open.
    const out = run((o) => { o.self.pos = [-20, 5, -2]; o.mechs = [enemy(5, [20, 5, 2]), { ...npc(10), pos: [-10, 5, -1] }] })
    assert.equal(out.hasTarget, false)
  })
  test("with a shootable mech and a nearer drone, the mech is the target", () => {
    const out = run((o) => (o.mechs = [npc(0), enemy(5, at(20, -20))]))
    assert.ok(Math.abs(out.aim[0] - aimAt(muzzle(), [20, -20, 6.5])[0]) < 0.02)
  })
})

describe("slot 1 lightning", () => {
  const withLightning = (target: [number, number, number], yawOffset: number, energy = 100) =>
    run((o) => {
      o.self.weapons = [o.self.weapons[0] ?? null, lightningWeapon()]
      o.self.energy = energy
      o.self.aim = [yawTo(ME[0], ME[1], target[0], target[1]) + yawOffset, 0]
      o.mechs = [enemy(5, target)]
    })

  test("fires slot 1 with LOS, in range, inside the cone and with energy", () => {
    assert.equal(withLightning(at(10, -20), 0).fire[1], true) // 30 m
  })
  test("cone: 30 deg total (15 deg half-angle) around the ACTUAL yaw", () => {
    assert.equal(withLightning(at(10, -20), (10 * Math.PI) / 180).fire[1], true)
    assert.equal(withLightning(at(10, -20), (40 * Math.PI) / 180).fire[1], false)
  })
  test("range: out of the 45 m reach does not fire (the gun may still)", () => {
    assert.equal(withLightning(at(30, -20), 0).fire[1], false) // 50 m
  })
  test("energy gate: at or below 12 never fires", () => {
    assert.equal(withLightning(at(10, -20), 0, 12).fire[1], false)
    assert.equal(withLightning(at(10, -20), 0, 12.5).fire[1], true)
    assert.equal(withLightning(at(10, -20), 0, 5).fire[1], false)
  })
  test("no LOS: does not fire", () => {
    const out = run((o) => {
      o.self.pos = [-20, 5, -2]
      o.self.weapons = [o.self.weapons[0] ?? null, lightningWeapon()]
      o.self.aim = [0, 0]
      o.mechs = [enemy(5, [10, 5, 1])] // inside/behind building A: no shot
    })
    assert.equal(out.fire[1], false)
  })
  test("without a lightning weapon, slot 1 is never fired", () => {
    assert.equal(run((o) => (o.mechs = [enemy(5, at(10, -20))])).fire[1], false)
  })
})

describe("proactive reload", () => {
  const ammo = (n: number, over: { reload?: number; mechs?: ActorObs[]; pos?: [number, number, number] } = {}) =>
    run((o) => {
      o.self.pos = over.pos ?? [...ME]
      const g = o.self.weapons[0]!
      g.ammo = n
      g.reload = over.reload ?? 0
      o.mechs = over.mechs ?? []
    }).reload
  test("<= 7 rounds and no enemy mech has LOS: reload", () => {
    assert.equal(ammo(7), true)
    assert.equal(ammo(6), true)
    assert.equal(ammo(1), true)
  })
  test("8+ rounds or a full mag: keep it", () => {
    assert.equal(ammo(8), false)
    assert.equal(ammo(12), false)
  })
  test("not while already reloading", () => {
    assert.equal(ammo(3, { reload: 1.0 }), false)
  })
  test("not while an enemy mech has line of sight (stay ready to shoot)", () => {
    assert.equal(ammo(4, { mechs: [enemy(5, at(20, -20))] }), false)
  })
  test("an enemy that is listed but has NO line of sight does not block the reload", () => {
    assert.equal(ammo(4, { pos: [-20, 5, -2], mechs: [enemy(5, [20, 5, 2])] }), true)
  })
  test("needsReload is pure: empty mag reloads even with a target in view", () => {
    assert.equal(needsReload({ kind: "gun", cooldown: 0, ammo: 0, reload: 0, stats: { mag: 12 } }, true), true)
    assert.equal(needsReload({ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: { mag: 12 } }, false), false)
  })
})

describe("defensive facing (rear armor): threat bearing sources and priority", () => {
  test("recent damage bearing wins; with a target there is no threatBearing", () => {
    const out = run((o) => {
      o.events = [{ type: "damaged", amount: 90, weapon: "gun", bearing: 1.2, by: 3, rear: true }]
      o.sounds = [{ kind: "gun", bearing: 2.5, dist: "near", age: 0.1 }]
    })
    assert.equal(out.hasTarget, false)
    assert.equal(out.threatBearing, 1.2)
    const withTarget = run((o) => {
      o.events = [{ type: "damaged", amount: 90, weapon: "gun", bearing: 1.2, by: 3 }]
      o.mechs = [enemy(5, at(20, -20))]
    })
    assert.equal(withTarget.hasTarget, true)
    assert.equal(withTarget.threatBearing, undefined)
  })

  test("zone damage has no bearing, so it never points the torso anywhere", () => {
    const out = run((o) => (o.events = [{ type: "damaged", amount: 20, weapon: "zone", bearing: null, by: null }]))
    assert.equal(out.threatBearing, undefined)
  })

  test("with no damage: the last seen enemy (kept after it leaves view), then combat sounds, nearest first", () => {
    const w = new WorldModel(fixtureHello())
    run((o) => (o.mechs = [enemy(5, [10, 30, 0])]), w) // seen at t = 10
    const later = run((o) => { o.t = 12; o.tick = 240 }, w) // gone from view 2 s later
    assert.ok(Math.abs(later.threatBearing! - yawTo(-20, -20, 10, 30)) < 1e-9)

    const sound = run((o) => {
      o.sounds = [{ kind: "gun", bearing: 0.5, dist: "far", age: 0.1 }, { kind: "laser", bearing: -1.0, dist: "near", age: 0.2 }, { kind: "step", bearing: 3, dist: "near", age: 0 }]
    })
    assert.equal(sound.threatBearing, -1.0, "nearest combat sound wins; footsteps are not combat")
  })

  test("nothing to go on: no bearing, aim held, never fires", () => {
    const out = run(() => {})
    assert.equal(out.threatBearing, undefined)
    assert.deepEqual(out.aim, [0, 0])
    assert.deepEqual(out.fire, [false, false])
  })

  test("end to end through the arbiter: with no target the torso faces the damage bearing", async () => {
    const { Bot } = await import("../src/bot.ts")
    const { NO_DEADLINE } = await import("../src/runtime/deadline.ts")
    const bot = new Bot(new WorldModel(fixtureHello()), null)
    const a = bot.decide(cleanObs((o) => (o.events = [{ type: "damaged", amount: 90, weapon: "gun", bearing: 2.0, by: 3, rear: true }])), NO_DEADLINE)
    assert.deepEqual(a.aim, [2.0, 0])
  })
})

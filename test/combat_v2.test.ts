/** Combat v2 + laser economy: distance gate, kill-confirm focus, regen hold, laser state machine, weaving, farming. */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { aimAt, leadPoint } from "../src/combat/aim.ts"
import { gunFireTolerance, RuleCombat } from "../src/combat/index.ts"
import { COMBAT, ECONOMY } from "../src/config/index.ts"
import { RuleEconomy } from "../src/economy/index.ts"
import { Bot } from "../src/bot.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import type { MapQuery } from "../src/world/map.ts"
import type { Observation, Vec2, WeaponObs } from "../src/types/mechfight.ts"
import { aimErrorRad } from "../src/world/geom.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, enemy, fixtureHello, lightningWeapon, syntheticMap } from "./helpers.ts"

const hello = fixtureHello()
const laserStats = { ...(hello.config.weapons.laser as Record<string, number>) }
const laser = (over: Partial<WeaponObs> = {}): WeaponObs => ({ kind: "laser", cooldown: 0, charge: 0, stats: { ...laserStats }, ...over })
const MUZZLE: [number, number, number] = [0, 0, 7]
const comOf = (x: number, y: number, z = 0): [number, number, number] => [x, y, z + 4.5]

/** One decision with a fresh RuleCombat (or a given one), no map (LOS always clear) unless a map is passed. */
function fight(patch: (o: Observation) => void, opts: { map?: MapQuery | null; combat?: RuleCombat; world?: WorldModel } = {}) {
  const o = cleanObs(patch)
  const combat = opts.combat ?? new RuleCombat()
  return combat.decide(ctxFor(o, opts.map ?? null, opts.world))
}
const withLaser = (o: Observation, w: WeaponObs = laser()): void => {
  o.self.weapons = [o.self.weapons[0] ?? null, w]
}

describe("distance-scaled gun fire gate", () => {
  test("tolerance is the angle the target's body subtends (+margin), clamped", () => {
    assert.ok(Math.abs(gunFireTolerance(2.5, 100) - Math.atan2(3, 100)) < 1e-12)
    assert.ok(gunFireTolerance(2.5, 20) > 0.14 && gunFireTolerance(2.5, 20) <= COMBAT.maxFireAngleErrorRad)
    assert.equal(gunFireTolerance(2.5, 2), COMBAT.maxFireAngleErrorRad, "point blank: capped")
    assert.equal(gunFireTolerance(2.5, 1e6), COMBAT.minFireAngleRad, "far away: floored")
  })

  const aligned = (x: number, cubes?: number, yawErr = 0) => {
    const desired = aimAt(MUZZLE, comOf(x, 0))
    return fight((o) => {
      o.mechs = [enemy(5, [x, 0, 0], cubes === undefined ? {} : { cubes })]
      o.self.aim = [desired[0] + yawErr, desired[1]]
    })
  }

  test("blocks a 0.05 rad-off shot at 100 m (the old fixed 0.15 rad gate would have fired)", () => {
    assert.equal(aligned(100, undefined, 0.05).fire[0], false)
    assert.equal(aligned(100, undefined, 0.02).fire[0], true)
  })
  test("allows a 0.1 rad-off shot at 20 m", () => {
    assert.equal(aligned(20, undefined, 0.1).fire[0], true)
  })
  test("a bigger (cube-scaled) target is easier to hit: 0.035 rad at 100 m fires only at 10 cubes", () => {
    assert.equal(aligned(100, 0, 0.035).fire[0], false)
    assert.equal(aligned(100, 10, 0.035).fire[0], true)
  })
  test("keeps the velocity lead for the gun", () => {
    const out = fight((o) => (o.mechs = [enemy(5, [100, 0, 0], { vel: [0, 10, 0] })]))
    const lead = aimAt(MUZZLE, leadPoint(MUZZLE, comOf(100, 0), [0, 10, 0], 252))
    assert.ok(Math.abs(out.aim[0] - lead[0]) < 1e-9)
    assert.ok(out.aim[0] > 0.005, "aims ahead of the target")
  })
})

describe("kill-confirm focus", () => {
  test("a 150 HP enemy beats a full-HP one that is slightly closer", () => {
    const out = fight((o) => (o.mechs = [enemy(5, [30, 0, 0], { hp: 1400 }), enemy(6, [0, 40, 0], { hp: 150 })]))
    assert.ok(Math.abs(out.aim[0] - Math.PI / 2) < 0.02, `aims north at the 150 HP mech: ${out.aim[0]}`)
  })
  test("equal HP: the nearer one", () => {
    const out = fight((o) => (o.mechs = [enemy(5, [30, 0, 0]), enemy(6, [0, 60, 0])]))
    assert.ok(Math.abs(out.aim[0]) < 0.02)
  })
  test("holding a laser, a mortar carrier is preferred (cook-off); without a laser it is not", () => {
    const mechs = () => [enemy(5, [30, 0, 0], { weapons: ["gun"] }), enemy(6, [0, 35, 0], { weapons: ["gun", "mortar"] })]
    const withL = fight((o) => { withLaser(o, laser({ cooldown: 1 })); o.mechs = mechs() })
    assert.ok(Math.abs(withL.aim[0] - Math.PI / 2) < 0.02, "laser: cook the mortar carrier")
    const without = fight((o) => (o.mechs = mechs()))
    assert.ok(Math.abs(without.aim[0]) < 0.02, "no laser: the nearer one")
  })
  test("a charging enemy jumps the queue", () => {
    const out = fight((o) => (o.mechs = [enemy(5, [30, 0, 0]), enemy(6, [0, 45, 0], { charging: true })]))
    assert.ok(Math.abs(out.aim[0] - Math.PI / 2) < 0.02)
  })
})

describe("regen hold-fire (strict: < 35% HP, in zone, > 75 m, not finishable)", () => {
  const scene = (x: number, opts: { hpFrac?: number; foeHp?: number; inZone?: boolean } = {}) => {
    const desired = aimAt(MUZZLE, comOf(x, 0))
    return fight((o) => {
      o.self.hp = o.self.max_hp * (opts.hpFrac ?? 0.3)
      o.self.in_zone = opts.inZone ?? true
      o.self.aim = [...desired]
      o.mechs = [enemy(5, [x, 0, 0], { hp: opts.foeHp ?? 1400 })]
    })
  }
  test("holds fire on a distant healthy enemy but keeps facing it", () => {
    const out = scene(100)
    assert.deepEqual(out.fire, [false, false])
    assert.equal(out.hasTarget, true)
    assert.ok(Math.abs(out.aim[0]) < 0.01, "torso stays on the threat (front armour)")
  })
  test("shoots back at anything within 75 m (no hold in a brawl)", () => {
    assert.equal(scene(60).fire[0], true)
    assert.equal(scene(30).fire[0], true)
  })
  test("shoots a finishable target (<= 350 HP) even far away", () => {
    assert.equal(scene(100, { foeHp: 300 }).fire[0], true)
  })
  test("above 35% HP, or outside the zone (no regen there anyway): keep shooting", () => {
    assert.equal(scene(100, { hpFrac: 0.4 }).fire[0], true)
    assert.equal(scene(100, { inZone: false }).fire[0], true)
  })
})

describe("laser: hold to charge, release to fire", () => {
  test("starts charging on a LOS target in range, aiming hitscan at the centre (no lead)", () => {
    const out = fight((o) => { withLaser(o); o.mechs = [enemy(5, [100, 0, 0], { vel: [0, 10, 0] })] })
    assert.equal(out.fire[1], true)
    const centre = aimAt(MUZZLE, comOf(100, 0))
    assert.ok(Math.abs(out.aim[0] - centre[0]) < 1e-9 && Math.abs(out.aim[1] - centre[1]) < 1e-9, "no lead for a hitscan weapon")
  })
  test("never starts outside the zone, on cooldown, beyond range, or with an enemy in our face (<= 18 m)", () => {
    assert.equal(fight((o) => { withLaser(o); o.self.in_zone = false; o.mechs = [enemy(5, [100, 0, 0])] }).fire[1], false)
    assert.equal(fight((o) => { withLaser(o, laser({ cooldown: 1 })); o.mechs = [enemy(5, [100, 0, 0])] }).fire[1], false)
    assert.equal(fight((o) => { withLaser(o); o.mechs = [enemy(5, [300, 0, 0])] }).fire[1], false)
    assert.equal(fight((o) => { withLaser(o); o.mechs = [enemy(5, [100, 0, 0]), enemy(6, [10, 5, 0])] }).fire[1], false)
  })
  test("an enemy closing in does not abort a charge already under way", () => {
    const out = fight((o) => { withLaser(o, laser({ charge: 0.4 })); o.self.aim = [2, 0]; o.mechs = [enemy(5, [100, 0, 0]), enemy(6, [10, 5, 0])] })
    assert.equal(out.fire[1], true)
  })

  const charging = (charge: number, opts: { off?: number; hp?: number; weapons?: ("gun" | "mortar")[] } = {}) => {
    const c = aimAt(MUZZLE, comOf(100, 0))
    return fight((o) => {
      withLaser(o, laser({ charge }))
      o.self.aim = [c[0] + (opts.off ?? 0), c[1]]
      o.mechs = [enemy(5, [100, 0, 0], { hp: opts.hp ?? 1400, weapons: opts.weapons ?? ["gun"] })]
    })
  }
  test("releases (fire=false) once charged (~0.70 s) and aligned", () => {
    assert.equal(charging(0.7).fire[1], false)
    assert.equal(charging(0.5).fire[1], true, "not full yet and the shot would not kill: keep charging")
  })
  test("keeps holding a full charge while the torso is still off target", () => {
    assert.equal(charging(0.7, { off: 0.3 }).fire[1], true)
  })
  test("releases early when the charge already kills (and min_charge is in)", () => {
    assert.equal(charging(0.3, { hp: 150 }).fire[1], false) // 315 * (0.35 + 0.65 * 0.4) = 192 >= 150
    assert.equal(charging(0.1, { hp: 50 }).fire[1], true, "below min_charge (0.15 s): keep holding")
  })
  test("cook-off (+60%) counts toward the kill check on a mortar carrier", () => {
    assert.equal(charging(0.2, { hp: 250, weapons: ["gun", "mortar"] }).fire[1], false) // 165 * 1.6 = 264
    assert.equal(charging(0.2, { hp: 250 }).fire[1], true)
  })
  test("safety: never holds an off-target charge to the auto-fire limit", () => {
    const limit = laserStats["charge"]! + laserStats["hold_s"]! - COMBAT.laserHoldSafetyS
    assert.equal(charging(limit + 0.01, { off: 0.3 }).fire[1], false)
    assert.equal(charging(limit - 0.2, { off: 0.3 }).fire[1], true)
  })
  test("target lost mid-charge: holds briefly (0.3 s), then releases instead of crawling at half speed", () => {
    const combat = new RuleCombat()
    const world = new WorldModel(hello)
    const tick = (t: number, mechs: boolean) =>
      fight((o) => { o.t = t; o.tick = Math.round(t * 20); withLaser(o, laser({ charge: 0.4 })); o.self.aim = [2, 0]; o.mechs = mechs ? [enemy(5, [100, 0, 0])] : [] }, { combat, world })
    assert.equal(tick(10, true).fire[1], true)
    assert.equal(tick(10.2, false).fire[1], true, "0.2 s without LOS: keep it")
    assert.equal(tick(10.4, false).fire[1], false, "0.4 s: release")
  })
  test("releases right before the target slips behind cover", () => {
    // synthetic map: building A at x 0..10, y 0..10; we stand at (-20,-20); the target crosses north behind it
    const map = syntheticMap()
    const me: [number, number, number] = [-20, -20, -2]
    const m: [number, number, number] = [me[0], me[1], me[2] + 7]
    const pos: [number, number, number] = [12, -3, 1.2]
    const com: [number, number, number] = [12, -3, 5.7]
    assert.ok(map.hasShotLOS(m, com), "precondition: in the open now")
    assert.ok(!map.hasShotLOS(m, [12, 5, 5.7]), "precondition: behind the building in 0.2 s")
    const scene = (vy: number) =>
      fight((o) => {
        o.self.pos = [...me]
        withLaser(o, laser({ charge: 0.3 }))
        o.self.aim = [...aimAt(m, com)]
        o.mechs = [enemy(5, pos, { vel: [0, vy, 0] })]
      }, { map })
    assert.equal(scene(40).fire[1], false, "slipping away: take the shot now")
    assert.equal(scene(0).fire[1], true, "standing still: keep charging")
  })

  test("weaving: the gun keeps leading and firing while the laser cools down", () => {
    const target = enemy(5, [100, 0, 0], { vel: [0, 5, 0] })
    const lead = aimAt(MUZZLE, leadPoint(MUZZLE, comOf(100, 0), [0, 5, 0], 252))
    const out = fight((o) => { withLaser(o, laser({ cooldown: 1.2 })); o.self.aim = [...lead]; o.mechs = [target] })
    assert.equal(out.fire[0], true, "gun fires")
    assert.equal(out.fire[1], false, "laser idle")
    assert.ok(Math.abs(out.aim[0] - lead[0]) < 1e-9, "with the laser cooling, the torso leads for the gun")
  })
  test("weaving: the gun also fires during a charge when its lead is inside the gate", () => {
    const c = aimAt(MUZZLE, comOf(40, 0))
    const out = fight((o) => { withLaser(o, laser({ charge: 0.3 })); o.self.aim = [...c]; o.mechs = [enemy(5, [40, 0, 0])] })
    assert.deepEqual(out.fire, [true, true])
  })

  test("the whole bot never emits a drop for a slot whose laser is charging", () => {
    const bot = new Bot(new WorldModel(hello), null, {
      economy: { decide: () => ({ take: 8001, drop: 1, lootTargets: [] }) },
      combat: new RuleCombat(),
      locomotion: { decide: () => ({ move: [0, 0], boost: false, jump: false }) },
    })
    const a = bot.decide(cleanObs((o) => { withLaser(o, laser({ charge: 0.5 })); o.mechs = [enemy(5, [100, 0, 0])] }), NO_DEADLINE)
    assert.equal(a.drop, undefined)
    assert.equal(a.take, undefined)
  })
})

describe("lightning", () => {
  test("fires inside 45 m and the cone with energy > 12; holds at 12", () => {
    const shot = (energy: number) => fight((o) => { o.self.weapons = [o.self.weapons[0] ?? null, lightningWeapon()]; o.self.energy = energy; o.mechs = [enemy(5, [30, 0, 0])] })
    assert.equal(shot(50).fire[1], true)
    assert.equal(shot(12).fire[1], false)
  })
})

describe("safe crate and drone farming", () => {
  const crate = (x: number) => ({ id: 1001, pos: [x, 0, 0] as [number, number, number], hp: 300 })
  const farm = (patch: (o: Observation) => void = () => {}, world?: WorldModel) =>
    fight((o) => { o.crates = [crate(20)]; patch(o) }, world ? { world } : {})

  test("nobody around, in the zone, healthy: aims at the nearest crate and shoots it with the gun", () => {
    const first = farm()
    assert.equal(first.hasTarget, true)
    const aim: Vec2 = [...first.aim]
    assert.ok(Math.abs(aim[0]) < 1e-9)
    const out = farm((o) => (o.self.aim = [...aim]))
    assert.equal(out.fire[0], true)
  })
  test("stops the tick an enemy mech is in sight", () => {
    const out = farm((o) => (o.mechs = [enemy(5, [150, 0, 0])]))
    assert.ok(Math.abs(out.aim[0]) < 0.05)
    assert.equal(out.hasTarget, true, "targets the mech, not the crate")
    const desired = aimAt(MUZZLE, comOf(150, 0))
    assert.ok(aimErrorRad(out.aim, desired) < 0.02)
  })
  test("no farming with an enemy tracked within 50 m (even out of sight), below 65% HP, outside the zone, or beyond 45 m", () => {
    const world = new WorldModel(hello)
    farm((o) => (o.mechs = [enemy(5, [40, 10, 0])]), world)
    const later = farm((o) => { o.t = 11; o.tick = 220 }, world) // gone from view 1 s later, still tracked
    assert.equal(later.hasTarget, false)
    assert.equal(farm((o) => (o.self.hp = o.self.max_hp * 0.6)).hasTarget, false)
    assert.equal(farm((o) => (o.self.in_zone = false)).hasTarget, false)
    assert.equal(fight((o) => (o.crates = [crate(50)])).hasTarget, false)
  })
  test("a drone within 40 m with no enemy mech visible is shot (2 cubes)", () => {
    const out = fight((o) => (o.mechs = [{ id: 101, kind: "npc", pos: [30, 0, 0], vel: [0, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 }]))
    assert.equal(out.hasTarget, true)
  })
})

describe("economy: laser and supply drops", () => {
  const eco = (patch: (o: Observation) => void) => new RuleEconomy().decide(ctxFor(cleanObs(patch)))
  const pickup = (id: number, kind: "laser" | "lightning" | "mortar", x: number) => ({ id, kind, pos: [x, 0, 0] as [number, number, number] })

  test("empty slot: takes the laser over a nearer lightning", () => {
    assert.equal(eco((o) => (o.pickups = [pickup(8001, "lightning", 1), pickup(8002, "laser", 3)])).take, 8002)
  })
  test("holding lightning: swaps to a laser in reach (take + drop that slot) when no enemy is within 30 m", () => {
    const out = eco((o) => { o.self.weapons = [o.self.weapons[0] ?? null, lightningWeapon()]; o.pickups = [pickup(8002, "laser", 2)] })
    assert.equal(out.take, 8002)
    assert.equal(out.drop, 1)
  })
  test("no swap with an enemy mech within 30 m; swap again at 35 m", () => {
    const at = (x: number) => eco((o) => { o.self.weapons = [o.self.weapons[0] ?? null, lightningWeapon()]; o.pickups = [pickup(8002, "laser", 2)]; o.mechs = [enemy(5, [x, 0, 0])] })
    assert.equal(at(25).take, undefined)
    assert.equal(at(25).drop, undefined)
    assert.equal(at(35).take, 8002)
  })
  test("holding a laser already: no swap and no laser loot target", () => {
    const out = eco((o) => { withLaser(o); o.pickups = [pickup(8002, "laser", 2), pickup(8003, "lightning", 2)] })
    assert.equal(out.take, undefined)
    assert.equal(out.lootTargets.length, 0)
  })
  test("loot values: laser > lightning at the same distance; mortar never appears", () => {
    const out = eco((o) => (o.pickups = [pickup(8002, "laser", 20), { ...pickup(8003, "lightning", 0), pos: [0, 20, 0] }, pickup(8004, "mortar", 5)]))
    const [lz, lt] = [out.lootTargets.find((t) => t.x === 20)!, out.lootTargets.find((t) => t.y === 20)!]
    assert.ok(lz.value > lt.value)
    assert.equal(out.lootTargets.length, 2)
  })
  test("supply drops: uncontested, landing within 10 s, within 45 m", () => {
    const drop = (over: Partial<Observation["drops"][number]>) => ({ id: 20000, pos: [30, 0, 0] as [number, number, number], radius: 8, lands_in: 5, capture_s: 4, progress: 0, holder: null, ...over })
    const kinds = (d: Observation["drops"][number]) => eco((o) => (o.drops = [d])).lootTargets.map((t) => t.kind)
    assert.deepEqual(kinds(drop({})), ["supply_drop"])
    assert.deepEqual(kinds(drop({ holder: 7 })), [], "someone else is capturing it")
    assert.deepEqual(kinds(drop({ lands_in: 20 })), [], "lands too late")
    assert.deepEqual(kinds(drop({ pos: [60, 0, 0] })), [], "too far")
    assert.ok(ECONOMY.lootBaseValue["supply_drop"]! > ECONOMY.lootBaseValue["laser"]!)
  })
})

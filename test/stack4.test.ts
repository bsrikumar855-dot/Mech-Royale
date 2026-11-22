/** stack-3 defaults + stack-4 interactions: only-hunters + laser pre-charge (a bystander never gets a pre-charged beam). */
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { RuleCombat } from "../src/combat/index.ts"
import { COMBAT, LOCOMOTION as L } from "../src/config/index.ts"
import type { Observation, WeaponObs } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, enemy, fixtureHello } from "./helpers.ts"

const hello = fixtureHello()
const laserStats = { ...(hello.config.weapons.laser as Record<string, number>) }
const laser = (): WeaponObs => ({ kind: "laser", cooldown: 0, charge: 0, stats: { ...laserStats } })
const withLaser = (o: Observation): void => { o.self.weapons = [o.self.weapons[0] ?? null, laser()] }

describe("stack-3 defaults", () => {
  test("only-hunters off (stack-4 scored 4.98); retreat-count, pre-charge, farm-45 on", () => {
    assert.equal(COMBAT.onlyHunters, false)
    assert.equal(COMBAT.laserPrecharge, true)
    assert.equal(COMBAT.farmOutsideAggro, true)
    assert.equal(L.retreatByCount, true)
  })
})

describe("only-hunters + pre-charge interaction (if the filter is switched back on)", () => {
  const huntCfg = COMBAT as { onlyHunters: boolean }
  let saved = false
  before(() => { saved = huntCfg.onlyHunters; huntCfg.onlyHunters = true })
  after(() => { huntCfg.onlyHunters = saved })
  const preAfter = (patch: (o: Observation) => void) => {
    const combat = new RuleCombat()
    const world = new WorldModel(hello)
    combat.decide(ctxFor(cleanObs((o) => { o.t = 10; o.tick = 200; withLaser(o); patch(o) }), null, world))
    return combat.decide(ctxFor(cleanObs((o) => { o.t = 11; o.tick = 220; withLaser(o); o.mechs = [] }), null, world)).fire?.[1]
  }
  test("no pre-charge for a static full-HP bystander seen 1 s ago at 120 m", () => {
    assert.equal(preAfter((o) => (o.mechs = [enemy(5, [120, 0, 0])])), false)
  })
  test("pre-charge for one that damaged us", () => {
    assert.equal(preAfter((o) => { o.mechs = [enemy(5, [120, 0, 0])]; o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0, by: 5 }] }), true)
  })
  test("pre-charge for one closing in", () => {
    assert.equal(preAfter((o) => (o.mechs = [enemy(5, [120, 0, 0], { vel: [-8, 0, 0] })])), true)
  })
})

describe("stack-3: with only-hunters off, pre-charge works as on its own branch", () => {
  test("a static bystander seen 1 s ago at 120 m does get a pre-charge", () => {
    const combat = new RuleCombat()
    const world = new WorldModel(hello)
    combat.decide(ctxFor(cleanObs((o) => { o.t = 10; o.tick = 200; withLaser(o); o.mechs = [enemy(5, [120, 0, 0])] }), null, world))
    assert.equal(combat.decide(ctxFor(cleanObs((o) => { o.t = 11; o.tick = 220; withLaser(o); o.mechs = [] }), null, world)).fire?.[1], true)
  })
})

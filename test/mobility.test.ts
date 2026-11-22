/** mobility build: never take, swap for, walk to or hunt a laser; lightning fills the second slot. */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { ECONOMY } from "../src/config/index.ts"
import { RuleEconomy, wantsPickup, wantsSwap } from "../src/economy/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, fixtureHello, lightningWeapon } from "./helpers.ts"

const hello = fixtureHello()
const pickup = (id: number, kind: "laser" | "lightning", x: number, y = 0) => ({ id, kind, pos: [x, y, 0] as [number, number, number] })

describe("mobility build (ECONOMY.noLaser)", () => {
  test("defaults on", () => assert.equal(ECONOMY.noLaser, true))
  test("never wants a laser into an empty slot; still wants lightning", () => {
    const o = cleanObs()
    assert.equal(wantsPickup(o.self, pickup(8001, "laser", 1)), false)
    assert.equal(wantsPickup(o.self, pickup(8002, "lightning", 1)), true)
  })
  test("never swaps lightning for a laser", () => {
    const o = cleanObs((x) => { x.self.weapons = [x.self.weapons[0]!, lightningWeapon()] })
    assert.equal(wantsSwap(o.self, pickup(8001, "laser", 1)), false)
  })
  test("a laser at our feet is not taken; a lightning at our feet is", () => {
    const eco = new RuleEconomy()
    assert.equal(eco.decide(ctxFor(cleanObs((o) => (o.pickups = [pickup(8001, "laser", 1)])))).take, undefined)
    assert.equal(eco.decide(ctxFor(cleanObs((o) => (o.pickups = [pickup(8002, "lightning", 1)])))).take, 8002)
  })
  test("a laser 60 m away is not walked to (no arm / loot move toward it)", () => {
    const loco = new EvasiveLocomotion()
    const w = new WorldModel(hello)
    const patch = (o: Observation): void => { o.self.grounded = true; o.alive = 10; o.pickups = [pickup(8001, "laser", 0, 60)] }
    w.update(cleanObs(patch))
    loco.decide({ world: w, map: null, deadline: NO_DEADLINE }, [])
    assert.notEqual(loco.lastMode, "arm")
    assert.notEqual(loco.lastMode, "loot")
  })
  test("off switch: the laser is wanted again", () => {
    const cfg = ECONOMY as { noLaser: boolean }
    cfg.noLaser = false
    try {
      assert.equal(wantsPickup(cleanObs().self, pickup(8001, "laser", 1)), true)
    } finally {
      cfg.noLaser = true
    }
  })
})

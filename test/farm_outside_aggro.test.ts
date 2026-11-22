/** farm-45: farm drones from outside their aggro range, down to 45% HP. Crates keep the 85% gate. */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { RuleCombat } from "../src/combat/index.ts"
import { COMBAT, LOCOMOTION as L } from "../src/config/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import type { ActorObs, Observation } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, fixtureHello } from "./helpers.ts"

const hello = fixtureHello()
const aggro = (hello.config.npc as Record<string, number>).aggro_range!
const standoff = aggro + COMBAT.farmAggroMarginM
const drone = (x: number, y = 0): ActorObs => ({ id: 101, kind: "npc", pos: [x, y, 0], vel: [0, 0, 0], aim: [0, 0], hp: 350, max_hp: 350 })
const scene = (hpFrac: number, patch: (o: Observation) => void) =>
  cleanObs((o) => { o.self.grounded = true; o.alive = 10; o.self.cubes = 0; o.self.hp = o.self.max_hp * hpFrac; patch(o) })
const loco = (hpFrac: number, patch: (o: Observation) => void) => {
  const l = new EvasiveLocomotion()
  const w = new WorldModel(hello)
  w.update(scene(hpFrac, patch))
  const out = l.decide({ world: w, map: null, deadline: NO_DEADLINE }, [])
  return { out, mode: l.lastMode }
}
const combat = (hpFrac: number, patch: (o: Observation) => void) => new RuleCombat().decide(ctxFor(scene(hpFrac, patch)))

describe("farm drones from outside their aggro range (farm-45)", () => {
  test("defaults on; the stand-off is outside aggro and inside Combat's drone range", () => {
    assert.equal(COMBAT.farmOutsideAggro, true)
    assert.ok(standoff > aggro)
    assert.ok(standoff < aggro + COMBAT.farmAggroMarginM + COMBAT.farmEngageExtraM)
  })
  test("at 50% HP a drone 70 m away is hunted (was: only above 85%)", () => {
    const r = loco(0.5, (o) => (o.mechs = [drone(0, 70)]))
    assert.equal(r.mode, "hunt")
    assert.ok(r.out.move[1] > 0.99, `toward the drone: ${r.out.move}`)
  })
  test("holds outside aggro: stops at ~50 m, keeps walking at 60 m (was: held only at <= 35 m)", () => {
    assert.deepEqual(loco(0.9, (o) => (o.mechs = [drone(0, 48)])).out.move, [0, 0])
    assert.ok(loco(0.9, (o) => (o.mechs = [drone(0, 60)])).out.move[1] > 0.99)
  })
  test("below 45% HP: no drone hunting, no drone shooting (unless it hit us)", () => {
    assert.notEqual(loco(0.4, (o) => (o.mechs = [drone(0, 70)])).mode, "hunt")
    assert.equal(combat(0.4, (o) => (o.mechs = [drone(30)])).hasTarget, false)
  })
  test("Combat shoots a drone at 50 m and 50% HP (was: 40 m cap, 85% gate); not beyond the extended range", () => {
    assert.equal(combat(0.5, (o) => (o.mechs = [drone(50)])).hasTarget, true)
    assert.equal(combat(0.9, (o) => (o.mechs = [drone(standoff + COMBAT.farmEngageExtraM + 3)])).hasTarget, false)
  })
  test("crates keep the 85% gate", () => {
    const r = loco(0.5, (o) => (o.crates = [{ id: 1001, pos: [0, 60, 0] }]))
    assert.notEqual(r.mode, "hunt")
    assert.equal(L.huntCrateMinHpFrac, 0.85)
  })
  test("off switch: the 5ceea9a rules (85% gate, 35 m hold, 40 m engage)", () => {
    const cfg = COMBAT as { farmOutsideAggro: boolean }
    cfg.farmOutsideAggro = false
    try {
      assert.notEqual(loco(0.5, (o) => (o.mechs = [drone(0, 70)])).mode, "hunt")
      assert.equal(combat(0.9, (o) => (o.mechs = [drone(45)])).hasTarget, false)
      assert.ok(loco(0.9, (o) => (o.mechs = [drone(0, 40)])).out.move[1] > 0.99, "keeps closing to 35 m")
    } finally {
      cfg.farmOutsideAggro = true
    }
  })
})

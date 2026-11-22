/** only-hunters: target an enemy mech only when it is hunting us (damaging a bystander recruits it). */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { RuleCombat } from "../src/combat/index.ts"
import { COMBAT } from "../src/config/index.ts"
import type { ActorObs, Observation } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, enemy, fixtureHello } from "./helpers.ts"

const FAR: [number, number, number] = [120, 0, 0]
const decideWith = (combat: RuleCombat, world: WorldModel, patch: (o: Observation) => void) => combat.decide(ctxFor(cleanObs(patch), null, world))
const once = (m: ActorObs, patch: (o: Observation) => void = () => {}) =>
  decideWith(new RuleCombat(), new WorldModel(fixtureHello()), (o) => { o.mechs = [m]; patch(o) })

describe("only-hunters target filter", () => {
  test("defaults on", () => assert.equal(COMBAT.onlyHunters, true))

  test("a static full-HP bystander at 120 m is not targeted (no fire)", () => {
    const out = once(enemy(5, FAR))
    assert.equal(out.hasTarget, false)
    assert.notEqual(out.fire?.[0], true)
  })

  test("it becomes a target once it damages us, and stays one for hunterRecentS", () => {
    const combat = new RuleCombat()
    const world = new WorldModel(fixtureHello())
    const hit = decideWith(combat, world, (o) => { o.mechs = [enemy(5, FAR)]; o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0, by: 5 }] })
    assert.equal(hit.hasTarget, true)
    const later = decideWith(combat, world, (o) => { o.tick = 300; o.t = 10 + COMBAT.hunterRecentS - 1; o.mechs = [enemy(5, FAR)] })
    assert.equal(later.hasTarget, true, "still a hunter 9 s later")
    const gone = decideWith(combat, world, (o) => { o.tick = 400; o.t = 10 + COMBAT.hunterRecentS + COMBAT.hunterStickyS + 2; o.mechs = [enemy(5, FAR)] })
    assert.equal(gone.hasTarget, false, "forgotten once it stops shooting")
  })

  test("close, closing in, low HP or charging: always a hunter", () => {
    assert.equal(once(enemy(5, [COMBAT.hunterCloseM - 5, 0, 0])).hasTarget, true, "close")
    assert.equal(once(enemy(5, FAR, { vel: [-(COMBAT.hunterClosingMps + 2), 0, 0] })).hasTarget, true, "closing")
    assert.equal(once(enemy(5, FAR, { vel: [0, 8, 0] })).hasTarget, false, "crossing, not closing")
    assert.equal(once(enemy(5, FAR, { hp: 300 })).hasTarget, true, "low HP")
    assert.equal(once(enemy(5, FAR, { charging: true })).hasTarget, true, "charging a laser")
  })

  test("the hunter is aimed at, not a cheaper (weaker) bystander", () => {
    const out = once(enemy(5, FAR), (o) => {
      o.mechs = [enemy(6, [100, 60, 0], { hp: 600 }), enemy(5, FAR)]
      o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0, by: 5 }]
    })
    assert.equal(out.hasTarget, true)
    assert.ok(Math.abs(out.aim![0]) < 0.05, `aims east at the hunter, got yaw ${out.aim![0]}`)
  })

  test("off switch restores the old targeting", () => {
    const cfg = COMBAT as { onlyHunters: boolean }
    cfg.onlyHunters = false
    try {
      assert.equal(once(enemy(5, FAR)).hasTarget, true)
    } finally {
      cfg.onlyHunters = true
    }
  })
})

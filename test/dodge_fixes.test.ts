/** dodge-fixes: the planner plans with the speed and body size we really have (laser charge slowdown, cube growth). */
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { LOCOMOTION as L } from "../src/config/index.ts"
import { planEvasion, threateningBullets } from "../src/locomotion/evade.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { cleanObs, ctxFor, fixtureHello } from "./helpers.ts"

const hello = fixtureHello()
const laserStats = { ...(hello.config.weapons.laser as Record<string, number>) }
type Cfg = { evadeChargeAware: boolean; evadeCubeSize: boolean }
const cfg = L as unknown as Cfg
/** A gun bullet from `dist` m east aimed at our centre; we stand still at the origin. */
const plan = (dist: number, patch: (o: Observation) => void, sw: Partial<Cfg> = {}) => {
  const saved = { ...cfg }
  Object.assign(cfg, sw)
  try {
    const w = ctxFor(cleanObs((o) => { o.self.pos = [0, 0, 0]; o.projectiles = [{ id: 1, kind: "gun", pos: [dist, 0, 4.5], vel: [-252, 0, 0] }]; patch(o) })).world
    return planEvasion(w, null, null, false, threateningBullets(w))
  } finally {
    Object.assign(cfg, saved)
  }
}
const charging = (o: Observation): void => { o.self.weapons = [o.self.weapons[0] ?? null, { kind: "laser", cooldown: 0, charge: 0.3, stats: { ...laserStats } }] }

describe("dodge-fixes", () => {
  let saved: Cfg
  before(() => { saved = { ...cfg }; cfg.evadeChargeAware = true; cfg.evadeCubeSize = true })
  after(() => Object.assign(cfg, saved))

  test("defaults on", () => {
    assert.equal(saved.evadeChargeAware, true)
    assert.equal(saved.evadeCubeSize, true)
  })
  test("laser charging (half speed): a walking sidestep cannot clear a 120 m shot, so it boosts", () => {
    const off = plan(120, charging, { evadeChargeAware: false })
    assert.ok(off && off.damage === 0 && !off.boost, `unaware planner trusts a walk it cannot make: ${JSON.stringify(off)}`)
    const on = plan(120, charging)
    assert.ok(on && on.damage === 0 && on.boost, `aware planner boosts: ${JSON.stringify(on)}`)
  })
  test("laser charging with no energy for a boost: no fake dodge (keeps the wanted move)", () => {
    const on = plan(120, (o) => { charging(o); o.self.energy = 0 })
    assert.ok(on === null || on.damage > 0, JSON.stringify(on))
  })
  test("not charging: unchanged (a walking sidestep is enough)", () => {
    const on = plan(120, () => {})
    assert.ok(on && on.damage === 0 && !on.boost, JSON.stringify(on))
  })
  test("10 cubes (1.5x body): a walking sidestep no longer clears a 120 m shot, so it boosts", () => {
    const big = (o: Observation): void => { o.self.cubes = 10 }
    const off = plan(120, big, { evadeCubeSize: false })
    assert.ok(off && off.damage === 0 && !off.boost, JSON.stringify(off))
    const on = plan(120, big)
    assert.ok(on && on.damage === 0 && on.boost, JSON.stringify(on))
  })
  test("cube size never shrinks the body below the server's stats", () => {
    const on = plan(120, (o) => { o.self.cubes = 0; o.self.stats = { ...o.self.stats, radius: 3.8 } })
    assert.ok(on && on.boost, "a 3.8 m server radius is used even with 0 cubes")
  })
})

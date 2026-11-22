/** los-guard: line-of-sight and nav segment checks stay bounded on absurd input (an enemy at 1e308 m hung the bot). */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { Bot } from "../src/bot.ts"
import { MAP } from "../src/config/index.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, enemy, fixtureHello, syntheticMap } from "./helpers.ts"

describe("los-guard", () => {
  const map = syntheticMap()
  test("hasShotLOS to a point 1e308 m away returns at once, and counts as blocked", () => {
    const t0 = performance.now()
    assert.equal(map.hasShotLOS([0, 0, 7], [1e308, -1e308, 4.5]), false)
    assert.ok(performance.now() - t0 < 50, "bounded")
  })
  test("non-finite end points count as blocked (never fire at garbage)", () => {
    assert.equal(map.hasShotLOS([0, 0, 7], [Number.NaN, 0, 4.5]), false)
    assert.equal(map.hasShotLOS([0, 0, 7], [Number.POSITIVE_INFINITY, 0, 4.5]), false)
    assert.equal(map.hasVisionLOS([0, 0, 8], [Number.NaN, 0, 4.5]), false)
  })
  test("the cap sits far above any in-arena query (arena diagonal ~1300 m)", () => {
    assert.ok(MAP.terrainLosMaxSteps * MAP.terrainLosStepM >= 3 * 1300)
  })
  test("ordinary queries are unchanged: open ground is clear", () => {
    assert.equal(map.hasShotLOS([-50, -50, 7], [-50, -20, 4.5]), true)
  })
  test("a whole decide() with an enemy at 1e308 m answers within the budget", () => {
    const hello = fixtureHello()
    const bot = new Bot(new WorldModel(hello), map)
    const t0 = performance.now()
    const a = bot.decide(cleanObs((o) => (o.mechs = [enemy(3, [1e308, -1e308, 0])])), NO_DEADLINE)
    assert.ok(performance.now() - t0 < 50, `${(performance.now() - t0).toFixed(1)} ms`)
    assert.equal(a.tick, 200)
  })
})

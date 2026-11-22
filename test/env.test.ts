import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { LOCOMOTION as L, WORLD } from "../src/config/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import { cleanObs, enemy, fixtureHello, realMap, HAS_ARENA, ROOT } from "./helpers.ts"

const STREAM = join(ROOT, "_kit", "check", "stream.jsonl.gz")

const step = (w: WorldModel, t: number, alive: number, patch: (o: Observation) => void = () => {}) =>
  w.update(cleanObs((o) => { o.t = t; o.tick = Math.round(t * 20); o.alive = alive; patch(o) }))

describe("free-for-all detector (deaths that are not ours)", () => {
  test("starts as practice", () => {
    const w = new WorldModel(fixtureHello())
    step(w, 1, 16)
    assert.equal(w.ffa, false)
  })
  test("our own kills never count", () => {
    const w = new WorldModel(fixtureHello())
    step(w, 10, 15, (o) => (o.events = [{ type: "kill", target: 3 }]))
    step(w, 20, 14, (o) => (o.events = [{ type: "kill", target: 4 }]))
    step(w, 30, 14)
    assert.equal(w.externalDeathsEarly, 0)
    assert.equal(w.ffa, false)
  })
  test("two deaths that are not ours inside the window: free-for-all, and it stays on", () => {
    const w = new WorldModel(fixtureHello())
    step(w, 18, 15)
    step(w, 18.5, 15)
    assert.equal(w.ffa, false, "one is not enough")
    step(w, 22.7, 14)
    step(w, 23.2, 14)
    assert.equal(w.ffa, true)
    step(w, 300, 14)
    assert.equal(w.ffa, true, "sticky")
  })
  test("deaths after the window (the zone can kill by then) do not count", () => {
    const w = new WorldModel(fixtureHello())
    step(w, WORLD.ffaWindowS + 10, 13)
    step(w, WORLD.ffaWindowS + 11, 13)
    assert.equal(w.ffa, false)
  })
  test("alive drops one observation BEFORE our kill event: the transient is not believed", () => {
    const w = new WorldModel(fixtureHello())
    step(w, 30, 15) // our victim already gone from `alive`...
    step(w, 30.1, 15, (o) => (o.events = [{ type: "kill", target: 2 }])) // ...the kill event lands next tick
    step(w, 31, 14)
    step(w, 31.1, 14, (o) => (o.events = [{ type: "kill", target: 5 }]))
    step(w, 35, 14)
    assert.equal(w.externalDeathsEarly, 0)
    assert.equal(w.ffa, false)
  })
  test("a new match (reset) clears it", () => {
    const w = new WorldModel(fixtureHello())
    step(w, 20, 14)
    step(w, 21, 14)
    assert.equal(w.ffa, true)
    w.reset()
    assert.equal(w.ffa, false)
    assert.equal(w.ourKills, 0)
  })
  test("the kit's recorded real match (alive 16 -> 13 by t = 25 s, no kill of ours) is classified free-for-all", { skip: !existsSync(STREAM) }, () => {
    const rows = gunzipSync(readFileSync(STREAM)).toString().trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l))
    const w = new WorldModel(rows[0])
    let at: number | null = null
    for (const o of rows.slice(1).filter((r: { type: string }) => r.type === "obs") as Observation[]) {
      w.update(o)
      if (w.ffa && at === null) at = o.t
    }
    assert.ok(at !== null && at < 30, `detected at ${at}`)
  })
})

describe("vanish only in a detected free-for-all", () => {
  const wounded = (w: WorldModel, t: number, alive: number) =>
    step(w, t, alive, (o) => { o.self.pos = [0, 0, 0]; o.self.hp = 300; o.mechs = [enemy(5, [80, 0, 0])]; o.events = [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0, by: 5 }] })
  test("practice (no external deaths): the old retreat, never vanish", { skip: !HAS_ARENA }, () => {
    assert.equal(L.vanishOnlyInFfa, true)
    const map = realMap().map
    const w = new WorldModel(fixtureHello())
    const loco = new EvasiveLocomotion()
    for (let k = 0; k < 10; k++) {
      wounded(w, 50 + k * 0.1, 16)
      loco.decide({ world: w, map, deadline: { remaining: () => 99, expired: () => false } as never }, [])
      assert.notEqual(loco.lastMode, "vanish")
    }
  })
})

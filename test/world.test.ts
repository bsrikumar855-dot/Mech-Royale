import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { WORLD } from "../src/config/index.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { fixtureHello, fixtureObs } from "./helpers.ts"

const obsAt = (tick: number, patch: (o: Observation) => void = () => {}): Observation => {
  const o = structuredClone(fixtureObs()[0] as Observation)
  o.tick = tick
  o.t = tick / 20
  o.mechs = []
  o.events = []
  o.sounds = []
  patch(o)
  return o
}

describe("WorldModel", () => {
  test("reads rules from hello.config (no hardcoded balance numbers)", () => {
    const h = fixtureHello()
    const w = new WorldModel(h)
    assert.equal(w.rules.radius, (h.config.mech as Record<string, number>)["radius"])
    assert.equal(w.rules.maxLineBytes, (h.config.bot as Record<string, number>)["max_line_bytes"])
    assert.equal(w.rules.memoryS, h.config.vision.memory_s)
  })

  test("tracks enemies, expires them after memory + grace, keeps bounded history", () => {
    const w = new WorldModel(fixtureHello())
    for (let i = 0; i < 40; i++) {
      w.update(obsAt(i * 2, (o) => {
        o.mechs = [{ id: 5, kind: "mech", pos: [i, 0, 0], vel: [20, 0, 0], aim: [0, 0], hp: 900, max_hp: 1400, weapons: ["gun"], charging: false }]
      }))
    }
    const tr = w.tracks.get(5)!
    assert.equal(tr.history.length, WORLD.historySamples)
    assert.equal(w.enemies().length, 1)
    assert.deepEqual(w.estimateVelocity(tr), [20, 0, 0])
    w.update(obsAt(160)) // t=8.0, last listed t=3.9: 4.1 s unseen < memory_s (5) + grace (1)
    assert.equal(w.tracks.has(5), true)
    w.update(obsAt(400)) // t=20: 16 s unseen
    assert.equal(w.tracks.has(5), false)
  })

  test("velocity falls back to a finite difference when vel is not finite", () => {
    const w = new WorldModel(fixtureHello())
    w.update(obsAt(0, (o) => (o.mechs = [{ id: 7, kind: "mech", pos: [0, 0, 0], vel: [NaN, 0, 0], aim: [0, 0] }])))
    w.update(obsAt(20, (o) => (o.mechs = [{ id: 7, kind: "mech", pos: [10, 0, 0], vel: [NaN, 0, 0], aim: [0, 0] }])))
    const v = w.estimateVelocity(w.tracks.get(7)!)
    assert.ok(Math.abs(v[0] - 10) < 1e-9)
  })

  test("track count, sounds and damage records stay bounded", () => {
    const w = new WorldModel(fixtureHello())
    w.update(obsAt(0, (o) => {
      o.mechs = Array.from({ length: 200 }, (_, i) => ({ id: 100 + i, kind: "npc" as const, pos: [i, 0, 0] as [number, number, number], vel: [0, 0, 0] as [number, number, number], aim: [0, 0] as [number, number] }))
      o.sounds = Array.from({ length: 500 }, () => ({ kind: "gun", bearing: 0, dist: "near" as const, age: 0 }))
      o.events = Array.from({ length: 300 }, () => ({ type: "damaged" as const, amount: 1, weapon: "gun", bearing: 0.3, by: 2 }))
    }))
    assert.ok(w.tracks.size <= WORLD.maxTracks)
    assert.ok(w.sounds.length <= WORLD.maxSounds)
    assert.ok(w.damage.length <= WORLD.maxDamageRecords)
  })

  test("reset() clears match state; a tick regression resets automatically (new match, same process)", () => {
    const w = new WorldModel(fixtureHello())
    w.update(obsAt(100, (o) => (o.mechs = [{ id: 3, kind: "mech", pos: [0, 0, 0], vel: [0, 0, 0], aim: [0, 0] }])))
    assert.equal(w.tracks.size, 1)
    w.update(obsAt(0)) // tick went backwards
    assert.equal(w.tracks.size, 0)
    w.update(obsAt(2, (o) => (o.mechs = [{ id: 3, kind: "mech", pos: [0, 0, 0], vel: [0, 0, 0], aim: [0, 0] }])))
    w.reset()
    assert.equal(w.tracks.size, 0)
    assert.equal(w.obs, null)
    assert.equal(w.sounds.length + w.damage.length, 0)
  })

  test("a kill event removes the track", () => {
    const w = new WorldModel(fixtureHello())
    w.update(obsAt(0, (o) => (o.mechs = [{ id: 9, kind: "mech", pos: [0, 0, 0], vel: [0, 0, 0], aim: [0, 0] }])))
    w.update(obsAt(2, (o) => (o.events = [{ type: "kill", target: 9 }])))
    assert.equal(w.tracks.has(9), false)
  })

  test("zoneAt interpolates the shrink window and holds before/after it", () => {
    const w = new WorldModel(fixtureHello())
    w.update(obsAt(0, (o) => {
      o.zone = { center: [0, 0], radius: 100, next_center: [40, -20], next_radius: 60, shrink_start: 10, shrink_end: 20, dps: 20 }
    }))
    assert.deepEqual(w.zoneAt(5), { center: [0, 0], radius: 100 })
    assert.deepEqual(w.zoneAt(15), { center: [20, -10], radius: 80 })
    assert.deepEqual(w.zoneAt(25), { center: [40, -20], radius: 60 })
  })

  test("recentThreatBearing returns the latest non-zone damage bearing within the window", () => {
    const w = new WorldModel(fixtureHello())
    w.update(obsAt(20, (o) => (o.events = [{ type: "damaged", amount: 50, weapon: "gun", bearing: 1.5, by: 4, rear: true }])))
    assert.equal(w.recentThreatBearing(3), 1.5)
    w.update(obsAt(22, (o) => (o.events = [{ type: "damaged", amount: 20, weapon: "zone", bearing: null, by: null }])))
    assert.equal(w.recentThreatBearing(3), 1.5)
    assert.equal(w.recentThreatBearing(0.01), null)
  })
})

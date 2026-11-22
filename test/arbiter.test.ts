import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { clampAim, clampMove, fitToLine, mergeAction } from "../src/arbiter.ts"
import type { CombatOutput, EconomyOutput, LocomotionOutput } from "../src/types/contracts.ts"
import type { Observation } from "../src/types/mechfight.ts"
import { WorldModel } from "../src/world/world.ts"
import { fixtureHello, fixtureObs } from "./helpers.ts"

const baseObs = (): Observation => structuredClone(fixtureObs()[0] as Observation)

function worldWith(patch: (o: Observation) => void): WorldModel {
  const w = new WorldModel(fixtureHello())
  const o = baseObs()
  patch(o)
  w.update(o)
  return w
}

const combat = (over: Partial<CombatOutput> = {}): CombatOutput => ({ aim: [0, 0], fire: [false, false], reload: false, moveConstraint: "NONE", hasTarget: true, ...over })
const loco = (over: Partial<LocomotionOutput> = {}): LocomotionOutput => ({ move: [0, 0], boost: false, jump: false, ...over })
const econ = (over: Partial<EconomyOutput> = {}): EconomyOutput => ({ lootTargets: [], ...over })

describe("arbiter invariants", () => {
  test("never drop (or swap out) a laser that is charging; the take is cancelled with it", () => {
    const w = worldWith((o) => {
      o.self.weapons = [o.self.weapons[0] ?? null, { kind: "laser", cooldown: 0, charge: 0.3, stats: {} }]
    })
    const a = mergeAction({ tick: 1, world: w, economy: econ({ take: 8001, drop: 1 }), combat: combat(), locomotion: loco() })
    assert.equal(a.drop, undefined)
    assert.equal(a.take, undefined)
  })

  test("drop/take are allowed when the laser is NOT charging, or the slot is not the laser", () => {
    const w = worldWith((o) => {
      o.self.weapons = [o.self.weapons[0] ?? null, { kind: "laser", cooldown: 0, charge: 0, stats: {} }]
    })
    const idle = mergeAction({ tick: 1, world: w, economy: econ({ take: 8001, drop: 1 }), combat: combat(), locomotion: loco() })
    assert.equal(idle.drop, 1)
    assert.equal(idle.take, 8001)
    const w2 = worldWith((o) => {
      o.self.weapons = [o.self.weapons[0] ?? null, { kind: "laser", cooldown: 0, charge: 0.5, stats: {} }]
    })
    const otherSlot = mergeAction({ tick: 1, world: w2, economy: econ({ take: 8001, drop: 0 }), combat: combat(), locomotion: loco() })
    assert.equal(otherSlot.drop, 0)
  })

  test("move is clamped to length <= 1; garbage becomes standing still", () => {
    assert.deepEqual(clampMove([3, 4]), [0.6, 0.8])
    assert.deepEqual(clampMove([0.3, 0.4]), [0.3, 0.4])
    assert.deepEqual(clampMove([NaN, 1]), [0, 0])
    assert.deepEqual(clampMove(undefined), [0, 0])
    assert.deepEqual(clampMove([Infinity, 0]), [0, 0])
  })

  test("aim: yaw wrapped to (-PI, PI], pitch clamped to the mech's limits, garbage dropped", () => {
    const a = clampAim([3 * Math.PI, 9], -0.7, 1.3)!
    assert.ok(Math.abs(Math.abs(a[0]) - Math.PI) < 1e-9)
    assert.equal(a[1], 1.3)
    assert.equal(clampAim([0, -9], -0.7, 1.3)![1], -0.7)
    assert.equal(clampAim([NaN, 0], -0.7, 1.3), undefined)
    const w = worldWith(() => {})
    const out = mergeAction({ tick: 5, world: w, economy: econ(), combat: combat({ aim: [0.5, 99] }), locomotion: loco() })
    assert.equal(out.aim![1], w.rules.maxPitch)
  })

  test("HOLD_POSITION overrides locomotion", () => {
    const w = worldWith(() => {})
    const a = mergeAction({ tick: 2, world: w, economy: econ(), combat: combat({ moveConstraint: "HOLD_POSITION" }), locomotion: loco({ move: [1, 0], boost: true, jump: true }) })
    assert.deepEqual(a.move, [0, 0])
    assert.equal(a.boost, false)
    assert.equal(a.jump, false)
  })

  test("defensive facing: with no target, face the threat bearing; with a target, Combat's aim wins", () => {
    const w = worldWith(() => {})
    const idle = mergeAction({ tick: 3, world: w, economy: econ(), combat: combat({ hasTarget: false, aim: [0, 0.4], threatBearing: 1.2 }), locomotion: loco() })
    assert.deepEqual(idle.aim, [1.2, 0])
    const busy = mergeAction({ tick: 3, world: w, economy: econ(), combat: combat({ hasTarget: true, aim: [0.1, 0.4], threatBearing: 1.2 }), locomotion: loco() })
    assert.deepEqual(busy.aim, [0.1, 0.4])
  })

  test("pick is only emitted for a real offer and a valid choice index", () => {
    const none = mergeAction({ tick: 4, world: worldWith(() => {}), economy: econ({ pick: 1 }), combat: combat(), locomotion: loco() })
    assert.equal(none.pick, undefined)
    const w = worldWith((o) => {
      o.offer = { id: 1, expires: 99, choices: [{ id: "a", name: "A", desc: "" }, { id: "b", name: "B", desc: "" }, { id: "c", name: "C", desc: "" }] }
    })
    assert.equal(mergeAction({ tick: 4, world: w, economy: econ({ pick: 2 }), combat: combat(), locomotion: loco() }).pick, 2)
    assert.equal(mergeAction({ tick: 4, world: w, economy: econ({ pick: 3 }), combat: combat(), locomotion: loco() }).pick, undefined)
    assert.equal(mergeAction({ tick: 4, world: w, economy: econ({ pick: -1 }), combat: combat(), locomotion: loco() }).pick, undefined)
  })

  test("the action always echoes the tick and is JSON-serialisable", () => {
    const w = worldWith(() => {})
    const a = mergeAction({ tick: 77, world: w, economy: econ(), combat: combat(), locomotion: loco({ move: [NaN, NaN] }) })
    assert.equal(a.tick, 77)
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(a)))
  })

  test("fitToLine: an oversized debug payload is dropped, then falls back to {tick}", () => {
    const big = { tick: 9, move: [1, 0] as [number, number], debug: { label: "x".repeat(70000) } }
    assert.deepEqual(fitToLine(big, 65536), { tick: 9, move: [1, 0] })
    const huge = { tick: 9, aim: [0, 0] as [number, number] }
    assert.deepEqual(fitToLine(huge, 5), { tick: 9 })
    assert.equal(fitToLine({ tick: 1 }, 65536).tick, 1)
  })
})

describe("P6: locomotion scan yaw", () => {
  test("used only when Combat has no target and no threat bearing", () => {
    const w = worldWith(() => {})
    const scan = mergeAction({ tick: 1, world: w, economy: econ(), combat: combat({ hasTarget: false, aim: [0, 0] }), locomotion: loco({ scanYaw: 1 }) })
    assert.ok(Math.abs(scan.aim![0] - 1) < 1e-9)
    const threat = mergeAction({ tick: 1, world: w, economy: econ(), combat: combat({ hasTarget: false, aim: [0, 0], threatBearing: 2 }), locomotion: loco({ scanYaw: 1 }) })
    assert.ok(Math.abs(threat.aim![0] - 2) < 1e-9)
    const target = mergeAction({ tick: 1, world: w, economy: econ(), combat: combat({ hasTarget: true, aim: [0.5, 0] }), locomotion: loco({ scanYaw: 1 }) })
    assert.ok(Math.abs(target.aim![0] - 0.5) < 1e-9)
  })
})

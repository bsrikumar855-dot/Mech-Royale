/** Mortar ballistics: pure solve/impact/safety math, independent of RuleCombat (see combat_v2.test.ts for integration). */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { mortarFireTolerance, mortarImpact, mortarSafeToFire, mortarSolve } from "../src/combat/mortar.ts"
import { COMBAT } from "../src/config/index.ts"

const MUZZLE: [number, number, number] = [0, 0, 9.5]
const SPEED = 72
const GRAVITY = 22
const TTL = 7
const MIN_PITCH = -0.7
const MAX_PITCH = 1.3
const solve = (pos: [number, number, number], vel: [number, number, number] = [0, 0, 0]) =>
  mortarSolve({ muzzle: MUZZLE, pos, vel, speed: SPEED, gravity: GRAVITY, maxTimeS: TTL, minPitch: MIN_PITCH, maxPitch: MAX_PITCH })

describe("mortarSolve: round-trips through mortarImpact (the solved arc actually lands on the target)", () => {
  test("a stationary target on level ground", () => {
    const target: [number, number, number] = [50, 0, 9.5]
    const sol = solve(target)
    assert.ok(sol, "a 50 m level shot is well within range")
    const impact = mortarImpact(MUZZLE, sol!.aim, SPEED, GRAVITY, sol!.flightTimeS)
    assert.ok(Math.hypot(impact[0] - target[0], impact[1] - target[1], impact[2] - target[2]) < 0.05)
  })

  test("a target above us, and one below", () => {
    for (const dz of [20, -15]) {
      const target: [number, number, number] = [40, 30, 9.5 + dz]
      const sol = solve(target)
      assert.ok(sol, `dz=${dz} should still solve`)
      const impact = mortarImpact(MUZZLE, sol!.aim, SPEED, GRAVITY, sol!.flightTimeS)
      assert.ok(Math.hypot(impact[0] - target[0], impact[1] - target[1], impact[2] - target[2]) < 0.05, `dz=${dz}`)
    }
  })

  test("a moving target: the fixed-point iteration converges on where it will actually be at impact", () => {
    const target: [number, number, number] = [60, 0, 9.5]
    const vel: [number, number, number] = [0, 8, 0]
    const sol = solve(target, vel)
    assert.ok(sol)
    const predicted: [number, number, number] = [target[0], target[1] + vel[1] * sol!.flightTimeS, target[2]]
    const impact = mortarImpact(MUZZLE, sol!.aim, SPEED, GRAVITY, sol!.flightTimeS)
    assert.ok(Math.hypot(impact[0] - predicted[0], impact[1] - predicted[1], impact[2] - predicted[2]) < 0.1)
  })

  test("prefers the flatter (low-arc) of the two ballistic solutions", () => {
    const sol = solve([50, 0, 9.5])
    assert.ok(sol)
    assert.ok(Math.abs(sol!.aim[1]) < Math.PI / 4, "a 50 m shot at this speed should not need anywhere near a 45 deg+ lob")
  })

  test("out of range at this speed/gravity (discriminant negative): null, never a wild guess", () => {
    assert.equal(solve([500, 0, 9.5]), null, "500 m is far beyond the ~235 m level-ground max for speed 72 / gravity 22")
  })

  test("directly overhead/underfoot (zero horizontal range): null", () => {
    assert.equal(solve([0, 0, 50]), null)
  })

  test("a ttl too short for even the low-arc flight time: null (it would self-destruct first)", () => {
    assert.ok(solve([50, 0, 9.5]), "sanity: this shot solves with the real 7 s ttl")
    assert.equal(mortarSolve({ muzzle: MUZZLE, pos: [50, 0, 9.5], vel: [0, 0, 0], speed: SPEED, gravity: GRAVITY, maxTimeS: 0.1, minPitch: MIN_PITCH, maxPitch: MAX_PITCH }), null)
  })

  test("invalid inputs (no speed, no gravity, no time) never throw and always return null", () => {
    assert.equal(mortarSolve({ muzzle: MUZZLE, pos: [50, 0, 9.5], vel: [0, 0, 0], speed: 0, gravity: GRAVITY, maxTimeS: TTL, minPitch: MIN_PITCH, maxPitch: MAX_PITCH }), null)
    assert.equal(mortarSolve({ muzzle: MUZZLE, pos: [50, 0, 9.5], vel: [0, 0, 0], speed: SPEED, gravity: 0, maxTimeS: TTL, minPitch: MIN_PITCH, maxPitch: MAX_PITCH }), null)
    assert.equal(mortarSolve({ muzzle: MUZZLE, pos: [50, 0, 9.5], vel: [0, 0, 0], speed: SPEED, gravity: GRAVITY, maxTimeS: 0, minPitch: MIN_PITCH, maxPitch: MAX_PITCH }), null)
  })
})

describe("mortarSafeToFire: never fire into our own blast", () => {
  const SELF: [number, number, number] = [0, 0, 0]
  test("an impact well clear of us is safe", () => {
    assert.equal(mortarSafeToFire(SELF, [50, 0, 0], 7, 5), true)
  })
  test("an impact inside splashRadius + margin of us is not", () => {
    assert.equal(mortarSafeToFire(SELF, [10, 0, 0], 7, 5), false, "10 m < 7 + 5")
    assert.equal(mortarSafeToFire(SELF, [12, 0, 0], 7, 5), false, "right at the boundary: not strictly beyond it")
    assert.equal(mortarSafeToFire(SELF, [12.01, 0, 0], 7, 5), true)
  })
})

describe("mortarFireTolerance: splash forgives a miss, within a cap", () => {
  test("widens with splash radius and shrinks with distance, like the gun's tolerance", () => {
    assert.ok(Math.abs(mortarFireTolerance(7, 50) - Math.atan2(7, 50)) < 1e-12)
    assert.ok(mortarFireTolerance(7, 1000) >= COMBAT.minFireAngleRad)
  })
  test("capped at mortarMaxAimErrorRad even point-blank", () => {
    assert.equal(mortarFireTolerance(7, 1), COMBAT.mortarMaxAimErrorRad)
  })
})

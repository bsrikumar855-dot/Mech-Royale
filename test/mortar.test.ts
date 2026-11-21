/** Mortar ballistics: pure solve/impact/safety math, independent of RuleCombat (see combat_v2.test.ts for integration). */
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { bestCluster, mortarFireTolerance, mortarImpact, mortarSafeToFire, mortarSolve, type ClusterCand } from "../src/combat/mortar.ts"
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

describe("bestCluster: the densest group of 2+ candidates within range, closing v1's gap (it never sought clusters)", () => {
  const cand = (x: number, y: number, dist = Math.hypot(x, y)): ClusterCand => ({ pos: [x, y, 0], vel: [0, 0, 0], dist })

  test("a single candidate is never a cluster, no matter how close to the muzzle", () => {
    assert.equal(bestCluster([cand(10, 0)], 10.5, 90), null)
  })

  test("two close together: a cluster, centroid and avg velocity of exactly those two", () => {
    const a = { pos: [10, 0, 0] as const, vel: [2, 0, 0] as const, dist: 10 }
    const b = { pos: [10, 8, 0] as const, vel: [0, 4, 0] as const, dist: Math.hypot(10, 8) }
    const c = bestCluster([a, b], 10.5, 90)
    assert.ok(c)
    assert.deepEqual(c!.centroid, [10, 4, 0])
    assert.deepEqual(c!.avgVel, [1, 2, 0])
    assert.equal(c!.size, 2)
  })

  test("two candidates farther apart than clusterRadiusM: not a cluster", () => {
    assert.equal(bestCluster([cand(10, 0), cand(10, 20)], 10.5, 90), null)
  })

  test("a candidate beyond maxRangeM is excluded from clustering entirely, even if it would complete one", () => {
    const near = cand(10, 0)
    const atLimit = cand(10, 8)
    const tooFar = { ...cand(10, 8), dist: 95 } // same position, but reported beyond maxRangeM
    assert.ok(bestCluster([near, atLimit], 10.5, 90), "sanity: these two do cluster")
    assert.equal(bestCluster([near, tooFar], 10.5, 90), null, "the far one is dropped before clustering, leaving only one candidate")
  })

  test("picks the LARGEST group when more than one cluster exists", () => {
    const pair = [cand(-50, 0), cand(-50, 5)] // cluster of 2, far from the trio below
    const trio = [cand(50, 0), cand(50, 5), cand(50, -5)] // cluster of 3
    const c = bestCluster([...pair, ...trio], 10.5, 90)
    assert.ok(c)
    assert.equal(c!.size, 3)
    assert.equal(c!.centroid[0], 50)
  })

  test("empty or all-isolated input: null, never throws", () => {
    assert.equal(bestCluster([], 10.5, 90), null)
    assert.equal(bestCluster([cand(10, 0), cand(-10, 0)], 10.5, 90), null)
  })
})

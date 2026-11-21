import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { segmentHitsPrism, makePrism } from "../src/world/polygon.ts"
import { syntheticMap } from "./helpers.ts"

const body = { radius: 2.5, height: 9, stepUp: 1.2 }
const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`)

describe("MapQuery on an exact synthetic map", () => {
  const map = syntheticMap()

  test("bilinear terrain height is exact on a plane, clamped outside the grid", () => {
    near(map.heightAt(10.5, 3), 1.05)
    near(map.heightAt(-12.25, 7.75), -1.225)
    near(map.heightAt(0, 0), 0)
    near(map.heightAt(500, 0), 5) // x clamped to the +50 edge
    near(map.heightAt(-500, 0), -5)
  })

  test("slope in degrees", () => {
    near(map.slopeDegAt(5, 5), (Math.atan(0.1) * 180) / Math.PI, 1e-4)
  })

  test("prism containment with a hole", () => {
    assert.equal(map.prismContaining(22, 30, 5)?.top, 15) // in the ring, outside the hole
    assert.equal(map.prismContaining(30, 30, 5), null) // inside the hole
    assert.equal(map.prismContaining(22, 30, 16), null) // above the top
    assert.equal(map.prismContaining(22, 30, -6), null) // below the base
    assert.equal(map.prismsAt(30, 30).length, 0)
  })

  test("elevated bridge underside: walk and shoot under, stand on the deck", () => {
    assert.equal(map.prismContaining(-20, 0, 15)?.kind, "bridge")
    assert.equal(map.prismContaining(-20, 0, 5), null)
    near(map.overheadClearance(-20, 0, -2), 16)
    assert.equal(map.overheadClearance(5, 5, 30), Infinity)
    near(map.standingHeightAt(-20, 0, -2, 1.2, 9), -2) // ground under the bridge, 16 m of headroom
    near(map.standingHeightAt(-20, 0, 15.5, 1.2, 9), 16) // on the deck
    assert.equal(map.isBlockedAt(-20, 0, -2, body), false) // base 14 is above the 9 m head: walk under
    assert.ok(map.hasShotLOS([-25, 0, 2], [-15, 0, 2])) // shot passes under
    assert.ok(!map.hasShotLOS([-25, 0, 15], [-15, 0, 15])) // shot into the deck
  })

  test("roof elevation", () => {
    assert.equal(map.roofHeightAt(5, 5), 20)
    assert.equal(map.roofHeightAt(15, 15), null)
    near(map.standingHeightAt(5, 5, 20, 1.2, 9), 20) // on the roof
    near(map.standingHeightAt(5, 5, 0, 1.2, 9), map.heightAt(5, 5)) // too low to step up: ground
  })

  test("wall slide: blocked into the wall, free along it, free in open ground", () => {
    const z = map.heightAt(-3, 5)
    assert.deepEqual(map.slideMove(-3, 5, z, 1, 1, body), [0, 1]) // x blocked by the wall at x=0, y free
    assert.deepEqual(map.slideMove(-3, 5, z, 1, 0, body), [0, 0])
    assert.deepEqual(map.slideMove(-3, 5, z, -1, 0, body), [-1, 0])
    assert.deepEqual(map.slideMove(-40, 40, map.heightAt(-40, 40), 1, 1, body), [1, 1])
    // a wall that is lower than the step height is walked over, not a wall
    assert.equal(map.isBlockedAt(5, 5, 19.5, body), false)
  })

  test("3D shot LOS: buildings, holes, terrain, open air", () => {
    assert.ok(!map.hasShotLOS([-5, 5, 5], [15, 5, 5])) // through building A
    assert.ok(map.hasShotLOS([-5, 5, 25], [15, 5, 25])) // over its roof
    assert.ok(!map.hasShotLOS([5, 5, 30], [5, 5, 10])) // straight down into the roof
    assert.ok(!map.hasShotLOS([0, -20, 0], [40, -20, 2])) // into rising terrain (ground 4 at x=40)
    assert.ok(map.hasShotLOS([0, -20, 0], [40, -20, 6]))
    assert.ok(!map.hasShotLOS([21, 30, 5], [39, 30, 5])) // solid wall segments either side of the hole
    assert.ok(map.hasShotLOS([26, 30, 5], [34, 30, 5])) // entirely inside the courtyard hole
    assert.ok(map.hasShotLOS([26, 30, 5], [34, 30, 5]))
  })

  test("vision LOS: trunk blocks, dense crown blocks, grazing crown and canopy:false see through", () => {
    assert.ok(!map.hasVisionLOS([-10, -30, 1.5], [10, -30, 1.5], { canopy: false })) // trunk (z -3..2); 1.5 clears the terrain (max 1 here)
    assert.ok(!map.hasVisionLOS([-10, -30, 4], [10, -30, 4])) // crown centre chord 6 m: transmittance exp(-2.1) < 0.25
    assert.ok(map.hasVisionLOS([-10, -30, 4], [10, -30, 4], { canopy: false })) // trunk ends at crownBase, shots ignore trees
    assert.ok(map.hasVisionLOS([-10, -27.3, 4], [10, -27.3, 4])) // grazes the crown edge (offset 2.7 of R=3): chord 2.6 m, transmittance ~0.40 > 0.25
    assert.ok(map.hasShotLOS([-10, -30, 1.5], [10, -30, 1.5])) // the same ray through the trunk: trees never stop shots
  })
})

describe("segmentHitsPrism edge cases", () => {
  const sq = makePrism("building", 0, 10, [0, 0, 10, 0, 10, 10, 0, 10])
  test("segment fully inside, fully outside, touching only the slab", () => {
    assert.ok(segmentHitsPrism(sq, 2, 2, 5, 8, 8, 5))
    assert.ok(!segmentHitsPrism(sq, 20, 20, 5, 30, 30, 5))
    assert.ok(!segmentHitsPrism(sq, 2, 2, 11, 8, 8, 11)) // above
    assert.ok(segmentHitsPrism(sq, 5, 5, 20, 5, 5, -20)) // vertical through the slab
    assert.ok(!segmentHitsPrism(sq, 15, 5, 20, 15, 5, -20)) // vertical, outside the footprint
  })
})

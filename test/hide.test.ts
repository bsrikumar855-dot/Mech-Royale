import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { findHideSpot, seenBy, type Watcher } from "../src/locomotion/hide.ts"
import { MapQuery, type WorldJson } from "../src/world/map.ts"
import { cleanObs, ctxFor } from "./helpers.ts"

const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1]
/** Flat 200 x 200 m, one tall building east of the origin: x 10..30, y -15..15, 40 m high. */
function oneBuilding(): MapQuery {
  const n = 201
  const world: WorldJson = {
    bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    terrain: { minX: -100, minY: -100, step: 1, nx: n, ny: n, scale: 0.01 },
    rules: { maxStep: 1.5, maxSlopeDeg: 50, canopyDensity: 0.35, canopyBlockT: 0.25 },
    prisms: [{ kind: "building", base: -5, top: 40, ring: rect(10, -15, 30, 15) }],
    trees: { fields: ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "osm", "crownX", "crownY"], data: [] },
  }
  return new MapQuery(world, new Int16Array(n * n))
}
const W = (x: number, y: number): Watcher => ({ x, y, eye: 8 })
const everywhere = () => true

describe("vanish: who can see us (protocol vision rules)", () => {
  const map = oneBuilding()
  test("open ground: a watcher 80 m away sees us", () => {
    assert.equal(seenBy(map, [W(-80, 0)], 0, 0, 0, 9, 45), true)
  })
  test("the building between us and the watcher hides us (centre and top both blocked)", () => {
    assert.equal(seenBy(map, [W(80, 0)], 0, 0, 0, 9, 45), false)
  })
  test("seen by any one of several watchers = seen", () => {
    assert.equal(seenBy(map, [W(80, 0), W(0, 80)], 0, 0, 0, 9, 45), true)
  })
})

describe("vanish: hide-spot search", () => {
  const map = oneBuilding()
  const world = ctxFor(cleanObs((o) => (o.self.pos = [40, 0, 0]))).world // east of the building, in the open

  test("seen from the west across open ground: the chosen spot is behind the building (hidden from the watcher)", () => {
    const watcher = W(-80, 30) // north-west, sees us over the building's north side? no: we check the spot, not us
    const spot = findHideSpot(world, map, null, [W(120, 0)], everywhere)
    assert.ok(spot, "a hidden spot exists")
    assert.equal(seenBy(map, [W(120, 0)], spot.x, spot.y, 0, 9, 45), false)
    void watcher
  })
  test("nowhere to hide (watchers all around on open ground beyond reach): null, the caller keeps its retreat", () => {
    const open = ctxFor(cleanObs((o) => (o.self.pos = [-60, -60, 0]))).world
    const ring = [W(-60, 20), W(20, -60), W(-140, -60)]
    assert.equal(findHideSpot(open, map, null, ring, everywhere), null)
  })
  test("unseen: drifting mode picks the hidden spot FARTHEST from where we were last seen", () => {
    const spot = findHideSpot(world, map, null, [], everywhere, [0, 0])!
    assert.ok(Math.hypot(spot.x, spot.y) > Math.hypot(40, 0) + 30, `moved away from the last-seen point: ${spot.x},${spot.y}`)
  })
  test("respects the safe zone predicate", () => {
    const spot = findHideSpot(world, map, null, [W(120, 0)], (x) => x > 35)
    assert.ok(spot === null || spot.x > 35)
  })
})

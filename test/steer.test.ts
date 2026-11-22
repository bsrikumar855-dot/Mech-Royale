import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { blockedAhead, steer } from "../src/locomotion/steer.ts"
import { LocoState } from "../src/locomotion/state.ts"
import { MapQuery, type WorldJson } from "../src/world/map.ts"
import { cleanObs, ctxFor } from "./helpers.ts"

/**
 * 200 x 200 m arena, no buildings. Terrain: flat at 0 for x < 5, an EMBANKMENT rising to 3 m between x = 5 and 6
 * (a 3 m rise in 1 m: a wall for a 1.2 m step_up), flat at 3 m beyond. Separately, a gentle 20 deg ramp for y > 20.
 */
function embankment(): MapQuery {
  const n = 201
  const h = new Int16Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -100 + i
      const y = -100 + j
      let z = x >= 6 ? 3 : x >= 5 ? 3 * (x - 5) : 0
      if (y > 20 && x < 0) z = Math.tan((20 * Math.PI) / 180) * (y - 20)
      h[j * n + i] = Math.round(z * 100)
    }
  }
  const world: WorldJson = {
    bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    terrain: { minX: -100, minY: -100, step: 1, nx: n, ny: n, scale: 0.01 },
    rules: { maxStep: 1.5, maxSlopeDeg: 50, canopyDensity: 0.35, canopyBlockT: 0.25 },
    prisms: [],
    trees: { fields: ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "osm", "crownX", "crownY"], data: [] },
  }
  return new MapQuery(world, h)
}
const at = (x: number, y: number, z = 0) => ctxFor(cleanObs((o) => (o.self.pos = [x, y, z]))).world

describe("wall feeler follows the ground (ledges and steep climbs are walls)", () => {
  const map = embankment()

  test("standing 3 m from a 3 m embankment, walking into it is blocked (the old feeler said open: its flat top is < 50 deg)", () => {
    assert.equal(blockedAhead(map, at(2, 0), [1, 0]), true)
  })
  test("walking along the embankment's foot is open", () => {
    assert.equal(blockedAhead(map, at(2, 0), [0, 1]), false)
  })
  test("a walkable 20 deg ramp is open", () => {
    assert.equal(blockedAhead(map, at(-20, 15), [0, 1]), false)
  })
  test("walking DOWN off the embankment top is open (only climbs are limited)", () => {
    assert.equal(blockedAhead(map, at(8, 0, 3), [-1, 0]), false)
  })
  test("steer turns away from the embankment instead of pressing into it", () => {
    const out = steer(map, at(3, 0), new LocoState(), [1, 0])
    assert.ok(out && Math.abs(out[0]) < 0.9, `expected a turn along the foot, got ${out}`)
  })
})

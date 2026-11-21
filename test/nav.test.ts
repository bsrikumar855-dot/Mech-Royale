import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { NAV } from "../src/config/index.ts"
import { EvasiveLocomotion } from "../src/locomotion/index.ts"
import { FieldBuild, NavGrid } from "../src/nav/grid.ts"
import { Navigator } from "../src/nav/index.ts"
import { MapQuery, type WorldJson } from "../src/world/map.ts"
import { WorldModel } from "../src/world/world.ts"
import { cleanObs, ctxFor, fixtureHello } from "./helpers.ts"

const BODY = { radius: 2.5, height: 9, stepUp: 1.2, maxSlopeDeg: 50 }
const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1]

/**
 * Flat 200 x 200 arena with a U-shaped building opening SOUTH: back wall y 10..16, side walls x -20..-14 and 14..20 down
 * to y -20. A mech inside the U at (0, 0) that wants to go NORTH is in a concave pocket: straight north is a wall, and
 * the exit is more than 120 degrees away from the target (the wall feeler's widest rotation).
 */
function pocketMap(): MapQuery {
  const n = 201
  const heights = new Int16Array(n * n) // all zero: flat
  const world: WorldJson = {
    bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
    terrain: { minX: -100, minY: -100, step: 1, nx: n, ny: n, scale: 0.01 },
    rules: { maxStep: 1.5, maxSlopeDeg: 50, canopyDensity: 0.35, canopyBlockT: 0.25 },
    prisms: [
      { kind: "building", base: -5, top: 30, ring: rect(-20, 10, 20, 16) },
      { kind: "building", base: -5, top: 30, ring: rect(-20, -20, -14, 16) },
      { kind: "building", base: -5, top: 30, ring: rect(14, -20, 20, 16) },
    ],
    trees: { fields: ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "osm", "crownX", "crownY"], data: [] },
  }
  return new MapQuery(world, heights)
}

/** Walk `steps` decisions of 0.1 s at 11.7 m/s along `headingAt(x, y)`, sliding along walls. */
function walk(map: MapQuery, start: [number, number], steps: number, headingAt: (x: number, y: number) => [number, number] | null): [number, number] {
  let [x, y] = start
  for (let s = 0; s < steps; s++) {
    const h = headingAt(x, y)
    if (!h) continue
    const [mx, my] = map.slideMove(x, y, 0, h[0] * 1.17, h[1] * 1.17, { radius: 2.5, height: 9, stepUp: 1.2 })
    x += mx
    y += my
  }
  return [x, y]
}

describe("nav grid", () => {
  const map = pocketMap()
  const g = new NavGrid(map, BODY)

  test("walls are unwalkable, open ground is walkable, cells beside walls cost more", () => {
    assert.equal(g.walk[g.cellOf(0, 13)], 0, "inside the back wall")
    assert.equal(g.walk[g.cellOf(0, 0)], 1, "inside the U")
    assert.equal(g.walk[g.cellOf(0, 60)], 1)
    assert.ok(g.costOf(g.cellOf(0, 6)) > 1, "next to the back wall")
    assert.equal(g.costOf(g.cellOf(0, -60)), 1)
  })

  test("the map edge is unwalkable (a body cannot stand there)", () => {
    assert.equal(g.walk[g.cellOf(99, 0)], 0)
  })

  test("a field reaches the whole connected arena and a path leaves the U to the south", () => {
    const f = g.field(g.circleSeeds(0, 60, 10, 0.85, 0))
    assert.ok(f.done)
    assert.ok(Number.isFinite(g.pathLength(f, 0, 0)))
    // straight line is 60 m; the detour south, around the U, and back north is much longer
    assert.ok(g.pathLength(f, 0, 0) > 120, `path ${g.pathLength(f, 0, 0)}`)
    const d = g.direction(f, 0, 0, 0)!
    assert.ok(d[1] < -0.2, `first heading must point out of the pocket (south), got ${d}`)
  })

  test("CONTROL: a straight heading toward the target gets stuck in the pocket; the planned path arrives", () => {
    const f = g.field(g.circleSeeds(0, 60, 10, 0.85, 0))
    const straight = walk(map, [0, 0], 400, (x, y) => {
      const dx = 0 - x
      const dy = 60 - y
      const l = Math.hypot(dx, dy)
      return l < 1 ? null : [dx / l, dy / l]
    })
    assert.ok(Math.hypot(straight[0], straight[1] - 60) > 30, `naive heading ended at ${straight} (expected stuck behind the back wall)`)
    const planned = walk(map, [0, 0], 400, (x, y) => g.direction(f, x, y, 0))
    assert.ok(Math.hypot(planned[0], planned[1] - 60) < 14, `planned path ended at ${planned}`)
  })

  test("open ground: string pulling gives a straight line to the destination", () => {
    const f = g.field(g.circleSeeds(80, -80, 5, 0.85, 0))
    const d = g.direction(f, -60, -80, 0)!
    assert.ok(Math.abs(d[0] - 1) < 0.05 && Math.abs(d[1]) < 0.15, `${d}`)
  })

  test("destination inside a building: seeds fall back to the nearest walkable cell, a path still exists", () => {
    const seeds = g.circleSeeds(0, 13, 3, 0.85, 0) // a circle entirely inside the back wall
    assert.equal(seeds.length, 1)
    const f = g.field(seeds)
    assert.ok(Number.isFinite(g.pathLength(f, 0, 60)))
  })

  test("no walkable cell anywhere near the destination: empty seeds, direction is null, nothing throws", () => {
    const f = new FieldBuild(g, [])
    assert.ok(f.done)
    assert.equal(g.direction(f, 0, 0, 0), null)
    assert.equal(g.pathLength(f, 0, 0), Infinity)
  })

  test("a field is resumable: stepping in slices equals one full build, and unsettled cells give no direction", () => {
    const seeds = g.circleSeeds(0, 60, 10, 0.85, 0)
    const full = g.field(seeds)
    const part = g.build(seeds)
    assert.equal(g.direction(part, 0, 0, 0), null, "nothing settled yet")
    assert.equal(g.pathLength(part, 0, 0), Infinity)
    let slices = 0
    while (!part.step(400)) slices++
    assert.ok(slices > 3, "400 pops per slice needs several slices on this arena")
    for (let k = 0; k < full.dist.length; k++) assert.equal(part.dist[k], full.dist[k])
  })

  test("one slice of NAV.popsPerTick pops costs well under the 34 ms compute budget", () => {
    const f = g.build(g.circleSeeds(0, 60, 10, 0.85, 0))
    const t0 = performance.now()
    f.step(NAV.popsPerTickUrgent)
    assert.ok(performance.now() - t0 < 25, `${performance.now() - t0} ms`)
  })
})

describe("Navigator", () => {
  const map = pocketMap()
  const g = new NavGrid(map, BODY)

  test("caches fields per destination and evicts beyond maxFields", () => {
    const nav = new Navigator(g)
    const a = nav.field(0, 60, 10)
    assert.equal(nav.field(0, 60, 10), a)
    for (let k = 0; k < NAV.maxFields + 2; k++) nav.field(-50 + k * 10, -60, 8)
    assert.notEqual(nav.field(0, 60, 10), a, "evicted and rebuilt")
  })

  test("pump advances one unfinished field per call and finishes it", () => {
    const nav = new Navigator(g)
    const f = nav.field(0, 60, 10)!
    let n = 0
    while (!f.done && n++ < 200) nav.pump(false)
    assert.ok(f.done)
  })
})

describe("Locomotion zone modes use the planned path", () => {
  const hello = fixtureHello()
  /** We stand in the pocket OUTSIDE a zone whose circle is north of the U. */
  const obsAt = (t: number, tick: number) =>
    cleanObs((o) => {
      o.t = t
      o.tick = tick
      o.self.pos = [0, 0, 0]
      o.self.in_zone = false
      o.zone = { center: [0, 60], radius: 12, next_center: [0, 60], next_radius: 12, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 100 }
    }, hello)

  test("outside the zone in the pocket: it leaves through the opening instead of pressing into the wall", () => {
    const map = pocketMap()
    const loco = new EvasiveLocomotion()
    const world = new WorldModel(hello)
    let move: [number, number] = [0, 0]
    for (let k = 0; k < 40; k++) move = loco.decide(ctxFor(obsAt(10 + k * 0.1, 200 + k * 2), map, world), []).move
    assert.equal(loco.lastMode, "outside")
    assert.ok(move[1] < -0.2, `expected a southbound exit heading, got ${move}`)
  })

  test("first tick: the field is not ready yet, the old direct heading is used and nothing throws", () => {
    const map = pocketMap()
    const loco = new EvasiveLocomotion()
    const out = loco.decide(ctxFor(obsAt(10, 200), map, new WorldModel(hello)), [])
    assert.equal(loco.lastMode, "outside")
    assert.ok(Number.isFinite(out.move[0]) && Number.isFinite(out.move[1]))
  })

  test("no map: zone runs keep working (direct heading), no navigator is created", () => {
    const loco = new EvasiveLocomotion()
    const out = loco.decide(ctxFor(obsAt(10, 200), null, new WorldModel(hello)), [])
    assert.equal(loco.lastMode, "outside")
    assert.ok(out.move[1] > 0.5, "straight toward the zone to the north")
  })
})

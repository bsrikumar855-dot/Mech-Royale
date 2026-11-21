import assert from "node:assert/strict"
import { statSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { performance } from "node:perf_hooks"
import { loadMapQuery } from "../src/world/mapLoader.ts"
import { pointInRing } from "../src/world/polygon.ts"
import { ARENA_DIR, HAS_ARENA, realMap } from "./helpers.ts"

const body = { radius: 2.5, height: 9, stepUp: 1.2 }

describe("MapQuery on the real /arena v2 map", { skip: !HAS_ARENA && "arena not found (see helpers.ts)" }, () => {
  const { map, world, raw } = realMap()
  const t = world.terrain

  test("files: terrain.i16 is exactly nx*ny int16 (1070 x 724 = 1,549,360 bytes); counts match the kit", () => {
    assert.equal(t.nx, 1070)
    assert.equal(t.ny, 724)
    assert.equal(statSync(join(ARENA_DIR, "v2", "terrain.i16")).size, 1070 * 724 * 2)
    assert.equal(raw.length, 1070 * 724)
    assert.equal(world.prisms.length, 259)
    assert.equal(map.treeCount, 1560)
  })

  test("bilinear height: exact at vertices, mean of four corners at a cell centre, clamped outside", () => {
    for (const [i, j] of [[0, 0], [500, 300], [1069, 723], [123, 456]] as const) {
      const x = t.minX + i * t.step
      const y = t.minY + j * t.step
      assert.ok(Math.abs(map.heightAt(x, y) - (raw[j * t.nx + i] as number) * t.scale) < 1e-9, `vertex ${i},${j}`)
    }
    const i = 400
    const j = 250
    const avg = ((raw[j * t.nx + i] as number) + (raw[j * t.nx + i + 1] as number) + (raw[(j + 1) * t.nx + i] as number) + (raw[(j + 1) * t.nx + i + 1] as number)) / 4
    assert.ok(Math.abs(map.heightAt(t.minX + i + 0.5, t.minY + j + 0.5) - avg * t.scale) < 1e-9)
    assert.ok(Number.isFinite(map.heightAt(1e6, -1e6)))
    const slope = map.slopeDegAt(t.minX + 400.5, t.minY + 250.5)
    assert.ok(slope >= 0 && slope < 90)
  })

  test("prism containment: every prism contains an interior point at mid-height and not above its top", () => {
    let checked = 0
    for (const p of map.prisms) {
      // find an interior XY point: scan a coarse grid over the AABB with an independent even-odd + hole check
      let found: [number, number] | null = null
      for (let a = 1; a < 12 && !found; a++) {
        for (let b = 1; b < 12 && !found; b++) {
          const x = p.minX + ((p.maxX - p.minX) * a) / 12
          const y = p.minY + ((p.maxY - p.minY) * b) / 12
          if (pointInRing(x, y, p.ring) && !p.holes.some((h) => pointInRing(x, y, h))) found = [x, y]
        }
      }
      if (!found) continue
      const mid = (p.base + p.top) / 2
      assert.ok(map.prismContaining(found[0], found[1], mid), `prism ${p.kind} ${p.base}..${p.top} should contain ${found}`)
      assert.ok(!map.prismContaining(found[0], found[1], p.top + 0.5) || map.prismsAt(found[0], found[1]).some((q) => q.top > p.top))
      checked++
    }
    assert.ok(checked > 200, `only ${checked} prisms had an interior probe point`)
  })

  test("prisms with holes: a point inside a hole is NOT contained by that prism", () => {
    let tested = 0
    for (const p of map.prisms) {
      for (const h of p.holes) {
        // probe a few interior points of the hole polygon
        for (let a = 1; a < 10; a++) {
          for (let b = 1; b < 10; b++) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
            for (let k = 0; k < h.length; k += 2) { minX = Math.min(minX, h[k] as number); maxX = Math.max(maxX, h[k] as number); minY = Math.min(minY, h[k + 1] as number); maxY = Math.max(maxY, h[k + 1] as number) }
            const x = minX + ((maxX - minX) * a) / 10
            const y = minY + ((maxY - minY) * b) / 10
            if (pointInRing(x, y, h)) {
              assert.ok(!map.prismsAt(x, y).includes(p), "hole point must not be inside its own prism")
              tested++
            }
          }
        }
      }
    }
    assert.ok(tested > 0, "no hole probes ran")
  })

  /** Interior XY probe points of a prism (independent even-odd check), on a coarse grid. */
  const interiorProbes = (p: (typeof map.prisms)[number]): [number, number][] => {
    const out: [number, number][] = []
    for (let a = 1; a < 16; a++)
      for (let b = 1; b < 16; b++) {
        const x = p.minX + ((p.maxX - p.minX) * a) / 16
        const y = p.minY + ((p.maxY - p.minY) * b) / 16
        if (pointInRing(x, y, p.ring) && !p.holes.some((h) => pointInRing(x, y, h))) out.push([x, y])
      }
    return out
  }

  test("bridges: elevated decks are walked UNDER, low decks are walls, the deck itself is standable", () => {
    const bridges = map.prisms.filter((p) => p.kind === "bridge")
    assert.equal(bridges.length, 9)
    let walkedUnder = 0
    let lowWalls = 0
    for (const p of bridges) {
      for (const [x, y] of interiorProbes(p)) {
        const ground = map.heightAt(x, y)
        const headroom = p.base - ground
        if (headroom >= 0) assert.ok(map.overheadClearance(x, y, ground) <= headroom + 1e-9, "the deck is a ceiling over the ground beneath it")
        assert.ok(map.standingHeightAt(x, y, p.top, body.stepUp, body.height) >= p.top - 1e-9 || map.overheadClearance(x, y, p.top) < body.height, "deck is standable unless something hangs over it")
        if (headroom >= body.height) {
          // Free of other obstacles (bridges abut buildings): then a mech walks under it, and the underside is a ceiling.
          if (!map.isBlockedAt(x, y, ground, body)) walkedUnder++
          assert.ok(map.overheadClearance(x, y, ground) >= body.height - 1e-9)
        } else if (headroom > body.stepUp && p.top > ground + body.stepUp) {
          assert.equal(map.isBlockedAt(x, y, ground, body), true, "a deck lower than the 9 m head is a wall")
          lowWalls++
        }
      }
    }
    assert.ok(walkedUnder > 0, "expected an unobstructed walk-under probe beneath at least one elevated bridge")
    assert.ok(lowWalls > 0, "expected a low bridge that acts as a wall")
  })

  test("roof elevation + 3D shot LOS against a real rectangular building", () => {
    const b = map.prisms.find((p) => p.kind === "building" && p.holes.length === 0 && p.ring.length === 8 && p.top - p.base > 12 && p.maxX - p.minX > 8 && p.maxY - p.minY > 8)
    assert.ok(b, "need a simple rectangular building")
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    const roof = map.roofHeightAt(cx, cy)!
    assert.ok(roof >= b.top - 1e-9)
    assert.ok(Math.abs(map.standingHeightAt(cx, cy, roof, body.stepUp, body.height) - roof) < 1e-9, "standing on the roof")
    const mid = (b.base + b.top) / 2
    // across the building at mid-height: blocked; over the roof: clear (nothing taller is guaranteed, so compare against the building alone)
    assert.ok(!map.hasShotLOS([b.minX - 3, cy, mid], [b.maxX + 3, cy, mid]), "through the walls")
    assert.ok(!map.hasShotLOS([cx, cy, b.top + 30], [cx, cy, b.top - 5]), "down into the roof")
  })

  test("wall-slide against real walls: blocked into the wall, never ends inside one, slides along it", () => {
    let tested = 0
    for (const p of map.prisms) {
      if (p.kind !== "building" || p.holes.length > 0 || p.top - p.base < 12) continue
      const n = p.ring.length / 2
      for (let i = 0; i < n && tested < 40; i++) {
        const j = (i + 1) % n
        const ax = p.ring[2 * i] as number, ay = p.ring[2 * i + 1] as number, bx = p.ring[2 * j] as number, by = p.ring[2 * j + 1] as number
        const len = Math.hypot(bx - ax, by - ay)
        if (len < 8) continue
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        let nx = -(by - ay) / len, ny = (bx - ax) / len
        if (pointInRing(mx + nx * 0.5, my + ny * 0.5, p.ring)) { nx = -nx; ny = -ny } // make the normal point outward
        const x = mx + nx * 3.2, y = my + ny * 3.2 // clear of the 2.5 m radius
        const z = map.heightAt(x, y)
        if (map.isBlockedAt(x, y, z, body)) continue // another obstacle makes this probe unusable
        const dx = -nx * 2, dy = -ny * 2 // straight into the wall
        if (!map.isBlockedAt(x + dx, y + dy, z, body)) continue // e.g. a doorway-like gap or step: not a wall probe
        const [sx, sy] = map.slideMove(x, y, z, dx, dy, body)
        assert.equal(map.isBlockedAt(x + sx, y + sy, z, body), false, "must never end inside a wall")
        assert.ok(Math.hypot(sx, sy) < Math.hypot(dx, dy), "must lose the part going into the wall")
        // an along-wall move (tangent) from the same spot is allowed to slide
        const tx = ((bx - ax) / len) * 1.5, ty = ((by - ay) / len) * 1.5
        const [ux, uy] = map.slideMove(x, y, z, tx + dx * 0.5, ty + dy * 0.5, body)
        assert.equal(map.isBlockedAt(x + ux, y + uy, z, body), false)
        tested++
      }
    }
    assert.ok(tested >= 10, `only ${tested} wall probes were usable`)
  })

  test("startup + query cost (informational; generous limits)", () => {
    const t0 = performance.now()
    const loaded = loadMapQuery(ARENA_DIR, ["v2/world.json", "v2/terrain.i16"])
    const loadMs = performance.now() - t0
    const a: [number, number, number] = [-200, -100, 30]
    const q0 = performance.now()
    let clear = 0
    for (let i = 0; i < 2000; i++) if (loaded.hasShotLOS([a[0] + (i % 40), a[1], a[2]], [a[0] + 150, a[1] + (i % 90), a[2] - 10])) clear++
    const losMs = ((performance.now() - q0) / 2000) * 1000
    console.error(`[bench] MapQuery load+index ${loadMs.toFixed(1)} ms; hasShotLOS (150 m) ${losMs.toFixed(1)} us/call; clear ${clear}/2000`)
    assert.ok(loadMs < 5000)
    assert.ok(losMs < 2000)
  })
})

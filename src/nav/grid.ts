/**
 * Walkability grid + path-distance fields on the real arena map (zone navigation, experiment zone-nav).
 *
 * Why: the wall feeler is local (2 probes up to 4 m, +-30..120 deg). In a concave pocket whose exit is more than 120
 * degrees away from the target it returns null and the mech STANDS STILL, outside the zone, until it dies (kinematic
 * harness: scripts/nav-eval.ts). A path-distance field from the destination gives every reachable cell a direction
 * that leads out of any pocket.
 *
 * Model: square cells of NAV.cellM; a cell is walkable when a body of the mech's radius centred on it is not blocked
 * by a wall / un-steppable ledge (MapQuery.isBlockedAt, feet on the terrain) and the ground there is not steeper than
 * the walkable slope. With cellM <= 2 x radius the discs of two adjacent cells overlap, so a wall crossing the segment
 * between two walkable centres cannot exist. 8-connected moves, no corner cutting, cells next to blocked ones cost more
 * (stay mid-corridor). Fields are Dijkstra distances in metres (Infinity = unreachable / unknown).
 */
import { MAP, NAV } from "../config/index.ts"
import type { MapQuery } from "../world/map.ts"

export interface NavBody {
  radius: number
  height: number
  stepUp: number
  maxSlopeDeg: number
}

const SQRT2 = Math.SQRT2
const NB: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
]

export class NavGrid {
  readonly nx: number
  readonly ny: number
  readonly cell: number
  private readonly map: MapQuery
  private readonly body: NavBody
  readonly minX: number
  readonly minY: number
  /** 1 = walkable */
  readonly walk: Uint8Array
  /** cost multiplier per cell (1 = open, >1 = next to a wall) */
  private readonly cost: Float32Array

  costOf(k: number): number {
    return this.cost[k]!
  }

  constructor(map: MapQuery, body: NavBody) {
    this.map = map
    this.body = body
    const b = map.bounds
    this.cell = NAV.cellM
    this.minX = b.minX
    this.minY = b.minY
    this.nx = Math.max(2, Math.ceil((b.maxX - b.minX) / this.cell))
    this.ny = Math.max(2, Math.ceil((b.maxY - b.minY) / this.cell))
    this.walk = new Uint8Array(this.nx * this.ny)
    this.cost = new Float32Array(this.nx * this.ny).fill(1)
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.minX + (i + 0.5) * this.cell
        const y = this.minY + (j + 0.5) * this.cell
        if (x < b.minX + body.radius || x > b.maxX - body.radius || y < b.minY + body.radius || y > b.maxY - body.radius) continue
        const g = map.heightAt(x, y)
        if (map.slopeDegAt(x, y) > body.maxSlopeDeg) continue
        if (map.isBlockedAt(x, y, g, { radius: body.radius + NAV.clearanceM, height: body.height, stepUp: body.stepUp })) continue
        this.walk[j * this.nx + i] = 1
      }
    }
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i
        if (!this.walk[k]) continue
        for (const [di, dj] of NB) {
          const ii = i + di
          const jj = j + dj
          if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny || !this.walk[jj * this.nx + ii]) {
            this.cost[k] = NAV.wallCostMult
            break
          }
        }
      }
    }
  }

  cellOf(x: number, y: number): number {
    const i = Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)))
    const j = Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)))
    return j * this.nx + i
  }

  centre(k: number): [number, number] {
    return [this.minX + ((k % this.nx) + 0.5) * this.cell, this.minY + (Math.floor(k / this.nx) + 0.5) * this.cell]
  }

  /** Nearest walkable cell to (x, y) within NAV.snapRadiusCells rings (-1 if none). */
  snap(x: number, y: number): number {
    const k0 = this.cellOf(x, y)
    if (this.walk[k0]) return k0
    const i0 = k0 % this.nx
    const j0 = Math.floor(k0 / this.nx)
    for (let r = 1; r <= NAV.snapRadiusCells; r++) {
      let best = -1
      let bestD = Infinity
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = i0 + di
          const j = j0 + dj
          if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue
          const k = j * this.nx + i
          if (!this.walk[k]) continue
          const d = di * di + dj * dj
          if (d < bestD) {
            bestD = d
            best = k
          }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  /** Resumable Dijkstra path-length field (metres) from `target`; call step() until done. */
  build(seeds: ReadonlyArray<readonly [number, number]>, buf?: FieldBuffers, heap?: Heap): FieldBuild {
    return new FieldBuild(this, seeds, buf, heap)
  }

  /**
   * Seeds for "get inside this circle": every walkable cell within `frac` x radius of the centre, each starting at
   * `pull` x its distance from the centre (a deeper cell is worth a slightly longer walk). If the disc holds no walkable
   * cell (centre inside a building) the nearest walkable cell to the centre is the only seed.
   */
  circleSeeds(cx: number, cy: number, radius: number, frac: number, pull: number): Array<[number, number]> {
    const seeds: Array<[number, number]> = []
    const R = radius * frac
    const i0 = Math.max(0, Math.floor((cx - R - this.minX) / this.cell))
    const i1 = Math.min(this.nx - 1, Math.floor((cx + R - this.minX) / this.cell))
    const j0 = Math.max(0, Math.floor((cy - R - this.minY) / this.cell))
    const j1 = Math.min(this.ny - 1, Math.floor((cy + R - this.minY) / this.cell))
    // Huge early circles would seed ~20k cells in one tick: sample every `stride`-th cell so seeding stays ~NAV.maxSeeds.
    const stride = Math.max(1, Math.ceil(Math.sqrt(((i1 - i0 + 1) * (j1 - j0 + 1)) / NAV.maxSeeds)))
    for (let j = j0; j <= j1; j += stride) {
      for (let i = i0; i <= i1; i += stride) {
        const k = j * this.nx + i
        if (!this.walk[k]) continue
        const d = Math.hypot(this.minX + (i + 0.5) * this.cell - cx, this.minY + (j + 0.5) * this.cell - cy)
        if (d <= R) seeds.push([k, pull * d])
      }
    }
    if (seeds.length === 0) {
      const k = this.snap(cx, cy)
      if (k >= 0) seeds.push([k, 0])
    }
    return seeds
  }

  /** Complete field in one go (tests, benchmarks; too slow for a 50 ms tick, see FieldBuild.step). */
  field(seeds: ReadonlyArray<readonly [number, number]>): FieldBuild {
    const b = new FieldBuild(this, seeds)
    while (!b.step(1 << 30)) {
      /* run to completion */
    }
    return b
  }

  /**
   * Can the REAL body (MapQuery.isBlockedAt, not just cell membership) walk the straight segment from (x0, y0) at feet
   * height z to (x1, y1)? Sampled every NAV.segmentStepM. The grid is a 4 m abstraction: this is the ground truth check.
   */
  segmentClear(x0: number, y0: number, z: number, x1: number, y1: number): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (!Number.isFinite(len) || !Number.isFinite(z)) return false // los-guard: never walk toward a non-finite point
    const n = Math.min(MAP.terrainLosMaxSteps, Math.max(1, Math.ceil(len / NAV.segmentStepM)))
    const body = { radius: this.body.radius, height: this.body.height, stepUp: this.body.stepUp }
    let fz = z
    for (let s = 1; s <= n; s++) {
      const x = x0 + ((x1 - x0) * s) / n
      const y = y0 + ((y1 - y0) * s) / n
      const g = this.map.heightAt(x, y)
      fz = Math.max(g, Math.min(fz, g + body.stepUp)) // follow the ground / a step, never float
      if (this.map.isBlockedAt(x, y, fz, body)) return false
    }
    return true
  }

  /**
   * Unit direction (world frame) from (x, y) toward the furthest cell along the field's steepest-descent path that is
   * still reachable by a straight walkable segment (string pulling: smooth, near-optimal headings, but a path around
   * any pocket). null when the start is not settled yet / unreachable, or already at the target.
   */
  direction(f: FieldBuild, x: number, y: number, z: number): [number, number] | null {
    let k0 = this.cellOf(x, y)
    if (!this.walk[k0] || !f.settled[k0]) {
      k0 = this.snap(x, y)
      if (k0 < 0 || !f.settled[k0]) return null
    }
    const d = f.dist
    if (d[k0]! <= this.cell) return null
    const path = [k0]
    let cur = k0
    for (let step = 0; step < NAV.pathCells; step++) {
      const i = cur % this.nx
      const j = (cur - i) / this.nx
      let best = cur
      let bestD = d[cur]!
      for (const [di, dj] of NB) {
        const ii = i + di
        const jj = j + dj
        if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.ny) continue
        const kk = jj * this.nx + ii
        if (!f.settled[kk]) continue
        if (d[kk]! < bestD) {
          bestD = d[kk]!
          best = kk
        }
      }
      if (best === cur) break
      path.push(best)
      cur = best
    }
    if (path.length < 2) return null
    // string pulling: the furthest path cell the real body can walk to in a straight line (candidates far to near)
    let pick = -1
    const cand: number[] = []
    for (const q of NAV.pullIndices) if (q < path.length) cand.push(q)
    if (!cand.includes(path.length - 1) && path.length - 1 > 1) cand.unshift(path.length - 1)
    for (const q of cand) {
      const [qx, qy] = this.centre(path[q]!)
      if (this.segmentClear(x, y, z, qx, qy)) {
        pick = q
        break
      }
    }
    if (pick < 0) return null // not even the first waypoint is walkable in a straight line: let the wall feeler decide
    const [cx, cy] = this.centre(path[pick]!)
    const dx = cx - x
    const dy = cy - y
    const l = Math.hypot(dx, dy)
    return l < 1e-6 ? null : [dx / l, dy / l]
  }

  /** Path length (m) from (x, y) to the field's target; Infinity if unreachable. */
  pathLength(f: FieldBuild, x: number, y: number): number {
    let k = this.cellOf(x, y)
    if (!this.walk[k]) k = this.snap(x, y)
    return k < 0 || !f.settled[k] ? Infinity : f.dist[k]!
  }
}

/** Binary min-heap on typed arrays, reused across fields (one build is in flight at a time): no per-field allocation. */
export class Heap {
  private cap = 1 << 16
  private hk = new Float32Array(this.cap)
  private hi = new Int32Array(this.cap)
  size = 0

  clear(): void {
    this.size = 0
  }

  push(key: number, id: number): void {
    if (this.size === this.cap) {
      this.cap *= 2
      const nk = new Float32Array(this.cap)
      const ni = new Int32Array(this.cap)
      nk.set(this.hk)
      ni.set(this.hi)
      this.hk = nk
      this.hi = ni
    }
    let c = this.size++
    while (c > 0) {
      const p = (c - 1) >> 1
      if (this.hk[p]! <= key) break
      this.hk[c] = this.hk[p]!
      this.hi[c] = this.hi[p]!
      c = p
    }
    this.hk[c] = key
    this.hi[c] = id
  }

  /** Remove the minimum; read it through topKey / topId BEFORE calling pop(). */
  get topKey(): number {
    return this.hk[0]!
  }
  get topId(): number {
    return this.hi[0]!
  }

  pop(): void {
    const size = --this.size
    if (size <= 0) return
    const lk = this.hk[size]!
    const li = this.hi[size]!
    let c = 0
    for (;;) {
      let ch = 2 * c + 1
      if (ch >= size) break
      if (ch + 1 < size && this.hk[ch + 1]! < this.hk[ch]!) ch++
      if (this.hk[ch]! >= lk) break
      this.hk[c] = this.hk[ch]!
      this.hi[c] = this.hi[ch]!
      c = ch
    }
    this.hk[c] = lk
    this.hi[c] = li
  }
}

/** Distance + settled buffers for one field (recycled by the Navigator). */
export interface FieldBuffers {
  dist: Float32Array
  settled: Uint8Array
}

/** Dijkstra state that can be advanced a few thousand pops per tick. `settled[k]` = dist[k] is final. */
export class FieldBuild {
  readonly dist: Float32Array
  readonly settled: Uint8Array
  done = false
  private readonly g: NavGrid
  private readonly heap: Heap

  /** `seeds`: [cell, initial cost] pairs (multi-source Dijkstra: the field is the cheapest way to ANY seed). */
  constructor(g: NavGrid, seeds: ReadonlyArray<readonly [number, number]>, buf?: FieldBuffers, heap?: Heap) {
    this.g = g
    this.heap = heap ?? new Heap()
    this.heap.clear()
    const n = g.nx * g.ny
    this.dist = buf?.dist ?? new Float32Array(n)
    this.settled = buf?.settled ?? new Uint8Array(n)
    this.dist.fill(Infinity)
    this.settled.fill(0)
    for (const [k, init] of seeds) {
      if (k < 0 || !g.walk[k] || init >= this.dist[k]!) continue
      this.dist[k] = init
      this.heap.push(init, k)
    }
    if (this.heap.size === 0) this.done = true
  }

  /** Pop up to `maxPops` heap entries; true once the whole reachable set is settled. */
  step(maxPops: number): boolean {
    if (this.done) return true
    const g = this.g
    const { dist, settled, heap } = this
    for (let pops = 0; pops < maxPops && heap.size > 0; pops++) {
      const key = heap.topKey
      const id = heap.topId
      heap.pop()
      if (key > dist[id]! || settled[id]) continue
      settled[id] = 1
      const i = id % g.nx
      const j = (id - i) / g.nx
      for (const [di, dj, w] of NB) {
        const ii = i + di
        const jj = j + dj
        if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) continue
        const k = jj * g.nx + ii
        if (!g.walk[k] || settled[k]) continue
        if (di !== 0 && dj !== 0 && (!g.walk[j * g.nx + ii] || !g.walk[jj * g.nx + i])) continue // no corner cutting
        const nd = key + w * g.cell * g.costOf(k)
        if (nd < dist[k]!) {
          dist[k] = nd
          heap.push(nd, k)
        }
      }
    }
    if (heap.size === 0) this.done = true
    return this.done
  }
}

/**
 * MapQuery: the static arena (v2/world.json + v2/terrain.i16) as fast 3D queries.
 *
 * Data model (protocol.md §11, verified against the kit):
 *  - terrain: int16 little-endian centimetres, nx x ny, row-major, vertex grid from (minX, minY), 1 m step.
 *  - prisms: extruded polygons (building | stadium | bridge) with base/top heights and optional holes. A bridge
 *    has base > ground: you walk and shoot UNDER it.
 *  - trees: vision only (trunks block sight, crowns fade it). They never stop shots or movement.
 * Everything here is static: built once during the 20 s hello window, read-only afterwards.
 */
import { MAP } from "../config/index.ts"
import { clamp } from "./geom.ts"
import {
  circleOverlapsPrismXY,
  makePrism,
  pointInPrism,
  pointInPrismXY,
  segmentCylinderInterval,
  segmentEllipsoidChord,
  segmentHitsPrism,
  type Prism,
} from "./polygon.ts"

export interface WorldJson {
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  terrain: { minX: number; minY: number; step: number; nx: number; ny: number; scale: number }
  rules: { maxStep: number; maxSlopeDeg: number; canopyDensity: number; canopyBlockT: number }
  prisms: { kind: string; base: number; top: number; ring: number[]; holes?: number[][] }[]
  trees: { fields: string[]; data: number[] }
}

/** The mech body used for collision queries (read from hello.config.mech / self.stats, never hardcoded). */
export interface Body {
  radius: number
  height: number
  stepUp: number
}

export type P3 = readonly [number, number, number]

const TREE_STRIDE_FIELDS = ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "crownX", "crownY"] as const

export class MapQuery {
  readonly bounds: WorldJson["bounds"]
  readonly terrain: WorldJson["terrain"]
  readonly rules: WorldJson["rules"]
  readonly prisms: Prism[]

  private readonly heights: Int16Array
  private readonly cell = MAP.gridCellM
  private readonly gx: number
  private readonly gy: number
  private readonly cells: number[][]
  private readonly stamp: Uint32Array
  private stampId = 0

  // trees (flat Float64Array, one stride per tree) + their own grid
  private readonly treeN: number
  private readonly trees: Float64Array
  private readonly treeCells: number[][]
  private readonly treeGx: number
  private readonly treeGy: number
  private readonly treeReach: number
  private readonly treeStamp: Uint32Array
  private treeStampId = 0

  constructor(world: WorldJson, heights: Int16Array) {
    this.bounds = world.bounds
    this.terrain = world.terrain
    this.rules = world.rules
    if (world.terrain.nx < 2 || world.terrain.ny < 2) throw new Error("terrain grid too small")
    if (heights.length < world.terrain.nx * world.terrain.ny) {
      throw new Error(`terrain.i16 has ${heights.length} samples, expected ${world.terrain.nx * world.terrain.ny}`)
    }
    this.heights = heights

    this.prisms = world.prisms.map((p) => makePrism(p.kind, p.base, p.top, p.ring, p.holes ?? []))
    this.stamp = new Uint32Array(this.prisms.length)
    const b = this.bounds
    this.gx = Math.max(1, Math.ceil((b.maxX - b.minX) / this.cell))
    this.gy = Math.max(1, Math.ceil((b.maxY - b.minY) / this.cell))
    this.cells = Array.from({ length: this.gx * this.gy }, () => [] as number[])
    this.prisms.forEach((p, idx) => {
      const [i0, i1, j0, j1] = this.cellRange(p.minX, p.maxX, p.minY, p.maxY)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.gx + i]?.push(idx)
    })

    // trees
    const f = world.trees.fields
    const col = Object.fromEntries(TREE_STRIDE_FIELDS.map((k) => [k, f.indexOf(k)])) as Record<(typeof TREE_STRIDE_FIELDS)[number], number>
    const stride = f.length
    this.treeN = stride > 0 ? Math.floor(world.trees.data.length / stride) : 0
    this.trees = new Float64Array(this.treeN * TREE_STRIDE_FIELDS.length)
    let reach = 0
    for (let n = 0; n < this.treeN; n++) {
      const row = n * stride
      TREE_STRIDE_FIELDS.forEach((k, c) => {
        const idx = col[k]
        const v = idx >= 0 ? (world.trees.data[row + idx] as number) : 0
        this.trees[n * TREE_STRIDE_FIELDS.length + c] = v
      })
      const crownR = this.tree(n, "crownR")
      const off = Math.hypot(this.tree(n, "crownX") - this.tree(n, "x"), this.tree(n, "crownY") - this.tree(n, "y"))
      reach = Math.max(reach, crownR + off, this.tree(n, "trunkR"))
    }
    this.treeReach = reach
    this.treeGx = Math.max(1, Math.ceil((b.maxX - b.minX) / MAP.treeCellM))
    this.treeGy = Math.max(1, Math.ceil((b.maxY - b.minY) / MAP.treeCellM))
    this.treeCells = Array.from({ length: this.treeGx * this.treeGy }, () => [] as number[])
    for (let n = 0; n < this.treeN; n++) {
      const i = clamp(Math.floor((this.tree(n, "x") - b.minX) / MAP.treeCellM), 0, this.treeGx - 1)
      const j = clamp(Math.floor((this.tree(n, "y") - b.minY) / MAP.treeCellM), 0, this.treeGy - 1)
      this.treeCells[j * this.treeGx + i]?.push(n)
    }
    this.treeStamp = new Uint32Array(this.treeN)
  }

  get treeCount(): number {
    return this.treeN
  }

  private tree(n: number, k: (typeof TREE_STRIDE_FIELDS)[number]): number {
    return this.trees[n * TREE_STRIDE_FIELDS.length + TREE_STRIDE_FIELDS.indexOf(k)] as number
  }

  // ---------------------------------------------------------------- terrain

  /** Ground height (m) at x,y: bilinear on the 1 m grid; clamped to the grid edge outside it. */
  heightAt(x: number, y: number): number {
    const t = this.terrain
    const fx = clamp((x - t.minX) / t.step, 0, t.nx - 1)
    const fy = clamp((y - t.minY) / t.step, 0, t.ny - 1)
    const i0 = Math.min(Math.floor(fx), t.nx - 2)
    const j0 = Math.min(Math.floor(fy), t.ny - 2)
    const tx = fx - i0
    const ty = fy - j0
    const H = this.heights
    const k = j0 * t.nx + i0
    const h00 = H[k] as number
    const h10 = H[k + 1] as number
    const h01 = H[k + t.nx] as number
    const h11 = H[k + t.nx + 1] as number
    const h0 = h00 + (h10 - h00) * tx
    const h1 = h01 + (h11 - h01) * tx
    return (h0 + (h1 - h0) * ty) * t.scale
  }

  /** Terrain slope in degrees (central difference). */
  slopeDegAt(x: number, y: number): number {
    const p = MAP.slopeProbeM
    const dzdx = (this.heightAt(x + p, y) - this.heightAt(x - p, y)) / (2 * p)
    const dzdy = (this.heightAt(x, y + p) - this.heightAt(x, y - p)) / (2 * p)
    return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI
  }

  // ---------------------------------------------------------------- spatial index

  private cellRange(minX: number, maxX: number, minY: number, maxY: number): [number, number, number, number] {
    const b = this.bounds
    const i0 = clamp(Math.floor((minX - b.minX) / this.cell), 0, this.gx - 1)
    const i1 = clamp(Math.floor((maxX - b.minX) / this.cell), 0, this.gx - 1)
    const j0 = clamp(Math.floor((minY - b.minY) / this.cell), 0, this.gy - 1)
    const j1 = clamp(Math.floor((maxY - b.minY) / this.cell), 0, this.gy - 1)
    return [i0, i1, j0, j1]
  }

  /** True as soon as `pred` returns true for any prism whose cells overlap the box. Each prism is visited once. */
  private anyPrism(minX: number, maxX: number, minY: number, maxY: number, pred: (p: Prism) => boolean): boolean {
    const id = ++this.stampId
    const [i0, i1, j0, j1] = this.cellRange(minX, maxX, minY, maxY)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells[j * this.gx + i]
        if (!list) continue
        for (const idx of list) {
          if (this.stamp[idx] === id) continue
          this.stamp[idx] = id
          const p = this.prisms[idx] as Prism
          if (pred(p)) return true
        }
      }
    }
    return false
  }

  /** Every prism whose XY footprint contains (x, y). */
  prismsAt(x: number, y: number): Prism[] {
    const out: Prism[] = []
    this.anyPrism(x, x, y, y, (p) => {
      if (pointInPrismXY(p, x, y)) out.push(p)
      return false
    })
    return out
  }

  /** The prism containing the 3D point, or null. */
  prismContaining(x: number, y: number, z: number): Prism | null {
    let found: Prism | null = null
    this.anyPrism(x, x, y, y, (p) => {
      if (pointInPrism(p, x, y, z)) {
        found = p
        return true
      }
      return false
    })
    return found
  }

  /** Solid = inside a prism, or below the terrain surface. */
  isSolid(x: number, y: number, z: number): boolean {
    if (z < this.heightAt(x, y) - MAP.zEps) return true
    return this.prismContaining(x, y, z) !== null
  }

  // ---------------------------------------------------------------- elevation

  /** Highest prism top over (x, y) (a rooftop or a bridge deck), or null if no prism covers it. */
  roofHeightAt(x: number, y: number): number | null {
    let best: number | null = null
    for (const p of this.prismsAt(x, y)) if (best === null || p.top > best) best = p.top
    return best
  }

  /** Distance from z up to the lowest ceiling (a prism base) above it at x,y. Infinity if open sky. */
  overheadClearance(x: number, y: number, z: number): number {
    let best = Infinity
    for (const p of this.prismsAt(x, y)) {
      if (p.base >= z - MAP.zEps) best = Math.min(best, p.base - z)
    }
    return best
  }

  /**
   * Height of the surface a mech with feet at `feetZ` would stand on at x,y: the highest of {terrain, prism tops}
   * that is within `stepUp` above the feet and leaves `headroom` of clearance. Falls back to terrain.
   */
  standingHeightAt(x: number, y: number, feetZ: number, stepUp: number, headroom: number): number {
    const ground = this.heightAt(x, y)
    const cands = [ground, ...this.prismsAt(x, y).map((p) => p.top)].sort((a, b) => b - a)
    for (const c of cands) {
      if (c <= feetZ + stepUp + MAP.zEps && this.overheadClearance(x, y, c) >= headroom) return c
    }
    return ground
  }

  // ---------------------------------------------------------------- walking

  /** Would the mech body, feet at `feetZ`, collide with a wall or an un-steppable ledge at x,y? */
  isBlockedAt(x: number, y: number, feetZ: number, body: Body): boolean {
    const r = body.radius
    if (this.heightAt(x, y) > feetZ + body.stepUp + MAP.zEps) return true
    return this.anyPrism(x - r, x + r, y - r, y + r, (p) => {
      // Overlaps the body's vertical span above step height (walls) and not entirely overhead (bridges you walk under).
      if (!(p.top > feetZ + body.stepUp && p.base < feetZ + body.height)) return false
      return circleOverlapsPrismXY(p, x, y, r)
    })
  }

  /**
   * Wall-slide: of the requested displacement (dx, dy) return the part the mech may actually make.
   * Full move if free; otherwise the axis-aligned component that is free; otherwise nothing.
   */
  slideMove(x: number, y: number, feetZ: number, dx: number, dy: number, body: Body): [number, number] {
    const b = body
    if (!this.isBlockedAt(x + dx, y + dy, feetZ, b)) return [dx, dy]
    const okX = dx !== 0 && !this.isBlockedAt(x + dx, y, feetZ, b)
    const okY = dy !== 0 && !this.isBlockedAt(x, y + dy, feetZ, b)
    if (okX && okY) return Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy]
    if (okX) return [dx, 0]
    if (okY) return [0, dy]
    return [0, 0]
  }

  // ---------------------------------------------------------------- line of sight

  private terrainBlocks(a: P3, b: P3): boolean {
    // los-guard: a non-finite end point is treated as blocked, and the sample count is capped (never hang a tick)
    if (!(Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]) && Number.isFinite(b[0]) && Number.isFinite(b[1]) && Number.isFinite(b[2]))) return true
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (!Number.isFinite(len)) return true
    const n = Math.min(MAP.terrainLosMaxSteps, Math.max(1, Math.ceil(len / MAP.terrainLosStepM)))
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const x = a[0] + (b[0] - a[0]) * t
      const y = a[1] + (b[1] - a[1]) * t
      const z = a[2] + (b[2] - a[2]) * t
      if (z < this.heightAt(x, y) - MAP.zEps) return true
    }
    return false
  }

  private prismsBlock(a: P3, b: P3): boolean {
    return this.anyPrism(Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1]), (p) =>
      segmentHitsPrism(p, a[0], a[1], a[2], b[0], b[1], b[2]),
    )
  }

  /** Shots (gun, mortar, laser) are stopped by buildings, bridges and terrain; trees never stop them. True = clear. */
  hasShotLOS(a: P3, b: P3): boolean {
    return !this.prismsBlock(a, b) && !this.terrainBlocks(a, b)
  }

  /**
   * Sight: buildings/bridges/terrain block; tree trunks block; with `canopy`, crowns attenuate
   * (optical depth = canopyDensity * chord; blocked once transmittance exp(-depth) < canopyBlockT).
   * NOTE: the canopy model is our reading of rules.canopyDensity / canopyBlockT, not verified against the server.
   * The server tells us what we see in obs; use this only for planning (e.g. "would X see me from there").
   */
  hasVisionLOS(a: P3, b: P3, opts: { canopy?: boolean } = {}): boolean {
    if (!this.hasShotLOS(a, b)) return false
    if (this.treeN === 0) return true
    const canopy = opts.canopy ?? true
    const pad = this.treeReach
    const minX = Math.min(a[0], b[0]) - pad
    const maxX = Math.max(a[0], b[0]) + pad
    const minY = Math.min(a[1], b[1]) - pad
    const maxY = Math.max(a[1], b[1]) + pad
    const bd = this.bounds
    const i0 = clamp(Math.floor((minX - bd.minX) / MAP.treeCellM), 0, this.treeGx - 1)
    const i1 = clamp(Math.floor((maxX - bd.minX) / MAP.treeCellM), 0, this.treeGx - 1)
    const j0 = clamp(Math.floor((minY - bd.minY) / MAP.treeCellM), 0, this.treeGy - 1)
    const j1 = clamp(Math.floor((maxY - bd.minY) / MAP.treeCellM), 0, this.treeGy - 1)
    const id = ++this.treeStampId
    let depth = 0
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.treeCells[j * this.treeGx + i]
        if (!list) continue
        for (const n of list) {
          if (this.treeStamp[n] === id) continue
          this.treeStamp[n] = id
          const z0 = this.tree(n, "z")
          const trunk = segmentCylinderInterval(a[0], a[1], a[2], b[0], b[1], b[2], this.tree(n, "x"), this.tree(n, "y"), this.tree(n, "trunkR"), z0, z0 + this.tree(n, "crownBase"))
          if (trunk) return false
          if (canopy) {
            const cb = z0 + this.tree(n, "crownBase")
            const top = z0 + this.tree(n, "height")
            depth += this.rules.canopyDensity * segmentEllipsoidChord(a[0], a[1], a[2], b[0], b[1], b[2], this.tree(n, "crownX"), this.tree(n, "crownY"), (cb + top) / 2, this.tree(n, "crownR"), (top - cb) / 2)
          }
        }
      }
    }
    return !(canopy && Math.exp(-depth) < this.rules.canopyBlockT)
  }
}

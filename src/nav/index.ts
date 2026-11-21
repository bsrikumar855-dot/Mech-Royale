/**
 * Zone navigator: owns the cached walkability grid (one per MapQuery) and a few time-sliced path-distance fields.
 * Built for Locomotion's zone modes (outside / shrink / rim); every call is bounded (NAV.popsPerTick heap pops).
 */
import { NAV } from "../config/index.ts"
import type { MapQuery } from "../world/map.ts"
import type { Rules } from "../world/rules.ts"
import { type FieldBuffers, FieldBuild, Heap, NavGrid } from "./grid.ts"

const grids = new WeakMap<MapQuery, NavGrid>()

/** The grid for this map (built once, ~0.2 s on the real arena: call it during the hello window, not mid-match). */
export function navGridFor(map: MapQuery, rules: Pick<Rules, "radius" | "height" | "stepUp" | "maxSlopeDeg">): NavGrid {
  let g = grids.get(map)
  if (!g) {
    g = new NavGrid(map, { radius: rules.radius, height: rules.height, stepUp: rules.stepUp, maxSlopeDeg: rules.maxSlopeDeg })
    grids.set(map, g)
  }
  return g
}

export class Navigator {
  private readonly fields = new Map<string, FieldBuild>()
  /** One build is in flight at a time, so one heap and a small pool of field buffers are reused (no GC churn per phase). */
  private readonly heap = new Heap()
  private readonly free: FieldBuffers[] = []
  private building: string | null = null

  readonly grid: NavGrid

  constructor(grid: NavGrid) {
    this.grid = grid
  }

  clear(): void {
    for (const k of [...this.fields.keys()]) this.drop(k)
    this.building = null
  }

  private drop(key: string): void {
    const f = this.fields.get(key)
    if (!f) return
    this.fields.delete(key)
    this.free.push({ dist: f.dist, settled: f.settled })
    if (this.building === key) this.building = null
  }

  /**
   * The (possibly still building) field toward "inside the circle (cx, cy, radius)": cheapest path to any walkable cell
   * within NAV.destFrac x radius of the centre (deeper cells get a small pull). Null if nothing walkable is near it.
   */
  field(cx: number, cy: number, radius: number): FieldBuild | null {
    const key = `${Math.round(cx)},${Math.round(cy)},${Math.round(radius)}`
    let f = this.fields.get(key)
    if (!f) {
      const seeds = this.grid.circleSeeds(cx, cy, radius, NAV.destFrac, NAV.centrePull)
      if (seeds.length === 0) return null
      // a newer destination makes an unfinished older build useless (the next circle replaced it): abandon it
      if (this.building !== null && !this.fields.get(this.building)?.done) this.drop(this.building)
      f = this.grid.build(seeds, this.free.pop(), this.heap)
      this.fields.set(key, f)
      this.building = key
      while (this.fields.size > NAV.maxFields) this.drop(this.fields.keys().next().value as string)
    }
    return f
  }

  /** Advance unfinished fields (newest first) by the per-tick pop budget. */
  pump(urgent: boolean): void {
    let budget = urgent ? NAV.popsPerTickUrgent : NAV.popsPerTick
    const list = [...this.fields.values()].reverse()
    for (const f of list) {
      if (f.done) continue
      f.step(budget)
      break // one field per tick keeps the cost flat
    }
  }

  direction(f: FieldBuild, x: number, y: number, z: number): [number, number] | null {
    return this.grid.direction(f, x, y, z)
  }

  pathLength(f: FieldBuild, x: number, y: number): number {
    return this.grid.pathLength(f, x, y)
  }
}

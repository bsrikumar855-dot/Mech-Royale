import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { MapQuery, type WorldJson } from "../src/world/map.ts"
import { parseTerrainI16 } from "../src/world/mapLoader.ts"
import type { ActorObs, Hello, Observation } from "../src/types/mechfight.ts"
import type { TickContext } from "../src/types/contracts.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import { WorldModel } from "../src/world/world.ts"

export const ROOT = resolve(import.meta.dirname, "..")
export const ARENA_DIR = process.env["ARENA_DIR"] ?? join(ROOT, "_kit", "arena")
export const HAS_ARENA = existsSync(join(ARENA_DIR, "v2", "world.json")) && existsSync(join(ARENA_DIR, "v2", "terrain.i16"))

export function fixtureHello(mapDir = ARENA_DIR): Hello {
  const h = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "hello.json"), "utf8")) as Hello
  h.map.dir = mapDir
  return h
}

export function fixtureObs(): Observation[] {
  return JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "obs.json"), "utf8")) as Observation[]
}

/**
 * A tiny exact map. Terrain is the plane z = 0.1 * x (so bilinear sampling is exact), bounds +-50.
 *   A: building (0..10, 0..10), base -5, top 20
 *   B: building with a hole: outer (20..40, 20..40), hole (25..35, 25..35), base -5, top 15
 *   C: bridge (-30..-10, -5..5), base 14, top 16
 *   tree: trunk+crown at (0, -30), z = -3 (terrain), height 10, crownBase 5, crownR 3, trunkR 0.5
 */
export function syntheticWorld(): { world: WorldJson; heights: Int16Array } {
  const n = 101
  const heights = new Int16Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = 10 * (i - 50)
  const rect = (x0: number, y0: number, x1: number, y1: number): number[] => [x0, y0, x1, y0, x1, y1, x0, y1]
  const world: WorldJson = {
    bounds: { minX: -50, maxX: 50, minY: -50, maxY: 50 },
    terrain: { minX: -50, minY: -50, step: 1, nx: n, ny: n, scale: 0.01 },
    rules: { maxStep: 1.5, maxSlopeDeg: 50, canopyDensity: 0.35, canopyBlockT: 0.25 },
    prisms: [
      { kind: "building", base: -5, top: 20, ring: rect(0, 0, 10, 10) },
      { kind: "building", base: -5, top: 15, ring: rect(20, 20, 40, 40), holes: [rect(25, 25, 35, 35)] },
      { kind: "bridge", base: 14, top: 16, ring: rect(-30, -5, -10, 5) },
    ],
    trees: {
      fields: ["x", "y", "z", "height", "crownR", "crownBase", "trunkR", "osm", "crownX", "crownY"],
      data: [0, -30, -3, 10, 3, 5, 0.5, 0, 0, -30],
    },
  }
  return { world, heights }
}

export function syntheticMap(): MapQuery {
  const { world, heights } = syntheticWorld()
  return new MapQuery(world, heights)
}

export function realMap(): { map: MapQuery; world: WorldJson; raw: Int16Array } {
  const world = JSON.parse(readFileSync(join(ARENA_DIR, "v2", "world.json"), "utf8")) as WorldJson
  const raw = parseTerrainI16(readFileSync(join(ARENA_DIR, "v2", "terrain.i16")))
  return { map: new MapQuery(world, raw), world, raw }
}

/** A clean, fully-specified observation: us at `pos`, aim [0,0], gun loaded, slot 1 empty, a huge safe zone, nothing else. */
export function cleanObs(patch: (o: Observation) => void = () => {}, hello: Hello = fixtureHello()): Observation {
  const o = structuredClone(fixtureObs()[0] as Observation)
  const cfg = hello.config
  o.tick = 200
  o.t = 10
  o.self.pos = [0, 0, 0]
  o.self.vel = [0, 0, 0]
  o.self.aim = [0, 0]
  o.self.in_zone = true
  o.self.energy = 100
  o.self.stats = { ...(cfg.mech as Record<string, number>) }
  o.self.weapons = [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: { ...(cfg.weapons.gun as Record<string, number>) } }, null]
  o.mechs = []
  o.projectiles = []
  o.crates = []
  o.cubes = []
  o.pickups = []
  o.sounds = []
  o.beams = []
  o.events = []
  o.drops = []
  o.offer = null
  o.zone = { center: [0, 0], radius: 500, next_center: [0, 0], next_radius: 500, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 20 }
  patch(o)
  return o
}

export const lightningWeapon = (hello: Hello = fixtureHello()): NonNullable<Observation["self"]["weapons"][1]> => ({
  kind: "lightning",
  cooldown: 0,
  stats: { ...(hello.config.weapons.lightning as Record<string, number>) },
})

export function enemy(id: number, pos: [number, number, number], over: Partial<ActorObs> = {}): ActorObs {
  return { id, kind: "mech", pos, vel: [0, 0, 0], aim: [0, 0], hp: 1400, max_hp: 1400, weapons: ["gun"], charging: false, ...over }
}

/** A WorldModel that has seen `obs`, plus the TickContext the modules receive. */
export function ctxFor(obs: Observation, map: MapQuery | null = null, world?: WorldModel): TickContext {
  const w = world ?? new WorldModel(fixtureHello())
  w.update(obs)
  return { world: w, map, deadline: NO_DEADLINE }
}

if (!HAS_ARENA) {
  console.error(`[test] arena not found at ${ARENA_DIR}: real-map tests are SKIPPED (set ARENA_DIR or unpack the kit into _kit/)`)
}

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MapQuery, type WorldJson } from "./map.ts"

const DEFAULT_WORLD = "v2/world.json"
const DEFAULT_TERRAIN = "v2/terrain.i16"

/** Little-endian int16 view that is safe regardless of Buffer pool alignment or host endianness. */
export function parseTerrainI16(buf: Uint8Array): Int16Array {
  const n = Math.floor(buf.byteLength / 2)
  const out = new Int16Array(n)
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true)
  return out
}

/** Reads the map STRICTLY from `dir` (hello.map.dir; read-only mount). Writes nothing. */
export function loadMapQuery(dir: string, files?: readonly string[]): MapQuery {
  const worldFile = files?.find((f) => f.endsWith("world.json")) ?? DEFAULT_WORLD
  const terrainFile = files?.find((f) => f.endsWith(".i16")) ?? DEFAULT_TERRAIN
  const world = JSON.parse(readFileSync(join(dir, worldFile), "utf8")) as WorldJson
  const heights = parseTerrainI16(readFileSync(join(dir, terrainFile)))
  return new MapQuery(world, heights)
}

// Forensic replay (ad hoc, not committed to the test suite): feed the kit's 300 recorded observations
// through the REAL Bot (real arena map) on current main, tallying mode/behavior stats to look for any
// dead-logic or "stuck" pattern similar to the original locomotion-v3 finding (stationary 300/300 ticks).
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Bot } from "../src/bot.ts"
import { NO_DEADLINE } from "../src/runtime/deadline.ts"
import { WorldModel } from "../src/world/world.ts"
import type { Hello, Observation } from "../src/types/mechfight.ts"
import { ARENA_DIR, realMap } from "../test/helpers.ts"

const raw = gunzipSync(readFileSync(join(ARENA_DIR, "..", "check", "stream.jsonl.gz"))).toString("utf8")
const lines = raw.split("\n").filter((l) => l.trim().length > 0)
const msgs = lines.map((l) => JSON.parse(l))
const hello = msgs.find((m) => m.type === "hello") as Hello
const obsList = msgs.filter((m) => m.type === "obs") as Observation[]

const world = new WorldModel(hello)
const { map } = realMap()
const bot = new Bot(world, map)

const modeCounts: Record<string, number> = {}
let stationary = 0
let fireTicks = 0
let jumpTicks = 0
let boostTicks = 0
let takeTicks = 0
let pickTicks = 0
let reloadTicks = 0
let dropTicks = 0
let maxEnemiesSeen = 0
let losEverTrue = 0

for (const obs of obsList) {
  const action = bot.decide(obs, NO_DEADLINE)
  const mode = (bot.modules.locomotion as unknown as { lastMode?: string }).lastMode ?? "?"
  modeCounts[mode] = (modeCounts[mode] ?? 0) + 1
  if (!action.move || (action.move[0] === 0 && action.move[1] === 0)) stationary++
  if (action.fire && (action.fire[0] || action.fire[1])) fireTicks++
  if (action.jump) jumpTicks++
  if (action.boost) boostTicks++
  if (action.take !== undefined) takeTicks++
  if (action.pick !== undefined) pickTicks++
  if (action.reload) reloadTicks++
  if (action.drop !== undefined) dropTicks++
  const enemies = (obs.mechs ?? []).filter((m) => m.kind === "mech")
  if (enemies.length > maxEnemiesSeen) maxEnemiesSeen = enemies.length
  if (enemies.length > 0) losEverTrue++
}

console.log("ticks:", obsList.length)
console.log("mode distribution:", modeCounts)
console.log("stationary:", stationary, "fire:", fireTicks, "jump:", jumpTicks, "boost:", boostTicks)
console.log("take:", takeTicks, "pick:", pickTicks, "reload:", reloadTicks, "drop:", dropTicks)
console.log("max enemies visible at once:", maxEnemiesSeen, "ticks with >=1 listed enemy:", losEverTrue)

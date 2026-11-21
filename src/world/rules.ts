import { RULE_FALLBACKS } from "../config/index.ts"
import type { Config } from "../types/mechfight.ts"
import { isFiniteNum } from "./geom.ts"

/** Rules the bot's geometry/arbiter code needs, resolved once per match from hello.config (server numbers win). */
export interface Rules {
  radius: number
  height: number
  eyeHeight: number
  muzzleHeight: number
  stepUp: number
  maxSlopeDeg: number
  minPitch: number
  maxPitch: number
  rearMult: number
  frontArcDeg: number
  visionRange: number
  fovDeg: number
  nearRange: number
  memoryS: number
  tickBudgetMs: number
  maxLineBytes: number
  tickHz: number
  decideEvery: number
}

type NumRec = Readonly<Record<string, number | undefined>> | undefined

const pick = (rec: NumRec, key: string, fallback: number): number => {
  const v = rec?.[key]
  return isFiniteNum(v) ? v : fallback
}

export function resolveRules(config: Config): Rules {
  const m = config.mech as NumRec
  const v = config.vision as unknown as NumRec
  const b = config.bot as NumRec
  const mt = config.match as NumRec
  const fm = RULE_FALLBACKS.mech
  return {
    radius: pick(m, "radius", fm.radius),
    height: pick(m, "height", fm.height),
    eyeHeight: pick(m, "eye_height", fm.eye_height),
    muzzleHeight: pick(m, "muzzle_height", fm.muzzle_height),
    stepUp: pick(m, "step_up", fm.step_up),
    maxSlopeDeg: pick(m, "max_slope_deg", fm.max_slope_deg),
    minPitch: pick(m, "min_pitch", fm.min_pitch),
    maxPitch: pick(m, "max_pitch", fm.max_pitch),
    rearMult: pick(m, "rear_mult", fm.rear_mult),
    frontArcDeg: pick(m, "front_arc_deg", fm.front_arc_deg),
    visionRange: pick(v, "range", RULE_FALLBACKS.vision.range),
    fovDeg: pick(v, "fov_deg", RULE_FALLBACKS.vision.fov_deg),
    nearRange: pick(v, "near_range", RULE_FALLBACKS.vision.near_range),
    memoryS: pick(v, "memory_s", RULE_FALLBACKS.vision.memory_s),
    tickBudgetMs: pick(b, "tick_budget_ms", RULE_FALLBACKS.bot.tick_budget_ms),
    maxLineBytes: pick(b, "max_line_bytes", RULE_FALLBACKS.bot.max_line_bytes),
    tickHz: pick(mt, "tick_hz", RULE_FALLBACKS.match.tick_hz),
    decideEvery: pick(mt, "decide_every", RULE_FALLBACKS.match.decide_every),
  }
}

/**
 * Locomotion v11: decaying threat map. A fixed-cap list (threatMapCap) of recent threat positions:
 *  - enemy mech sightings (weight threatEnemyWeight), keyed by enemy id and updated in place (one entry per enemy),
 *  - weapon sounds from obs.sounds (weight threatSoundWeight), placed at our position + bearing * a representative
 *    range for the sound's distance bucket (near / mid / far): a coarse estimate, enough to tell the loud side.
 * Each entry's weight decays linearly to 0 over threatDecayS. score(x, y) is O(entries) (<= 16).
 * Owned by LocoState: cleared on a new match (resetCount) or a backwards tick, never on an observation gap.
 */
import { LOCOMOTION as L } from "../config/index.ts"
import type { WorldModel } from "../world/world.ts"

export interface ThreatEntry {
  x: number
  y: number
  /** match time it was last seen / heard */
  t: number
  /** base weight before decay */
  w: number
  /** enemy id for sightings (updated in place), null for sounds */
  id: number | null
}

export class ThreatMap {
  entries: ThreatEntry[] = []

  clear(): void {
    this.entries = []
  }

  /** Feed this observation's sightings and sounds; drop expired entries; keep at most threatMapCap (oldest out). */
  ingest(world: WorldModel): void {
    const obs = world.obs
    if (!obs) return
    const t = world.t
    const [px, py] = world.self.pos
    for (const m of obs.mechs ?? []) {
      if (m.kind !== "mech") continue
      const e = this.entries.find((x) => x.id === m.id)
      if (e) {
        e.x = m.pos[0]
        e.y = m.pos[1]
        e.t = t
      } else this.entries.push({ x: m.pos[0], y: m.pos[1], t, w: L.threatEnemyWeight, id: m.id })
    }
    for (const s of obs.sounds ?? []) {
      if (!L.threatSoundKinds.includes(s.kind)) continue
      const r = L.threatSoundRangeM[s.dist] ?? 0
      if (r <= 0) continue
      this.entries.push({ x: px + Math.cos(s.bearing) * r, y: py + Math.sin(s.bearing) * r, t: t - s.age, w: L.threatSoundWeight, id: null })
    }
    this.entries = this.entries.filter((e) => t - e.t < L.threatDecayS)
    if (this.entries.length > L.threatMapCap) {
      this.entries.sort((a, b) => b.t - a.t)
      this.entries.length = L.threatMapCap
    }
  }

  /** Decayed weight of an entry at time t (0 once threatDecayS old). */
  static weight(e: ThreatEntry, t: number): number {
    const age = t - e.t
    return age < 0 ? e.w : Math.max(0, e.w * (1 - age / L.threatDecayS))
  }

  /** Threat pressure at (x, y): sum of decayed weights times a 1 / (1 + (d / scale)^2) falloff (default threatScaleM). */
  score(x: number, y: number, t: number, scale: number = L.threatScaleM): number {
    let s = 0
    for (const e of this.entries) {
      const w = ThreatMap.weight(e, t)
      if (w <= 0) continue
      const d = Math.hypot(x - e.x, y - e.y) / scale
      s += w / (1 + d * d)
    }
    return s
  }

  /** Is any still-active threat within r of (x, y)? */
  near(x: number, y: number, r: number, t: number): boolean {
    return this.entries.some((e) => ThreatMap.weight(e, t) > 0 && Math.hypot(x - e.x, y - e.y) < r)
  }

  get active(): number {
    return this.entries.length
  }
}

/**
 * WorldModel: the bot's memory of one match. Stores hello.config (no hardcoded balance numbers) and a bounded
 * view of what we have seen. Owner: Person A. Person B reads it; nobody else mutates it.
 *
 * Every buffer here is bounded (WORLD.*) so RSS stays far below 512 MB however long a match runs.
 */
import { WORLD } from "../config/index.ts"
import type { Config, DamagedEvent, Hello, Observation, SelfObs, Vec2, Vec3, WeaponKind } from "../types/mechfight.ts"
import { clamp, isFiniteNum, lerp } from "./geom.ts"
import { resolveRules, type Rules } from "./rules.ts"

export interface TrackSample {
  t: number
  pos: Vec3
}

/** A mech or NPC drone we have seen. `lastListedT` is the last match time it appeared in obs.mechs. */
export interface Track {
  id: number
  kind: "mech" | "npc"
  pos: Vec3
  vel: Vec3
  aim: Vec2
  hp?: number
  maxHp?: number
  cubes?: number
  weapons: WeaponKind[]
  charging: boolean
  firstSeenT: number
  lastListedT: number
  history: TrackSample[]
}

export interface HeardSound {
  kind: string
  /** world-frame yaw to the source, with Gaussian error (sigma = sound.bearing_noise_deg) */
  bearing: number
  dist: "near" | "mid" | "far"
  /** absolute match time the sound happened (obs.t - age) */
  t: number
}

export interface DamageRecord {
  t: number
  amount: number
  weapon: string
  bearing: number | null
  by: number | null
  rear: boolean
}

export interface ZoneCircle {
  center: Vec2
  radius: number
}

export class WorldModel {
  readonly config: Config
  readonly slot: number
  readonly rules: Rules

  /** Latest observation (null before the first tick of a match). */
  obs: Observation | null = null
  tracks = new Map<number, Track>()
  sounds: HeardSound[] = []
  damage: DamageRecord[] = []
  private lastTick: number | null = null
  /** Our confirmed kills this match (`kill` events). */
  ourKills = 0
  /** Deaths that were not our kills, counted only within WORLD.ffaWindowS (environment detector). */
  externalDeathsEarly = 0
  /** Sticky: other mechs are killing each other, so this is a free-for-all, not the practice squad. */
  ffa = false
  private extValue = 0
  private extSince = 0
  /** Incremented by every reset(): lets modules with their own memory (Locomotion) detect a new match. Read-only for them. */
  resetCount = 0

  constructor(hello: Hello) {
    this.config = hello.config
    this.slot = hello.slot
    this.rules = resolveRules(hello.config)
  }

  /** Clean state for a new match (also run when a tick regression shows a new match in the same process). */
  reset(): void {
    this.resetCount++
    this.obs = null
    this.tracks.clear()
    this.sounds = []
    this.damage = []
    this.lastTick = null
    this.ourKills = 0
    this.externalDeathsEarly = 0
    this.ffa = false
    this.extValue = 0
    this.extSince = 0
  }

  get self(): SelfObs {
    if (!this.obs) throw new Error("WorldModel has no observation yet")
    return this.obs.self
  }
  get t(): number {
    return this.obs?.t ?? 0
  }
  get tick(): number {
    return this.obs?.tick ?? 0
  }

  /** A stat of OUR mech after upgrades (falls back to config.mech). */
  selfStat(key: string, fallback: number): number {
    const v = this.obs?.self.stats?.[key]
    if (isFiniteNum(v)) return v
    const c = (this.config.mech as Record<string, number | undefined>)[key]
    return isFiniteNum(c) ? c : fallback
  }

  update(obs: Observation): void {
    if (this.lastTick !== null && obs.tick < this.lastTick) this.reset() // new match in the same process
    this.lastTick = obs.tick
    this.obs = obs
    const t = obs.t

    for (const m of obs.mechs ?? []) {
      let tr = this.tracks.get(m.id)
      if (!tr) {
        tr = { id: m.id, kind: m.kind, pos: m.pos, vel: m.vel, aim: m.aim, weapons: [], charging: false, firstSeenT: t, lastListedT: t, history: [] }
        this.tracks.set(m.id, tr)
      }
      tr.kind = m.kind
      tr.pos = m.pos
      tr.vel = m.vel
      tr.aim = m.aim
      tr.hp = m.hp
      tr.maxHp = m.max_hp
      tr.cubes = m.cubes
      tr.weapons = m.weapons ?? []
      tr.charging = m.charging ?? false
      tr.lastListedT = t
      tr.history.push({ t, pos: m.pos })
      if (tr.history.length > WORLD.historySamples) tr.history.shift()
    }

    for (const e of obs.events ?? []) {
      if (e.type === "kill") {
        this.tracks.delete(e.target)
        this.ourKills++
      } else if (e.type === "damaged") this.recordDamage(e, t)
    }
    this.updateEnvironment(obs, t)

    for (const s of obs.sounds ?? []) this.sounds.push({ kind: s.kind, bearing: s.bearing, dist: s.dist, t: t - s.age })
    this.sounds = this.sounds.filter((s) => t - s.t <= WORLD.soundMemoryS).slice(-WORLD.maxSounds)
    this.damage = this.damage.filter((d) => t - d.t <= WORLD.damageMemoryS).slice(-WORLD.maxDamageRecords)

    this.pruneTracks(t)
  }

  /** Environment detector: deaths before the zone can kill that are not ours mean the others fight each other. */
  private updateEnvironment(obs: Observation, t: number): void {
    const total = (this.config.match as Record<string, number | undefined>)["mechs"] ?? 16
    if (typeof obs.alive !== "number" || !Number.isFinite(obs.alive)) return
    const external = Math.max(0, total - obs.alive - this.ourKills)
    // a value must hold for ffaConfirmS: the alive drop and our `kill` event can land in different observations
    if (external !== this.extValue) {
      this.extValue = external
      this.extSince = t
    }
    if (t <= WORLD.ffaWindowS && t - this.extSince >= WORLD.ffaConfirmS) this.externalDeathsEarly = Math.max(this.externalDeathsEarly, external)
    if (this.externalDeathsEarly >= WORLD.ffaMinExternalDeaths) this.ffa = true
  }

  private recordDamage(e: DamagedEvent, t: number): void {
    this.damage.push({ t, amount: e.amount, weapon: e.weapon, bearing: e.bearing, by: e.by, rear: e.rear ?? false })
  }

  private pruneTracks(t: number): void {
    const keep = this.rules.memoryS + WORLD.trackGraceS
    for (const [id, tr] of this.tracks) if (t - tr.lastListedT > keep) this.tracks.delete(id)
    if (this.tracks.size > WORLD.maxTracks) {
      const oldest = [...this.tracks.values()].sort((a, b) => a.lastListedT - b.lastListedT)
      for (const tr of oldest.slice(0, this.tracks.size - WORLD.maxTracks)) this.tracks.delete(tr.id)
    }
  }

  enemies(): Track[] {
    return [...this.tracks.values()].filter((tr) => tr.kind === "mech")
  }
  npcs(): Track[] {
    return [...this.tracks.values()].filter((tr) => tr.kind === "npc")
  }

  /**
   * Velocity for lead calculations: the server's `vel` when it is finite (it is exact for listed actors), else a
   * finite difference over the bounded history. Needed because gun (252 m/s) and mortar shells are projectiles.
   */
  estimateVelocity(tr: Track): Vec3 {
    if (tr.vel.every(isFiniteNum)) return tr.vel
    const h = tr.history
    const a = h[0]
    const b = h[h.length - 1]
    if (!a || !b || b.t <= a.t) return [0, 0, 0]
    const dt = b.t - a.t
    return [(b.pos[0] - a.pos[0]) / dt, (b.pos[1] - a.pos[1]) / dt, (b.pos[2] - a.pos[2]) / dt]
  }

  /** The zone circle at match time `t`, interpolating the shrink window (protocol.md §9). */
  zoneAt(t: number): ZoneCircle {
    const z = this.obs?.zone
    if (!z) return { center: [0, 0], radius: Infinity }
    if (t <= z.shrink_start || z.shrink_end <= z.shrink_start) return { center: z.center, radius: z.radius }
    const f = clamp((t - z.shrink_start) / (z.shrink_end - z.shrink_start), 0, 1)
    return {
      center: [lerp(z.center[0], z.next_center[0], f), lerp(z.center[1], z.next_center[1], f)],
      radius: lerp(z.radius, z.next_radius, f),
    }
  }

  /** Most recent damage bearing within `maxAgeS` (null if none or it was zone damage). */
  recentThreatBearing(maxAgeS: number): number | null {
    for (let i = this.damage.length - 1; i >= 0; i--) {
      const d = this.damage[i] as DamageRecord
      if (this.t - d.t <= maxAgeS && d.bearing !== null) return d.bearing
    }
    return null
  }
}

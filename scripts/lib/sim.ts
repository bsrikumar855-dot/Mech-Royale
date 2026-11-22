/**
 * Kinematic evaluation harness (NOT the game server). Drives the REAL Bot on the REAL arena map against:
 *  - a zone with the protocol's phase table (hello.config.zone) and random next centres (ASSUMPTION: the server's
 *    rule for choosing the next circle is not documented beyond "entirely inside the current one");
 *  - simple movement physics (accel limit, walk / boost speed, wall sliding via MapQuery, step-up);
 *  - optional scripted enemies (static / pursue / orbit) with an expected-DPS shooting model when they have a
 *    shot line (ASSUMPTION: crude, uncalibrated; gun 45 dmg / 0.24 s x hitProb).
 * It validates movement, zone and spacing logic. It says NOTHING about official placement. No jumps, no jets, no
 * weapons on our side: use it for navigation / positioning behaviour only.
 */
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { pathToFileURL } from "node:url"
import { join, resolve } from "node:path"

export interface Enemy {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  hp: number
  policy: "static" | "pursue" | "orbit" | "hunter"
  speed: number
  /** expected gun hit probability per shot while it has a shot line within 200 m (0 = never shoots) */
  hitProb: number
}

export interface SimOpts {
  root: string // repo root whose src/ to evaluate
  kit: string
  seed: number
  startPhase: number // 0 = match start
  pos?: [number, number] // override spawn
  enemies?: Enemy[]
  /** run until this match time (default: end of the start phase + 10 s) */
  untilT?: number
  /** override the zone phase table (tests) */
  zoneOverride?: any[]
  /** our starting HP (default: full) */
  startHp?: number
  /** called after every decision (audits): state BEFORE the action is applied */
  onDecision?: (d: Decision) => void
}

export interface Decision {
  t: number
  x: number
  y: number
  aim: number
  act: any
  mode: string
  inZone: boolean
  circle: { c: [number, number]; r: number }
  /** match time of the last enemy damage we took (-Infinity if none) */
  lastHitT: number
  /** the enemy that last damaged us, if any */
  lastHitBy: { x: number; y: number } | null
  hp: number
}

export interface SimResult {
  died: boolean
  deathT: number | null
  endT: number
  hp: number
  zoneDamage: number
  enemyDamage: number
  timeOutside: number
  minEnemyDist: number
  meanDistToFinalCentre: number
  finalPos: [number, number]
  trace: Array<{ t: number; x: number; y: number; mode: string; inZone: boolean; hp: number }>
  modes: Record<string, number>
  /** seconds during which the hunter squad could see us (hunter policy only) */
  seenS: number
  /** wall-clock ms of every Bot.decide() call (compute only, no IPC) */
  decideMs: number[]
}

/** mulberry32 */
export const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export async function load(root: string, kit: string) {
  const u = (p: string) => pathToFileURL(join(resolve(root), p)).href
  const { Bot } = await import(u("src/bot.ts"))
  const { WorldModel } = await import(u("src/world/world.ts"))
  const { loadMapQuery } = await import(u("src/world/mapLoader.ts"))
  const { NO_DEADLINE } = await import(u("src/runtime/deadline.ts"))
  const rows = gunzipSync(readFileSync(join(kit, "check", "stream.jsonl.gz"))).toString().trim().split("\n").map((l) => JSON.parse(l))
  const hello = rows[0]
  hello.map.dir = join(kit, "arena")
  const map = loadMapQuery(hello.map.dir, hello.map.files)
  const tmpl = rows.slice(1).find((o: any) => o.type === "obs")
  return { Bot, WorldModel, NO_DEADLINE, hello, map, tmpl }
}

type Loaded = Awaited<ReturnType<typeof load>>

export function phases(hello: any, rand: () => number, bounds?: { minX: number; maxX: number; minY: number; maxY: number }) {
  const z = hello.config.zone
  const out: any[] = []
  let c: [number, number] = [z.start_center[0], z.start_center[1]]
  let r = z.start_radius
  let t = 0
  for (const p of z.phases) {
    const maxOff = Math.max(0, r - p.radius)
    // ASSUMPTION: the next centre is uniform inside the allowed offset AND inside the playable map (the first circle,
    // radius 560, already reaches 300 m past the south edge; the server's rule is undocumented).
    let nc: [number, number] = [c[0], c[1]]
    for (let k = 0; k < 200; k++) {
      const ang = rand() * 2 * Math.PI
      const off = maxOff * Math.sqrt(rand())
      const cand: [number, number] = [c[0] + Math.cos(ang) * off, c[1] + Math.sin(ang) * off]
      if (!bounds || (cand[0] > bounds.minX + 40 && cand[0] < bounds.maxX - 40 && cand[1] > bounds.minY + 40 && cand[1] < bounds.maxY - 40)) {
        nc = cand
        break
      }
    }
    out.push({ t0: t, shrinkStart: t + p.hold_s, shrinkEnd: t + p.hold_s + p.shrink_s, c0: c, r0: r, c1: nc, r1: p.radius, dps: p.dps })
    t += p.hold_s + p.shrink_s
    c = nc
    r = p.radius
  }
  return out
}

export function circleAt(ph: any, t: number): { c: [number, number]; r: number } {
  if (t <= ph.shrinkStart) return { c: ph.c0, r: ph.r0 }
  if (t >= ph.shrinkEnd) return { c: ph.c1, r: ph.r1 }
  const f = (t - ph.shrinkStart) / (ph.shrinkEnd - ph.shrinkStart)
  return { c: [ph.c0[0] + (ph.c1[0] - ph.c0[0]) * f, ph.c0[1] + (ph.c1[1] - ph.c0[1]) * f], r: ph.r0 + (ph.r1 - ph.r0) * f }
}

export async function run(L: Loaded, o: SimOpts): Promise<SimResult> {
  const { hello, map, tmpl } = L
  const rand = rng(o.seed)
  const ph = o.zoneOverride ?? phases(hello, rand, map.bounds)
  const cfg = hello.config
  const mech = cfg.mech as Record<string, number>
  const body = { radius: mech["radius"]!, height: mech["height"]!, stepUp: mech["step_up"]! }
  const startPh = ph[Math.min(o.startPhase, ph.length - 1)]
  let t = startPh.t0
  let x = 0
  let y = 0
  const spawnC = startPh.c0
  const spawnR = o.startPhase === 0 ? startPh.r0 * 0.8 : startPh.r0
  const b = map.bounds
  if (o.pos) [x, y] = o.pos
  else {
    for (let k = 0; k < 500; k++) {
      const a = rand() * 2 * Math.PI
      const d = spawnR * Math.sqrt(rand())
      const qx = spawnC[0] + Math.cos(a) * d
      const qy = spawnC[1] + Math.sin(a) * d
      if (qx < b.minX + 30 || qx > b.maxX - 30 || qy < b.minY + 30 || qy > b.maxY - 30) continue
      const g = map.heightAt(qx, qy)
      if (map.isBlockedAt(qx, qy, g, body) || map.slopeDegAt(qx, qy) > 30) continue
      ;[x, y] = [qx, qy]
      break
    }
  }
  let z = map.standingHeightAt(x, y, map.heightAt(x, y), body.stepUp, body.height)
  let vx = 0
  let vy = 0
  let aim = 0
  let hp = o.startHp ?? mech["hp"]!
  let energy = mech["energy"]!
  let lastSpend = -99
  let lastDmg = -99
  const maxT = o.untilT ?? startPh.shrinkEnd + 10
  const enemies = (o.enemies ?? []).map((e) => ({ ...e }))
  const bot = new L.Bot(new L.WorldModel(hello), map)
  const res: SimResult = { died: false, deathT: null, endT: t, hp, zoneDamage: 0, enemyDamage: 0, timeOutside: 0, minEnemyDist: Infinity, meanDistToFinalCentre: 0, finalPos: [x, y], trace: [], modes: {}, decideMs: [], seenS: 0 }
  const dt = 0.05
  let tick = 0
  /** events / sounds produced by enemy fire since the previous observation (the server reports them to us) */
  let pendEvents: any[] = []
  let lastHitT = Number.NEGATIVE_INFINITY
  let lastBoost = false
  // hunter squad (ASSUMPTION: the practice squad shares what any member SEES and hears; protocol vision and sound rules,
  // 360 deg awareness for every hunter, which makes hiding HARDER than for a real wedge-limited bot)
  let known: { x: number; y: number } | null = null
  let squadSees = false
  const searchWp = new Map<number, { x: number; y: number; t: number }>()
  let lastHitBy: { x: number; y: number } | null = null
  let pendSounds: any[] = []
  let distSum = 0
  let distN = 0
  const phaseAt = (tt: number) => ph.find((p: any) => tt < p.shrinkEnd) ?? ph[ph.length - 1]
  const finalC = ph[ph.length - 1].c1
  const HALF = ((cfg.vision.fov_deg as number) * Math.PI) / 360
  while (t < maxT && !res.died) {
    const P = phaseAt(t)
    const circ = circleAt(P, t)
    const inZone = Math.hypot(x - circ.c[0], y - circ.c[1]) <= circ.r
    if (enemies.some((e) => e.policy === "hunter")) {
      if (!known) known = { x, y } // the squad starts on our trail
      squadSees = false
      for (const e of enemies) {
        const d = Math.hypot(e.x - x, e.y - y)
        const eye: [number, number, number] = [e.x, e.y, map.heightAt(e.x, e.y) + 8]
        const canopy = { canopy: d > (cfg.vision.near_range as number) }
        if (d <= (cfg.vision.range as number) && (map.hasVisionLOS(eye, [x, y, z + 4.5], canopy) || map.hasVisionLOS(eye, [x, y, z + 9], canopy))) squadSees = true
        if ((Math.hypot(vx, vy) > 5 && d <= 40) || (lastBoost && d <= 90)) known = { x, y } // footsteps / boost heard
      }
      if (squadSees) {
        known = { x, y }
        res.seenS += 0.1
      }
    }
    const obs = structuredClone(tmpl)
    obs.tick = tick
    obs.t = +t.toFixed(3)
    obs.alive = 16
    const s = obs.self
    s.pos = [x, y, z]
    s.vel = [vx, vy, 0]
    s.aim = [aim, 0]
    s.hp = hp
    s.max_hp = mech["hp"]
    s.energy = energy
    s.max_energy = mech["energy"]
    s.grounded = true
    s.cubes = 0
    s.upgrades = []
    s.in_zone = inZone
    s.stats = { ...mech }
    s.weapons = [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: { ...(cfg.weapons.gun as Record<string, number>) } }, null]
    obs.mechs = []
    for (const e of enemies) {
      const d = Math.hypot(e.x - x, e.y - y)
      const bearing = Math.atan2(e.y - y, e.x - x)
      const seen = d <= (cfg.vision.near_range as number) || (d <= (cfg.vision.range as number) && Math.abs(wrap(bearing - aim)) <= HALF)
      if (seen && map.hasVisionLOS([x, y, z + 8], [e.x, e.y, map.heightAt(e.x, e.y) + 4.5], { canopy: true })) {
        obs.mechs.push({ id: e.id, kind: "mech", pos: [e.x, e.y, map.heightAt(e.x, e.y)], vel: [e.vx, e.vy, 0], aim: [Math.atan2(y - e.y, x - e.x), 0], hp: e.hp, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false })
      }
    }
    obs.projectiles = []
    obs.crates = []
    obs.cubes = []
    obs.pickups = []
    obs.sounds = pendSounds
    obs.beams = []
    obs.events = pendEvents
    pendEvents = []
    pendSounds = []
    obs.drops = []
    obs.offer = null
    obs.zone = { center: P.c0, radius: P.r0, next_center: P.c1, next_radius: P.r1, shrink_start: P.shrinkStart, shrink_end: P.shrinkEnd, dps: P.dps }
    const tDecide = performance.now()
    const act = bot.decide(obs, L.NO_DEADLINE)
    res.decideMs.push(performance.now() - tDecide)
    const mode = (bot.modules.locomotion as any).lastMode ?? "?"
    o.onDecision?.({ t, x, y, aim, act, mode, inZone, circle: circ, lastHitT, lastHitBy, hp })
    res.modes[mode] = (res.modes[mode] ?? 0) + 1
    if (tick % 10 === 0) res.trace.push({ t, x, y, mode, inZone, hp })
    tick += 2
    const mv = act.move ?? [0, 0]
    const wantBoost = act.boost === true && energy > 1 && Math.hypot(mv[0], mv[1]) > 0.05
    lastBoost = wantBoost
    const speed = wantBoost ? (mech["boost_speed"] as number) : (mech["walk_speed"] as number)
    for (let k = 0; k < 2; k++) {
      const tx = mv[0] * speed
      const ty = mv[1] * speed
      const ax = tx - vx
      const ay = ty - vy
      const am = Math.hypot(ax, ay)
      const lim = (mech["ground_accel"] as number) * dt
      if (am > lim) {
        vx += (ax / am) * lim
        vy += (ay / am) * lim
      } else {
        vx = tx
        vy = ty
      }
      const [mx, my] = map.slideMove(x, y, z, vx * dt, vy * dt, body)
      const nx = Math.min(b.maxX - body.radius, Math.max(b.minX + body.radius, x + mx))
      const ny = Math.min(b.maxY - body.radius, Math.max(b.minY + body.radius, y + my))
      vx = (nx - x) / dt
      vy = (ny - y) / dt
      x = nx
      y = ny
      z = map.standingHeightAt(x, y, z, body.stepUp, body.height)
      if (act.aim) {
        const turn = (mech["turn_rate"] as number) * dt
        aim = wrap(aim + Math.max(-turn, Math.min(turn, wrap(act.aim[0] - aim))))
      }
      if (wantBoost) {
        energy = Math.max(0, energy - (mech["boost_drain"] as number) * dt)
        lastSpend = t
      } else if (t - lastSpend >= (mech["energy_regen_delay"] as number)) energy = Math.min(mech["energy"] as number, energy + (mech["energy_regen"] as number) * dt)
      for (const e of enemies) {
        const dx = x - e.x
        const dy = y - e.y
        const d = Math.hypot(dx, dy) || 1
        if (e.policy === "hunter") {
          let gx = known ? known.x : e.x
          let gy = known ? known.y : e.y
          if (squadSees) {
            // in contact: hold ~90 m (the recorded house bot fought at 55-150 m)
            const radial = Math.max(-e.speed, Math.min(e.speed, d - 90))
            e.vx = (dx / d) * radial + (-dy / d) * e.speed * 0.5
            e.vy = (dy / d) * radial + (dx / d) * e.speed * 0.5
          } else {
            const kd = known ? Math.hypot(gx - e.x, gy - e.y) : 0
            if (known && kd < 10) {
              let wp = searchWp.get(e.id)
              if (!wp || t - wp.t > 5 || Math.hypot(wp.x - e.x, wp.y - e.y) < 5) {
                wp = { x: known.x + (rand() - 0.5) * 120, y: known.y + (rand() - 0.5) * 120, t }
                searchWp.set(e.id, wp)
              }
              gx = wp.x
              gy = wp.y
            }
            const gd = Math.hypot(gx - e.x, gy - e.y) || 1
            const want = gd > 2 ? e.speed : 0
            e.vx = ((gx - e.x) / gd) * want
            e.vy = ((gy - e.y) / gd) * want
          }
        } else if (e.policy === "pursue") {
          const sp = d > 60 ? e.speed : 0
          e.vx = (dx / d) * sp
          e.vy = (dy / d) * sp
        } else if (e.policy === "orbit") {
          const radial = Math.max(-e.speed, Math.min(e.speed, d - 90))
          e.vx = (-dy / d) * e.speed + (dx / d) * radial
          e.vy = (dx / d) * e.speed + (dy / d) * radial
        } else {
          e.vx = 0
          e.vy = 0
        }
        const [emx, emy] = map.slideMove(e.x, e.y, map.heightAt(e.x, e.y), e.vx * dt, e.vy * dt, body)
        e.x += emx
        e.y += emy
        res.minEnemyDist = Math.min(res.minEnemyDist, d)
        if (e.hitProb > 0 && d <= 200 && (e.policy !== "hunter" || squadSees) && map.hasShotLOS([e.x, e.y, map.heightAt(e.x, e.y) + 7], [x, y, z + 4.5])) {
          const dmg = (45 / 0.24) * e.hitProb * dt
          hp -= dmg
          res.enemyDamage += dmg
          lastDmg = t
          const bearing = Math.atan2(e.y - y, e.x - x)
          lastHitT = t
          lastHitBy = { x: e.x, y: e.y }
          const ev = pendEvents.find((q) => q.by === e.id)
          if (ev) ev.amount += dmg
          else pendEvents.push({ type: "damaged", amount: dmg, weapon: "gun", bearing, by: e.id })
        }
        if (e.hitProb > 0 && d <= 320 && !pendSounds.some((q) => q.src === e.id)) {
          pendSounds.push({ kind: "gun", bearing: Math.atan2(e.y - y, e.x - x), dist: d < 60 ? "near" : d < 160 ? "mid" : "far", age: 0.05, src: e.id })
        }
      }
      const c2 = circleAt(phaseAt(t), t)
      const inside = Math.hypot(x - c2.c[0], y - c2.c[1]) <= c2.r
      if (!inside) {
        const dmg = phaseAt(t).dps * dt
        hp -= dmg
        res.zoneDamage += dmg
        res.timeOutside += dt
        lastDmg = t
      } else if (t - lastDmg >= (mech["regen_delay"] as number)) hp = Math.min(mech["hp"] as number, hp + (mech["regen_per_s"] as number) * dt)
      distSum += Math.hypot(x - finalC[0], y - finalC[1])
      distN++
      t += dt
      if (hp <= 0) {
        res.died = true
        res.deathT = t
        break
      }
    }
  }
  res.endT = t
  res.hp = Math.max(0, hp)
  res.meanDistToFinalCentre = distN ? distSum / distN : 0
  res.finalPos = [x, y]
  return res
}

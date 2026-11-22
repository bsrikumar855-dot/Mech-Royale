/**
 * Bullet-dodge evaluation with the protocol's exact projectile physics (speed 252 m/s, no drop, Gaussian spread,
 * projectile radius 0.3, walls stop bullets) against the REAL Bot on the REAL map.
 *   node scripts/dodge-eval.ts [--n 40] [--spread 0.6]
 * The shooter is the assumption: it stands (or strafes) at range D, sees us, and fires every gun cooldown with a
 * perfect linear lead on our current velocity (what a competent bot does), reloading after 12 rounds. We report the
 * share of fired bullets that hit us, with the predictive evasion ON vs OFF (same code, same seeds, same positions).
 * Our own weapons do not exist here: this measures evasion only, never placement.
 */
import { join, resolve } from "node:path"
import { LOCOMOTION } from "../src/config/index.ts"
import { load, rng } from "./lib/sim.ts"

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k)
  return i >= 0 ? process.argv[i + 1]! : d
}
const root = resolve(arg("root", join(import.meta.dirname, "..")))
const kit = resolve(arg("kit", join(import.meta.dirname, "..", "_kit")))
const N = Number(arg("n", "30"))
const SPREAD_DEG = Number(arg("spread", "0.6")) // treated as the Gaussian sigma (worst plausible reading for the shooter)
const DUR = Number(arg("dur", "20"))
const L = await load(root, kit)
const map = L.map
const cfg = L.hello.config
const mech = cfg.mech as Record<string, number>
const gun = cfg.weapons.gun as Record<string, number>
const body = { radius: mech["radius"]!, height: mech["height"]!, stepUp: mech["step_up"]! }
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const HALF = ((cfg.vision.fov_deg as number) * Math.PI) / 360

type Cat = "open" | "wallBehind" | "wallSide" | "corner"
const openAt = (x: number, y: number) => !map.isBlockedAt(x, y, map.heightAt(x, y), body) && map.slopeDegAt(x, y) < 20
/** Find a start position of the given category; returns our pos and the direction the shooter is in. */
function place(cat: Cat, rand: () => number, D: number): { x: number; y: number; sx: number; sy: number } | null {
  const b = map.bounds
  for (let k = 0; k < 4000; k++) {
    const x = b.minX + 60 + rand() * (b.maxX - b.minX - 120)
    const y = b.minY + 60 + rand() * (b.maxY - b.minY - 120)
    if (!openAt(x, y)) continue
    const a = rand() * 2 * Math.PI
    const sx = x + Math.cos(a) * D
    const sy = y + Math.sin(a) * D
    if (!openAt(sx, sy)) continue
    if (!map.hasShotLOS([sx, sy, map.heightAt(sx, sy) + 7], [x, y, map.heightAt(x, y) + 4.5])) continue
    const blockedDir = (ang: number, r: number) => map.isBlockedAt(x + Math.cos(ang) * r, y + Math.sin(ang) * r, map.heightAt(x, y), body)
    const behind = blockedDir(a + Math.PI, 6)
    const left = blockedDir(a + Math.PI / 2, 6)
    const right = blockedDir(a - Math.PI / 2, 6)
    const anyNear = [0, 1, 2, 3, 4, 5, 6, 7].some((q) => blockedDir((q * Math.PI) / 4, 12))
    if (cat === "open" && !anyNear) return { x, y, sx, sy }
    if (cat === "wallBehind" && behind && !left && !right) return { x, y, sx, sy }
    if (cat === "wallSide" && !behind && left !== right) return { x, y, sx, sy }
    if (cat === "corner" && behind && (left || right)) return { x, y, sx, sy }
  }
  return null
}

interface Bul {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  id: number
  life: number
}

const DEFAULTS: Record<string, unknown> = { ...LOCOMOTION }
async function trial(arm: Record<string, unknown>, cat: Cat, seed: number, D: number) {
  Object.assign(LOCOMOTION as Record<string, unknown>, DEFAULTS, arm)
  const rand = rng(seed)
  const spot = place(cat, rand, D)
  if (!spot) return null
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand())
  let x = spot.x
  let y = spot.y
  let z = map.heightAt(x, y)
  let vx = 0
  let vy = 0
  let vz = 0
  let grounded = true
  let aim = Math.atan2(spot.sy - y, spot.sx - x)
  let energy = mech["energy"]!
  let lastSpend = -9
  const sx = spot.sx
  const sy = spot.sy
  const sz = map.heightAt(sx, sy)
  const bot = new L.Bot(new L.WorldModel(L.hello), map)
  let bullets: Bul[] = []
  let nextShot = 0.3
  let ammo = gun["mag"]!
  let fired = 0
  let hits = 0
  let pend: any[] = []
  let bid = 1
  let dodges = 0
  let jumps = 0
  const dt = 0.05
  let t = 0
  for (let tick = 0; t < DUR; tick += 2) {
    const obs = structuredClone(L.tmpl)
    obs.tick = tick
    obs.t = +(10 + t).toFixed(3)
    obs.alive = 16
    const s = obs.self
    s.pos = [x, y, z]
    s.vel = [vx, vy, vz]
    s.aim = [aim, 0]
    s.hp = 1400
    s.max_hp = 1400
    s.energy = energy
    s.max_energy = 100
    s.grounded = grounded
    s.cubes = 0
    s.upgrades = []
    s.in_zone = true
    s.stats = { ...mech }
    s.weapons = [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: { ...gun } }, null]
    obs.mechs = [{ id: 7, kind: "mech", pos: [sx, sy, sz], vel: [0, 0, 0], aim: [Math.atan2(y - sy, x - sx), 0], hp: 1400, max_hp: 1400, cubes: 0, weapons: ["gun"], charging: false }]
    obs.projectiles = bullets
      .filter((u) => {
        const d = Math.hypot(u.x - x, u.y - y)
        return d <= (cfg.vision.near_range as number) || (d <= (cfg.vision.range as number) && Math.abs(wrap(Math.atan2(u.y - y, u.x - x) - aim)) <= HALF)
      })
      .map((u) => ({ id: u.id, kind: "gun", pos: [u.x, u.y, u.z], vel: [u.vx, u.vy, u.vz] }))
    obs.crates = []
    obs.cubes = []
    obs.pickups = []
    obs.sounds = []
    obs.beams = []
    obs.events = pend
    pend = []
    obs.drops = []
    obs.offer = null
    obs.zone = { center: [x, y], radius: 5000, next_center: [x, y], next_radius: 5000, shrink_start: 1e6, shrink_end: 1e6 + 1, dps: 0 }
    const act = bot.decide(obs, L.NO_DEADLINE)
    if ((bot.modules.locomotion as any).lastMode === "dodge") dodges++
    const mv = act.move ?? [0, 0]
    const wantBoost = act.boost === true && energy > 1 && Math.hypot(mv[0], mv[1]) > 0.05
    if (act.jump && grounded) {
      vz = mech["jump_speed"]!
      grounded = false
      jumps++
    }
    for (let k = 0; k < 2; k++) {
      const speed = wantBoost ? mech["boost_speed"]! : mech["walk_speed"]!
      const tx = mv[0] * speed
      const ty = mv[1] * speed
      const acc = (grounded ? mech["ground_accel"]! : mech["air_accel"]!) * dt
      const ax = tx - vx
      const ay = ty - vy
      const am = Math.hypot(ax, ay)
      if (am > acc) {
        vx += (ax / am) * acc
        vy += (ay / am) * acc
      } else {
        vx = tx
        vy = ty
      }
      const [mx, my] = map.slideMove(x, y, z, vx * dt, vy * dt, body)
      vx = mx / dt
      vy = my / dt
      x += mx
      y += my
      const ground = map.standingHeightAt(x, y, z, body.stepUp, body.height)
      if (!grounded) {
        vz -= mech["gravity"]! * dt
        z += vz * dt
        if (z <= ground) {
          z = ground
          vz = 0
          grounded = true
        }
      } else z = ground
      if (act.aim) aim = wrap(aim + Math.max(-mech["turn_rate"]! * dt, Math.min(mech["turn_rate"]! * dt, wrap(act.aim[0] - aim))))
      if (wantBoost) {
        energy = Math.max(0, energy - mech["boost_drain"]! * dt)
        lastSpend = t
      } else if (t - lastSpend > mech["energy_regen_delay"]!) energy = Math.min(100, energy + mech["energy_regen"]! * dt)
      // shooter: perfect linear lead on our current velocity, Gaussian spread
      if (t >= nextShot) {
        if (ammo <= 0) {
          ammo = gun["mag"]!
          nextShot = t + gun["reload"]!
        } else {
          const m: [number, number, number] = [sx, sy, sz + 7]
          let tx2 = x
          let ty2 = y
          let tz2 = z + 4.5
          for (let it = 0; it < 3; it++) {
            const tf = Math.hypot(tx2 - m[0], ty2 - m[1], tz2 - m[2]) / gun["speed"]!
            tx2 = x + vx * tf
            ty2 = y + vy * tf
            tz2 = z + 4.5 + (grounded ? 0 : vz * tf)
          }
          const yaw = Math.atan2(ty2 - m[1], tx2 - m[0]) + (gauss() * SPREAD_DEG * Math.PI) / 180
          const pitch = Math.atan2(tz2 - m[2], Math.hypot(tx2 - m[0], ty2 - m[1])) + (gauss() * SPREAD_DEG * Math.PI) / 180
          const sp = gun["speed"]!
          bullets.push({ x: m[0] + Math.cos(yaw) * 3, y: m[1] + Math.sin(yaw) * 3, z: m[2], vx: Math.cos(pitch) * Math.cos(yaw) * sp, vy: Math.cos(pitch) * Math.sin(yaw) * sp, vz: Math.sin(pitch) * sp, id: bid++, life: gun["range"]! / sp })
          fired++
          ammo--
          nextShot = t + gun["cooldown"]!
        }
      }
      // bullets: sub-stepped swept test against our cylinder, stopped by walls
      const keep: Bul[] = []
      for (const u of bullets) {
        let hit = false
        let dead = false
        const sub = 5
        for (let q = 0; q < sub && !hit && !dead; q++) {
          const h = dt / sub
          const nx = u.x + u.vx * h
          const ny = u.y + u.vy * h
          const nz = u.z + u.vz * h
          if (!map.hasShotLOS([u.x, u.y, u.z], [nx, ny, nz])) dead = true
          else if (Math.hypot(nx - x, ny - y) <= body.radius + 0.3 && nz >= z - 0.3 && nz <= z + body.height + 0.3) hit = true
          u.x = nx
          u.y = ny
          u.z = nz
          u.life -= h
          if (u.life <= 0) dead = true
        }
        if (hit) {
          hits++
          pend.push({ type: "damaged", amount: 45, weapon: "gun", bearing: Math.atan2(sy - y, sx - x), by: 7 })
        } else if (!dead) keep.push(u)
      }
      bullets = keep
      t += dt
    }
  }
  return { fired, hits, dodges, jumps }
}

const cats: Cat[] = (arg("cats", "open,wallBehind,wallSide,corner")).split(",") as Cat[]
const dists = (arg("dists", "70,120,170")).split(",").map(Number)
// --arms "name:key=val,key=val;name2:..." (values parsed as JSON); default compares evasion OFF vs ON
const arms = (arg("arms", "off:evadeEnabled=false;on:evadeEnabled=true")).split(";").map((a) => {
  const [name, kv] = a.split(":")
  const o: Record<string, unknown> = {}
  for (const pair of (kv ?? "").split(",").filter(Boolean)) {
    const [k, v] = pair.split("=")
    o[k!] = JSON.parse(v!)
  }
  return { name: name!, o }
})
const total = arms.map(() => [0, 0])
console.log(`spread sigma ${SPREAD_DEG} deg, ${DUR}s per trial, arms: ${arms.map((a) => a.name).join(" | ")}`)
for (const cat of cats) {
  for (const D of dists) {
    const agg = arms.map(() => [0, 0, 0])
    let n = 0
    for (let k = 0; k < N; k++) {
      const seed = 1000 * D + k + cats.indexOf(cat) * 100000
      const res = []
      for (const a of arms) res.push(await trial(a.o, cat, seed, D))
      if (res.some((r) => !r)) continue
      n++
      res.forEach((r, i) => {
        agg[i]![0] += r!.fired
        agg[i]![1] += r!.hits
        agg[i]![2] += r!.dodges
        total[i]![0] += r!.fired
        total[i]![1] += r!.hits
      })
    }
    console.log(`${cat.padEnd(10)} D=${String(D).padStart(3)}m n=${n}  ` + arms.map((a, i) => `${a.name} ${agg[i]![0] ? ((100 * agg[i]![1]) / agg[i]![0]).toFixed(1) : "-"}%`).join("  "))
  }
}
console.log("ALL  " + arms.map((a, i) => `${a.name} ${((100 * total[i]![1]) / total[i]![0]).toFixed(1)}% (${total[i]![1]}/${total[i]![0]})`).join("  "))

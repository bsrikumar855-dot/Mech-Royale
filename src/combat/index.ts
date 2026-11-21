/**
 * OWNER: Person B. Combat: aim, fire, reload, MoveConstraint, threat bearing.
 * Contract: src/types/contracts.ts (CombatOutput). Read-only access to WorldModel. Never throws past decide().
 *
 * v1 rules (SURVIVAL FIRST: placement counts, kills do not; never chase):
 *  - Target: the best visible enemy MECH with a clear MapQuery.hasShotLOS inside weapon range (nearer and weaker
 *    first). NPC drones are shot only within npcEngageRangeM and only when NO enemy mech is visible at all.
 *  - Aim: linear lead to the target's centre of mass from the real muzzle, using the gun's own (upgraded) projectile speed.
 *  - Fire gate: shots leave along the ACTUAL slewed self.aim, so the gun fires only when that is within
 *    maxFireAngleErrorRad of the lead aim, with ammo and not mid-reload. No aiming = no firing (no wasted magazine).
 *  - Lightning (if held): instant, so no lead; needs LOS, range, the target inside the 30 deg cone of the actual yaw, energy.
 *  - Reload early when no enemy mech has LOS and ammo is low (or empty).
 *  - No target: hasTarget=false + threatBearing so the Arbiter faces the threat (rear hits deal x rear_mult).
 */
import { COMBAT } from "../config/index.ts"
import type { Combat, CombatOutput, TickContext } from "../types/contracts.ts"
import type { ActorObs, SelfObs, Vec3, WeaponKind, WeaponObs } from "../types/mechfight.ts"
import { aimErrorRad, angleDiff, yawTo } from "../world/geom.ts"
import type { WorldModel } from "../world/world.ts"
import { aimAt, leadPoint } from "./aim.ts"
import { pickThreatBearing } from "./threat.ts"

const DEG = Math.PI / 180

const stat = (w: WeaponObs, key: string, fallback = 0): number => {
  const v = w.stats[key]
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

const slotOf = (self: SelfObs, kind: WeaponKind): number => self.weapons.findIndex((w) => w?.kind === kind)

interface Cand {
  a: ActorObs
  com: Vec3
  dist: number
  los: boolean
}

/** Centre of mass of an actor: feet + its own height * comHeightFrac (mechs use our rules, drones use config.npc). */
function centerOf(world: WorldModel, a: ActorObs): Vec3 {
  const npcH = (world.config.npc as Record<string, number | undefined>)["height"]
  const h = a.kind === "npc" && typeof npcH === "number" ? npcH : world.rules.height
  return [a.pos[0], a.pos[1], a.pos[2] + h * COMBAT.comHeightFrac]
}

export class RuleCombat implements Combat {
  decide(ctx: TickContext): CombatOutput {
    const { world, map } = ctx
    const obs = world.obs
    const self = world.self
    const idle: CombatOutput = { aim: [self.aim[0], self.aim[1]], fire: [false, false], reload: false, moveConstraint: "NONE", hasTarget: false }
    if (!obs) return idle

    const gunSlot = slotOf(self, "gun")
    const ltSlot = slotOf(self, "lightning")
    const gun = gunSlot >= 0 ? (self.weapons[gunSlot] as WeaponObs) : null
    const lightning = ltSlot >= 0 ? (self.weapons[ltSlot] as WeaponObs) : null
    const gunRange = gun ? stat(gun, "range") * COMBAT.rangeMargin : 0
    const lightningRange = lightning ? stat(lightning, "range") : 0
    const engageRange = Math.max(gunRange, lightningRange)

    const muzzle: Vec3 = [self.pos[0], self.pos[1], self.pos[2] + world.selfStat("muzzle_height", world.rules.muzzleHeight)]
    const view = (a: ActorObs): Cand => {
      const com = centerOf(world, a)
      return { a, com, dist: Math.hypot(com[0] - muzzle[0], com[1] - muzzle[1], com[2] - muzzle[2]), los: map ? map.hasShotLOS(muzzle, com) : true }
    }

    const mechs = (obs.mechs ?? []).filter((m) => m.kind === "mech").map(view)
    const mechHasLos = mechs.some((c) => c.los)
    let pool = mechs.filter((c) => c.los && c.dist <= engageRange)
    if (mechs.length === 0) {
      // No enemy mech in sight at all: a nearby drone is fair game (cubes), but never a distraction from a mech.
      pool = (obs.mechs ?? [])
        .filter((m) => m.kind === "npc")
        .map(view)
        .filter((c) => c.los && c.dist <= Math.min(engageRange, COMBAT.npcEngageRangeM))
    }
    const target = pickTarget(pool)

    const fire: [boolean, boolean] = [false, false]
    let aim = idle.aim
    if (target) {
      const speed = gun ? stat(gun, "speed") : 0
      const track = world.tracks.get(target.a.id)
      const vel = track ? world.estimateVelocity(track) : target.a.vel
      const lead = gun ? leadPoint(muzzle, target.com, vel, speed) : target.com
      aim = aimAt(muzzle, lead)
      if (gun && gunSlot >= 0 && gunReady(gun) && target.dist <= gunRange && aimErrorRad(self.aim, aim) <= COMBAT.maxFireAngleErrorRad) {
        fire[gunSlot as 0 | 1] = true
      }
    }

    if (lightning && ltSlot >= 0 && self.energy > COMBAT.lightningMinEnergy && self.energy >= stat(lightning, "energy")) {
      const near = pool.filter((c) => c.dist <= lightningRange).sort((x, y) => x.dist - y.dist)[0]
      const half = (stat(lightning, "cone_deg") * DEG) / 2
      if (near && Math.abs(angleDiff(self.aim[0], yawTo(self.pos[0], self.pos[1], near.a.pos[0], near.a.pos[1]))) <= half) fire[ltSlot as 0 | 1] = true
    }

    const reload = !!gun && needsReload(gun, mechHasLos)
    const out: CombatOutput = { aim, fire, reload, moveConstraint: target ? "FACE_TARGET" : "NONE", hasTarget: target !== null }
    if (!target) {
      const bearing = pickThreatBearing(world)
      if (bearing !== undefined) out.threatBearing = bearing
    }
    return out
  }
}

/** Nearer and weaker first: lowest distance * (hpScoreBase + hp fraction). */
export function pickTarget(pool: readonly Cand[]): Cand | null {
  let best: Cand | null = null
  let bestScore = Infinity
  for (const c of pool) {
    const frac = c.a.hp !== undefined && c.a.max_hp ? c.a.hp / c.a.max_hp : 1
    const score = c.dist * (COMBAT.hpScoreBase + frac)
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/** The gun can fire: rounds in the magazine and not mid-reload. */
export const gunReady = (gun: WeaponObs): boolean => (gun.ammo ?? 0) > 0 && (gun.reload ?? 0) === 0

/** Reload now if empty, or (no enemy mech has LOS and the mag is at/below the threshold); never while already reloading. */
export function needsReload(gun: WeaponObs, anyMechHasLos: boolean): boolean {
  if ((gun.reload ?? 0) > 0) return false
  const ammo = gun.ammo ?? 0
  const mag = stat(gun, "mag", Infinity)
  if (ammo >= mag) return false
  return ammo === 0 || (!anyMechHasLos && ammo <= COMBAT.reloadAmmoThreshold)
}

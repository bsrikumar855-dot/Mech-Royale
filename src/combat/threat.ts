/**
 * Defensive facing: with nothing to shoot, which way should the torso point? Rear hits deal x rear_mult, and the
 * 120 deg vision wedge follows the torso, so facing the threat both protects us and lets us see it.
 * Priority: (1) the bearing of damage we just took, (2) an enemy mech listed this tick but without a clear shot,
 * (3) the most recently seen enemy, (4) the nearest recent combat sound. Returns undefined when nothing points anywhere.
 */
import { COMBAT } from "../config/index.ts"
import { yawTo } from "../world/geom.ts"
import type { WorldModel } from "../world/world.ts"

export function pickThreatBearing(world: WorldModel): number | undefined {
  const self = world.self
  const [sx, sy] = self.pos

  const dmg = world.recentThreatBearing(COMBAT.threatMemoryS)
  if (dmg !== null) return dmg

  const enemies = world.enemies().filter((e) => world.t - e.lastListedT <= COMBAT.threatMemoryS)
  if (enemies.length > 0) {
    const listedNow = enemies.filter((e) => e.lastListedT === world.t)
    const pool = listedNow.length > 0 ? listedNow : enemies
    pool.sort((a, b) => Math.hypot(a.pos[0] - sx, a.pos[1] - sy) - Math.hypot(b.pos[0] - sx, b.pos[1] - sy) || b.lastListedT - a.lastListedT)
    const e = pool[0]
    if (e) return yawTo(sx, sy, e.pos[0], e.pos[1])
  }

  const sounds = world.sounds
    .filter((s) => COMBAT.combatSoundKinds.includes(s.kind) && world.t - s.t <= COMBAT.threatMemoryS)
    .sort((a, b) => (COMBAT.soundDistRank[a.dist] ?? 9) - (COMBAT.soundDistRank[b.dist] ?? 9) || b.t - a.t)
  return sounds[0]?.bearing
}

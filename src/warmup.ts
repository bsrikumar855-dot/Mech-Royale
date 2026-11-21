/** Synthetic observations used to warm V8's JIT during the 20 s hello window, before `ready`. */
import type { Hello, Observation } from "./types/mechfight.ts"
import type { MapQuery } from "./world/map.ts"

export function syntheticObservation(hello: Hello, map: MapQuery | null, tick: number): Observation {
  const b = map?.bounds
  const x = b ? (b.minX + b.maxX) / 2 : 0
  const y = b ? (b.minY + b.maxY) / 2 : 0
  const z = map ? map.heightAt(x, y) : 0
  const mech = hello.config.mech as Record<string, number>
  const zone = hello.config.zone
  const hp = mech["hp"] ?? 1400
  return {
    type: "obs",
    tick,
    t: tick / 20,
    alive: 16,
    self: {
      id: hello.slot,
      pos: [x, y, z],
      vel: [0, 0, 0],
      aim: [0, 0],
      hp,
      max_hp: hp,
      energy: mech["energy"] ?? 100,
      max_energy: mech["energy"] ?? 100,
      grounded: true,
      cubes: 0,
      upgrades: [],
      in_zone: true,
      weapons: [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: { ...hello.config.weapons.gun } }, null],
      stats: { ...mech },
    },
    mechs: [{ id: (hello.slot + 1) % 16, kind: "mech", pos: [x + 40, y + 10, z], vel: [3, 0, 0], aim: [0, 0], hp, max_hp: hp, weapons: ["gun"], charging: false }],
    projectiles: [],
    crates: [],
    cubes: [{ id: 5000, pos: [x + 5, y + 5, z] }],
    pickups: [],
    sounds: [{ kind: "gun", bearing: 1, dist: "near", age: 0.05 }],
    beams: [],
    events: [],
    zone: { center: zone.start_center, radius: zone.start_radius, next_center: zone.start_center, next_radius: zone.start_radius, shrink_start: 60, shrink_end: 110, dps: 20 },
    offer: null,
    drops: [],
  }
}

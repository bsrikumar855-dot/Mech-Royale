/** OWNER: Person B. Combat tunables. Game mechanics (ranges, cooldowns, speeds) come from hello.config / self.weapons[i].stats. */
export const COMBAT = {
  // ---- gun fire gate (distance-scaled)
  /**
   * Shots leave along the ACTUAL slewed self.aim. Fire only when that is within the angle the target's body
   * subtends: clamp(atan2(targetRadius + gunAimMarginM, dist), minFireAngleRad, maxFireAngleErrorRad).
   * A fixed 0.15 rad wasted the magazine at range (a 15 m miss at 100 m).
   */
  gunAimMarginM: 0.5,
  minFireAngleRad: 0.01,
  maxFireAngleErrorRad: 0.15,
  /**
   * Post-slew gun gate: the trigger is held for the next 2 sim ticks while the torso keeps slewing toward the
   * commanded aim, so the gate compares the desired lead against self.aim projected this far ahead (half a
   * decision), each axis clamped by the live stats.turn_rate (yaw) / stats.pitch_rate (pitch).
   * The laser release and the lightning cone still use the raw self.aim (hitscan fires on the first tick).
   */
  slewLeadS: 0.05,

  /** Target centre of mass = feet + height * this (protocol: pos.z + 4.5 for the 9 m mech). */
  comHeightFrac: 0.5,

  /** Shoot an NPC drone (2 cubes) within this range, only when no enemy mech is visible at all. */
  npcEngageRangeM: 40,

  /** Engage a bit inside the weapon's nominal range (bullets spread, targets move). */
  rangeMargin: 0.9,

  // ---- kill-confirm focus (cost = HP left * (1 + dist / killDistScaleM) * product of (1 - bonus); lower wins)
  /** Time-to-kill dominates: HP left first, distance second. Unknown HP counts as full mech HP. */
  killDistScaleM: 100,
  /** We hold a laser and it carries a mortar: laser cook-off (+60%). */
  cookoffTargetBonus: 0.3,
  closeThreatM: 50,
  closeThreatBonus: 0.2,
  chargingThreatBonus: 0.4,
  /** We would hit its rear arc (x rear_mult). */
  rearArcBonus: 0.1,

  // ---- v9 sticky focus fire: keep shooting the same mech (2v1s are won by deleting one bot fast)
  /** The last mech target's cost is multiplied by (1 - this) while it is still a valid target... */
  stickyFocusBonus: 0.4,
  /** ...remembered this long after it was last targeted... */
  stickyMemoryS: 2,
  /** ...unless ANOTHER shot-line enemy is critically low (below this HP): then the plain kill-confirm cost decides. */
  stickySwitchHp: 250,

  // ---- laser: hold to charge, release to fire (hitscan: no lead). Charging halves walk speed: keep it short.
  /** Vs a mech, release once charged this long (capped at the weapon's full charge time stats.charge)... */
  laserReleaseChargeS: 0.65,
  /** ...and only when the RAW self.aim error is within atan2(targetRadius * this, dist). */
  laserReleaseAimFrac: 1.15,
  /** Max-crawl safety: never hold a charge past this (aligned or not) so A-D strafing gets full speed back. */
  laserMaxCrawlS: 1.25,
  /** Never hold an off-target charge later than charge + hold_s - this (it would auto-fire anyway). */
  laserHoldSafetyS: 0.3,
  /** Look-ahead used to release before the target slips behind cover. */
  laserCoverLookaheadS: 0.2,
  /** Mid-charge, release if the target has been out of line of sight this long (do not crawl at half speed). */
  laserLosLossS: 0.3,
  /** Do not START a charge with an enemy mech this close (half speed in its face). */
  laserMinStartDistM: 22,

  // ---- safe crate farming: no enemy mech has LOS, none tracked within crateFarmEnemyClearM.
  // v9: with a laser off cooldown and NO enemy mech listed at all (in the zone), crates and drones are laser-farmed
  // (one full charge ~ 315 damage vs 300 HP crates / 350 HP drones), released at full charge unless it already kills;
  // the gun weaves only while the laser is unavailable (saves the magazine and the 2.4 s reload).
  crateFarmEnemyClearM: 50,
  crateFarmMinHpFrac: 0.65,
  crateFarmRangeM: 45,

  /** Lead solver: fixed-point iterations and the longest flight time we will lead for. */
  leadIterations: 3,
  leadMaxTimeS: 1.5,

  /** Proactive reload when no enemy mech has line of sight and the magazine is at or below this... */
  reloadAmmoThreshold: 7,
  /**
   * ...and only after no enemy mech has had a clear shot line for this long (anti-blink: a 2.4 s reload must not
   * start because a target flickered behind a pillar or trunk for one decision)...
   */
  proactiveReloadDelayS: 1.5,
  /** ...and no tracked enemy mech is within this distance. An empty magazine always reloads at once. */
  proactiveReloadClearM: 35,

  /**
   * Short-flicker aim lock: when the last line-of-sight mech target drops out of sight for less than this and no
   * other enemy mech has a shot line, keep the torso on its (extrapolated) lead point so we are on target the tick
   * it re-peeks. Never fires without hasShotLOS.
   */
  flickerAimHoldS: 0.6,

  /** Lightning costs `energy` per shot and spends the boost budget: only fire above this. */
  lightningMinEnergy: 12,

  /** Defensive facing: how long a damage bearing / last-seen enemy / combat sound still points at a threat. */
  threatMemoryS: 3,
  /** Sound kinds that mean someone is fighting nearby (bearing is noisy: sigma 7 deg). */
  combatSoundKinds: ["gun", "laser", "laser_charge", "mortar", "explosion", "lightning", "npc_gun"] as readonly string[],
  /** Prefer nearer sounds. */
  soundDistRank: { near: 0, mid: 1, far: 2 } as Readonly<Record<string, number>>,
} as const

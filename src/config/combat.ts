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
  /** An enemy at or below this HP is finishable (a laser release or a short gun burst). */
  killableHp: 350,
  /** We hold a laser and it carries a mortar: laser cook-off (+60%). */
  cookoffTargetBonus: 0.3,
  closeThreatM: 50,
  closeThreatBonus: 0.2,
  chargingThreatBonus: 0.4,
  /** We would hit its rear arc (x rear_mult). */
  rearArcBonus: 0.1,

  // ---- regen hold-fire discipline (dealing damage resets the 5 s out-of-combat regen timer). Strict: never in a 1v1 brawl.
  regenHoldHpFrac: 0.35,
  /** Hold fire only on targets farther than this that we cannot finish (hp > killableHp). */
  regenHoldDistM: 75,

  // ---- mortar (v1): the same LOS mech target Combat already picked, never an unseen one (see combat/mortar.ts)
  /** Conservative engagement cap: keeps the arc's flight time short, so the straight-line target-velocity
   * prediction stays reasonable and the squad has less time to walk out of the blast before it lands. */
  mortarMaxRangeM: 90,
  /** Never fire if the computed impact point is this close (beyond the shell's own splash_radius) to US. */
  mortarSafetyMarginM: 5,
  /** Splash forgives a miss, but cap how loose the torso-alignment gate gets at point-blank range. */
  mortarMaxAimErrorRad: 0.5,

  // ---- laser: hold to charge, release to fire (hitscan: no lead)
  /** Release once charged to this fraction of the full charge time (stats.charge): ~0.70 s of 0.75 s... */
  laserFullChargeFrac: 0.93,
  /** ...and only when the actual aim error is within atan2(targetRadius * this, dist). */
  laserReleaseAimFrac: 0.9,
  /** Never hold an off-target charge later than charge + hold_s - this (it would auto-fire anyway). */
  laserHoldSafetyS: 0.3,
  /** Look-ahead used to release before the target slips behind cover. */
  laserCoverLookaheadS: 0.2,
  /** Mid-charge, release if the target has been out of line of sight this long (do not crawl at half speed). */
  laserLosLossS: 0.3,
  /** Do not START a charge with an enemy mech this close (half speed in its face)... */
  laserMinStartDistM: 18,
  /** ...unless the charge is already this far along. */
  laserCommitChargeS: 0.3,

  // ---- safe crate farming (gun only): no enemy mech has LOS, none tracked within crateFarmEnemyClearM
  crateFarmEnemyClearM: 50,
  /** v14: shoot crates / drones only above this HP fraction (was 0.65 for crates, none for drones): dealing damage
   * resets the 5 s regen timer, so heal first. A drone that damaged us within npcSelfDefenseS is always shot back. */
  crateFarmMinHpFrac: 0.85,
  npcFarmMinHpFrac: 0.85,
  npcSelfDefenseS: 3,
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

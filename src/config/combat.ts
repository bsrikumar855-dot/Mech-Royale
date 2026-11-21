/** OWNER: Person B. Combat tunables. Game mechanics (ranges, cooldowns, speeds) come from hello.config / self.weapons[i].stats. */
export const COMBAT = {
  /**
   * Shots leave along the ACTUAL slewed self.aim. Fire only when it is within this angle of the lead-corrected aim,
   * otherwise a held trigger dumps the 12-round magazine into the air while the torso is still turning (~8.6 deg).
   */
  maxFireAngleErrorRad: 0.15,

  /** Target centre of mass = feet + height * this (protocol: pos.z + 4.5 for the 9 m mech). */
  comHeightFrac: 0.5,

  /** Only shoot an NPC drone within this range, and only when no enemy mech is visible at all. */
  npcEngageRangeM: 35,

  /** Engage a bit inside the weapon's nominal range (bullets spread, targets move). */
  rangeMargin: 0.9,

  /** Target score = distance * (hpScoreBase + hpFraction): nearer and weaker first. Lower is better. */
  hpScoreBase: 0.5,

  /** Lead solver: fixed-point iterations and the longest flight time we will lead for. */
  leadIterations: 3,
  leadMaxTimeS: 1.5,

  /** Proactive reload when no enemy mech has line of sight and the magazine is at or below this. */
  reloadAmmoThreshold: 6,

  /** Lightning costs `energy` per shot and spends the boost budget: only fire above this. */
  lightningMinEnergy: 15,

  /** Defensive facing: how long a damage bearing / last-seen enemy / combat sound still points at a threat. */
  threatMemoryS: 3,
  /** Sound kinds that mean someone is fighting nearby (bearing is noisy: sigma 7 deg). */
  combatSoundKinds: ["gun", "laser", "laser_charge", "mortar", "explosion", "lightning", "npc_gun"] as readonly string[],
  /** Prefer nearer sounds. */
  soundDistRank: { near: 0, mid: 1, far: 2 } as Readonly<Record<string, number>>,
} as const

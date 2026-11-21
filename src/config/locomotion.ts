/** OWNER: Person A. Runtime, world-model and map tunables. Zero magic numbers outside src/config/. */
export const RUNTIME = {
  botName: "mech-royale",
  /** COMPUTE_BUDGET_MS = tick_budget(50) - p99 overhead(~1) - safety(15) = 34. See the CLAUDE.md benchmark table. */
  computeBudgetMs: 34,
  /** Time held back for JSON parse + stdout flush + scheduler jitter on the 1-CPU container. */
  safetyMarginMs: 15,
  warmupTicks: 2,
  /** Hard cap on unparsed stdin bytes we keep (protects the 512 MB limit against a runaway stream). */
  maxInputBufferBytes: 4 * 1024 * 1024,
  /** stdout is a pipe; EAGAIN retries before giving up on a single write. */
  writeRetryLimit: 2000,
  /** stderr is bounded so an unread pipe can never block the bot: first N warnings, then every Nth. */
  warnFirst: 5,
  warnEvery: 100,
  warnMaxChars: 400,
} as const

export const WORLD = {
  historySamples: 8,
  /** Extra seconds a track is kept beyond vision.memory_s before being dropped. */
  trackGraceS: 1,
  maxTracks: 64,
  maxSounds: 64,
  maxDamageRecords: 32,
  soundMemoryS: 5,
  damageMemoryS: 5,
} as const

/**
 * Locomotion v3: evasive anti-lead movement. Every weight, radius and threshold lives here; game physics (speeds,
 * gravity, splash, vision memory) are read live from hello.config / self.stats.
 */
export const LOCOMOTION = {
  // ---- zone
  /** Stay inside this fraction of the current radius (the rim is where the damage and the crowd are). */
  safeRadiusFrac: 0.85,
  /** We aim to be inside this fraction of the NEXT circle's radius before its shrink ends. */
  nextSafeFrac: 0.9,
  /** Start moving in when distToNextSafe / walk_speed >= max(1, shrink_end - t) - this. */
  shrinkBufferS: 8,
  outsideBoostMinEnergy: 10,
  /** Perpendicular weave mixed into a zone run while under fire (fraction of the inward vector). */
  outsideWeave: 0.35,
  shrinkWeave: 0.5,

  // ---- threat trigger (any of these -> evasive movement, at ANY range)
  damageMemoryS: 3,
  soundMemoryS: 2,
  threatSoundKinds: ["gun", "laser", "laser_charge", "lightning", "mortar", "explosion"] as readonly string[],
  projectileAlertM: 140,
  /** Line-of-sight checks per decision (nearest listed enemies first, charging lasers before everything). */
  maxLosChecks: 4,

  // ---- A-D strafing
  /** Strafe direction flips after a deterministic, varying period in [flipMinS, flipMaxS]. */
  flipMinS: 0.75,
  flipMaxS: 1.15,
  /** v10: with an enemy mech tracked closer than flipTightBelowM, flips come faster: [flipTightMinS, flipTightMaxS]. */
  flipTightBelowM: 85,
  flipTightMinS: 0.55,
  flipTightMaxS: 0.85,
  /** Flip at once if the current strafe side is blocked within this distance. */
  strafeBlockProbeM: 5,
  /** Range control: radial blend added to the perpendicular strafe (negative = away from the threat). */
  retreatBlend: -0.55,
  woundedHpFrac: 0.42,
  /**
   * v10 long-range kiting. A gun bullet (252 m/s) needs 0.20 s for 50 m: walking 11.7 m/s moves us 2.3 m (< our 2.5 m
   * radius), so we hold the fight at 90-145 m (0.36-0.58 s flights: 4-7 m of dodge) where gun (230 m) and laser
   * (280 m) still reach. Hard close (< closeM, or < closeLightningM vs lightning) backpedals before any loot.
   */
  closeM: 42,
  closeLightningM: 52,
  /** Below kiteStrongBelowM: strong backpedal; kiteStrongBelowM..kiteBelowM: smooth backpedal; both + full strafe. */
  kiteStrongBelowM: 65,
  kiteBelowM: 90,
  kiteStrongBlend: -0.6,
  kiteSoftBlend: -0.35,
  /** Mild approach only beyond this (healthy, inside the safe rim). */
  approachBeyondM: 155,
  approachBlend: 0.25,
  approachMinHpFrac: 0.65,
  /** Lightning finish: holding lightning (no laser), energy > finishMinEnergy, ONE shooter below finishMaxHp -> close
   * in (finishBlend) until inside closeM instead of backpedalling. */
  finishMaxHp: 350,
  finishMinEnergy: 25,
  finishBlend: 0.6,

  // ---- v10 boost-snap reversals: under fire (shot line, or damaged within jumpDamageWindowS = 2 s), not charging our
  // laser, energy >= snapBoostMinEnergy -> boost for snapBoostS after every strafe reversal / bullet snap (decisions
  // are 0.1 s apart, so the burst covers the reversal decision and the next two)
  snapBoostS: 0.25,
  snapBoostMinEnergy: 65,
  /** Any move whose 4 m lookahead leaves the safe rim is bent back inward. */
  rimLookaheadM: 4,

  // ---- hops
  jumpMinS: 1.8,
  jumpMaxS: 2.4,
  jumpDamageWindowS: 2,

  // ---- boost
  tacticalBoostStartEnergy: 30,
  tacticalBoostHoldEnergy: 15,
  mortarBoostMinEnergy: 8,
  laserDodgeBoostMinEnergy: 12,

  // ---- projectiles
  mortarHorizonS: 4,
  mortarStepS: 0.1,
  /** Mortar danger radius = splash_radius + our radius + this. */
  mortarMarginM: 3,
  bulletHorizonS: 0.45,
  /** A bullet ray passing within our radius + this triggers a perpendicular snap away from it. */
  bulletClearanceExtraM: 2.5,
  /** Charging-laser dodge: test this far to each side for a spot the charger cannot see (max 2 raycasts). */
  laserDodgeStepM: 7,

  // ---- loot (read straight from the observation: Economy decides what to take, Locomotion how far to walk)
  closeLootM: 18,
  closeLootMinHpFrac: 0.55,
  lootWeave: 0.4,
  dropRangeM: 70,
  dropMaxLandsInS: 12,
  /** Once this far inside a supply-drop ring, micro-strafe inside it instead of walking to its centre. */
  dropRingInsetM: 1.5,
  dropMicroStrafe: 0.4,
  laserPickupRangeM: 80,
  lightningPickupRangeM: 55,
  cubeRangeM: 55,
  lootArriveM: 1.5,
  lootBase: { supply_drop: 30, laser: 20, lightning: 14, cube: 10 } as Readonly<Record<string, number>>,
  lootHalfValueM: 20,

  // ---- v5: early snowball rush (crate / drone hunting). Gate: no enemy mech with a shot line, none tracked within
  // huntEnemyClearM, we stand inside the safe rim, and (cubes < huntCubeCap or no laser held yet).
  huntEnemyClearM: 50,
  huntCubeCap: 10,
  /** While the gate is open the free-loot reach grows to these ranges. */
  huntLaserRangeM: 90,
  huntDropRangeM: 75,
  huntCubeRangeM: 65,
  /** Drones (2 cubes) and crates (1 cube + weapon chance) are hunted up to this far... */
  huntTargetRangeM: 75,
  /** ...only this healthy (drones shoot back; combat's crate gate is 65%)... */
  huntNpcMinHpFrac: 0.55,
  huntCrateMinHpFrac: 0.65,
  /** ...and we walk in until the muzzle-to-centre distance is within this AND there is a shot line, then hold so the
   * combat module (npc gate 40 m, crate gate 45 m) melts it. */
  huntNpcStandoffM: 35,
  huntCrateStandoffM: 38,
  /** Loot value bases for hunt targets (value = base / (1 + dist / lootHalfValueM); a laser at 80 m beats a crate at 40 m). */
  huntBase: { npc: 12, crate: 8 } as Readonly<Record<string, number>>,

  // ---- v5: post-kill cube scoop while under fire
  /** Nobody has a shot line on us (unseen shooter, stray projectile): scoop cubes up to this far. */
  scoopNoLosM: 25,
  /** One shooter has a line: still scoop a cube this close if we are above scoopOneLosMinHpFrac. */
  scoopOneLosM: 14,
  scoopOneLosMinHpFrac: 0.45,

  // ---- idle
  /** Below this HP, safe and unthreatened: stand still (silent) so the out-of-combat regen runs. */
  regenHoldHpFrac: 0.85,
  /** Healthy and idle: patrol along a band of the next circle (fraction of its radius). */
  patrolInnerFrac: 0.4,
  patrolOuterFrac: 0.75,
  /** Smaller next circles than this: patrol around the current one instead. */
  patrolMinRadiusM: 20,

  // ---- wall feeler
  feelerStepM: 4,
  steerAnglesDeg: [30, 60, 90, 120] as readonly number[],
  /** Once we steer around a wall to one side, prefer that side for this long (no oscillation). */
  wallCommitS: 1.5,
} as const

export const MAP = {
  gridCellM: 16,
  treeCellM: 16,
  /** Terrain-vs-ray sampling step (the heightfield itself has a 1 m grid). */
  terrainLosStepM: 1,
  slopeProbeM: 0.5,
  /** Vertical tolerance when comparing a ray/feet height to a surface. */
  zEps: 0.05,
  /** Parametric / geometric epsilon for segment-polygon tests. */
  geomEps: 1e-9,
} as const

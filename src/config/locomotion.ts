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
  /** Flip at once if the current strafe side is blocked within this distance. */
  strafeBlockProbeM: 5,
  /** Range control: radial blend added to the perpendicular strafe (negative = away from the threat). */
  retreatBlend: -0.55,
  backpedalBlend: -0.5,
  approachBlend: 0.3,
  woundedHpFrac: 0.42,
  closeM: 42,
  closeLightningM: 52,
  farM: 95,
  approachMinHpFrac: 0.65,
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

  // ---- idle
  /** Below this HP, safe and unthreatened: stand still (silent) so the out-of-combat regen runs. */
  regenHoldHpFrac: 0.85,
  /** Healthy and idle: patrol along a band of the next circle (fraction of its radius). */
  patrolInnerFrac: 0.4,
  patrolOuterFrac: 0.75,
  /** Smaller next circles than this: patrol around the current one instead. */
  patrolMinRadiusM: 20,

  // ---- v4: 2v1+ corner slicing (only on crossfire / critically wounded ticks; max 8 probes x 3 enemies raycasts)
  /** Slice when this many enemies have a shot line on us... */
  sliceMinLosEnemies: 2,
  /** ...or one does and we are below this HP fraction and it is not finishable (HP above sliceFinishableHp). */
  sliceWoundedHpFrac: 0.42,
  sliceFinishableHp: 300,
  /** On a roof the wounded trigger is looser: step inward off the threatened edge sooner. */
  sliceRoofWoundedHpFrac: 0.55,
  sliceProbes: 8,
  sliceProbeM: 12,
  /** On a roof: probe this close (4-6 m inward), never past a drop. */
  sliceRoofProbeM: 5,
  /** Exposure is checked against at most this many of the nearest shot-line enemies. */
  sliceMaxEnemies: 3,
  /** Score = exposed * this - tie breakers (lower wins). */
  sliceExposedWeight: 100,
  sliceOutsideSafePenalty: 30,
  sliceAwayWeight: 6,
  sliceHeadingWeight: 3,
  /** The previous slice heading counts for hysteresis this long. */
  sliceHeadingMemoryS: 1,
  /** Snap-behind-the-corner boost latch. */
  sliceBoostStartEnergy: 28,
  sliceBoostHoldEnergy: 14,

  // ---- v4: ledge and rooftop climbing (jump, then jet = boost in the air, then steer onto the top)
  /** Ledge clear: an obstacle ahead whose walkable top is above step_up and at most this far above our feet. */
  ledgeMaxRiseM: 8,
  ledgeMinEnergy: 30,
  /** Probe this far ahead for the ledge edge, and aim the landing this far past the edge. */
  ledgeProbeM: 3,
  climbLandInsetM: 2.5,
  /** Rooftop escape (heavy pressure): roof within 4-24 m above our feet, within 7 m, energy >= 55. */
  roofMinRiseM: 4,
  roofMaxRiseM: 24,
  roofSearchM: [3.5, 7] as readonly number[],
  roofSearchBearings: 8,
  roofMinEnergy: 55,
  roofPressureHpFrac: 0.5,
  roofPressureNearM: 55,
  /** Jet while below top + this; release (and steer on) once at top + climbReleaseAboveM. */
  climbJetBelowAboveM: 0.4,
  climbReleaseAboveM: 0.3,
  /** After the release, keep steering onto the top this long. */
  climbLandS: 0.5,
  climbAbortEnergy: 8,
  climbTimeoutS: 3.5,
  /** Clock comparisons tolerate float drift in obs.t (10.8 arrives as 10.799999999999997). */
  climbTimeEpsS: 1e-6,

  // ---- v4: roof edge safety
  /** Standing more than this above the terrain under us = on a roof. */
  onRoofAboveTerrainM: 4,
  /** A drop deeper than this ahead is treated like a wall by the feelers (strafe flips along the roof). */
  roofEdgeDropM: 6,

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

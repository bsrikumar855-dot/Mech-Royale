/** OWNER: Person A. Runtime, world-model and map tunables. Zero magic numbers outside src/config/. */
export const RUNTIME = {
  botName: "mech-royale",
  /** COMPUTE_BUDGET_MS = tick_budget(50) - p99 overhead(~1) - safety(15) = 34. See the CLAUDE.md benchmark table. */
  computeBudgetMs: 34,
  /** Time held back for JSON parse + stdout flush + scheduler jitter on the 1-CPU container. */
  safetyMarginMs: 15,
  /**
   * Synthetic decisions run during the 20 s hello window before `ready`, so V8 optimises the (large) locomotion
   * scorer BEFORE the match. With 2, TurboFan compiled it mid-match and, on one core, p95 tick latency was ~4.8 ms
   * instead of ~1.8 ms. Costs ~0.3 s of the hello window locally.
   */
  warmupTicks: 300,
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
 * Phase 2 tactical locomotion (utility scorer). Every weight, radius and threshold lives here.
 * Game physics (speeds, ranges, gravity, splash, vision) are read live from hello.config / self.stats.
 * Score units: 1 point ~ "1 m of zone pressure"; cover exposures cost ~10, a mortar splash ~20-40.
 */
export const LOCOMOTION = {
  // ---- candidate generation
  /** Concentric rings around us: radius (m) and number of evenly spaced bearings. Hold [0,0] is always candidate 0. */
  rings: [
    { radiusM: 4.5, bearings: 8 },
    { radiusM: 11, bearings: 12 },
    { radiusM: 24, bearings: 12 },
  ] as readonly { radiusM: number; bearings: number }[],
  /** Direct steps toward the zone goal (capped at the goal distance). */
  goalStepsM: [12, 24] as readonly number[],
  /** When the direct goal ray is blocked: tangent slides around the wall (deg off the goal bearing) at these distances. */
  tangentAnglesDeg: [65, -65, 105, -105] as readonly number[],
  tangentStepsM: [6, 12] as readonly number[],
  /**
   * Bonus for a tangent slide, scaled by zone pressure (1 outside the zone, else urgency). A slide along a long wall
   * briefly INCREASES our distance to the zone, so without this the scorer would stall in front of the wall.
   */
  tangentEscapeBonus: 12,
  /** Once we slide one way along a wall, only that side keeps the escape bonus for this long (no zig-zag). */
  escapeCommitS: 2,
  /** A direct candidate toward the best safe LootTarget within this range. */
  lootCandidateMaxM: 30,
  /** Walkability is sampled along each ray at this spacing (< mech diameter, so no wall is skipped). */
  raySampleM: 2,
  /** A partially blocked ray still yields a candidate at its last walkable point if that is at least this far. */
  clampMinM: 3,
  /** Candidates closer than this to each other are merged (clamped rays often coincide). */
  dedupeM: 0.5,
  /** The zone goal sits this fraction of the target radius in from the centre-facing rim (never the dead centre). */
  goalRimFrac: 0.75,

  // ---- threats
  /** Most dangerous tracked enemy mechs considered per tick (bounds the LOS work). */
  maxThreats: 6,
  /** Enemies beyond near_range AND looking away from a spot (outside their fov wedge) are discounted to this. */
  fovDiscount: 0.45,
  /** Weapon danger multipliers. */
  laserChargeMult: 4,
  laserHoldMult: 1.4,
  lightningMult: 1.8,
  /** Lightning reach (45 m) plus a margin. */
  lightningDangerM: 52,
  /** Threat falls off with distance as 1 / (1 + d / threatDistScaleM). */
  threatDistScaleM: 120,
  /** Ignore an enemy for exposure beyond max(gun range, laser range) * this (covers range upgrades). */
  threatRangeMargin: 1.15,
  /** Midpoint path check uses this many closest threats. */
  midpointThreats: 2,

  // ---- zone
  /** Safe radius of the NEXT circle we aim to be inside. */
  nextSafeFrac: 0.9,
  /** Arrive inside the next circle this many seconds before the shrink ends. */
  shrinkSafetyBufferS: 8,
  /** Urgency ramps from 0 to 1 over the last this-many seconds of slack. */
  urgencyRampS: 20,
  /** Above this urgency the "active" circle (rim band, safe-loot test) becomes the next circle. */
  activeCircleUrgency: 0.5,
  /** Outside the current circle: flat cliff + per metre, both scaled by max(1, dps / refZoneDps). */
  outsideCliff: 30,
  outsidePerM: 2,
  refZoneDps: 20,
  /** Pull toward the next safe circle per metre still to travel, scaled by urgency. */
  nextPullPerM: 1.5,
  /** Rim plateau: no preference inside [deadCenterFrac, rimBandOuter] of the active radius. */
  rimBandOuter: 0.85,
  rimOutPerM: 1,
  deadCenterFrac: 0.35,
  deadCenterPerM: 0.05,
  /** The dead-centre penalty only applies while more than this many mechs are alive (crowd at the middle). */
  deadCenterMinAlive: 5,

  // ---- cover / exposure
  coverWeight: 10,
  /** Extra penalty (exposedCount - 1)^2 * crossfireWeight once 2+ enemies see the spot. */
  crossfireWeight: 8,
  midpointWeight: 4,
  /** The midpoint check runs when we are exposed now, or the candidate is farther than this. */
  midpointMinDistM: 10,
  /** HP scaling of all exposure terms: 1x at/above hpScaleStart, rising linearly to hpScaleMax at hpScaleFull. */
  hpScaleStart: 0.75,
  hpScaleFull: 0.3,
  hpScaleMax: 2.5,
  /** Wounded and in the zone: extra per exposed enemy so the out-of-combat regen timer is not reset. */
  regenHpFrac: 0.85,
  regenExposedWeight: 6,

  // ---- projectiles
  mortarHorizonS: 4,
  mortarStepS: 0.1,
  /** Danger radius = splash_radius + our radius + this. */
  mortarMarginM: 3,
  /** Penalty inside the danger radius: mortarWeight * (0.5 + 0.5 * closeness). */
  mortarWeight: 40,
  bulletHorizonS: 0.4,
  /** Bullet corridor half-width = our radius + this. */
  bulletCorridorExtraM: 1,
  bulletWeight: 6,

  // ---- spacing / acoustic
  spacingRangeM: 48,
  spacingWeight: 6,
  spacingLightningMult: 2,
  spacingLowHpFrac: 0.5,
  spacingLowHpMult: 1.5,
  npcRangeM: 45,
  npcHpFrac: 0.8,
  npcWeight: 2,
  unseenMemoryS: 3,
  unseenSoundKinds: ["gun", "laser", "laser_charge", "lightning", "mortar", "explosion"] as readonly string[],
  unseenHpFrac: 0.85,
  unseenWeight: 3,

  // ---- loot
  lootWeight: 1.5,
  lootMinHpFrac: 0.45,
  lootArriveM: 1.5,

  // ---- stealth / movement cost
  holdBonus: 3,
  /** No hold bonus while safe loot lies within this range. */
  holdLootBlockM: 25,
  /** Every metre moved costs a little (footsteps are audible above sound.step_speed). */
  moveCostPerM: 0.02,

  // ---- hysteresis / anti-stuck
  hystDirWeight: 1.5,
  hystTargetWeight: 1,
  hystTargetRadiusM: 6,
  /** Hysteresis multiplier during emergencies (a charging laser sees us, or a mortar will land on us): react instantly. */
  emergencyHystFactor: 0,
  stuckWindowS: 1.5,
  stuckMinCommand: 0.5,
  stuckMinDisplacementM: 2,
  stuckEscapeS: 1.5,
  stuckBiasWeight: 4,
  /** A jump this large between decisions means a new match / respawn: reset all memory. */
  teleportResetM: 40,

  // ---- energy / boost
  emergencyBoostMinEnergy: 8,
  coverBoostStartEnergy: 35,
  coverBoostHoldEnergy: 18,
  escapeEnemyM: 28,

  // ---- deadline
  /** Stop generating / scoring candidates when less than this much of the compute budget is left. */
  deadlineReserveMs: 3,
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

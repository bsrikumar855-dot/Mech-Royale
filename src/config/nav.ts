/** OWNER: Person A. Zone navigation (src/nav, Locomotion zone modes). Zero magic numbers outside src/config/. */
export const NAV = {
  /** Grid cell size (m). Must be <= 2 x mech radius so adjacent cell discs overlap (no wall can hide between centres). */
  cellM: 4,
  /** Extra clearance (m) beyond the body radius for a cell to count as walkable (corridors < 2 x (radius + this) close). */
  clearanceM: 1,
  /** Spacing (m) of the real-body samples when a straight waypoint segment is verified. */
  segmentStepM: 1.5,
  /** Path indices tried as the waypoint, far to near (the last path cell is always tried first). */
  pullIndices: [10, 7, 5, 3, 2, 1] as readonly number[],
  /** Cells adjacent to a blocked / unwalkable cell cost this much more per metre (stay mid-corridor). */
  wallCostMult: 1.6,
  /** A destination or start inside a wall snaps to the nearest walkable cell within this many rings. */
  snapRadiusCells: 12,
  /** Destination = any walkable cell within this fraction of the next circle's radius (the nearest one by path wins). */
  destFrac: 0.85,
  /** Upper bound on destination seeds per field (large early circles are sampled on a coarser stride). */
  maxSeeds: 1500,
  /** A destination cell starts at this x its distance from the circle centre (m of walking per m of depth). */
  centrePull: 0.5,
  /** Steepest-descent steps (cells) followed when string-pulling a waypoint (12 cells = 48 m). */
  pathCells: 12,
  /** Dijkstra heap pops per decision while a field is being built (1500 is about 2-3 ms; a full field is ~34k pops, so ~2 s). */
  popsPerTick: 1500,
  /** Same, while the mech is outside the zone (emergency: finish the field fast). */
  popsPerTickUrgent: 4000,
  /** Fields kept at once (current + next destination + the locomotion unstick fallback). */
  maxFields: 4,
  /** Use the path length instead of the straight distance when deciding to start the zone run (ablation switch). */
  pathUrgency: false,
} as const

/** OWNER: Person B. Economy tunables. Game mechanics (costs, caps, effects) come from hello.config, never from here. */
export const ECONOMY = {
  /**
   * Upgrade priority, best first. EXPERIMENT (submission 24): the DPS snowball (gun rate/damage) now ranks ABOVE
   * survivability (armor, plating), inverting the assumption every prior build has made. Rationale: placement is
   * confirmed driven by kills here (ghostHold, submission 18, -2.79 for refusing to finish weak enemies), and every
   * cube already grants +4% HP and +4% damage up to 10 cubes regardless of which upgrade is picked -- the upgrade
   * choice is a multiplier on TOP of that passive growth, so the question is only which multiplier compounds faster.
   * Then laser/regen/mobility, as before. Offers only contain weapon upgrades for weapons we hold, so laser_*
   * appear once we carry one. ALL 22 ids of hello.config.upgrades are ranked (a test enforces it). An id not listed
   * here (a balance change adds one) ranks after every listed id instead of silently winning, and ties keep the
   * server's choice order.
   */
  upgradePriority: [
    "gun_rate",
    "gun_damage",
    "armor", // -8% damage taken
    "plating", // +15% max HP
    "laser_damage",
    "laser_charge",
    "nanites", // faster out-of-combat regen
    "servos", // +8% speed
    "gun_mag",
    "reactor", // +30% energy regen (boost)
    "capacitor", // +30 max energy
    "lightning_efficiency",
    "lightning_range",
    "lightning_chain",
    "gyros", // turn rate: the slew gate depends on it
    "gun_velocity",
    "sensors",
    "jets",
    "laser_pierce",
    "mortar_reload",
    "mortar_splash",
    "mortar_velocity",
  ] as readonly string[],

  /**
   * Weapons we take, best first. Laser: 315 hitscan damage at 280 m, +60% cook-off on mortar carriers.
   * Lightning: instant, 45 m cone. Mortar is still skipped (it exposes us to laser cook-off and we cannot lob yet).
   */
  takeKinds: ["laser", "lightning"] as readonly string[],

  /** Swap lightning for a laser only when no visible enemy mech is closer than this (the swap costs equip time). */
  swapNoEnemyM: 30,

  /** Fixed by the protocol (not in hello.config): `take` works within 4 m vertically of the pickup. */
  pickupVerticalM: 4,

  /** LootTarget value = base / (1 + distance / halfValueDistanceM): inversely scaled by distance. */
  lootBaseValue: { cube: 10, lightning: 14, laser: 20, supply_drop: 30 } as Readonly<Record<string, number>>,
  /** A supply drop is worth walking to once it lands within this many seconds, within this range, and nobody else holds it. */
  dropMaxLandsInS: 10,
  dropRangeM: 45,
  halfValueDistanceM: 20,
} as const

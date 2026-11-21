/** OWNER: Person B. Economy tunables. Game mechanics (costs, caps, effects) come from hello.config, never from here. */
export const ECONOMY = {
  /**
   * Upgrade priority, best first: survivability (armor, plating) then the DPS snowball (gun rate/damage, laser), then
   * regen and mobility. Offers only contain weapon upgrades for weapons we hold, so laser_* appear once we carry one.
   * ALL 22 ids of hello.config.upgrades are ranked (a test enforces it). An id not listed here (a balance change adds
   * one) ranks after every listed id instead of silently winning, and ties keep the server's choice order.
   */
  upgradePriority: [
    "armor", // -8% damage taken
    "plating", // +15% max HP
    "gun_rate",
    "gun_damage",
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
   * Weapons we take, best first. Laser: 315 hitscan damage at 280 m, +60% cook-off on mortar carriers. Lightning:
   * instant, 45 m cone. Mortar: lobbed splash at a cluster of 2+ enemies (combat/mortar.ts), lowest preference --
   * never worth swapping a laser or lightning away for, but a fine pickup into an empty slot.
   */
  takeKinds: ["laser", "lightning", "mortar"] as readonly string[],

  /** Swap lightning for a laser only when no visible enemy mech is closer than this (the swap costs equip time). */
  swapNoEnemyM: 30,

  /** Fixed by the protocol (not in hello.config): `take` works within 4 m vertically of the pickup. */
  pickupVerticalM: 4,

  /** LootTarget value = base / (1 + distance / halfValueDistanceM): inversely scaled by distance. */
  lootBaseValue: { cube: 10, lightning: 14, laser: 20, mortar: 14, supply_drop: 30 } as Readonly<Record<string, number>>,
  /** A supply drop is worth walking to once it lands within this many seconds, within this range, and nobody else holds it. */
  dropMaxLandsInS: 10,
  dropRangeM: 45,
  halfValueDistanceM: 20,
} as const

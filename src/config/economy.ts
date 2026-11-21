/** OWNER: Person B. Economy tunables. Game mechanics (costs, caps, effects) come from hello.config, never from here. */
export const ECONOMY = {
  /**
   * Upgrade priority, best first. Survival and mobility before damage; weapon upgrades only matter for weapons we hold.
   * ALL 22 ids of hello.config.upgrades are ranked (a test enforces it). An id not listed here (a balance change adds
   * one) ranks after every listed id instead of silently winning, and ties keep the server's choice order.
   */
  upgradePriority: [
    "armor", // -8% damage taken
    "plating", // +15% max HP
    "nanites", // faster out-of-combat regen
    "servos", // +8% speed
    "reactor", // +30% energy regen (boost)
    "capacitor", // +30 max energy
    "jets",
    "gyros", // turn rate: the slew gate depends on it
    "sensors",
    "gun_damage",
    "gun_rate",
    "gun_mag",
    "gun_velocity",
    "lightning_efficiency",
    "lightning_range",
    "lightning_chain",
    "laser_damage",
    "laser_charge",
    "laser_pierce",
    "mortar_reload",
    "mortar_splash",
    "mortar_velocity",
  ] as readonly string[],

  /**
   * v1 takes ONLY these weapon kinds. mortar: +60% laser cook-off exposure and we cannot lob it yet. laser: not used yet.
   * A weapon we cannot fire is a wasted slot and a liability.
   */
  takeKinds: ["lightning"] as readonly string[],

  /** Fixed by the protocol (not in hello.config): `take` works within 4 m vertically of the pickup. */
  pickupVerticalM: 4,

  /** LootTarget value = base / (1 + distance / halfValueDistanceM): inversely scaled by distance. */
  lootBaseValue: { cube: 10, weapon: 14 } as Readonly<Record<string, number>>,
  halfValueDistanceM: 20,
} as const

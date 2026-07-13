import { BALANCE } from "../../shared/balance";
import type { UnitCounts, UnitType } from "../../shared/types";

export const UNIT_TYPES = ["melee", "ranged", "wizard"] as const satisfies readonly UnitType[];

export function emptyUnits(): UnitCounts {
  return { melee: 0, ranged: 0, wizard: 0 };
}

export function unitsOf(type: UnitType, count: number): UnitCounts {
  const units = emptyUnits();
  units[type] = count;
  return units;
}

export function totalUnits(units: UnitCounts): number {
  return units.melee + units.ranged + units.wizard;
}

export function hasUnits(units: UnitCounts): boolean {
  return totalUnits(units) > 0;
}

export function addUnits(left: UnitCounts, right: UnitCounts): UnitCounts {
  return {
    melee: left.melee + right.melee,
    ranged: left.ranged + right.ranged,
    wizard: left.wizard + right.wizard,
  };
}

export function sumUnits(values: readonly UnitCounts[]): UnitCounts {
  return values.reduce(addUnits, emptyUnits());
}

export function subtractUnits(left: UnitCounts, right: UnitCounts): UnitCounts {
  const result = {
    melee: left.melee - right.melee,
    ranged: left.ranged - right.ranged,
    wizard: left.wizard - right.wizard,
  };
  if (UNIT_TYPES.some((type) => result[type] < 0)) {
    throw new Error("Unit subtraction would create a negative count");
  }
  return result;
}

export function unitsEqual(left: UnitCounts, right: UnitCounts): boolean {
  return UNIT_TYPES.every((type) => left[type] === right[type]);
}

export function unitsContainedBy(subset: UnitCounts, superset: UnitCounts): boolean {
  return UNIT_TYPES.every((type) => subset[type] <= superset[type]);
}

/**
 * Select an exact number of units proportionally using largest remainders and
 * the canonical Melee, Ranged, Wizard tie-break order.
 */
export function takeUnitsProportionally(units: UnitCounts, requested: number): UnitCounts {
  const total = totalUnits(units);
  const amount = Math.max(0, Math.min(total, Math.floor(requested)));
  if (amount === 0 || total === 0) return emptyUnits();
  if (amount === total) return { ...units };

  const output = emptyUnits();
  let assigned = 0;
  const remainders = UNIT_TYPES.map((type, order) => {
    const numerator = units[type] * amount;
    const count = Math.floor(numerator / total);
    output[type] = count;
    assigned += count;
    return { type, order, remainder: numerator % total };
  }).sort((left, right) => right.remainder - left.remainder || left.order - right.order);
  for (let index = 0; assigned < amount; index += 1, assigned += 1) {
    const type = remainders[index % remainders.length]!.type;
    output[type] += 1;
  }
  return output;
}

/** Allocate one composition over canonical exact totals without loss or duplication. */
export function allocateUnitsAcrossTotals(
  units: UnitCounts,
  totals: readonly number[],
): UnitCounts[] {
  if (totals.some((total) => !Number.isInteger(total) || total < 0)) {
    throw new Error("Unit allocation totals must be non-negative integers");
  }
  if (totals.reduce((sum, total) => sum + total, 0) !== totalUnits(units)) {
    throw new Error("Unit allocation totals must consume the complete composition");
  }
  let remaining = { ...units };
  return totals.map((total, index) => {
    const allocation =
      index === totals.length - 1 ? remaining : takeUnitsProportionally(remaining, total);
    remaining = subtractUnits(remaining, allocation);
    return allocation;
  });
}

export function formatUnits(units: UnitCounts): string {
  return `${units.melee} Melee, ${units.ranged} Ranged, ${units.wizard} Wizard`;
}

export function unitTypeForStructure(
  type: "barracks" | "archery-range" | "wizard-tower",
): UnitType {
  if (type === "barracks") return "melee";
  if (type === "archery-range") return "ranged";
  return "wizard";
}

export function counteredUnitType(type: UnitType): UnitType {
  if (type === "melee") return "ranged";
  if (type === "ranged") return "wizard";
  return "melee";
}

export function matchupPermille(attacker: UnitType, defender: UnitType): number {
  return counteredUnitType(attacker) === defender ? BALANCE.rpsAdvantagePermille : 1_000;
}

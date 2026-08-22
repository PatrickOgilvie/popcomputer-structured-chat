import { Repair } from "./core/repair.js"

/** Opt into bounded standard conversation repair. */
export const standard = Repair.standard

export type {
  StandardRepair as Standard,
  StandardRepairOptions as StandardOptions,
} from "./core/repair.js"

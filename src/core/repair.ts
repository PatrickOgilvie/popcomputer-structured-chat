import { Schema } from "effect"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"

/** Package-owned opt-in policy for bounded standard conversation repair. */
export interface StandardRepair extends StructuredDefinition<"repair"> {
  readonly _tag: "StandardRepair"
  readonly maximumCorrections: number
}

/** Options for standard correction detection and state repair. */
export interface StandardRepairOptions {
  readonly maximumCorrections?: number
}

const maximumCorrectionsSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 20 }),
)

const standard = (
  options: StandardRepairOptions = {},
): StandardRepair =>
  structuredDefinition("repair")({
    _tag: "StandardRepair",
    maximumCorrections: Schema.decodeSync(maximumCorrectionsSchema)(
      options.maximumCorrections ?? 5,
    ),
  })

/** Opt-in conversation-repair policies. */
export const Repair = { standard } as const

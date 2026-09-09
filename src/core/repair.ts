import { Schema } from "effect"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import type { StructuredTool } from "./tool.js"

/** @internal Decoded transition produced by a definition-owned repair schema. */
export type RepairCorrection =
  | {
      readonly _tag: "ReplaceAcceptedAnswer"
      readonly stage: string
      readonly field: string
      readonly value: unknown
      readonly evidence: { readonly quote: string }
    }
  | {
      readonly _tag: "ReconfirmAnswer"
      readonly stage: string
      readonly field: string
      readonly evidence: { readonly quote: string }
    }

/** @internal Bounded corrections parsed by the compiled chat's repair tool. */
export interface RepairProposal {
  readonly corrections: readonly [RepairCorrection, ...RepairCorrection[]]
}

/** @internal Planning-only query definition with a known repair proposal shape. */
export type RepairTool = StructuredTool<
  "apply_conversation_repairs",
  Schema.Codec<RepairProposal, unknown>,
  RepairProposal,
  never,
  never
>

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

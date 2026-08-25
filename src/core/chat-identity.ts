import { Schema } from "effect"

/** Stable machine-facing name for one structured chat definition. */
export const ChatNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Positive persisted-state version for one structured chat definition. */
export const ChatVersionSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
)

import { Schema } from "effect"

/** Stable machine-facing name for one structured chat stage. */
export const StageNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

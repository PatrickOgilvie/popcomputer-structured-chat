import { Schema } from "effect"

/** Stable machine-facing name for one structured chat stage. */
export const StageNameSchema = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(100),
  Schema.pattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

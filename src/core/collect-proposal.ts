import { Effect, Schema } from "effect"
import { JsonValueSchema } from "./json-value.js"
import { defineTool } from "./tool.js"
import { defineToolSet } from "./tool-set.js"

/**
 * Collection's transport boundary. The model still sees the precise answer
 * schemas; field values are decoded independently after this strict envelope.
 * Unknown fields (including fields retained from an earlier attempt) fail here.
 */
export const collectProposalPlanner = (
  fields: ReadonlyArray<string>,
  modelInput: Schema.Codec<unknown, unknown>,
) => {
  const input = Schema.Struct({
    answers: Schema.Struct(Object.fromEntries(fields.map(field => [field, Schema.optionalKey(JsonValueSchema)]))),
    evidence: Schema.Array(Schema.Struct({
      field: fields.length === 0 ? Schema.Never : Schema.Literals(fields),
      quote: JsonValueSchema,
    })).check(Schema.isMaxLength(Math.max(1, fields.length * 2))),
    nextQuestion: Schema.optionalKey(JsonValueSchema),
  })
  const transport = defineTool({
    name: "submit_answers",
    description: "Parse collection proposals before independently decoding their values.",
    input,
    execute: proposal => Effect.succeed(proposal),
  })
  const advertised = defineTool({
    name: "submit_answers",
    description: "Submit only new or changed grounded answers. Use null for unchanged or unknown values. Optionally phrase the next question.",
    input: modelInput,
    execute: proposal => Effect.succeed(proposal),
  })
  return {
    ...defineToolSet(transport),
    models: defineToolSet(advertised).models,
  }
}

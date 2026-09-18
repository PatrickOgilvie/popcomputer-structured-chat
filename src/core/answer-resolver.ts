import { Effect, Function as Fn, Predicate, Schema } from "effect"
import type { AnswerDefinition, AnswerDefinitionContract } from "./answer.js"
import {
  canGroundAnswer,
  type ConversationMessage,
} from "./conversation-message.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"
import type { AnswerFields, IssuedCollectQuestion } from "./collect-stage.js"

type ValueOf<A> =
  A extends AnswerDefinition<infer _Mode, infer S, infer _E, infer _R>
    ? S["Type"]
    : never
/** Finite candidate values compatible with every registered answer schema. */
export type FiniteChoicesFor<Fields extends AnswerFields> = {
  readonly [K in keyof Fields]: readonly [
    {
      readonly value: Extract<ValueOf<Fields[K]>, string | boolean>
      readonly meaning: JsonValue
    },
    ...ReadonlyArray<{
      readonly value: Extract<ValueOf<Fields[K]>, string | boolean>
      readonly meaning: JsonValue
    }>,
  ]
}
/** Evidence prepared by the core; resolvers return its candidate IDs only. */
export interface EligibleEvidence {
  readonly id: string
  readonly messageIndex: number
  readonly quote: string
}
/** One registered answer paired with eligible evidence. */
export interface AnswerCandidate {
  readonly id: string
  readonly evidenceId: string
  readonly meaning: JsonValue
}
/** One field's interpretation, independent of every other field. */
export interface FieldDecision {
  readonly field: string
  readonly mode: AnswerDefinitionContract["mode"]
  readonly description: string
  readonly candidates: ReadonlyArray<AnswerCandidate>
}
/** Bounded context supplied to an optional answer resolver. */
export interface CollectionDecisionContext {
  readonly fields: ReadonlyArray<FieldDecision>
  readonly evidence: ReadonlyArray<EligibleEvidence>
}
/** Candidate selection never contains a model-authored value or quote. */
export const FieldSelectionSchema = Schema.TaggedUnion({
  Selected: { field: Schema.String, candidateId: Schema.String },
  Abstained: {
    field: Schema.String,
    reason: Schema.Literals(["no_answer", "ambiguous", "below_threshold"]),
  },
})
/** Candidate selection or an explicit abstention. */
export type FieldSelection = typeof FieldSelectionSchema.Type
/** A bounded strategy can decline an input before evaluating it. */
export const CollectionResolutionSchema = Schema.TaggedUnion({
  Resolved: { selections: Schema.Array(FieldSelectionSchema) },
  NotApplicable: {
    reason: Schema.Literals(["evidence_too_long", "candidate_budget_exceeded"]),
  },
})
/** The result of attempting a collection strategy. */
export type CollectionResolution = typeof CollectionResolutionSchema.Type
/** A resolver returned a selection outside the core's candidate registry. */
export class InvalidAnswerResolution extends Schema.TaggedError<InvalidAnswerResolution>()(
  "InvalidAnswerResolution",
  {
    reason: Schema.Literals([
      "invalid_shape",
      "field_mismatch",
      "invalid_candidate",
    ]),
  },
) {}
interface EncodedChoice {
  readonly value: JsonValue
  readonly meaning: JsonValue
}
interface ResolverRuntime {
  readonly choices: ReadonlyMap<string, ReadonlyArray<EncodedChoice>>
  readonly resolve: (
    context: CollectionDecisionContext,
  ) => Effect.Effect<CollectionResolution, unknown, unknown>
}
const resolverRuntime = Symbol("AnswerResolverRuntime")
/** Authentic optional collection strategy with its bound field definitions. */
export interface AnswerResolverContract
  extends StructuredDefinition<"answer_resolver"> {
  readonly fields: AnswerFields
  readonly [resolverRuntime]: ResolverRuntime
}
/** An answer resolver preserves its expected failures and Effect requirements. */
export interface AnswerResolver<
  Fields extends AnswerFields,
  Error,
  Requirements,
> extends AnswerResolverContract {
  readonly fields: Fields
  readonly resolve: (
    context: CollectionDecisionContext,
  ) => Effect.Effect<CollectionResolution, Error, Requirements>
}
/** Errors introduced by an optional collection strategy. */
export type ResolverError<R> =
  R extends AnswerResolver<infer _Fields, infer E, infer _R> ? E : never
/** Services introduced by an optional collection strategy. */
export type ResolverRequirements<R> =
  R extends AnswerResolver<infer _Fields, infer _E, infer Requirements>
    ? Requirements
    : never

/** Define a finite collection strategy after checking every candidate against its answer. */
export const defineAnswerResolver = <const Fields extends AnswerFields, E, R>(
  fields: Fields,
  choices: FiniteChoicesFor<Fields>,
  resolve: (
    context: CollectionDecisionContext,
  ) => Effect.Effect<CollectionResolution, E, R>,
): AnswerResolver<Fields, E, R> => {
  const names = Object.keys(fields)
  if (
    names.length !== Object.keys(choices).length ||
    Object.keys(choices).some((key) => !Object.hasOwn(fields, key))
  )
    throw new Error("Answer resolver choices must match its fields")
  const encoded = new Map<string, ReadonlyArray<EncodedChoice>>()
  for (const name of names) {
    const field = fields[name]
    const options = choices[name]
    if (field === undefined || options === undefined || options.length < 2)
      throw new Error("Answer resolver fields require at least two choices")
    const unique = new Set(options.map((option) => option.value))
    if (
      unique.size !== options.length ||
      !(
        options.every((option) => Predicate.isString(option.value)) ||
        options.every((option) => Predicate.isBoolean(option.value))
      )
    )
      throw new Error(
        "Answer resolver choices must be distinct strings or booleans",
      )
    if (
      options.every((option) => Predicate.isBoolean(option.value)) &&
      (!options.some((option) => option.value === true) ||
        !options.some((option) => option.value === false))
    )
      throw new Error("Boolean answers require both true and false choices")
    encoded.set(
      name,
      options.map((option) => {
        if (!Schema.is(field.schema)(option.value))
          throw new Error(
            "Answer resolver choice does not satisfy its answer schema",
          )
        const value = Schema.decodeUnknownSync(JsonValueSchema)(
          Schema.encodeSync(field.schema)(option.value),
        )
        return {
          value,
          meaning: Schema.decodeUnknownSync(JsonValueSchema)(
            structuredClone(option.meaning),
          ),
        }
      }),
    )
  }
  return structuredDefinition("answer_resolver")({
    fields,
    resolve,
    [resolverRuntime]: { choices: encoded, resolve },
  })
}

interface CandidateValue {
  readonly value: JsonValue
  readonly quote: string
}
/** @internal Per-turn context and core-owned value/evidence registry. */
export interface PreparedResolution {
  readonly context: CollectionDecisionContext
  readonly registry: ReadonlyMap<string, ReadonlyMap<string, CandidateValue>>
  readonly tooLong: boolean
}
/** @internal Prepare candidates only from eligible, current user evidence. */
export const prepareAnswerResolution = (
  resolver: AnswerResolverContract,
  input: {
    readonly messages: ReadonlyArray<ConversationMessage>
    readonly asked: Readonly<Partial<Record<string, IssuedCollectQuestion>>>
    readonly escaped: boolean
  },
): PreparedResolution => {
  const latest = input.messages.at(-1)
  const empty: PreparedResolution = {
    context: { fields: [], evidence: [] },
    registry: new Map(),
    tooLong: false,
  }
  if (latest === undefined || latest.role !== "user" || input.escaped)
    return empty
  const quote = latest.content.trim()
  if (quote.length > 2_000) return { ...empty, tooLong: true }
  if (quote.length === 0) return empty
  const index = input.messages.length - 1
  const evidence: EligibleEvidence = {
    id: `message_${index}`,
    messageIndex: index,
    quote,
  }
  const fields: Array<FieldDecision> = []
  const registry = new Map<string, ReadonlyMap<string, CandidateValue>>()
  for (const [name, field] of Object.entries(resolver.fields)) {
    const issued = input.asked[name]
    if (
      !canGroundAnswer(latest, field.mode) ||
      (field.mode === "confirmed" &&
        (issued === undefined || issued.messageIndex >= index))
    )
      continue
    const options = resolver[resolverRuntime].choices.get(name)
    if (options === undefined)
      throw new Error("Missing registered resolver choices")
    const values = new Map<string, CandidateValue>()
    const candidates = options.map((option, optionIndex) => {
      const id = `candidate_${optionIndex}`
      values.set(id, { value: option.value, quote })
      return { id, evidenceId: evidence.id, meaning: option.meaning }
    })
    fields.push({
      field: name,
      mode: field.mode,
      description: field.description,
      candidates,
    })
    registry.set(name, values)
  }
  return { context: { fields, evidence: [evidence] }, registry, tooLong: false }
}
/** @internal Invoke the sealed resolver while retaining its conditional Effect types. */
export const runAnswerResolver = <R extends AnswerResolverContract>(
  resolver: R,
  context: CollectionDecisionContext,
): Effect.Effect<
  CollectionResolution,
  ResolverError<R> | InvalidAnswerResolution,
  ResolverRequirements<R>
> => {
  const effect = resolver[resolverRuntime]
    .resolve(context)
    .pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(CollectionResolutionSchema)(result).pipe(
          Effect.mapError(
            () => new InvalidAnswerResolution({ reason: "invalid_shape" }),
          ),
        ),
      ),
    )
  // SAFETY: the sealed runtime belongs to this resolver; its generic errors/services are unchanged.
  return Fn.cast<
    typeof effect,
    Effect.Effect<
      CollectionResolution,
      ResolverError<R> | InvalidAnswerResolution,
      ResolverRequirements<R>
    >
  >(effect)
}
/** @internal Construct the ordinary submission envelope from validated candidate IDs. */
export const resolutionCall = (
  fields: AnswerFields,
  prepared: PreparedResolution,
  selections: ReadonlyArray<FieldSelection>,
): Effect.Effect<JsonValue, InvalidAnswerResolution> =>
  Effect.gen(function* () {
    const expected = prepared.context.fields.map((field) => field.field)
    const selected = new Set(selections.map((selection) => selection.field))
    if (
      selected.size !== selections.length ||
      selections.length !== expected.length ||
      expected.some((field) => !selected.has(field))
    )
      return yield* new InvalidAnswerResolution({ reason: "field_mismatch" })
    const answers = new Map<string, JsonValue>(
      Object.keys(fields).map((name) => [name, null]),
    )
    const evidence: Array<{ readonly field: string; readonly quote: string }> =
      []
    for (const selection of selections) {
      if (selection._tag === "Abstained") continue
      const candidate = prepared.registry
        .get(selection.field)
        ?.get(selection.candidateId)
      if (candidate === undefined)
        return yield* new InvalidAnswerResolution({
          reason: "invalid_candidate",
        })
      answers.set(selection.field, candidate.value)
      evidence.push({ field: selection.field, quote: candidate.quote })
    }
    return {
      name: "submit_answers",
      arguments: {
        answers: Object.fromEntries(answers),
        evidence,
        nextQuestion: null,
      },
    }
  })

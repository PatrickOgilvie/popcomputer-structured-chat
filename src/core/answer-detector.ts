import { Effect, Function as Fn, Schema } from "effect"
import type { AnswerMode } from "./answer.js"
import { canGroundAnswer, type ConversationMessage } from "./conversation-message.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import type { AnswerFields, IssuedCollectQuestion } from "./collect-stage.js"

/** Evidence prepared by the core; a detector judges it but never authors values. */
export interface EligibleEvidence {
  readonly id: string
  readonly messageIndex: number
  readonly quote: string
}

/** One form question offered to an optional answer detector. */
export interface DetectionFieldDecision {
  readonly field: string
  readonly mode: AnswerMode
  readonly description: string
  /** The exact question text issued to the user, when one has been asked. */
  readonly issuedQuestion?: string
  /** Ordered labels from the latest issued question. */
  readonly issuedOptions?: ReadonlyArray<string>
}

/** Bounded context supplied to an optional answer detector. */
export interface DetectionDecisionContext {
  readonly fields: ReadonlyArray<DetectionFieldDecision>
  readonly evidence: ReadonlyArray<EligibleEvidence>
}

/** One field's answered or unanswered interpretation. */
export const DetectionSelectionSchema = Schema.TaggedUnion({
  Detected: { field: Schema.String },
  Undetected: { field: Schema.String },
  Uncertain: { field: Schema.String },
})
/** Field-level detection outcome. */
export type DetectionSelection = typeof DetectionSelectionSchema.Type

/** A bounded detector can decline an input before evaluating it. */
export const DetectionResolutionSchema = Schema.TaggedUnion({
  Resolved: { selections: Schema.Array(DetectionSelectionSchema) },
  NotApplicable: {
    reason: Schema.Literals(["evidence_too_long", "question_budget_exceeded"]),
  },
})
/** The result of attempting a detection strategy. */
export type DetectionResolution = typeof DetectionResolutionSchema.Type

/** A detector returned a selection outside the core's field registry. */
export class InvalidAnswerDetection extends Schema.TaggedError<InvalidAnswerDetection>()(
  "InvalidAnswerDetection",
  {
    reason: Schema.Literals(["invalid_shape", "field_mismatch"]),
  },
) {}

interface DetectorRuntime {
  readonly detect: (
    context: DetectionDecisionContext,
  ) => Effect.Effect<DetectionResolution, unknown, unknown>
}
const detectorRuntime = Symbol("AnswerDetectorRuntime")
/** Authentic optional detection strategy with its bound field definitions. */
export interface AnswerDetectorContract
  extends StructuredDefinition<"answer_detector"> {
  readonly fields: AnswerFields
  readonly [detectorRuntime]: DetectorRuntime
}
/** An answer detector preserves its expected failures and Effect requirements. */
export interface AnswerDetector<
  Fields extends AnswerFields,
  Error,
  Requirements,
> extends AnswerDetectorContract {
  readonly fields: Fields
  readonly detect: (
    context: DetectionDecisionContext,
  ) => Effect.Effect<DetectionResolution, Error, Requirements>
}
/** Errors introduced by an optional detection strategy. */
export type DetectorError<D> =
  D extends AnswerDetector<infer _Fields, infer E, infer _R> ? E : never
/** Services introduced by an optional detection strategy. */
export type DetectorRequirements<D> =
  D extends AnswerDetector<infer _Fields, infer _E, infer Requirements>
    ? Requirements
    : never

/** Define one detection strategy bound to the exact stage fields. */
export const defineAnswerDetector = <const Fields extends AnswerFields, E, R>(
  fields: Fields,
  detect: (
    context: DetectionDecisionContext,
  ) => Effect.Effect<DetectionResolution, E, R>,
): AnswerDetector<Fields, E, R> =>
  structuredDefinition("answer_detector")({
    fields,
    detect,
    [detectorRuntime]: { detect },
  })

/** @internal Per-turn detector context prepared from eligible user evidence. */
export interface PreparedDetection {
  readonly context: DetectionDecisionContext
  readonly tooLong: boolean
}
/** @internal Prepare detector questions only from eligible, current user evidence. */
export const prepareAnswerDetection = (
  detector: Pick<AnswerDetectorContract, "fields">,
  input: {
    readonly messages: ReadonlyArray<ConversationMessage>
    readonly asked: Readonly<Partial<Record<string, IssuedCollectQuestion>>>
  },
): PreparedDetection => {
  const latest = input.messages.at(-1)
  const empty: PreparedDetection = {
    context: { fields: [], evidence: [] },
    tooLong: false,
  }
  if (latest === undefined || latest.role !== "user") return empty
  const quote = latest.content.trim()
  if (quote.length === 0) return empty
  const index = input.messages.length - 1
  const evidence: EligibleEvidence = {
    id: `message_${index}`,
    messageIndex: index,
    quote,
  }
  const fields: Array<DetectionFieldDecision> = []
  for (const [name, field] of Object.entries(detector.fields)) {
    const issued = Object.hasOwn(input.asked, name) ? input.asked[name] : undefined
    if (
      !canGroundAnswer(latest, field.mode) ||
      (field.mode === "confirmed" &&
        (issued === undefined || issued.messageIndex >= index))
    )
      continue
    const decision: DetectionFieldDecision = issued === undefined
      ? { field: name, mode: field.mode, description: field.description }
      : {
          field: name,
          mode: field.mode,
          description: field.description,
          issuedQuestion: (issued.latest ?? issued).text,
          issuedOptions: (issued.latest ?? issued).options ?? [],
        }
    fields.push(decision)
  }
  return { context: { fields, evidence: [evidence] }, tooLong: quote.length > 2_000 }
}
/** @internal Invoke the sealed detector while retaining its conditional Effect types. */
export const runAnswerDetector = <D extends AnswerDetectorContract>(
  detector: D,
  context: DetectionDecisionContext,
): Effect.Effect<
  DetectionResolution,
  DetectorError<D> | InvalidAnswerDetection,
  DetectorRequirements<D>
> => {
  const effect = detector[detectorRuntime]
    .detect(context)
    .pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(DetectionResolutionSchema)(result).pipe(
          Effect.mapError(
            () => new InvalidAnswerDetection({ reason: "invalid_shape" }),
          ),
        ),
      ),
    )
  // SAFETY: the sealed runtime belongs to this detector; its generic errors/services are unchanged.
  return Fn.cast<
    typeof effect,
    Effect.Effect<
      DetectionResolution,
      DetectorError<D> | InvalidAnswerDetection,
      DetectorRequirements<D>
    >
  >(effect)
}
/** @internal Validate one detection pass and return fields eligible for extraction. */
export const readExtractionFields = (
  expected: ReadonlyArray<string>,
  selections: ReadonlyArray<DetectionSelection>,
): Effect.Effect<ReadonlySet<string>, InvalidAnswerDetection> => {
  const selected = new Set(selections.map((selection) => selection.field))
  if (
    selected.size !== selections.length ||
    selections.length !== expected.length ||
    expected.some((field) => !selected.has(field))
  )
    return Effect.fail(new InvalidAnswerDetection({ reason: "field_mismatch" }))
  return Effect.succeed(
    new Set(
      selections
        .filter((selection) => selection._tag !== "Undetected")
        .map((selection) => selection.field),
    ),
  )
}

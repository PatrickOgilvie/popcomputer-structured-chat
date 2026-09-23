import { Effect, Function as Fn, Result, Schema, Struct } from "effect"

import {
  prepareAnswerDetection,
  readExtractionFields,
  runAnswerDetector,
  InvalidAnswerDetection,
  type AnswerDetectorContract,
  type DetectorError,
  type DetectorRequirements,
  type DetectionSelection,
} from "./answer-detector.js"
import {
  InvalidCollectStageResponse,
  invalidCollectResponse,
  type AnswerValidationRejected,
} from "./answer-errors.js"
import { buildExtractionRequest } from "./answer-extraction.js"
import { askPendingQuestion, nextQuestion } from "./answer-prompts.js"
import {
  annotateAnswerProposal,
  assessAnswerProposal,
  emptyAnswerProposal,
  mergeAnswerProposal,
  type AnswerProposal,
  type ProposalAccumulator,
} from "./answer-proposal.js"
import { isEscapeReply, type AnswerRegistry } from "./answer-registry.js"
import { applyAnswerRepairs } from "./answer-repairs.js"
import {
  isCompleteAnswerState,
  isGroundedInMessages,
  isInitialAnswerState,
  isValidAnswerState,
} from "./answer-state.js"
import {
  readAnswerUserPresentation,
  type AnswerDefinition,
  type AnswerDefinitionContract,
  type AnswerMode,
} from "./answer.js"
import { collectProposalPlanner } from "./collect-proposal.js"
import {
  canGroundAnswer,
  findEvidence,
  type ConversationMessage,
} from "./conversation-message.js"
import { recordDebugEvent } from "./debug-trace.js"
import { type StructuredDefinition } from "./definition.js"
import {
  type ExtractionContextContract,
  type ExtractionContextError,
  type ExtractionContextRequirements,
} from "./extraction-context.js"
import { encodeJsonValue, type JsonValue } from "./json-value.js"
import {
  type ModelGuardError,
  type ModelGuardRequirements,
  type ModelGuardTuple,
  runModelCallGuards,
  runModelGuards,
} from "./model-guard.js"
import {
  ChatModelUnavailable,
  Instruction,
  planToolCallAfterGuards,
  type AnyModelProfile,
  type ModelProfileInput,
  type ModelRequirement,
  type UnsupportedModelToolSchema,
} from "./model.js"
import {
  type AdaptiveChoiceQuestion,
  type ChoiceQuestion,
  type QuestionDefinitionContract,
  type QuestionChoice,
} from "./question.js"
import { getOwn } from "./record.js"
import type { RepairCorrection } from "./repair.js"
import { StageNameSchema } from "./stage-name.js"
import type { ToolPlanningFrame } from "./tool-selection.js"
import { InvalidToolCall, type InvalidToolProjection } from "./tool.js"

/** Named answer fields accepted by a collect stage. */
export type AnswerFields = Readonly<Record<string, AnswerDefinitionContract>>

/** @internal Compare exact definitions while allowing separately composed registries. */
export const sameAnswerFields = (
  left: AnswerFields,
  right: AnswerFields,
): boolean => {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  )
}

/** @internal Registered answer definitions carried by one answer stage. */
export type AnswerFieldsOf<Stage> = Stage extends {
  readonly fields: infer Fields extends AnswerFields
}
  ? Fields
  : never

/** @internal Persisted state carried by one answer stage, keyed by its name. */
export type AnswerStateEntryOf<Stage> = Stage extends {
  readonly _tag: "CollectStage" | "InterviewStage"
  readonly name: infer Name extends string
  readonly stateSchema: Schema.Codec<infer State, unknown>
}
  ? { readonly [Key in Name]: State }
  : never

/** Stable machine-facing key for one collect-stage answer field. */
export const CollectAnswerFieldNameSchema = Schema.String.check(
  Schema.isMaxLength(60),
  Schema.isPattern(/^[a-z][a-zA-Z0-9_]*$/),
)

type AnswerValue<Answer> =
  Answer extends AnswerDefinition<
    infer _Mode,
    infer ValueSchema,
    infer _Error,
    infer _Requirements
  >
    ? Schema.Schema.Type<ValueSchema>
    : never

/** Complete typed answers required by a collect stage. */
export type CollectAnswers<Fields extends AnswerFields> = {
  readonly [Field in keyof Fields]: AnswerValue<Fields[Field]>
}

/**
 * Location of the user-authored text that supported an accepted answer.
 *
 * The quote is untrusted conversation data. For semantic answers it supports
 * an inference; it is not required to equal the accepted typed value.
 */
export interface AcceptedAnswerEvidence {
  readonly messageIndex: number
  readonly quote: string
}

/** One typed answer persisted together with its supporting transcript data. */
export interface AcceptedAnswer<Value> {
  readonly value: Value
  readonly evidence: AcceptedAnswerEvidence
}

/** Accepted answer units keyed by their collect-stage field. */
export type CollectAcceptedAnswers<Fields extends AnswerFields> = {
  readonly [Field in keyof Fields]: AcceptedAnswer<AnswerValue<Fields[Field]>>
}

/** One assistant question persisted together with its transcript location. */
export interface IssuedQuestionContext {
  readonly messageIndex: number
  readonly text: string
  readonly options?: ReadonlyArray<string>
}

/** First issuance retains confirmation authority; latest retains the current wording. */
export interface IssuedCollectQuestion extends IssuedQuestionContext {
  readonly latest?: IssuedQuestionContext
}

/** Server-owned progress for one collect stage. */
export interface CollectStageState<Fields extends AnswerFields> {
  readonly accepted: Partial<CollectAcceptedAnswers<Fields>>
  readonly asked: Partial<Record<keyof Fields & string, IssuedCollectQuestion>>
  /** Unresolved answers or corrections that must be clarified before advancing. */
  readonly clarifying?: ReadonlyArray<keyof Fields & string>
}

/** Typed question selected for the next missing answer. */
export type CollectStageQuestion<Fields extends AnswerFields> = {
  [Field in keyof Fields & string]: {
    readonly field: Field
    readonly mode: Fields[Field]["mode"]
    readonly description: string
    readonly question: Fields[Field]["question"]
  }
}[keyof Fields & string]

type QuestionOptions<Question> =
  Question extends ChoiceQuestion<infer Value>
    ? ReadonlyArray<QuestionChoice<Value>>
    : Question extends AdaptiveChoiceQuestion
      ? ReadonlyArray<QuestionChoice<string>>
      : readonly []

/** Browser-ready question deterministically selected after fact extraction. */
export type CollectStagePrompt<Fields extends AnswerFields> = {
  [Field in keyof Fields & string]: {
    readonly field: Field
    readonly mode: Fields[Field]["mode"]
    readonly text: string
    readonly options: QuestionOptions<Fields[Field]["question"]>
    readonly escape?: { readonly label: string }
  }
}[keyof Fields & string]

type AnswerValidationError<Answer> =
  Answer extends AnswerDefinition<
    infer _Mode,
    infer _Schema,
    infer Error,
    infer _Requirements
  >
    ? Error
    : never

type AnswerValidationRequirements<Answer> =
  Answer extends AnswerDefinition<
    infer _Mode,
    infer _Schema,
    infer _Error,
    infer Requirements
  >
    ? Requirements
    : never

/** Failure union produced by all field validators in a collect stage. */
export type CollectAnswerValidationError<Fields extends AnswerFields> = {
  [Field in keyof Fields & string]: [
    AnswerValidationError<Fields[Field]>,
  ] extends [never]
    ? never
    : AnswerValidationRejected<
        AnswerValidationError<Fields[Field]>,
        Extract<CollectStagePrompt<Fields>, { readonly field: Field }>
      >
}[keyof Fields & string]

/** Effect service union required by all field validators in a collect stage. */
export type CollectAnswerValidationRequirements<Fields extends AnswerFields> =
  AnswerValidationRequirements<Fields[keyof Fields]>

/** Result of one collect-stage model turn. */
export interface CollectStageTurn<Fields extends AnswerFields> {
  readonly state: CollectStageState<Fields>
  readonly complete: boolean
  readonly question: CollectStagePrompt<Fields> | undefined
}

/** @internal A decoded answer value whose schema is known only to its field. */
export type RuntimeAnswerValue = Schema.Schema.Type<
  Schema.Codec<unknown, unknown>
>

type RuntimeAcceptedAnswer = AcceptedAnswer<RuntimeAnswerValue>

export interface RuntimeCollectStageState {
  readonly accepted: Readonly<Partial<Record<string, RuntimeAcceptedAnswer>>>
  readonly asked: Readonly<Partial<Record<string, IssuedCollectQuestion>>>
  readonly clarifying?: ReadonlyArray<string>
}

export interface RuntimeCollectStagePrompt {
  readonly field: string
  readonly mode: AnswerMode
  readonly text: string
  readonly options: ReadonlyArray<QuestionChoice<RuntimeAnswerValue>>
  readonly escape?: { readonly label: string }
}

export interface RuntimeCollectStageTurn {
  readonly state: RuntimeCollectStageState
  readonly complete: boolean
  readonly question: RuntimeCollectStagePrompt | undefined
}

/** @internal Interview queries preserve answer progress without advancing the stage. */
type RuntimeAnswerStageTurn =
  | RuntimeCollectStageTurn
  | {
      readonly complete: false
      readonly state: RuntimeCollectStageState
      readonly question: undefined
      readonly action:
        | { readonly _tag: "ToolResult"; readonly result: unknown }
        | { readonly _tag: "Clarification"; readonly text: string }
    }

/** @internal Repaired state and whether a reconfirmation now blocks completion. */
export interface RuntimeCollectRepairResult {
  readonly state: RuntimeCollectStageState
  readonly requiresConfirmation: boolean
}

/** @internal Validated answer progress before any question is issued. */
export interface AnswerCollectionResult<
  State extends RuntimeCollectStageState = RuntimeCollectStageState,
> {
  readonly state: State
  readonly wording: ProposedQuestionWording | null
  readonly declines: ReadonlyArray<{
    readonly field: string
    readonly evidence: AcceptedAnswerEvidence
  }>
}

/** @internal Untrusted wording already parsed against the question contract. */
export interface ProposedQuestionWording {
  readonly field: string
  readonly text: string
  readonly options: ReadonlyArray<{ readonly label: string }>
}

/** @internal Extraction focus is the question actually issued, independent of field order. */
export interface AnswerCollectionInput {
  readonly state: RuntimeCollectStageState
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly focus?: string
  readonly declinable?: ReadonlyArray<string>
  readonly history?: "whole"
}

/** @internal Erased answer-stage behavior consumed by the chat runtime. */
export interface AnswerStageRuntime {
  readonly stateFields: Schema.Struct.Fields
  readonly extract: (
    input: AnswerCollectionInput,
  ) => Effect.Effect<AnswerCollectionResult, unknown, unknown>
  readonly ask: (
    state: RuntimeCollectStageState,
    messages: ReadonlyArray<ConversationMessage>,
    field: string,
    wording: ProposedQuestionWording | null,
  ) => RuntimeCollectStageTurn
  readonly initialState: RuntimeCollectStageState
  readonly stateSchema: Schema.Codec<unknown, unknown>
  readonly isInitial: (state: RuntimeCollectStageState) => boolean
  readonly isValid: (state: RuntimeCollectStageState) => boolean
  readonly isGroundedInMessages: (
    state: RuntimeCollectStageState,
    messages: ReadonlyArray<ConversationMessage>,
  ) => boolean
  readonly isComplete: (state: RuntimeCollectStageState) => boolean
  readonly repairSchema: Schema.Codec<RepairCorrection, unknown>
  readonly applyRepairs: (
    state: RuntimeCollectStageState,
    messages: ReadonlyArray<ConversationMessage>,
    repairs: ReadonlyArray<RepairCorrection>,
  ) => Effect.Effect<RuntimeCollectRepairResult, unknown, unknown>
  readonly run: (input: {
    readonly frame?: ToolPlanningFrame
    readonly state: RuntimeCollectStageState
    readonly messages: ReadonlyArray<ConversationMessage>
  }) => Effect.Effect<RuntimeAnswerStageTurn, unknown, unknown>
}

/** @internal One definition-ordered field exposed to trusted projections. */
export interface AnswerStageInspectionField {
  readonly field: string
  readonly mode: AnswerMode
  readonly description: string
  readonly question: QuestionDefinitionContract
  readonly userPresentation: { readonly label?: string } | undefined
  readonly encodeValue: (
    value: RuntimeAnswerValue,
  ) => Effect.Effect<JsonValue, Schema.SchemaError>
}

/** @internal Read-only collect-stage metadata used by trusted projections. */
export interface AnswerStageInspection {
  readonly fields: ReadonlyArray<AnswerStageInspectionField>
}

const answerStageRuntime = Symbol(
  "@popcomputer/structured-chat/AnswerStageRuntime",
)

const answerStageInspection = Symbol(
  "@popcomputer/structured-chat/AnswerStageInspection",
)

/** Minimum sealed collect-stage shape accepted by a chat definition. */
export interface AnswerStageDefinitionContract extends StructuredDefinition<
  "collect_stage" | "interview_stage"
> {
  readonly _tag: "CollectStage" | "InterviewStage"
  readonly name: string
  readonly guards: ModelGuardTuple
  readonly [answerStageRuntime]: AnswerStageRuntime
  readonly [answerStageInspection]: AnswerStageInspection
}

/** Minimum sealed deterministic collection definition. */
export interface CollectStageDefinitionContract extends AnswerStageDefinitionContract {
  readonly _tag: "CollectStage"
}

/** @internal Install shared answer-stage capabilities before sealing a definition. */
export const withAnswerStageRuntime = <T extends object>(
  definition: T,
  runtime: AnswerStageRuntime,
  inspection: AnswerStageInspection,
) => ({
  ...definition,
  [answerStageRuntime]: runtime,
  [answerStageInspection]: inspection,
})

/** @internal Recognize stages that retain grounded answers. */
export const isAnswerStage = (stage: {
  readonly _tag: string
}): stage is AnswerStageDefinitionContract =>
  stage._tag === "CollectStage" || stage._tag === "InterviewStage"

/** @internal Read the erased runtime from an authentic collect stage. */
export const readAnswerStageRuntime = (
  stage: AnswerStageDefinitionContract,
): AnswerStageRuntime => stage[answerStageRuntime]

/** @internal Read trusted definition metadata from an authentic collect stage. */
export const readAnswerStageInspection = (
  stage: AnswerStageDefinitionContract,
): AnswerStageInspection => stage[answerStageInspection]

/** Shared conversational policy for questions in one collect stage. */
export interface CollectQuestionPolicy {
  /** Trusted style guidance applied to every adaptive question in this stage. */
  readonly guidance?: string
  /** A browser-visible answer that keeps the current field unresolved. */
  readonly escape?: string
}

interface MutableCollectQuestionPolicy {
  guidance?: string
  escape?: string
}

/** Definition input for one schema-derived fact collection stage. */
export type DefineCollectStageInput<
  Name extends string,
  Fields extends AnswerFields,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined = undefined,
  Detector extends AnswerDetectorContract | undefined = undefined,
  Enrichment extends ExtractionContextContract | undefined = undefined,
> = {
  readonly name: Name
  readonly questions?: CollectQuestionPolicy
  readonly fields: Fields
  readonly guards?: Guards
  readonly detector?: Detector
  readonly context?: Enrichment
} & ModelProfileInput<Profile>

/** One schema-derived stage that is complete only when every fact is known. */
export interface CollectStage<
  Name extends string,
  Fields extends AnswerFields,
  Guards extends ModelGuardTuple = readonly [],
  Profile extends AnyModelProfile | undefined = undefined,
  Detector extends AnswerDetectorContract | undefined = undefined,
  Enrichment extends ExtractionContextContract | undefined = undefined,
> extends CollectStageDefinitionContract {
  readonly _tag: "CollectStage"
  readonly name: Name
  readonly fields: Fields
  readonly questions: CollectQuestionPolicy
  readonly answersSchema: Schema.Codec<CollectAnswers<Fields>, unknown>
  readonly stateSchema: Schema.Codec<CollectStageState<Fields>, unknown>
  readonly initialState: CollectStageState<Fields>
  readonly guards: Guards

  /** Strictly parse persisted or client-returned stage state. */
  readonly parseState: (
    input: Schema.Codec.Encoded<
      Schema.Codec<CollectStageState<Fields>, unknown>
    >,
  ) => Effect.Effect<CollectStageState<Fields>, Schema.SchemaError>

  /** Test whether every schema-defined answer has been populated. */
  readonly isComplete: (state: CollectStageState<Fields>) => boolean

  /** Select the first missing question in schema declaration order. */
  readonly nextQuestion: (
    state: CollectStageState<Fields>,
  ) => CollectStageQuestion<Fields> | undefined

  /** Record the first assistant question issued for one field. */
  readonly markAsked: <Field extends keyof Fields & string>(
    state: CollectStageState<Fields>,
    field: Field,
    messageIndex: number,
    text: string,
  ) => CollectStageState<Fields>

  /** Extract grounded answers and deterministically advance one turn. */
  readonly run: (input: {
    readonly state: CollectStageState<Fields>
    readonly messages: ReadonlyArray<ConversationMessage>
  }) => Effect.Effect<
    CollectStageTurn<Fields>,
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | InvalidToolCall
    | InvalidToolProjection
    | InvalidCollectStageResponse
    | CollectAnswerValidationError<Fields>
    | ModelGuardError<Guards>
    | DetectorError<Detector>
    | ExtractionContextError<Enrichment>
    | (Detector extends AnswerDetectorContract
        ? InvalidAnswerDetection
        : never),
    | ModelRequirement<Profile>
    | CollectAnswerValidationRequirements<Fields>
    | ModelGuardRequirements<Guards>
    | DetectorRequirements<Detector>
    | ExtractionContextRequirements<Enrichment>
  >
}

type AnswerSchemas<Fields extends AnswerFields> = {
  readonly [Field in keyof Fields]: Fields[Field]["schema"]
}

/** @internal Shared acceptance engine; stage constructors install their own lifecycle and identity. */
export type AnswerCollection<
  Name extends string,
  Fields extends AnswerFields,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined,
  Detector extends AnswerDetectorContract | undefined,
  Enrichment extends ExtractionContextContract | undefined,
> = Omit<
  CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment>,
  keyof CollectStageDefinitionContract
> & {
  readonly name: Name
  readonly guards: Guards
  readonly runtime: AnswerStageRuntime
  readonly inspection: AnswerStageInspection
}

/** @internal Build shared answer acceptance and deterministic collection behavior. */
export const createAnswerCollection = <
  const Name extends string,
  const Fields extends AnswerFields,
  const Guards extends ModelGuardTuple = readonly [],
  const Profile extends AnyModelProfile | undefined = undefined,
  const Detector extends AnswerDetectorContract | undefined = undefined,
  const Enrichment extends ExtractionContextContract | undefined = undefined,
>(
  definition: DefineCollectStageInput<
    Name,
    Fields,
    Guards,
    Profile,
    Detector,
    Enrichment
  >,
): AnswerCollection<Name, Fields, Guards, Profile, Detector, Enrichment> => {
  StageNameSchema.make(definition.name)

  const questionGuidanceSchema = Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(2_000),
  )

  const questionEscapeSchema = Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(100),
  )

  const questionPolicyBuilder: MutableCollectQuestionPolicy = {}

  if (definition.questions?.guidance !== undefined) {
    questionPolicyBuilder.guidance = questionGuidanceSchema.make(
      definition.questions.guidance,
    )
  }

  if (definition.questions?.escape !== undefined) {
    questionPolicyBuilder.escape = questionEscapeSchema.make(
      definition.questions.escape,
    )
  }

  const questions: CollectQuestionPolicy = questionPolicyBuilder

  // SAFETY: definition.fields is the exact Fields mapping; Object.keys returns
  // only its enumerable string keys.
  const fieldNames = Fn.cast<
    Array<string>,
    ReadonlyArray<keyof Fields & string>
  >(Object.keys(definition.fields))

  if (fieldNames.length === 0) {
    throw new Error("Collect stages require at least one answer field")
  }

  if (fieldNames.length > 20) {
    throw new Error("Collect stages support at most 20 answer fields")
  }

  // Field declaration order drives questioning, and JavaScript reorders
  // integer-like object keys ahead of string keys; names therefore must
  // start with a letter.
  for (const field of fieldNames) {
    if (!Schema.is(CollectAnswerFieldNameSchema)(field)) {
      throw new Error(
        `Collect-stage field names must start with a lowercase letter, use only letters, digits, and underscores, and stay within 60 characters: ${JSON.stringify(field)}`,
      )
    }
  }

  const [firstField, ...remainingFields] = fieldNames

  if (firstField === undefined) {
    throw new Error("Collect stages require at least one answer field")
  }

  const fieldSchema = Schema.Literals([firstField, ...remainingFields])

  const recordStateAnnotations = (
    previous: CollectStageState<Fields>,
    next: CollectStageState<Fields>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const field of fieldNames) {
        const previousAccepted = getOwn(previous.accepted, field)
        const nextAccepted = getOwn(next.accepted, field)

        if (previousAccepted === undefined && nextAccepted !== undefined) {
          yield* recordDebugEvent({
            _tag: "QuestionAnswered",
            stage: definition.name,
            field,
          })
        }

        const previousQuestion = getOwn(previous.asked, field)
        const nextQuestion = getOwn(next.asked, field)

        if (
          nextQuestion !== undefined &&
          (previousQuestion === undefined ||
            previousQuestion.messageIndex !== nextQuestion.messageIndex ||
            previousQuestion.text !== nextQuestion.text)
        ) {
          yield* recordDebugEvent({
            _tag: "QuestionAsked",
            stage: definition.name,
            field,
          })
        }
      }
    })

  const messageIndexSchema = Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 1_000_000 }),
  )

  const getAnswer = (
    field: keyof Fields & string,
  ): AnswerDefinitionContract => {
    const answer = definition.fields[field]

    if (answer === undefined) {
      throw new Error(`Unknown collect-stage answer field: ${field}`)
    }

    return answer
  }

  const registry: AnswerRegistry<Fields> = {
    stage: definition.name,
    fields: definition.fields,
    fieldNames,
    questions,
    getAnswer,
  }

  if (questions.escape === undefined) {
    for (const field of fieldNames) {
      if (getAnswer(field).escape !== undefined) {
        throw new Error(
          `Escape resolution for ${field} requires questions.escape`,
        )
      }
    }
  }

  const answerSchemaEntries = fieldNames.map(
    (field) => [field, getAnswer(field).schema] as const,
  )

  // SAFETY: every entry uses one exact Fields key and its corresponding schema.
  const answerSchemas = Fn.cast<
    ReturnType<typeof Object.fromEntries>,
    AnswerSchemas<Fields>
  >(Object.fromEntries(answerSchemaEntries))

  const rawAnswersSchema = Schema.Struct(answerSchemas)

  const evidenceQuoteSchema = Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(2_000),
  )

  const questionTextSchema = Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(500),
  )

  const acceptedEvidenceSchema = Schema.Struct({
    messageIndex: messageIndexSchema,
    quote: evidenceQuoteSchema,
  })

  const proposedEvidenceSchema = Schema.Struct({
    quote: evidenceQuoteSchema,
  })

  const repairSchemas = fieldNames.map((field) => {
    const answer = getAnswer(field)

    const identity = {
      stage: Schema.Literal(definition.name),
      field: Schema.Literal(field),
      evidence: proposedEvidenceSchema,
    }

    return answer.mode === "confirmed"
      ? Schema.TaggedStruct("ReconfirmAnswer", {
          ...identity,
        })
      : Schema.TaggedStruct("ReplaceAcceptedAnswer", {
          ...identity,
          value: answer.schema,
        })
  })

  const [firstRepairSchema, ...remainingRepairSchemas] = repairSchemas

  if (firstRepairSchema === undefined) {
    throw new Error("Collect stages require one repair schema")
  }

  const rawRepairSchema =
    remainingRepairSchemas.length === 0
      ? firstRepairSchema
      : Schema.Union([firstRepairSchema, ...remainingRepairSchemas])

  // SAFETY: every dynamically generated member uses only AnyNoContext field
  // schemas and exact stage, field, and transition literals.
  const repairSchema = Fn.cast<
    typeof rawRepairSchema,
    Schema.Codec<RepairCorrection, unknown>
  >(rawRepairSchema)

  const acceptedFields = Object.fromEntries(
    fieldNames.map((field) => [
      field,
      Schema.Struct({
        value: getAnswer(field).schema,
        evidence: acceptedEvidenceSchema,
      }),
    ]),
  )

  const issuedContextSchema = Schema.Struct({
    messageIndex: messageIndexSchema,
    text: questionTextSchema,
    options: Schema.optionalKey(
      Schema.Array(
        Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
      ).check(Schema.isMaxLength(20)),
    ),
  })
  const issuedQuestionSchema = Schema.Struct({
    ...issuedContextSchema.fields,
    latest: Schema.optionalKey(issuedContextSchema),
  })
  const askedFields: Record<string, typeof issuedQuestionSchema> =
    Object.fromEntries(fieldNames.map((field) => [field, issuedQuestionSchema]))

  const rawStateSchema = Schema.Struct({
    accepted: Schema.Struct(acceptedFields).mapFields(
      Struct.map(Schema.optional),
    ),
    asked: Schema.Struct(askedFields).mapFields(Struct.map(Schema.optional)),
    clarifying: Schema.optionalKey(
      Schema.Array(fieldSchema).check(
        Schema.isMaxLength(fieldNames.length),
        Schema.makeFilter((fields) => new Set(fields).size === fields.length),
      ),
    ),
  })

  const isValidState = (state: {
    readonly accepted: object
    readonly asked: Readonly<Partial<Record<string, IssuedCollectQuestion>>>
  }): boolean => isValidAnswerState(registry, state)

  const refinedStateSchema = rawStateSchema.check(
    Schema.makeFilter<Schema.Schema.Type<typeof rawStateSchema>>(isValidState, {
      description: "semantically valid collect-stage state",
    }),
  )

  // SAFETY: rawAnswersSchema is created from every field's exact schema.
  const answersSchema = Fn.cast<
    typeof rawAnswersSchema,
    Schema.Codec<CollectAnswers<Fields>, unknown>
  >(rawAnswersSchema)

  // SAFETY: partial preserves the mapped accepted-answer types, while asked is
  // a record whose keys are restricted to the exact field literal union.
  const stateSchema = Fn.cast<
    typeof refinedStateSchema,
    Schema.Codec<CollectStageState<Fields>, unknown>
  >(refinedStateSchema)

  const initialState = Schema.decodeSync(Schema.toType(stateSchema))({
    accepted: {},
    asked: {},
  })

  const inspectionFields: ReadonlyArray<AnswerStageInspectionField> =
    fieldNames.map((field) => {
      const answer = getAnswer(field)

      return {
        field,
        mode: answer.mode,
        description: answer.description,
        question: answer.question,
        userPresentation: readAnswerUserPresentation(answer),
        encodeValue: (value) =>
          encodeJsonValue(answer.schema, value, { onExcessProperty: "error" }),
      }
    })

  // SAFETY: when guards are omitted, Guards uses its readonly [] default; an
  // explicitly supplied tuple is returned unchanged.
  const guards = definition.guards ?? Fn.cast<readonly [], Guards>([])
  // SAFETY: ModelProfileInput requires a concrete model whenever Profile is
  // defined; when Profile is undefined, undefined is the only legal value.
  const model = Fn.cast<typeof definition.model, Profile>(definition.model)

  // SAFETY: the selected value above preserves the conditional input proof;
  // this projection only restores that relationship for object construction.
  const modelInput = Fn.cast<
    { readonly model: Profile },
    ModelProfileInput<Profile>
  >({ model })

  // SAFETY: every entry is built from one registered AnyNoContext answer
  // schema and adds only the model-wire null representation for absence.
  const proposalAnswerSchemaEntries = fieldNames.map((field) => {
    const answer = getAnswer(field)

    return [
      field,
      Schema.NullOr(answer.schema).annotate({
        description: `${answer.mode}: ${answer.description}`,
      }),
    ]
  })

  // SAFETY: each entry contains one registered field and its no-context schema.
  const proposalAnswerSchemas = Fn.cast<
    ReturnType<typeof Object.fromEntries>,
    Record<string, Schema.Codec<unknown, unknown>>
  >(Object.fromEntries(proposalAnswerSchemaEntries))

  const rawProposalSchema = Schema.Struct({
    answers: Schema.Struct(proposalAnswerSchemas),
    evidence: Schema.Array(
      Schema.Struct({
        field: fieldSchema,
        quote: evidenceQuoteSchema,
      }),
    ).check(Schema.isMaxLength(fieldNames.length)),
    nextQuestion: Schema.NullOr(
      Schema.Struct({
        field: fieldSchema,
        text: questionTextSchema,
        options: Schema.Array(
          Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
        ).check(Schema.isMaxLength(20)),
      }),
    ),
  })

  const invalidResponse = (
    reason: "invalid_evidence" | "invalid_repair" = "invalid_evidence",
  ) => invalidCollectResponse(definition.name, reason)

  const runExtraction = ({
    state,
    messages,
    focus,
    history,
    declinable = [],
  }: {
    readonly state: CollectStageState<Fields>
    readonly messages: ReadonlyArray<ConversationMessage>
    readonly focus?: keyof Fields & string
    readonly declinable?: ReadonlyArray<string>
    readonly history?: "whole"
  }) => {
    const detector = definition.detector

    const resolvedStep = Effect.gen(function* () {
      const guardContext = { messages, toolNames: ["submit_answers"] }
      yield* runModelGuards(guards, guardContext)
      const latest = messages.at(-1)
      const pending = nextQuestion(registry, state, focus)
      const escapedField = isEscapeReply(latest, questions.escape)
        ? pending?.field
        : undefined
      const prepared = prepareAnswerDetection(
        detector ?? { fields: definition.fields },
        { messages, asked: state.asked },
      )
      const fallback: ReadonlyArray<DetectionSelection> =
        prepared.context.fields.map(({ field }) => ({
          _tag: "Uncertain",
          field,
        }))
      // On interview entry, earlier messages may already answer this bank. A
      // detector of the latest reply cannot rule out that earlier evidence.
      const enteringInterview =
        history === "whole" && Object.keys(state.asked).length === 0
      const resolution =
        enteringInterview ||
        escapedField !== undefined ||
        prepared.tooLong ||
        detector === undefined
          ? { _tag: "Resolved" as const, selections: fallback }
          : prepared.context.fields.length === 0
            ? { _tag: "Resolved" as const, selections: [] }
            : yield* runAnswerDetector(detector, prepared.context)
      const detected =
        resolution._tag === "NotApplicable" ? fallback : resolution.selections
      // Validate the detector contract before overriding a decision. A pending
      // clarification needs value interpretation even if detection says no.
      yield* readExtractionFields(
        prepared.context.fields.map((field) => field.field),
        detected,
      )
      const decisions = detected.map((decision) =>
        state.clarifying?.includes(decision.field) === true ||
        declinable.includes(decision.field)
          ? { _tag: "Uncertain" as const, field: decision.field }
          : decision,
      )
      const extracting = yield* readExtractionFields(
        prepared.context.fields.map((field) => field.field),
        decisions,
      )
      let selected =
        detector === undefined && definition.context === undefined
          ? [...fieldNames]
          : fieldNames.filter((field) => extracting.has(field))
      selected = fieldNames.filter(
        (field) => selected.includes(field) || declinable.includes(field),
      )
      const declines: Array<{
        readonly field: string
        readonly evidence: AcceptedAnswerEvidence
      }> = []
      const declineSchema = Schema.Array(
        Schema.Struct({
          field:
            declinable.length === 0
              ? Schema.Never
              : Schema.Literals(declinable),
          quote: evidenceQuoteSchema,
        }),
      ).check(Schema.isMaxLength(declinable.length))
      const proposal = emptyAnswerProposal(registry)
      const clarifying = new Set(state.clarifying ?? [])
      if (selected.length === 0) {
        yield* runModelCallGuards(guards, {
          ...guardContext,
          call: { name: "submit_answers", arguments: proposal },
        })
        return { serverResult: proposal, clarifying: [...clarifying], declines }
      }
      // Context hooks run once. A repair retains this labelled context while
      // its tool schema and safe diagnostics narrow the permitted changes.
      const context = yield* buildExtractionRequest(registry, {
        state,
        messages,
        focus,
        history,
        declinable,
        decisions: selected.map(
          (field) =>
            decisions.find((decision) => decision.field === field) ?? {
              _tag: "Uncertain",
              field,
            },
        ),
        detectorConfigured: detector !== undefined,
        context: definition.context,
      })
      const accumulator: ProposalAccumulator<Fields> = {
        answers: { ...proposal.answers },
        evidence: [],
        clarifying,
      }
      let proposedQuestion = proposal.nextQuestion
      let repairInstruction = ""
      for (const attempt of [1, 2] as const) {
        const selectedSchema = Schema.Literals(selected)
        const inputFields = {
          answers: Schema.Struct(
            Object.fromEntries(
              selected.map((field) => {
                const schema = proposalAnswerSchemas[field]
                if (schema === undefined)
                  throw new Error("Missing registered answer schema")
                return [field, schema]
              }),
            ),
          ),
          evidence: Schema.Array(
            Schema.Struct({
              field: selectedSchema,
              quote: evidenceQuoteSchema,
            }),
          ).check(Schema.isMaxLength(selected.length)),
          nextQuestion: rawProposalSchema.fields.nextQuestion,
        }
        const inputSchema =
          declinable.length === 0
            ? Schema.Struct(inputFields)
            : Schema.Struct({ ...inputFields, declines: declineSchema })
        // SAFETY: all selected codecs are no-context schemas registered by this stage.
        const schema = Fn.cast<
          typeof inputSchema,
          typeof inputSchema & Schema.Codec<unknown, unknown>
        >(inputSchema)
        const planner = collectProposalPlanner(selected, schema)
        const response = yield* planToolCallAfterGuards<
          typeof planner.tools,
          readonly [],
          Profile
        >({
          ...context,
          instructions:
            repairInstruction.length === 0
              ? context.instructions
              : [...context.instructions, Instruction.make(repairInstruction)],
          tools: planner,
          maximumAttempts: 1,
          ...modelInput,
        }).pipe(
          Effect.withSpan("popcomputer.structured_chat.collect.extraction", {
            attributes: {
              stage: definition.name,
              attempt,
              fieldCount: selected.length,
            },
          }),
          Effect.result,
        )
        if (Result.isFailure(response)) {
          const error = response.failure
          if (
            !(
              Schema.is(InvalidToolCall)(error) ||
              (Schema.is(ChatModelUnavailable)(error) &&
                error.reason === "invalid_response")
            )
          ) {
            return yield* Effect.fail(error)
          }
          repairInstruction = [
            "The previous output did not satisfy the required tool-call contract.",
            "Call submit_answers exactly once using only the fields in its current schema.",
            "Earlier valid proposals are retained.",
            "Use null when evidence is insufficient.",
          ].join(" ")
          continue
        }
        const raw = response.success.arguments
        if (declinable.length > 0 && raw.declines !== undefined) {
          const declined = yield* Schema.decodeUnknownEffect(declineSchema)(
            raw.declines,
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(() => invalidResponse()))
          for (const item of declined) {
            if (
              getOwn(raw.answers, item.field) !== null &&
              getOwn(raw.answers, item.field) !== undefined
            )
              return yield* invalidResponse()
            const messageIndex = findEvidence(messages, {
              quote: item.quote,
              afterIndex:
                getOwn(state.accepted, item.field)?.evidence.messageIndex ?? -1,
              mode: "explicit",
            })
            if (messageIndex === undefined) return yield* invalidResponse()
            const previous = declines.find(
              (decline) => decline.field === item.field,
            )
            if (previous === undefined)
              declines.push({
                field: item.field,
                evidence: { messageIndex, quote: item.quote },
              })
          }
        }
        const wording = Schema.decodeUnknownResult(
          rawProposalSchema.fields.nextQuestion,
        )(raw.nextQuestion ?? null, { onExcessProperty: "error" })
        if (Result.isSuccess(wording) && wording.success !== null)
          proposedQuestion = wording.success
        const rejected = yield* assessAnswerProposal(registry, {
          state,
          messages,
          attempt,
          selected,
          escapedField,
          raw,
          accumulator,
        })
        if (rejected.length === 0) break
        selected = rejected.map((item) => item.field)
        if (attempt === 1) {
          for (const issue of rejected)
            yield* annotateAnswerProposal(
              definition.name,
              issue.field,
              2,
              "repair_requested",
              issue.reason,
            )
        }
        repairInstruction = [
          `Repair only these rejected fields: ${JSON.stringify(rejected)}.`,
          "Earlier valid proposals are retained and must not be resubmitted.",
          "Supply a schema-valid value with exactly one short exact eligible user quote, or null when evidence is insufficient.",
          "If the reply is ambiguous, use null and optionally phrase a focused clarification for an unresolved field.",
          "The server selects the next question from the combined result.",
        ].join(" ")
      }
      // Each non-null value was decoded exactly once by its owning schema and
      // paired with verified evidence. All other fields remain null.
      const combined: AnswerProposal<Fields> = {
        answers: accumulator.answers,
        evidence: accumulator.evidence,
        nextQuestion: proposedQuestion,
      }
      yield* runModelCallGuards(guards, {
        ...guardContext,
        call: { name: "submit_answers", arguments: combined },
      })
      yield* recordDebugEvent({ _tag: "ToolCalled", tool: "submit_answers" })
      if (
        escapedField !== undefined &&
        getAnswer(escapedField).escape !== undefined &&
        latest !== undefined &&
        canGroundAnswer(latest, getAnswer(escapedField).mode) &&
        (getAnswer(escapedField).mode !== "confirmed" ||
          getOwn(state.asked, escapedField) !== undefined)
      )
        clarifying.delete(escapedField)
      return { serverResult: combined, clarifying: [...clarifying], declines }
    })
    const extracted = resolvedStep.pipe(
      Effect.flatMap(({ serverResult, clarifying, declines }) =>
        mergeAnswerProposal(
          registry,
          state,
          messages,
          serverResult,
          clarifying,
          focus,
        ).pipe(Effect.map((result) => ({ ...result, declines }))),
      ),
      Effect.catchIf(
        (error): error is InvalidCollectStageResponse | ChatModelUnavailable =>
          Schema.is(InvalidCollectStageResponse)(error) ||
          (Schema.is(ChatModelUnavailable)(error) &&
            error.reason === "invalid_response"),
        (error) =>
          Effect.logWarning(
            "Falling back to the trusted pending question",
          ).pipe(
            Effect.annotateLogs({
              stage: definition.name,
              errorTag: error._tag,
            }),
            Effect.as({ state, wording: null, declines: [] }),
          ),
        (error) => Effect.fail(error),
      ),
      Effect.tap((turn) => recordStateAnnotations(state, turn.state)),
    )
    return Effect.gen(function* () {
      if (
        !isValidAnswerState(registry, state) ||
        !isGroundedInMessages(registry, state, messages)
      )
        return yield* invalidResponse()
      return yield* extracted
    })
  }

  const runCollection = (
    input: Parameters<
      CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment>["run"]
    >[0],
  ) =>
    runExtraction(input).pipe(
      Effect.flatMap((result) => {
        const turn = askPendingQuestion(
          registry,
          result.state,
          input.messages,
          result.wording,
        )
        return recordStateAnnotations(result.state, turn.state).pipe(
          Effect.as(turn),
        )
      }),
    )

  // SAFETY: detector-only errors and requirements arise solely in the detector
  // branch. TypeScript cannot narrow the enclosing generic parameter.
  const run = Fn.cast<
    typeof runCollection,
    CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment>["run"]
  >(runCollection)

  // SAFETY: The chat runtime calls these erased operations only after the
  // generated state schema has parsed this exact collect-stage state. The
  // public lower-level run method already requires CollectStageState<Fields>.
  const assumeParsedState = (
    state: RuntimeCollectStageState,
  ): CollectStageState<Fields> =>
    Fn.cast<RuntimeCollectStageState, CollectStageState<Fields>>(state)

  return {
    name: definition.name,
    fields: definition.fields,
    questions,
    answersSchema,
    stateSchema,
    initialState,
    guards,
    parseState: (input) =>
      Schema.decodeUnknownEffect(stateSchema)(input, {
        onExcessProperty: "error",
      }),
    isComplete: (state) => isCompleteAnswerState(registry, state),
    nextQuestion: (state) => nextQuestion(registry, state),
    markAsked: (state, field, messageIndex, text) => ({
      ...state,
      asked: Object.hasOwn(state.asked, field)
        ? state.asked
        : {
            ...state.asked,
            [field]: {
              messageIndex: messageIndexSchema.make(messageIndex),
              text: questionTextSchema.make(text),
            },
          },
    }),
    run,
    inspection: {
      fields: inspectionFields,
    },
    runtime: {
      stateFields: rawStateSchema.fields,
      initialState,
      stateSchema,
      isInitial: (state) => isInitialAnswerState(state),
      isValid: (state) => isValidState(assumeParsedState(state)),
      isGroundedInMessages: (state, messages) =>
        isGroundedInMessages(registry, assumeParsedState(state), messages),
      isComplete: (state) =>
        isCompleteAnswerState(registry, assumeParsedState(state)),
      repairSchema,
      applyRepairs: (state, messages, repairs) =>
        applyAnswerRepairs(
          registry,
          assumeParsedState(state),
          messages,
          repairs,
        ),
      extract: (input) =>
        runExtraction({
          ...input,
          state: assumeParsedState(input.state),
        }),
      ask: (state, messages, field, wording) => {
        if (!fieldNames.includes(field))
          throw new Error("Question field is not registered")
        return askPendingQuestion(
          registry,
          assumeParsedState(state),
          messages,
          wording,
          field,
        )
      },
      run: (input) =>
        run({
          state: assumeParsedState(input.state),
          messages: input.messages,
        }),
    },
  }
}

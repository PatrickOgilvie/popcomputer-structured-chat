import type { ExtractionContextContract } from "../core/extraction-context.js"
import type { AnswerDetectorContract } from "../core/answer-detector.js"
import { Effect, Layer, Ref, Result, Schema } from "effect"
import type {
  AnswerFields,
  CollectAnswers,
  CollectStage,
} from "../core/collect-stage.js"
import {
  StructuredChatModel,
  type AnyModelProfile,
  type ToolModelRequest,
} from "../core/model.js"
import type { ModelGuardTuple } from "../core/model-guard.js"
import type { StructuredTool, ToolDefinitionContract } from "../core/tool.js"
import { JsonValueSchema, type JsonValue } from "../core/json-value.js"

const scenarioQuote = Symbol(
  "@popcomputer/structured-chat/testing/ScenarioQuote",
)

const ScenarioQuoteSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_000),
)

/** One typed scenario value paired with its exact supporting user quote. */
export interface ScenarioQuote<Value> {
  readonly value: Value
  readonly quote: string
  readonly messageIndex?: number
  readonly [scenarioQuote]: true
}

interface ScenarioStep {
  readonly respond: (request: ToolModelRequest) => JsonValue
}

type QuotedAnswers<Fields extends AnswerFields> = Partial<{
  readonly [Field in keyof Fields]: ScenarioQuote<CollectAnswers<Fields>[Field]>
}>

type ScenarioNextQuestion<Fields extends AnswerFields> = {
  readonly field: keyof Fields & string
  readonly text: string
  readonly options?: ReadonlyArray<{ readonly label: string }>
}

type ReplaceableField<Fields extends AnswerFields> = {
  [Field in keyof Fields & string]: Fields[Field]["mode"] extends "confirmed"
    ? never
    : Field
}[keyof Fields & string]

type ConfirmedField<Fields extends AnswerFields> = {
  [Field in keyof Fields & string]: Fields[Field]["mode"] extends "confirmed"
    ? Field
    : never
}[keyof Fields & string]

interface ScenarioRepair {
  readonly respond: (request: ToolModelRequest) => JsonValue
}

type ToolInput<Tool> =
  Tool extends StructuredTool<
    infer _Name,
    infer InputSchema,
    infer _ServerResult,
    infer _Error,
    infer _Requirements,
    infer _ModelSchema,
    infer _Presenters,
    infer _Operation
  >
    ? Schema.Schema.Type<InputSchema>
    : never

const ScenarioExtractionPlanSchema = Schema.fromJsonString(Schema.Struct({
  stage: Schema.String,
  extracting: Schema.Array(Schema.Struct({ field: Schema.String })),
  conversation: Schema.Array(Schema.Struct({
    messageIndex: Schema.Natural,
    role: Schema.Literals(["user", "assistant"]),
    content: Schema.String,
  })),
}))

const scenarioConversation = (request: ToolModelRequest) => {
  const serialized = request.untrustedMessages.map((message, index) => {
    const prefix = `Untrusted extraction plan JSON, part ${index + 1} of ${request.untrustedMessages.length}:\n`
    return message.content.startsWith(prefix) ? message.content.slice(prefix.length) : message.content
  }).join("")
  const plan = Schema.decodeUnknownResult(ScenarioExtractionPlanSchema)(serialized)
  return Result.isSuccess(plan) ? plan.success.conversation : request.untrustedMessages.map((message, messageIndex) => ({ ...message, messageIndex }))
}

const evidenceIndex = <Value>(
  request: ToolModelRequest,
  quoted: ScenarioQuote<Value>,
): number => {
  const conversation = scenarioConversation(request)
  if (quoted.messageIndex !== undefined) {
    const message = conversation.find(message => message.messageIndex === quoted.messageIndex)

    if (
      message === undefined ||
      message.role !== "user" ||
      !message.content.includes(quoted.quote)
    ) {
      throw new Error(
        `Scenario quote does not match user message ${quoted.messageIndex}`,
      )
    }

    return quoted.messageIndex
  }

  const matches = conversation.flatMap(message =>
    message.role === "user" && message.content.includes(quoted.quote)
      ? [message.messageIndex]
      : [],
  )

  if (matches.length !== 1) {
    throw new Error(
      `Scenario quote must match exactly one user message; matched ${matches.length}`,
    )
  }

  const match = matches[0]

  if (match === undefined) {
    throw new Error("Scenario quote match disappeared")
  }

  return match
}

const quoted = <Value>(
  value: Value,
  options: { readonly quote: string; readonly messageIndex?: number },
): ScenarioQuote<Value> => {
  const base = {
    value,
    quote: Schema.decodeSync(ScenarioQuoteSchema)(options.quote),
    [scenarioQuote]: true as const,
  }

  return options.messageIndex === undefined
    ? base
    : { ...base, messageIndex: options.messageIndex }
}

const answers = <
  const Name extends string,
  const Fields extends AnswerFields,
  const Guards extends ModelGuardTuple,
  const Profile extends AnyModelProfile | undefined,
  const Detector extends AnswerDetectorContract | undefined,
  const Enrichment extends ExtractionContextContract | undefined,
>(
  stage: CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment>,
  proposed: QuotedAnswers<Fields>,
  options: {
    readonly nextQuestion?: ScenarioNextQuestion<Fields> | null
  } = {},
): ScenarioStep => ({
  respond: (request) => {
    const encodedAnswers: Record<string, JsonValue> = {}
    const input = Schema.decodeUnknownSync(Schema.Struct({ properties: Schema.Struct({
      answers: Schema.Struct({ properties: Schema.Record(Schema.String, JsonValueSchema) }),
    }) }))(request.tools.find(tool => tool.name === "submit_answers")?.inputSchema)
    const selected = Object.keys(input.properties.answers.properties)
    for (const field of selected) {
      encodedAnswers[field] = null
    }

    const evidence: Array<{
      readonly field: string
      readonly quote: string
    }> = []

    // SAFETY: proposed is a mapped type whose only keys are Fields keys.
    for (const field of Object.keys(proposed) as ReadonlyArray<
      keyof Fields & string
    >) {
      const value = proposed[field]
      const answer = stage.fields[field]

      if (value === undefined || answer === undefined) {
        continue
      }
      if (!selected.includes(field)) throw new Error(`Scenario answer field ${field} is not selected for extraction`)

      encodedAnswers[field] = Schema.decodeUnknownSync(JsonValueSchema)(
        Schema.encodeSync(answer.schema)(value.value),
      )
      evidenceIndex(request, value)
      evidence.push({
        field,
        quote: value.quote,
      })
    }

    return {
      name: "submit_answers",
      arguments: {
        answers: encodedAnswers,
        evidence,
        nextQuestion:
          options.nextQuestion === undefined || options.nextQuestion === null
            ? null
            : {
                field: options.nextQuestion.field,
                text: options.nextQuestion.text,
                options:
                  options.nextQuestion.options?.map(({ label }) => label) ?? [],
              },
      },
    }
  },
})

const call = <Tool extends ToolDefinitionContract>(
  tool: Tool,
  input: ToolInput<Tool>,
): ScenarioStep => ({
  respond: () => ({
    name: tool.name,
    arguments: Schema.decodeUnknownSync(JsonValueSchema)(
      Schema.encodeSync(tool.inputSchema)(input),
    ),
  }),
})

const replace = <
  const Name extends string,
  const Fields extends AnswerFields,
  const Guards extends ModelGuardTuple,
  const Profile extends AnyModelProfile | undefined,
  const Detector extends AnswerDetectorContract | undefined,
  const Enrichment extends ExtractionContextContract | undefined,
  const Field extends ReplaceableField<Fields>,
>(
  stage: CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment>,
  field: Field,
  value: CollectAnswers<Fields>[Field],
  options: { readonly quote: string; readonly messageIndex?: number },
): ScenarioRepair => {
  const support = quoted(value, options)
  const answer = stage.fields[field]

  if (answer === undefined) {
    throw new Error(`Unknown scenario repair field: ${String(field)}`)
  }

  return {
    respond: (request) => {
      evidenceIndex(request, support)

      return {
        _tag: "ReplaceAcceptedAnswer",
        stage: stage.name,
        field,
        value: Schema.decodeUnknownSync(JsonValueSchema)(
          Schema.encodeSync(answer.schema)(value),
        ),
        evidence: {
          quote: support.quote,
        },
      }
    },
  }
}

const reconfirm = <
  const Name extends string,
  const Fields extends AnswerFields,
  const Guards extends ModelGuardTuple,
  const Profile extends AnyModelProfile | undefined,
  const Detector extends AnswerDetectorContract | undefined,
  const Enrichment extends ExtractionContextContract | undefined,
  const Field extends ConfirmedField<Fields>,
>(
  stage: CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment>,
  field: Field,
  options: { readonly quote: string; readonly messageIndex?: number },
): ScenarioRepair => {
  const support = quoted(undefined, options)

  return {
    respond: (request) => {
      evidenceIndex(request, support)

      return {
        _tag: "ReconfirmAnswer",
        stage: stage.name,
        field,
        evidence: {
          quote: support.quote,
        },
      }
    },
  }
}

const repairs = (
  first: ScenarioRepair,
  ...remaining: ReadonlyArray<ScenarioRepair>
): ScenarioStep => ({
  respond: (request) => ({
    name: "apply_conversation_repairs",
    arguments: {
      corrections: [first, ...remaining].map((repair) =>
        repair.respond(request),
      ),
    },
  }),
})

const model = (
  first: ScenarioStep,
  ...remaining: ReadonlyArray<ScenarioStep>
): Layer.Layer<StructuredChatModel> =>
  Layer.effect(
    StructuredChatModel,
    Ref.make(0).pipe(
      Effect.map((cursor) => {
        const steps = [first, ...remaining]

        return StructuredChatModel.of({
          requestTool: (request: ToolModelRequest) =>
            Ref.getAndUpdate(cursor, (index) => index + 1).pipe(
              Effect.flatMap((index) => {
                const step = steps[index]

                return step === undefined
                  ? Effect.die(
                      new Error(
                        `Scenario model exhausted after ${steps.length} requests`,
                      ),
                    )
                  : Effect.sync(() => step.respond(request))
              }),
            ),
        })
      }),
    ),
  )

/** Typed constructors for concise valid transcript scenarios. */
export const Scenario = {
  quoted,
  answers,
  call,
  replace,
  reconfirm,
  repairs,
  model,
} as const

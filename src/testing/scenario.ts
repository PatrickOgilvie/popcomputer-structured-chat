import { Effect, Layer, Ref, Schema } from "effect"
import type {
  AnswerFields,
  CollectAnswers,
  CollectStage,
} from "../core/collect-stage.js"
import {
  StructuredChatModel,
  type ToolModelRequest,
} from "../core/model.js"
import type { ModelGuardTuple } from "../core/model-guard.js"
import type {
  StructuredTool,
  ToolDefinitionContract,
} from "../core/tool.js"
import {
  JsonValueSchema,
  type JsonValue,
} from "../core/json-value.js"

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
  readonly [Field in keyof Fields]: ScenarioQuote<
    CollectAnswers<Fields>[Field]
  >
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

type ToolInput<Tool> = Tool extends StructuredTool<
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

const evidenceIndex = <Value>(
  request: ToolModelRequest,
  quoted: ScenarioQuote<Value>,
): number => {
  if (quoted.messageIndex !== undefined) {
    const message = request.untrustedMessages[quoted.messageIndex]
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

  const matches = request.untrustedMessages.flatMap((message, index) =>
    message.role === "user" && message.content.includes(quoted.quote)
      ? [index]
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
>(
  stage: CollectStage<Name, Fields, Guards>,
  proposed: QuotedAnswers<Fields>,
  options: {
    readonly nextQuestion?: ScenarioNextQuestion<Fields> | null
  } = {},
): ScenarioStep => ({
  respond: (request) => {
    const encodedAnswers: Record<string, JsonValue> = {}
    for (const field of Object.keys(stage.fields)) {
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
          options.nextQuestion === undefined ||
          options.nextQuestion === null
            ? null
            : {
                field: options.nextQuestion.field,
                text: options.nextQuestion.text,
                options:
                  options.nextQuestion.options?.map(
                    ({ label }) => label,
                  ) ?? [],
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
  const Field extends ReplaceableField<Fields>,
>(
  stage: CollectStage<Name, Fields, Guards>,
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
  const Field extends ConfirmedField<Fields>,
>(
  stage: CollectStage<Name, Fields, Guards>,
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

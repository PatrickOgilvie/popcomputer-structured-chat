import { cast, Effect, Schema } from "effect"
import { AnswerModeSchema } from "./answer.js"
import {
  ChatNameSchema,
  ChatVersionSchema,
  type ChatDefinition,
  type ChatStageTuple,
  type ChatState,
} from "./chat.js"
import {
  readCollectStageInspection,
} from "./collect-stage.js"
import { JsonValueSchema } from "./json-value.js"
import type { QuestionDefinitionContract } from "./question.js"
import {
  readCommandStageRuntime,
  readToolStageRuntime,
  ToolStageAfterExecutionSchema,
} from "./stage.js"
import { StageNameSchema } from "./stage-name.js"
import { ToolNameSchema } from "./tool.js"

const DebugIndexSchema = Schema.Natural

const DebugIssuedQuestionSchema = Schema.Struct({
  messageIndex: DebugIndexSchema,
  text: Schema.String,
})

const DebugAnswerEvidenceSchema = Schema.Struct({
  messageIndex: DebugIndexSchema,
  quote: Schema.String,
})

const DebugQuestionSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("FixedQuestion"),
    text: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("AdaptiveQuestion"),
    goal: Schema.String,
    fallback: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("AdaptiveChoiceQuestion"),
    prompt: Schema.String,
    minimumOptions: Schema.Natural,
    maximumOptions: Schema.Natural,
    fallbackOptions: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ChoiceQuestion"),
    text: Schema.String,
    options: Schema.Array(
      Schema.Struct({
        label: Schema.String,
      }),
    ),
  }),
])

const DebugFieldStateSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Missing"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Asked"),
    issuedQuestion: DebugIssuedQuestionSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Accepted"),
    value: JsonValueSchema,
    evidence: Schema.NullOr(DebugAnswerEvidenceSchema),
    issuedQuestion: Schema.NullOr(DebugIssuedQuestionSchema),
  }),
])

const DebugFieldSchema = Schema.Struct({
  field: Schema.String,
  mode: AnswerModeSchema,
  description: Schema.String,
  question: DebugQuestionSchema,
  state: DebugFieldStateSchema,
})

const DebugStageStatusSchema = Schema.Literals([
  "complete",
  "current",
  "upcoming",
])

const DebugStageBaseFields = {
  index: DebugIndexSchema,
  name: StageNameSchema,
  status: DebugStageStatusSchema,
  repairPending: Schema.Boolean,
}

const DebugStageSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("CollectStage"),
    ...DebugStageBaseFields,
    satisfiedFields: Schema.Natural,
    totalFields: Schema.Natural,
    fields: Schema.Array(DebugFieldSchema),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ToolStage"),
    ...DebugStageBaseFields,
    tools: Schema.Array(ToolNameSchema),
    afterExecution: ToolStageAfterExecutionSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("CommandStage"),
    ...DebugStageBaseFields,
    command: ToolNameSchema,
  }),
])

/** Runtime schema for one JSON-safe structured-chat debug snapshot. */
export const StructuredChatDebugSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chat: Schema.Struct({
    name: ChatNameSchema,
    version: ChatVersionSchema,
  }),
  status: Schema.Literals(["active", "complete"]),
  currentStage: Schema.Struct({
    index: DebugIndexSchema,
    name: StageNameSchema,
    kind: Schema.Literals(["collect", "tool", "command"]),
  }),
  stages: Schema.Array(DebugStageSchema),
})

/** JSON-safe read model rendered by a structured-chat debug inspector. */
export type StructuredChatDebugSnapshot = Schema.Schema.Type<
  typeof StructuredChatDebugSnapshotSchema
>

/** Controls sensitive provenance included in a structured-chat debug snapshot. */
export interface InspectChatStateOptions {
  readonly evidence?: "include" | "omit"
}

const InspectChatStateOptionsSchema = Schema.Struct({
  evidence: Schema.optionalKey(Schema.Literals(["include", "omit"])),
})

const InvalidChatDebugProjectionReasonSchema = Schema.Literals([
  "invalid_options",
  "invalid_state",
  "invalid_answer_value",
  "invalid_snapshot",
])

/** A chat state or answer could not be projected into safe debug JSON. */
export class InvalidChatDebugProjection extends Schema.TaggedError<InvalidChatDebugProjection>()(
  "InvalidChatDebugProjection",
  { reason: InvalidChatDebugProjectionReasonSchema },
) {}

type InvalidChatDebugProjectionReason = Schema.Schema.Type<
  typeof InvalidChatDebugProjectionReasonSchema
>

type DebugQuestion = Schema.Schema.Type<typeof DebugQuestionSchema>
type DebugStage = StructuredChatDebugSnapshot["stages"][number]
type DebugStageStatus = DebugStage["status"]

interface RuntimeAcceptedAnswer {
  readonly value: unknown
  readonly evidence: {
    readonly messageIndex: number
    readonly quote: string
  }
}

interface RuntimeCollectStageState {
  readonly accepted: Readonly<
    Partial<Record<string, RuntimeAcceptedAnswer>>
  >
  readonly asked: Readonly<
    Partial<
      Record<
        string,
        {
          readonly messageIndex: number
          readonly text: string
        }
      >
    >
  >
}

interface RuntimeChatState {
  readonly stage: number
  readonly status: "active" | "complete"
  readonly stages: Readonly<
    Partial<Record<string, RuntimeCollectStageState>>
  >
  readonly repair?: {
    readonly pendingStages: ReadonlyArray<number>
  }
}

const invalidProjection = (
  reason: InvalidChatDebugProjectionReason,
): InvalidChatDebugProjection => new InvalidChatDebugProjection({ reason })

const projectQuestion = (
  question: QuestionDefinitionContract,
): DebugQuestion => {
  switch (question._tag) {
    case "FixedQuestion":
      return { _tag: question._tag, text: question.text }
    case "AdaptiveQuestion":
      return {
        _tag: question._tag,
        goal: question.goal,
        fallback: question.fallback,
      }
    case "AdaptiveChoiceQuestion":
      return {
        _tag: question._tag,
        prompt: question.prompt,
        minimumOptions: question.minimumOptions,
        maximumOptions: question.maximumOptions,
        fallbackOptions: question.fallbackOptions,
      }
    case "ChoiceQuestion":
      return {
        _tag: question._tag,
        text: question.text,
        options: question.options.map(({ label }) => ({ label })),
      }
  }
}

const stageKind = (
  stage: ChatStageTuple[number],
): StructuredChatDebugSnapshot["currentStage"]["kind"] => {
  switch (stage._tag) {
    case "CollectStage":
      return "collect"
    case "ToolStage":
      return "tool"
    case "CommandStage":
      return "command"
  }
}

const stageStatus = (
  state: RuntimeChatState,
  index: number,
): DebugStageStatus => {
  if (index === state.stage) {
    return state.status === "complete" ? "complete" : "current"
  }
  if (index < state.stage) {
    return "complete"
  }
  return "upcoming"
}

/**
 * Project one trusted chat definition and Type-side state into browser-safe
 * inspector data without exposing choice values or raw Effect schemas.
 */
export const inspectChatState = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: ChatDefinition<Name, Version, Stages>,
  state: ChatState<Name, Version, Stages>,
  options: InspectChatStateOptions = {},
): Effect.Effect<
  StructuredChatDebugSnapshot,
  InvalidChatDebugProjection
> =>
  Effect.gen(function* () {
    const parsedOptions = yield* Schema.decodeUnknownEffect(
      InspectChatStateOptionsSchema,
    )(options, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => invalidProjection("invalid_options")),
    )
    const parsedState = yield* Schema.decodeUnknownEffect(
      Schema.toType(chat.stateSchema),
    )(state, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => invalidProjection("invalid_state")),
    )
    // SAFETY: this definition's exact state schema parsed the envelope and all
    // named collect-stage states immediately above; only tuple correlations are
    // erased for definition-ordered read-only projection.
    const runtimeState = cast<typeof parsedState, RuntimeChatState>(parsedState)
    const currentStage = chat.stages[runtimeState.stage]
    if (currentStage === undefined) {
      return yield* Effect.fail(invalidProjection("invalid_state"))
    }

    const stages: Array<DebugStage> = []
    for (const [index, stage] of chat.stages.entries()) {
      const repairPending =
        runtimeState.repair?.pendingStages.includes(index) ?? false
      if (stage._tag === "ToolStage") {
        const runtime = readToolStageRuntime(stage)
        stages.push({
          _tag: "ToolStage",
          index,
          name: stage.name,
          status: stageStatus(runtimeState, index),
          repairPending,
          tools: runtime.toolNames,
          afterExecution: runtime.afterExecution,
        })
        continue
      }
      if (stage._tag === "CommandStage") {
        stages.push({
          _tag: "CommandStage",
          index,
          name: stage.name,
          status: stageStatus(runtimeState, index),
          repairPending,
          command: readCommandStageRuntime(stage).commandName,
        })
        continue
      }

      const collectState = runtimeState.stages[stage.name]
      if (collectState === undefined) {
        return yield* Effect.fail(invalidProjection("invalid_state"))
      }
      const inspection = readCollectStageInspection(stage)
      const fields: Array<
        Extract<DebugStage, { readonly _tag: "CollectStage" }>["fields"][number]
      > = []
      let satisfiedFields = 0

      for (const field of inspection.fields) {
        const accepted = collectState.accepted[field.field]
        const issuedQuestion = collectState.asked[field.field]
        const fieldBase = {
          field: field.field,
          mode: field.mode,
          description: field.description,
          question: projectQuestion(field.question),
        }
        if (accepted === undefined) {
          fields.push(
            issuedQuestion === undefined
              ? { ...fieldBase, state: { _tag: "Missing" } }
              : {
                  ...fieldBase,
                  state: {
                    _tag: "Asked",
                    issuedQuestion,
                  },
                },
          )
          continue
        }

        const encoded = yield* field.encodeValue(accepted.value).pipe(
          Effect.mapError(() =>
            invalidProjection("invalid_answer_value"),
          ),
        )
        const value = yield* Schema.decodeUnknownEffect(JsonValueSchema)(
          encoded,
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(() =>
            invalidProjection("invalid_answer_value"),
          ),
        )
        satisfiedFields += 1
        fields.push({
          ...fieldBase,
          state: {
            _tag: "Accepted",
            value,
            evidence:
              (parsedOptions.evidence ?? "include") === "include"
                ? accepted.evidence
                : null,
            issuedQuestion: issuedQuestion ?? null,
          },
        })
      }

      stages.push({
        _tag: "CollectStage",
        index,
        name: stage.name,
        status: stageStatus(runtimeState, index),
        repairPending,
        satisfiedFields,
        totalFields: inspection.fields.length,
        fields,
      })
    }

    return yield* Schema.decodeUnknownEffect(
      StructuredChatDebugSnapshotSchema,
    )(
      {
        schemaVersion: 1,
        chat: { name: chat.name, version: chat.version },
        status: runtimeState.status,
        currentStage: {
          index: runtimeState.stage,
          name: currentStage.name,
          kind: stageKind(currentStage),
        },
        stages,
      },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(() => invalidProjection("invalid_snapshot")),
    )
  })

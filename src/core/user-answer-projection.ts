import { Effect, Schema } from "effect"
import {
  inspectChatAnswers,
  type InspectChatAnswersInput,
  type TrustedChatAnswerState,
} from "./chat-answer-inspection.js"
import { ChatNameSchema, ChatVersionSchema } from "./chat-identity.js"
import {
  CollectAnswerFieldNameSchema,
  type CollectStageDefinitionContract,
} from "./collect-stage.js"
import { JsonValueSchema } from "./json-value.js"
import { StageNameSchema } from "./stage-name.js"

/** Safe reason that a user-answer projection could not be constructed. */
export const InvalidChatUserAnswerProjectionReasonSchema = Schema.Literals([
  "invalid_state",
  "invalid_answer_value",
  "invalid_snapshot",
])

/** A trusted chat state could not produce a display-safe answer snapshot. */
export class InvalidChatUserAnswerProjection extends Schema.TaggedError<InvalidChatUserAnswerProjection>()(
  "InvalidChatUserAnswerProjection",
  { reason: InvalidChatUserAnswerProjectionReasonSchema },
) {}

const UserAnswerLabelSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
)

const StructuredChatUserAnswerStateSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Missing"),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Accepted"),
    value: JsonValueSchema,
  }),
])

const StructuredChatUserAnswerFieldSchema = Schema.Struct({
  key: CollectAnswerFieldNameSchema,
  label: UserAnswerLabelSchema,
  state: StructuredChatUserAnswerStateSchema,
})

const StructuredChatUserAnswerSectionSchema = Schema.Struct({
  key: StageNameSchema,
  label: UserAnswerLabelSchema,
  fields: Schema.NonEmptyArray(
    StructuredChatUserAnswerFieldSchema,
  ).check(Schema.isMaxLength(20)),
})

/** Runtime schema for one complete display-safe user-answer snapshot. */
export const StructuredChatUserAnswerSnapshotSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  chat: Schema.Struct({
    name: ChatNameSchema,
    version: ChatVersionSchema,
  }),
  sections: Schema.Array(StructuredChatUserAnswerSectionSchema),
})

/** Missing or JSON-encoded accepted state exposed to browser consumers. */
export type StructuredChatUserAnswerState = Schema.Schema.Type<
  typeof StructuredChatUserAnswerStateSchema
>

/** One explicitly disclosed answer field in a public snapshot. */
export type StructuredChatUserAnswerField = Schema.Schema.Type<
  typeof StructuredChatUserAnswerFieldSchema
>

/** One non-empty collect-stage section in a public snapshot. */
export type StructuredChatUserAnswerSection = Schema.Schema.Type<
  typeof StructuredChatUserAnswerSectionSchema
>

/** Complete display-safe answers derived from one trusted chat state. */
export type StructuredChatUserAnswerSnapshot = Schema.Schema.Type<
  typeof StructuredChatUserAnswerSnapshotSchema
>

type UserAnswerProjectionStage =
  | CollectStageDefinitionContract
  | {
      readonly _tag: "ToolStage" | "CommandStage"
      readonly name: string
    }

/** Trusted definition and state used to construct one public answer snapshot. */
export interface ProjectUserAnswersInput {
  readonly definition: {
    readonly name: string
    readonly version: number
    readonly stages: ReadonlyArray<UserAnswerProjectionStage>
  }
  readonly state: TrustedChatAnswerState
}

const invalidProjection = (
  reason:
    | "invalid_state"
    | "invalid_answer_value"
    | "invalid_snapshot",
): InvalidChatUserAnswerProjection =>
  new InvalidChatUserAnswerProjection({ reason })

const defaultLabel = (identifier: string): string => {
  const words = identifier
    .split(/[._-]+/)
    .filter((word) => word.length > 0)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")

  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** Project explicitly disclosed answers into a complete browser-safe snapshot. */
export const projectUserAnswers = (
  input: ProjectUserAnswersInput,
): Effect.Effect<
  StructuredChatUserAnswerSnapshot,
  InvalidChatUserAnswerProjection
> =>
  Effect.gen(function* () {
    const inspected = yield* inspectChatAnswers({
      definition: input.definition,
      state: input.state,
      include: ({ userPresentation }) =>
        userPresentation !== undefined,
    } satisfies InspectChatAnswersInput).pipe(
      Effect.mapError(({ reason }) => invalidProjection(reason)),
    )

    const sections: Array<StructuredChatUserAnswerSection> = []
    let visibleFieldCount = 0
    let acceptedVisibleFieldCount = 0
    for (const section of inspected.sections) {
      if (section.fields.length === 0) {
        continue
      }

      const fields: Array<StructuredChatUserAnswerField> = []
      for (const field of section.fields) {
        visibleFieldCount += 1
        if (field.state._tag === "Accepted") {
          acceptedVisibleFieldCount += 1
          fields.push({
            key: field.field,
            label:
              field.userPresentation?.label ?? defaultLabel(field.field),
            state: {
              _tag: "Accepted",
              value: field.state.value,
            },
          })
          continue
        }

        fields.push({
          key: field.field,
          label:
            field.userPresentation?.label ?? defaultLabel(field.field),
          state: { _tag: "Missing" },
        })
      }

      const [firstField, ...remainingFields] = fields
      if (firstField === undefined) {
        continue
      }
      sections.push({
        key: section.stage,
        label: defaultLabel(section.stage),
        fields: [firstField, ...remainingFields],
      })
    }

    yield* Effect.annotateCurrentSpan({
      chat: inspected.chat.name,
      version: inspected.chat.version,
      visibleFieldCount,
      acceptedVisibleFieldCount,
    })

    return yield* Schema.decodeUnknownEffect(
      StructuredChatUserAnswerSnapshotSchema,
    )(
      {
        schemaVersion: 1,
        chat: inspected.chat,
        sections,
      },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(() => invalidProjection("invalid_snapshot")),
    )
  }).pipe(
    Effect.withSpan("popcomputer.structured_chat.user_answers.project"),
  )

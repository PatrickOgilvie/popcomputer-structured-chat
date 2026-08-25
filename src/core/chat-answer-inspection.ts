import { Effect, Schema } from "effect"
import type { AnswerMode } from "./answer.js"
import {
  readCollectStageInspection,
  type AcceptedAnswerEvidence,
  type CollectStageDefinitionContract,
  type CollectStageInspectionField,
  type IssuedCollectQuestion,
} from "./collect-stage.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"
import type { QuestionDefinitionContract } from "./question.js"

/** @internal Safe failure reason produced by trusted answer inspection. */
export const InvalidChatAnswerInspectionReasonSchema = Schema.Literals([
  "invalid_state",
  "invalid_answer_value",
])

/** @internal Trusted chat state could not be inspected as JSON-safe answers. */
export class InvalidChatAnswerInspection extends Schema.TaggedError<InvalidChatAnswerInspection>()(
  "InvalidChatAnswerInspection",
  { reason: InvalidChatAnswerInspectionReasonSchema },
) {}

interface TrustedAcceptedAnswer {
  readonly value: unknown
  readonly evidence: AcceptedAnswerEvidence
}

interface TrustedCollectStageState {
  readonly accepted: Readonly<
    Partial<Record<string, TrustedAcceptedAnswer>>
  >
  readonly asked: Readonly<
    Partial<Record<string, IssuedCollectQuestion>>
  >
}

/** @internal Structural answer state accepted only after definition parsing. */
export interface TrustedChatAnswerState {
  readonly stages: Readonly<
    Partial<Record<string, TrustedCollectStageState>>
  >
}

type ChatAnswerInspectionStage =
  | CollectStageDefinitionContract
  | {
      readonly _tag: "ToolStage" | "CommandStage"
      readonly name: string
    }

/** @internal One JSON-safe field produced by definition-ordered inspection. */
export interface InspectedAnswerField {
  readonly field: string
  readonly mode: AnswerMode
  readonly description: string
  readonly question: QuestionDefinitionContract
  readonly userPresentation:
    | { readonly label?: string }
    | undefined
  readonly state:
    | { readonly _tag: "Missing" }
    | {
        readonly _tag: "Asked"
        readonly issuedQuestion: IssuedCollectQuestion
      }
    | {
        readonly _tag: "Accepted"
        readonly value: JsonValue
        readonly evidence: AcceptedAnswerEvidence
        readonly issuedQuestion: IssuedCollectQuestion | undefined
      }
}

/** @internal One collect stage and its included inspected answer fields. */
export interface InspectedAnswerSection {
  readonly stage: string
  readonly fields: ReadonlyArray<InspectedAnswerField>
}

/** @internal Projection-neutral, JSON-safe answer inspection result. */
export interface InspectedChatAnswers {
  readonly chat: {
    readonly name: string
    readonly version: number
  }
  readonly sections: ReadonlyArray<InspectedAnswerSection>
}

/** @internal Input accepted by trusted definition/state answer traversal. */
export interface InspectChatAnswersInput {
  readonly definition: {
    readonly name: string
    readonly version: number
    readonly stages: ReadonlyArray<ChatAnswerInspectionStage>
  }
  readonly state: TrustedChatAnswerState
  readonly include: (field: CollectStageInspectionField) => boolean
}

const invalidInspection = (
  reason: "invalid_state" | "invalid_answer_value",
): InvalidChatAnswerInspection =>
  new InvalidChatAnswerInspection({ reason })

const hasOwn = <Owner extends object>(
  value: Owner,
  key: PropertyKey,
): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

/**
 * @internal Traverse trusted collect state in declaration order and encode
 * included accepted values for projection-neutral consumers.
 */
export const inspectChatAnswers = (
  input: InspectChatAnswersInput,
): Effect.Effect<InspectedChatAnswers, InvalidChatAnswerInspection> =>
  Effect.gen(function* () {
    const sections: Array<InspectedAnswerSection> = []

    for (const stage of input.definition.stages) {
      if (stage._tag !== "CollectStage") {
        continue
      }
      if (!hasOwn(input.state.stages, stage.name)) {
        return yield* Effect.fail(invalidInspection("invalid_state"))
      }
      const collectState = input.state.stages[stage.name]
      if (collectState === undefined) {
        return yield* Effect.fail(invalidInspection("invalid_state"))
      }

      const fields: Array<InspectedAnswerField> = []
      for (const field of readCollectStageInspection(stage).fields) {
        // Disclosure filtering deliberately precedes every state lookup and
        // codec invocation so hidden values cannot leak or break projection.
        if (!input.include(field)) {
          continue
        }

        const accepted = hasOwn(collectState.accepted, field.field)
          ? collectState.accepted[field.field]
          : undefined
        const issuedQuestion = hasOwn(collectState.asked, field.field)
          ? collectState.asked[field.field]
          : undefined
        const fieldBase = {
          field: field.field,
          mode: field.mode,
          description: field.description,
          question: field.question,
          userPresentation: field.userPresentation,
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
            invalidInspection("invalid_answer_value"),
          ),
        )
        const value = yield* Schema.decodeUnknownEffect(JsonValueSchema)(
          encoded,
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(() =>
            invalidInspection("invalid_answer_value"),
          ),
        )
        fields.push({
          ...fieldBase,
          state: {
            _tag: "Accepted",
            value,
            evidence: accepted.evidence,
            issuedQuestion,
          },
        })
      }

      sections.push({ stage: stage.name, fields })
    }

    return {
      chat: {
        name: input.definition.name,
        version: input.definition.version,
      },
      sections,
    }
  })

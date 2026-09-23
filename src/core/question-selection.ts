import { Effect, Function as Fn, Schema } from "effect"
import type { IssuedQuestionContext, AnswerFields } from "./answer-collection.js"
import type { ConversationMessage } from "./conversation-message.js"
import { structuredDefinition, type StructuredDefinition } from "./definition.js"
import type { TrustedInstruction } from "./model.js"
import type { QuestionDefinitionContract } from "./question.js"
import type { ModelToolDefinition } from "./tool.js"
import type { ToolTuple } from "./tool-set.js"
import type { SelectionAcceptedAnswer } from "./tool-selection.js"

/** Closed question registry and the answers required for interview completion. */
export interface InterviewBank {
  readonly required: AnswerFields
  readonly optional: AnswerFields
  readonly tools?: readonly [] | ToolTuple
}

/** The exact answer definitions registered by an interview. */
export type InterviewFields<B extends InterviewBank> = B["required"] & B["optional"]
/** A registered interview field, preserving literal names. */
export type InterviewField<B extends InterviewBank> = keyof InterviewFields<B> & string

/** Query capabilities registered with an interview, preserving literal names. */
export type InterviewTools<B extends InterviewBank> = B extends { readonly tools: infer T extends readonly [] | ToolTuple } ? T : readonly []
export type InterviewToolName<B extends InterviewBank> = InterviewTools<B>[number]["name"]

/** An offered question, query tool, or runtime-authorized completion. */
export type QuestionTarget<K extends string = string, T extends string = string> =
  | { readonly _tag: "Question"; readonly field: K }
  | { readonly _tag: "Tool"; readonly name: T }
  | { readonly _tag: "Finish" }

/** Reason for selecting the next conversational action. */
export type InterviewTrigger = "direct" | "stage_entered" | "user_reply" | "after_repair"

/** Eligibility and question descriptions, without validators or executors. */
export type QuestionCandidate<K extends string = string, T extends string = string> =
  | {
      readonly target: { readonly _tag: "Question"; readonly field: K }
      readonly requirement: "required" | "optional"
      readonly purpose: "collect" | "clarify"
      readonly description: string
      readonly question: QuestionDefinitionContract
    }
  | { readonly target: { readonly _tag: "Tool"; readonly name: T }; readonly description: string; readonly inputSchema: ModelToolDefinition["inputSchema"] }
  | { readonly target: { readonly _tag: "Finish" }; readonly description: string }

/** Complete retained conversation and post-validation progress supplied to a selector. */
export interface QuestionSelectionContext<K extends string = string, T extends string = string> {
  readonly stage: string
  readonly trigger: InterviewTrigger
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly conversation: ReadonlyArray<{ readonly messageIndex: number; readonly message: ConversationMessage }>
  readonly accepted: ReadonlyArray<SelectionAcceptedAnswer>
  readonly focus:
    | { readonly _tag: "Issued"; readonly field: K; readonly question: IssuedQuestionContext }
    | { readonly _tag: "None" }
  readonly candidates: ReadonlyArray<QuestionCandidate<K, T>>
}

/** Boundary codec for selection; offered-target membership is checked separately. */
export const QuestionSelectionSchema = Schema.TaggedUnion({
  Selected: { target: Schema.TaggedUnion({ Question: { field: Schema.String }, Tool: { name: Schema.String }, Finish: {} }) },
  Uncertain: {},
  NotApplicable: { reason: Schema.Literals(["context_budget_exceeded", "candidate_budget_exceeded", "disabled", "provider_unavailable"]) },
})

/** Selection proposes an action; it never accepts values or grants completion authority. */
export type QuestionSelection<K extends string = string, T extends string = string> =
  | { readonly _tag: "Selected"; readonly target: QuestionTarget<K, T> }
  | Exclude<typeof QuestionSelectionSchema.Type, { readonly _tag: "Selected" }>

/** A selector returned a malformed or unavailable action. */
export class InvalidQuestionSelection extends Schema.TaggedError<InvalidQuestionSelection>()("InvalidQuestionSelection", {
  reason: Schema.Literals(["invalid_shape", "target_not_offered"]),
}) {}

/** Accepted values could not be safely projected for question selection. */
export class InvalidQuestionPlanningContext extends Schema.TaggedError<InvalidQuestionPlanningContext>()("InvalidQuestionPlanningContext", {
  reason: Schema.Literals(["invalid_answer_value", "invalid_context"]),
}) {}

const selectorRuntime = Symbol("QuestionSelectorRuntime")

/** Authentic selector with erased Effect dependencies retained behind its runtime symbol. */
export interface QuestionSelectorContract extends StructuredDefinition<"question_selector"> {
  readonly bank: InterviewBank
  readonly [selectorRuntime]: (context: QuestionSelectionContext) => Effect.Effect<QuestionSelection, unknown, unknown>
}

/** Effect-native question selector bound to one closed bank.
 * @template B, E, R Registered questions, expected failures, and required services.
 */
export interface QuestionSelector<B extends InterviewBank, E, R> extends QuestionSelectorContract {
  readonly bank: B
  readonly select: (context: QuestionSelectionContext<InterviewField<B>, InterviewToolName<B>>) => Effect.Effect<QuestionSelection<InterviewField<B>, InterviewToolName<B>>, E, R>
}

/** Expected failures introduced by a selector. */
export type QuestionSelectorError<S> = S extends QuestionSelector<infer _B, infer E, infer _R> ? E : never
/** Effect services introduced by a selector. */
export type QuestionSelectorRequirements<S> = S extends QuestionSelector<infer _B, infer _E, infer R> ? R : never

/** Bind an application decision function to an interview's declared questions.
 * @template B, E, R Registered questions, expected failures, and required services.
 */
export const defineQuestionSelector = <const B extends InterviewBank, E, R>(
  bank: B,
  select: (context: QuestionSelectionContext<InterviewField<B>, InterviewToolName<B>>) => Effect.Effect<QuestionSelection<InterviewField<B>, InterviewToolName<B>>, E, R>,
): QuestionSelector<B, E, R> => structuredDefinition("question_selector")({
  bank,
  select,
  // SAFETY: the owning stage checks the bank identity before constructing this context.
  [selectorRuntime]: Fn.cast<typeof select, QuestionSelectorContract[typeof selectorRuntime]>(select),
})

/** @internal Parse a proposal and enforce the exact candidate set used for that decision. */
export const parseQuestionSelection = (value: QuestionSelection, context: QuestionSelectionContext) =>
  Schema.decodeUnknownEffect(QuestionSelectionSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new InvalidQuestionSelection({ reason: "invalid_shape" })),
    Effect.flatMap((decision): Effect.Effect<QuestionSelection, InvalidQuestionSelection> => {
      if (decision._tag !== "Selected") return Effect.succeed(decision)
      const target = decision.target
      const offered = context.candidates.some(candidate => candidate.target._tag === "Finish"
        ? target._tag === "Finish"
        : candidate.target._tag === "Tool"
          ? target._tag === "Tool" && candidate.target.name === target.name
          : target._tag === "Question" && candidate.target.field === target.field)
      return offered ? Effect.succeed(decision) : Effect.fail(new InvalidQuestionSelection({ reason: "target_not_offered" }))
    }),
  )

/** @internal Run and parse a bound selector at its capability boundary. */
export const selectQuestion = Effect.fn("structured_chat.interview.select")(
  function* (selector: QuestionSelectorContract, context: QuestionSelectionContext) {
    return yield* parseQuestionSelection(yield* selector[selectorRuntime](context), context)
  },
)

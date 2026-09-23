import { Effect, Function as Fn, Option, Schema } from "effect"
import {
  createAnswerCollection, sameAnswerFields, withAnswerStageRuntime,
  type AcceptedAnswerEvidence, type AnswerFields, type AnswerStageDefinitionContract,
  type CollectAnswers, type CollectStage, type CollectStagePrompt, type CollectStageState,
  type DefineCollectStageInput, type CollectStageRuntime, type CollectQuestionPolicy, type RuntimeCollectStageState,
} from "./answer-collection.js"
import { canGroundAnswer, type ConversationMessage } from "./conversation-message.js"
import { structuredDefinition } from "./definition.js"
import type { AnswerDetectorContract } from "./answer-detector.js"
import type { ExtractionContextContract } from "./extraction-context.js"
import {
  Instruction, type AnyModelProfile, type ModelProfileInput,
} from "./model.js"
import type { ModelGuardTuple } from "./model-guard.js"
import { JsonValueSchema } from "./json-value.js"
import { planInterviewQuestion } from "./question-planning.js"
import {
  InvalidQuestionPlanningContext, InvalidQuestionSelection,
  type InterviewBank, type InterviewField, type InterviewFields, type InterviewTrigger, type InterviewTools,
  type QuestionCandidate, type QuestionSelectionContext, type QuestionSelectorContract,
  type QuestionSelectorError, type QuestionSelectorRequirements,
} from "./question-selection.js"
import { recordDebugEvent } from "./debug-trace.js"
import type { SelectionAcceptedAnswer } from "./tool-selection.js"
import type { ToolTuple, ToolSetExecution, ToolSetError, ToolSetRequirements } from "./tool-set.js"
import type { ToolInputsContract, ToolInputsError, ToolInputsRequirements } from "./tool-inputs.js"
import type { ToolClarification } from "./tool-planning.js"
import type { FixedQuestion, AdaptiveQuestion } from "./question.js"
import { ToolContext } from "./tool-context.js"
import { createInterviewTools } from "./interview-tools.js"

/** Required answers are guaranteed only after completion; optional values may be absent. */
export type InterviewAnswers<B extends InterviewBank> = CollectAnswers<B["required"]> & Partial<CollectAnswers<B["optional"]>>

/** Persisted question focus and explicit completion, independent of required-answer readiness. */
export type InterviewPhase<K extends string> =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "AwaitingReply"; readonly field: K; readonly issuedMessageIndex: number }
  | { readonly _tag: "Complete" }

/** Grounded progress for one interview, including optional declines. */
export interface InterviewState<B extends InterviewBank> extends CollectStageState<InterviewFields<B>> {
  readonly declined: Readonly<Partial<Record<keyof B["optional"] & string, AcceptedAnswerEvidence>>>
  readonly phase: InterviewPhase<InterviewField<B>>
}

/** Execution union of the interview's registered queries. */
export type InterviewToolExecution<B extends InterviewBank> = InterviewTools<B> extends ToolTuple ? ToolSetExecution<InterviewTools<B>> : never

type InterviewToolTurn<B extends InterviewBank> = InterviewTools<B> extends ToolTuple ? {
  readonly complete: false
  readonly state: InterviewState<B>
  readonly question: undefined
  readonly action: { readonly _tag: "ToolResult"; readonly result: InterviewToolExecution<B> } | ToolClarification
} : never

/** A prepared question, query result, clarification, or completed interview. Session commit establishes issuance. */
export type InterviewTurn<B extends InterviewBank> =
  | InterviewToolTurn<B>
  | { readonly complete: false; readonly state: InterviewState<B>; readonly question: CollectStagePrompt<InterviewFields<B>> }
  | { readonly complete: true; readonly state: InterviewState<B>; readonly question: undefined; readonly answers: InterviewAnswers<B> }

/** Runtime-owned context from other answer stages; transcript indices remain invocation-local. */
export interface InterviewPlanningFrame {
  readonly trigger: InterviewTrigger
  readonly accepted: ReadonlyArray<SelectionAcceptedAnswer>
}

/** Minimum sealed interview definition consumed by chat and trusted projections. */
export interface InterviewStageDefinitionContract extends AnswerStageDefinitionContract {
  readonly _tag: "InterviewStage"
  readonly required: AnswerFields
  readonly optional: AnswerFields
  readonly tools: readonly [] | ToolTuple
}

type Collection<Name extends string, B extends InterviewBank, G extends ModelGuardTuple, P extends AnyModelProfile | undefined, D extends AnswerDetectorContract | undefined, C extends ExtractionContextContract | undefined> = CollectStage<Name, InterviewFields<B>, G, P, D, C>

/** Input for a conversation-aware interview using ordinary answer definitions. */
export type DefineInterviewStageInput<Name extends string, Required extends AnswerFields, Optional extends AnswerFields, G extends ModelGuardTuple, P extends AnyModelProfile | undefined, D extends AnswerDetectorContract | undefined, C extends ExtractionContextContract | undefined, S extends QuestionSelectorContract | undefined, T extends readonly [] | ToolTuple = readonly [], I extends ToolInputsContract | undefined = undefined> = {
  readonly name: Name
  readonly required: Required
  // Open records are checked for overlap at construction; closed maps also get a static check.
  readonly optional: Optional & (string extends keyof Required | keyof Optional
    ? unknown
    : { readonly [K in Extract<keyof Required, keyof Optional>]: never })
  readonly instructions: readonly [string, ...ReadonlyArray<string>]
  readonly questions?: CollectQuestionPolicy
  readonly guards?: G
  readonly detector?: D
  readonly context?: C
  readonly selection?: S
  readonly tools?: T
  readonly inputs?: I
  readonly clarification?: FixedQuestion | AdaptiveQuestion
} & ModelProfileInput<P>

/** A stage whose next question or query follows the conversation while completion remains runtime-owned.
 * @template Name, B, G, P, D, C, S, I Name, bank, guards, model, detector, extraction context, selector, and bound tool inputs.
 */
export interface InterviewStage<Name extends string, B extends InterviewBank, G extends ModelGuardTuple = readonly [], P extends AnyModelProfile | undefined = undefined, D extends AnswerDetectorContract | undefined = undefined, C extends ExtractionContextContract | undefined = undefined, S extends QuestionSelectorContract | undefined = undefined, I extends ToolInputsContract | undefined = undefined> extends InterviewStageDefinitionContract {
  readonly name: Name
  readonly required: B["required"]
  readonly optional: B["optional"]
  readonly tools: InterviewTools<B>
  readonly fields: InterviewFields<B>
  readonly instructions: ReadonlyArray<string>
  readonly questions: CollectQuestionPolicy
  readonly guards: G
  readonly initialState: InterviewState<B>
  readonly stateSchema: Schema.Codec<InterviewState<B>, unknown>
  readonly answersSchema: Schema.Codec<InterviewAnswers<B>, unknown>
  readonly parseState: (input: Schema.Codec.Encoded<Schema.Codec<InterviewState<B>, unknown>>) => Effect.Effect<InterviewState<B>, Schema.SchemaError>
  readonly canFinish: (state: InterviewState<B>) => boolean
  readonly isComplete: (state: InterviewState<B>) => boolean
  readonly run: (input: {
    readonly state: InterviewState<B>
    readonly messages: ReadonlyArray<ConversationMessage>
    readonly frame?: InterviewPlanningFrame
  }) => Effect.Effect<InterviewTurn<B>,
    Effect.Error<ReturnType<Collection<Name, B, G, P, D, C>["run"]>> | QuestionSelectorError<S> | InvalidQuestionSelection | InvalidQuestionPlanningContext | ToolInputsError<I> | (InterviewTools<B> extends ToolTuple ? ToolSetError<InterviewTools<B>> : never),
    Effect.Services<ReturnType<Collection<Name, B, G, P, D, C>["run"]>> | QuestionSelectorRequirements<S> | ToolInputsRequirements<I> | (InterviewTools<B> extends ToolTuple ? ToolSetRequirements<InterviewTools<B>> : never)>
}

/** Define a closed interview and preserve every collaborator's Effect errors and requirements. */
export const defineInterviewStage = <
  const Name extends string, const Required extends AnswerFields, const Optional extends AnswerFields,
  const G extends ModelGuardTuple = readonly [], const P extends AnyModelProfile | undefined = undefined,
  const D extends AnswerDetectorContract | undefined = undefined, const C extends ExtractionContextContract | undefined = undefined,
  const S extends QuestionSelectorContract | undefined = undefined,
  const T extends readonly [] | ToolTuple = readonly [], const I extends ToolInputsContract | undefined = undefined,
>(definition: DefineInterviewStageInput<Name, Required, Optional, G, P, D, C, S, T, I>): InterviewStage<Name, { readonly required: Required; readonly optional: Optional; readonly tools: T }, G, P, D, C, S, I> => {
  type B = { readonly required: Required; readonly optional: Optional; readonly tools: T }
  type State = InterviewState<B>
  type Stage = InterviewStage<Name, B, G, P, D, C, S, I>
  const tools: readonly [] | ToolTuple = definition.tools ?? []
  const selectedTools = definition.selection?.bank.tools ?? []
  if (definition.selection !== undefined && (tools.length !== selectedTools.length || tools.some((tool, index) => tool !== selectedTools[index]))) throw new Error("Question selector must be bound to the interview's exact tools")
  if (tools.length === 0 && (definition.inputs !== undefined || definition.clarification !== undefined)) throw new Error("Interview inputs and clarification require tools")
  const merged = { ...definition.required, ...definition.optional }
  if (Object.keys(definition.required).some(field => Object.hasOwn(definition.optional, field))) throw new Error("Required and optional interview fields must be disjoint")
  if (definition.selection !== undefined && (!sameAnswerFields(definition.required, definition.selection.bank.required) || !sameAnswerFields(definition.optional, definition.selection.bank.optional))) throw new Error("Question selector must be bound to the interview's exact answer definitions and requirements")
  for (const binding of [definition.detector, definition.context]) {
    if (binding !== undefined && !sameAnswerFields(merged, binding.fields)) throw new Error("Interview detector and context must be bound to its exact answer definitions")
  }
  // Keep the merged registry authoritative while accepting separately composed bindings.
  const fields: InterviewFields<B> = merged
  const instructions = Schema.decodeUnknownSync(Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4000))).check(Schema.isMinLength(1)))(definition.instructions)
  const collectionInput = { ...definition, fields }
  // SAFETY: this projection keeps the exact registered fields, collaborators, and conditional model binding.
  const collection = createAnswerCollection(Fn.cast<typeof collectionInput, DefineCollectStageInput<Name, InterviewFields<B>, G, P, D, C>>(collectionInput))
  // SAFETY: the profile is forwarded unchanged to both answer and tool planning.
  const model = Fn.cast<{ readonly model: typeof definition.model }, ModelProfileInput<P>>({ model: definition.model })
  const [firstTool, ...otherTools] = tools
  const toolRuntime = firstTool === undefined ? undefined : createInterviewTools({
    name: definition.name, tools: [firstTool, ...otherTools], inputs: definition.inputs,
    clarification: definition.clarification, instructions: instructions.map(Instruction.make), guards: collection.guards, model,
  })
  const base = collection.runtime
  const inspection = collection.inspection
  const required = Object.keys(definition.required)
  const optional = Object.keys(definition.optional)
  const names = inspection.fields.map(field => field.field)
  const fieldSchema = Schema.Literals(names)
  const evidenceSchema = Schema.Struct({ messageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), quote: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)) })
  const phaseSchema = Schema.TaggedUnion({ Ready: {}, AwaitingReply: { field: fieldSchema, issuedMessageIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }, Complete: {} })
  const rawStateSchema = Schema.Struct({
    ...base.stateFields,
    declined: Schema.Struct(Object.fromEntries(optional.map(field => [field, Schema.optionalKey(evidenceSchema)]))),
    phase: phaseSchema,
  })
  const canFinish = (state: RuntimeCollectStageState): boolean => required.every(field => Object.hasOwn(state.accepted, field)) && (state.clarifying?.length ?? 0) === 0
  const isValid = (state: State): boolean => {
    if (!base.isValid(state)) return false
    if (Object.keys(state.declined).some(field => Object.hasOwn(state.accepted, field) || state.clarifying?.includes(field))) return false
    if (state.phase._tag === "Complete") return canFinish(state)
    if (state.phase._tag === "Ready") return true
    const issued = state.asked[state.phase.field]
    return issued !== undefined && (issued.latest ?? issued).messageIndex === state.phase.issuedMessageIndex
  }
  // SAFETY: fields come from the shared codecs and this exact bank; the filter refines phase invariants.
  const stateSchema = Fn.cast<typeof rawStateSchema, Schema.Codec<State, unknown>>(rawStateSchema).check(Schema.makeFilter(isValid, { description: "consistent interview progress and question focus" }))
  const answers = Schema.Struct({
    ...Object.fromEntries(required.map(field => [field, fields[field]?.schema ?? Schema.Never])),
    ...Object.fromEntries(optional.map(field => [field, Schema.optionalKey(fields[field]?.schema ?? Schema.Never)])),
  })
  // SAFETY: required and optional codec entries retain each registered field's value type.
  const answersSchema = Fn.cast<typeof answers, Schema.Codec<InterviewAnswers<B>, unknown>>(answers)
  const initialState = Schema.decodeUnknownSync(Schema.toType(stateSchema))({ ...collection.initialState, declined: {}, phase: { _tag: "Ready" } })
  const isComplete = (state: State): boolean => state.phase._tag === "Complete" && canFinish(state)
  const isGrounded = (state: State, messages: ReadonlyArray<ConversationMessage>): boolean => base.isGroundedInMessages(state, messages) && Object.values(state.declined).every(evidence => {
    if (evidence === undefined) return false
    const message = messages[evidence.messageIndex]
    return message?.role === "user" && message.content.includes(evidence.quote)
  })
  const candidates = (state: State): ReadonlyArray<QuestionCandidate> => {
    const available: Array<QuestionCandidate> = inspection.fields.flatMap(field => {
      const clarifying = state.clarifying?.includes(field.field) === true
      if (!clarifying && (Object.hasOwn(state.accepted, field.field) || Object.hasOwn(state.declined, field.field))) return []
      return [{ target: { _tag: "Question", field: field.field }, requirement: required.includes(field.field) ? "required" : "optional", purpose: clarifying ? "clarify" : "collect", description: field.description, question: field.question } satisfies QuestionCandidate]
    })
    for (const tool of toolRuntime?.models ?? []) available.push({ target: { _tag: "Tool", name: tool.name }, description: tool.description, inputSchema: tool.inputSchema })
    if (canFinish(state)) available.push({ target: { _tag: "Finish" }, description: "All required answers are accepted. Finish if another question would add little or the user wants to proceed." })
    return available
  }
  const execution = Effect.fn("popcomputer.structured_chat.interview.run")(function* (input: Parameters<Stage["run"]>[0]) {
    if (!isValid(input.state) || !isGrounded(input.state, input.messages) || isComplete(input.state)) return yield* new InvalidQuestionPlanningContext({ reason: "invalid_context" })
    const focus = input.state.phase._tag === "AwaitingReply" ? input.state.phase.field : undefined
    const extractionInput = { state: input.state, messages: input.messages, declinable: optional, history: "whole" as const }
    const extracted = yield* base.extract(focus === undefined ? extractionInput : { ...extractionInput, focus })
    // SAFETY: extraction was created from this bank's exact codecs and preserves their correlations.
    const progress = Fn.cast<RuntimeCollectStageState, CollectStageState<InterviewFields<B>>>(extracted.state)
    const acceptedValues = new Map(Object.entries(progress.accepted))
    const declinedValues = new Map(Object.entries(input.state.declined))
    const clarifying = new Set(progress.clarifying ?? [])
    for (const [field, answer] of acceptedValues) {
      const decline = declinedValues.get(field)
      if (answer !== undefined && decline !== undefined) {
        if (answer.evidence.messageIndex > decline.messageIndex) declinedValues.delete(field)
        else acceptedValues.delete(field)
      }
    }
    for (const decline of extracted.declines) {
      if ((acceptedValues.get(decline.field)?.evidence.messageIndex ?? -1) >= decline.evidence.messageIndex) continue
      acceptedValues.delete(decline.field)
      clarifying.delete(decline.field)
      declinedValues.set(decline.field, decline.evidence)
    }
    const latest = input.messages.at(-1)
    if (focus !== undefined && optional.includes(focus) && fields[focus]?.escape === undefined && collection.questions.escape !== undefined &&
      latest !== undefined && canGroundAnswer(latest, "explicit") && latest.content.toLowerCase() === collection.questions.escape.toLowerCase()) {
      acceptedValues.delete(focus)
      clarifying.delete(focus)
      declinedValues.set(focus, { messageIndex: input.messages.length - 1, quote: latest.content })
    }
    const updated = { accepted: Object.fromEntries(acceptedValues), asked: progress.asked, clarifying: [...clarifying], declined: Object.fromEntries(declinedValues), phase: input.state.phase }
    // SAFETY: keys and values originate only in the parsed bank and its grounded acceptance/decline results.
    const state = Fn.cast<typeof updated, State>(updated)
    const accepted: Array<SelectionAcceptedAnswer> = (input.frame?.accepted ?? []).filter(answer => answer.stage !== definition.name)
    for (const field of inspection.fields) {
      const answer = state.accepted[field.field]
      if (answer === undefined) continue
      const value = yield* field.encodeValue(answer.value).pipe(Effect.flatMap(encoded => Schema.decodeUnknownEffect(JsonValueSchema)(encoded)), Effect.mapError(() => new InvalidQuestionPlanningContext({ reason: "invalid_answer_value" })))
      accepted.push({ stage: definition.name, field: field.field, value, evidence: answer.evidence })
    }
    const issued = focus === undefined ? undefined : state.asked[focus]
    const context: QuestionSelectionContext = {
      stage: definition.name, trigger: input.frame?.trigger ?? "direct", instructions: instructions.map(Instruction.make),
      conversation: input.messages.map((message, messageIndex) => ({ messageIndex, message })), accepted,
      focus: issued === undefined || focus === undefined ? { _tag: "None" } : { _tag: "Issued", field: focus, question: issued.latest ?? issued },
      candidates: candidates(state),
    }
    const plan = yield* planInterviewQuestion<G, P>({ ...model, context, selection: definition.selection, guards: collection.guards, guidance: collection.questions.guidance })
    if (plan.target._tag === "Finish") {
      const values = Object.fromEntries(Object.entries(state.accepted).flatMap(([field, answer]) => answer === undefined ? [] : [[field, answer.value]]))
      return { state: { ...state, phase: { _tag: "Complete" } }, complete: true, question: undefined, answers: values }
    }
    if (plan.target._tag === "Tool") {
      if (toolRuntime === undefined) return yield* new InvalidQuestionSelection({ reason: "target_not_offered" })
      const context = yield* Effect.serviceOption(ToolContext)
      const execute = toolRuntime.run(plan.target.name, input.messages, { trigger: input.frame?.trigger ?? "direct", accepted })
      // A tool sees answers accepted in this turn, including the interview's partial progress.
      const action = yield* (Option.isSome(context) ? execute.pipe(Effect.provideService(ToolContext, {
        stages: { ...context.value.stages, [definition.name]: state },
      })) : execute)
      return { complete: false, state, question: undefined, action }
    }
    const turn = base.ask(state, input.messages, plan.target.field, plan.wording)
    yield* recordDebugEvent({ _tag: "QuestionAsked", stage: definition.name, field: plan.target.field })
    return { ...turn, state: { ...turn.state, declined: state.declined, phase: { _tag: "AwaitingReply", field: plan.target.field, issuedMessageIndex: input.messages.length } } }
  })
  // SAFETY: erased collaborators belong to the checked bank and concrete generic definitions above.
  const run = Fn.cast<typeof execution, Stage["run"]>(execution)
  // SAFETY: chat parses this definition's state codec before using its sealed runtime.
  const parsedState = (state: RuntimeCollectStageState): State => Fn.cast<RuntimeCollectStageState, State>(state)
  const runtime: CollectStageRuntime = {
    ...base, stateFields: rawStateSchema.fields, stateSchema, initialState,
    isInitial: state => base.isInitial(state) && parsedState(state).phase._tag === "Ready" && Object.keys(parsedState(state).declined).length === 0,
    isValid: state => isValid(parsedState(state)),
    isGroundedInMessages: (state, messages) => isGrounded(parsedState(state), messages),
    isComplete: state => isComplete(parsedState(state)),
    run: input => run({ ...input, state: parsedState(input.state) }),
    applyRepairs: (state, messages, repairs) => base.applyRepairs(state, messages, repairs).pipe(Effect.map(result => {
      const previous = parsedState(state)
      const next = { ...result.state, declined: previous.declined, phase: canFinish(result.state) && previous.phase._tag === "Complete" ? previous.phase : { _tag: "Ready" as const } }
      return { state: next, requiresConfirmation: next.phase._tag !== "Complete" }
    })),
  }
  const stage = structuredDefinition("interview_stage")(withAnswerStageRuntime({
    _tag: "InterviewStage" as const, name: definition.name, required: definition.required, optional: definition.optional,
    tools, fields, instructions, questions: collection.questions, guards: collection.guards,
    stateSchema, answersSchema, initialState, isComplete, canFinish, run,
    parseState: (input: Schema.Codec.Encoded<typeof stateSchema>) => Schema.decodeUnknownEffect(stateSchema)(input, { onExcessProperty: "error" }),
  }, runtime, inspection))
  // SAFETY: B is exactly the Required/Optional pair above; TypeScript cannot normalize all conditional Effect services through their intersection.
  return Fn.cast<typeof stage, Stage>(stage)
}

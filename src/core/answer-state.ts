import type {
  AcceptedAnswer,
  AnswerFields,
  CollectStageState,
  IssuedCollectQuestion,
  RuntimeAnswerValue,
} from "./answer-collection.js"
import type { AnswerRegistry } from "./answer-registry.js"
import {
  canGroundAnswer,
  isAuthored,
  type ConversationMessage,
} from "./conversation-message.js"
import { getOwn } from "./record.js"

/** @internal Cross-field invariants the generated state schema refines with. */
export const isValidAnswerState = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: {
    readonly accepted: object
    readonly asked: Readonly<Partial<Record<string, IssuedCollectQuestion>>>
  },
): boolean =>
  registry.fieldNames.every((field) => {
    const answer = registry.getAnswer(field)
    const issued = getOwn(state.asked, field)

    return (
      (issued?.latest === undefined ||
        issued.latest.messageIndex >= issued.messageIndex) &&
      (answer.mode !== "confirmed" ||
        !Object.hasOwn(state.accepted, field) ||
        Object.hasOwn(state.asked, field))
    )
  })

/** @internal Every registered answer is accepted and nothing awaits clarification. */
export const isCompleteAnswerState = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
): boolean =>
  (state.clarifying?.length ?? 0) === 0 &&
  registry.fieldNames.every((field) => Object.hasOwn(state.accepted, field))

/** @internal No answer, question, or clarification has been recorded yet. */
export const isInitialAnswerState = (state: {
  readonly accepted: object
  readonly asked: object
  readonly clarifying?: ReadonlyArray<string>
}): boolean =>
  (state.clarifying?.length ?? 0) === 0 &&
  Object.keys(state.accepted).length === 0 &&
  Object.keys(state.asked).length === 0

/**
 * @internal Every issued question and accepted quote resolves to the exact
 * transcript entry it claims; confirmed evidence must follow its question.
 */
export const isGroundedInMessages = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
  messages: ReadonlyArray<ConversationMessage>,
): boolean => {
  const questionsAreGrounded = registry.fieldNames.every((field) => {
    const issued = getOwn(state.asked, field)

    if (issued === undefined) {
      return true
    }

    return [
      issued,
      ...(issued.latest === undefined ? [] : [issued.latest]),
    ].every((question) => {
      const message = messages[question.messageIndex]
      return (
        message !== undefined &&
        isAuthored(message) &&
        message.content === question.text
      )
    })
  })

  if (!questionsAreGrounded) {
    return false
  }

  return registry.fieldNames.every((field) => {
    const accepted = getOwn(state.accepted, field)

    if (accepted === undefined) {
      return true
    }

    const { messageIndex, quote } = accepted.evidence
    const message = messages[messageIndex]
    const issued = getOwn(state.asked, field)
    const mode = registry.getAnswer(field).mode

    return (
      message !== undefined &&
      canGroundAnswer(message, mode) &&
      message.content.includes(quote) &&
      (mode !== "confirmed" ||
        (issued !== undefined && messageIndex > issued.messageIndex))
    )
  })
}

/** @internal Copy accepted answers into a mutable turn-local map. */
export const copyAcceptedAnswers = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
): Map<string, AcceptedAnswer<RuntimeAnswerValue>> => {
  const accepted = new Map<string, AcceptedAnswer<RuntimeAnswerValue>>()

  for (const field of registry.fieldNames) {
    const answer = getOwn(state.accepted, field)

    if (answer !== undefined) {
      accepted.set(field, answer)
    }
  }

  return accepted
}

/** @internal Copy issued questions into a mutable turn-local map. */
export const copyAskedQuestions = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
): Map<string, IssuedCollectQuestion> => {
  const asked = new Map<string, IssuedCollectQuestion>()

  for (const field of registry.fieldNames) {
    const question = getOwn(state.asked, field)

    if (question !== undefined) {
      asked.set(field, question)
    }
  }

  return asked
}

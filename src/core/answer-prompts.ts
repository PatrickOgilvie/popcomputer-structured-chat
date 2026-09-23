import { Function as Fn, Predicate, Result, Schema } from "effect"

import type {
  AnswerFields,
  CollectStagePrompt,
  CollectStageQuestion,
  CollectStageState,
  CollectStageTurn,
  IssuedQuestionContext,
  ProposedQuestionWording,
} from "./answer-collection.js"
import type { AnswerRegistry } from "./answer-registry.js"
import type { AnswerDefinitionContract } from "./answer.js"
import type { ConversationMessage } from "./conversation-message.js"
import { hasAdaptiveWording, type QuestionChoice } from "./question.js"
import { getOwn } from "./record.js"

/** @internal Model-facing summary of how one answer is asked. */
export const describeQuestion = (answer: AnswerDefinitionContract): string => {
  const question = answer.question

  switch (question._tag) {
    case "FixedQuestion":
      return `fixed question: ${question.text}`
    case "AdaptiveQuestion":
      return `adaptive question goal: ${question.goal}`
    case "AdaptiveChoiceQuestion":
      return `adaptive choice prompt: ${question.prompt}; provide ${question.minimumOptions}-${question.maximumOptions} contextual options`
    case "ChoiceQuestion":
      return question.goal === undefined
        ? `fixed choice question: ${question.text}`
        : `adaptive wording goal: ${question.goal}; keep the application-authored choice labels and values unchanged`
  }
}

/**
 * @internal Select the pending question: an explicit focus first, then the
 * earliest clarification, then the first missing field in declaration order.
 */
export const nextQuestion = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
  focus?: keyof Fields & string,
): CollectStageQuestion<Fields> | undefined => {
  const field =
    focus ??
    registry.fieldNames.find((candidate) =>
      state.clarifying?.includes(candidate),
    ) ??
    registry.fieldNames.find(
      (candidate) => !Object.hasOwn(state.accepted, candidate),
    )

  if (field === undefined) {
    return undefined
  }

  const answer = registry.getAnswer(field)

  // SAFETY: field and answer originate from the same mapped Fields entry.
  return Fn.cast<
    {
      readonly field: typeof field
      readonly mode: typeof answer.mode
      readonly description: string
      readonly question: typeof answer.question
    },
    CollectStageQuestion<Fields>
  >({
    field,
    mode: answer.mode,
    description: answer.description,
    question: answer.question,
  })
}

const withEscape = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  prompt: {
    readonly field: keyof Fields & string
    readonly mode: AnswerDefinitionContract["mode"]
    readonly text: string
    readonly options: ReadonlyArray<QuestionChoice<unknown>>
  },
): CollectStagePrompt<Fields> =>
  // SAFETY: the pending field determines the corresponding question and
  // therefore the exact option value union in CollectStagePrompt.
  registry.questions.escape === undefined
    ? Fn.cast<typeof prompt, CollectStagePrompt<Fields>>(prompt)
    : Fn.cast<
        typeof prompt & { readonly escape: { readonly label: string } },
        CollectStagePrompt<Fields>
      >({ ...prompt, escape: { label: registry.questions.escape } })

/** @internal Render the pending question, honouring valid adaptive wording. */
export const toPrompt = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  pending: CollectStageQuestion<Fields>,
  adaptive: ProposedQuestionWording | null,
): CollectStagePrompt<Fields> => {
  const question = pending.question

  const matchingAdaptive =
    adaptive?.field === pending.field ? adaptive : undefined

  const fallback = Predicate.isTagged(question, "AdaptiveQuestion")
    ? question.fallback
    : Predicate.isTagged(question, "AdaptiveChoiceQuestion")
      ? question.prompt
      : question.text
  const text = hasAdaptiveWording(question)
    ? (matchingAdaptive?.text ?? fallback)
    : fallback

  let options: ReadonlyArray<QuestionChoice<unknown>> = []

  if (Predicate.isTagged(question, "ChoiceQuestion")) {
    options = question.options
  } else if (Predicate.isTagged(question, "AdaptiveChoiceQuestion")) {
    const supplied = matchingAdaptive?.options ?? []

    const normalized = supplied.map(({ label }) =>
      label.toLocaleLowerCase("en"),
    )

    // A selected label is later submitted as this answer's wire value,
    // so model-authored labels that cannot decode would dead-end the
    // user; fall back to the application-authored options instead.
    const decodeLabel = Schema.decodeUnknownResult(
      registry.getAnswer(pending.field).schema,
    )

    const validOptions =
      supplied.length < question.minimumOptions ||
      supplied.length > question.maximumOptions ||
      new Set(normalized).size !== normalized.length ||
      supplied.some(({ label }) => Result.isFailure(decodeLabel(label)))
        ? undefined
        : supplied

    const selectedOptions =
      validOptions ?? question.fallbackOptions.map((label) => ({ label }))

    if (selectedOptions.length > 0) {
      options = selectedOptions.map(({ label }) => ({
        label,
        value: label,
      }))
    }
  }

  return withEscape(registry, {
    field: pending.field,
    mode: pending.mode,
    text,
    options,
  })
}

/**
 * @internal Issue the pending question and record its transcript position.
 * The first issuance retains confirmation authority; later wording is kept
 * separately as the latest question.
 */
export const askPendingQuestion = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
  messages: ReadonlyArray<ConversationMessage>,
  adaptive: ProposedQuestionWording | null,
  focus?: keyof Fields & string,
): CollectStageTurn<Fields> => {
  const pending = nextQuestion(registry, state, focus)

  if (pending === undefined) {
    return {
      state,
      complete: true,
      question: undefined,
    }
  }

  const basePrompt = toPrompt(registry, pending, adaptive)
  const clarificationText = `Could you clarify your answer? ${basePrompt.text}`
  const prompt =
    state.clarifying?.includes(pending.field) === true &&
    (adaptive === null || !hasAdaptiveWording(pending.question)) &&
    clarificationText.length <= 500
      ? { ...basePrompt, text: clarificationText }
      : basePrompt

  const prior = getOwn(state.asked, pending.field)
  const current: IssuedQuestionContext =
    prompt.options.length === 0
      ? { messageIndex: messages.length, text: prompt.text }
      : {
          messageIndex: messages.length,
          text: prompt.text,
          options: prompt.options.map((option) => option.label),
        }
  const advanced = {
    ...state,
    asked: {
      ...state.asked,
      [pending.field]:
        prior === undefined ? current : { ...prior, latest: current },
    },
  }

  return {
    state: advanced,
    complete: false,
    question: prompt,
  }
}

/** @internal The application-authored retry prompt after a validator rejects a value. */
export const toRejectionPrompt = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  field: keyof Fields & string,
): CollectStagePrompt<Fields> => {
  const answer = registry.getAnswer(field)
  const question = answer.reject?.ask

  if (question === undefined) {
    throw new Error(`Answer validator for ${field} requires reject.ask`)
  }

  // Answer construction restricts rejection prompts to fixed or typed choice
  // questions whose values match this field's answer schema.
  return withEscape(registry, {
    field,
    mode: answer.mode,
    text: question.text,
    options: Predicate.isTagged(question, "ChoiceQuestion")
      ? question.options
      : [],
  })
}

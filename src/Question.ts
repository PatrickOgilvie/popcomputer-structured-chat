import { Question } from "./core/question.js"

/** Define a fixed free-text question. */
export const fixed = Question.fixed

/** Define a model-authored free-text question with a safe fallback. */
export const adaptive = Question.adaptive

/** Define a model-authored choice question with bounded fallback options. */
export const adaptiveChoice = Question.adaptiveChoice

/** Add typed suggestions to fixed text or an adaptive question. Choice values remain fixed. */
export const choice = Question.choice

export type {
  AdaptiveChoiceQuestion,
  AdaptiveQuestion,
  ChoiceQuestion,
  FixedQuestion,
  QuestionChoice as Choice,
  QuestionDefinition as Definition,
  QuestionDefinitionContract as DefinitionContract,
} from "./core/question.js"

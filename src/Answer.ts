import { Answer } from "./core/answer.js"

/** Define a semantic fact that may be inferred from untrusted messages. */
export const semantic = Answer.semantic

/** Define a fact that must be explicitly stated by the user. */
export const explicit = Answer.explicit

/** Define a fact that requires explicit user confirmation. */
export const confirmed = Answer.confirmed

/** Mark one JSON-encodable answer for user-facing answer snapshots. */
export const visibleToUser = Answer.visibleToUser

export { AnswerModeSchema as ModeSchema } from "./core/answer.js"

export type {
  AnswerDefinition as Definition,
  AnswerDefinitionContract as DefinitionContract,
  AnswerMode as Mode,
  DefineAnswerInput as DefineInput,
  DefineUnvalidatedAnswerInput as DefineUnvalidatedInput,
  DefineValidatedAnswerInput as DefineValidatedInput,
  VisibleToUserOptions,
} from "./core/answer.js"

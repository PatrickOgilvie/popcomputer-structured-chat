import { Stage } from "./core/stage.js"

/** Define one collect stage. */
export const collect = Stage.collect

/** Define one repeatable or terminal query-tool stage. */
export const tools = Stage.tools

/** Define one terminal idempotent command stage. */
export const command = Stage.command

export { ToolStageAfterExecutionSchema as AfterExecutionSchema } from "./core/stage.js"

export {
  AnswerValidationRejected,
  InvalidCollectStageResponse as InvalidResponse,
  InvalidCollectStageResponseReasonSchema as InvalidResponseReasonSchema,
} from "./core/collect-stage.js"

export type {
  AcceptedAnswer,
  AcceptedAnswerEvidence,
  AnswerFields,
  CollectAcceptedAnswers as AcceptedAnswers,
  CollectAnswerValidationError as AnswerValidationError,
  CollectAnswerValidationRequirements as AnswerValidationRequirements,
  CollectAnswers as Answers,
  CollectQuestionPolicy as QuestionPolicy,
  CollectStage as Collect,
  CollectStagePrompt as Prompt,
  CollectStageQuestion as CollectQuestion,
  CollectStageState as State,
  CollectStageTurn as Turn,
  DefineCollectStageInput as DefineCollectInput,
  IssuedCollectQuestion as IssuedQuestion,
} from "./core/collect-stage.js"

export type {
  ChatStageDefinitionContract as DefinitionContract,
  ChatStageTuple as Tuple,
} from "./core/chat.js"

export type {
  CommandStage as Command,
  DefineCommandStageInput as DefineCommandInput,
  DefineToolStageInput as DefineToolsInput,
  ToolStage as Tools,
  ToolStageAfterExecution as AfterExecution,
} from "./core/stage.js"

/** Define one repeatable query and command interaction. */
export const interact = Stage.interact

export type {
  InteractionStage as Interaction,
  DefineInteractionStageInput as DefineInteractionInput,
  InteractionCommandContext,
} from "./core/interaction-stage.js"

/** Construct an optional finite answer resolution strategy. */
export {
  defineAnswerResolver as resolver,
  InvalidAnswerResolution,
} from "./core/answer-resolver.js"
export type {
  AnswerResolver,
  AnswerResolverContract,
  CollectionDecisionContext,
  CollectionResolution,
  FieldSelection,
  FiniteChoicesFor,
} from "./core/answer-resolver.js"

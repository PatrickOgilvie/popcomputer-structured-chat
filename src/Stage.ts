import { Stage } from "./core/stage.js"

/** Define one collect stage. */
export const collect = Stage.collect

/** Collect required and optional answers in conversation-dependent order. */
export const interview = Stage.interview

export { defineQuestionSelector as questionSelector, InvalidQuestionSelection, InvalidQuestionPlanningContext } from "./core/question-selection.js"
export type { InterviewBank, InterviewFields, InterviewField, InterviewTools, InterviewToolName, InterviewTrigger, QuestionSelector, QuestionSelectorContract, QuestionSelection, QuestionSelectionContext, QuestionTarget, QuestionCandidate } from "./core/question-selection.js"
export type { InterviewStage as Interview, InterviewState, InterviewPhase, InterviewTurn, InterviewAnswers, InterviewToolExecution, InterviewPlanningFrame, DefineInterviewStageInput as DefineInterviewInput } from "./core/interview-stage.js"

/** Define one repeatable or terminal query-tool stage. */
export const tools = Stage.tools

export {
  defineToolSelector as toolSelector,
  InvalidToolSelection,
  InvalidToolPlanningContext,
} from "./core/tool-selection.js"
export type {
  ToolSelector,
  ToolSelectorContract,
  ToolSelection,
  ToolSelectionContext,
  SelectionTarget,
  ToolPlanningFrame,
  SelectionAcceptedAnswer,
  ToolStageTrigger,
} from "./core/tool-selection.js"
export {
  defineToolInputs as toolInputs,
  InvalidToolInput,
} from "./core/tool-inputs.js"
export type {
  ToolInputs,
  ToolInputsContract,
  ToolInputResolvers,
} from "./core/tool-inputs.js"
export type {
  ToolStagePlan,
  SelectedToolRun,
  ToolClarification,
} from "./core/tool-planning.js"

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

/** Construct an optional answer detection strategy. */
export {
  defineAnswerDetector as detector,
  InvalidAnswerDetection,
} from "./core/answer-detector.js"

/** Build labelled application context for collect-stage extraction. */
export {
  defineExtractionContext as extractionContext,
  InvalidExtractionContext,
} from "./core/extraction-context.js"
export type {
  ExtractionContext,
  ExtractionContextContract,
  ExtractionContextInput,
} from "./core/extraction-context.js"
export type {
  AnswerDetector,
  AnswerDetectorContract,
  DetectionDecisionContext,
  DetectionFieldDecision,
  DetectionResolution,
  DetectionSelection,
  EligibleEvidence,
} from "./core/answer-detector.js"

/** Optional TypeSafe primitives and Effect service. */
export {
  batch,
  choice,
  noul,
  score,
  TypeSafeService as Service,
  EvaluationInputRejected,
  TypeSafeConfigurationInvalid,
  TypeSafeInvalidResponse,
  TypeSafeRequestRejected,
  TypeSafeUnavailable,
} from "./core/evaluation.js"
/** Server-only SDK adapter; importing the package root does not import this module. */
export type { UnavailablePolicy } from "./integrations/typesafe-availability.js"
export { typeSafeLayer as layer } from "./adapters/typesafe.js"
export type { TypeSafeConfig as Config } from "./adapters/typesafe.js"
export type {
  AnswerFor,
  Batch,
  ChoiceQuestion,
  Description,
  Evaluation,
  EvaluationError,
  EvaluationLimits,
  EvaluationService as ServiceContract,
  NoulQuestion,
  Question,
  QuestionMap,
  ScoreQuestion,
} from "./core/evaluation.js"
/** Optional batched answer detection for collect-stage questions. */
export {
  detection,
  detectionPolicy,
} from "./integrations/typesafe-detection.js"
export {
  selection,
  selectionPolicy,
} from "./integrations/typesafe-selection.js"
export type {
  SelectionPolicy,
  TypeSafeSelectionOptions as SelectionOptions,
} from "./integrations/typesafe-selection.js"
export type {
  DetectionPolicy,
  TypeSafeDetectionOptions as DetectionOptions,
} from "./integrations/typesafe-detection.js"

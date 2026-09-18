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
/** Optional bounded enum and boolean collection. */
export { collection } from "./integrations/typesafe-collection.js"
export type {
  ChoiceAcceptance,
  TypeSafeCollectionOptions as CollectionOptions,
} from "./integrations/typesafe-collection.js"
/** Optional batched answer detection for collect-stage questions. */
export { detection } from "./integrations/typesafe-detection.js"
export type {
  DetectionAcceptance,
  TypeSafeDetectionOptions as DetectionOptions,
} from "./integrations/typesafe-detection.js"

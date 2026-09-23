import { createAnswerCollection, withAnswerStageRuntime } from "./answer-collection.js"
import type { AnswerFields, CollectStage, DefineCollectStageInput } from "./answer-collection.js"
import type { ModelGuardTuple } from "./model-guard.js"
import type { AnyModelProfile } from "./model.js"
import type { AnswerDetectorContract } from "./answer-detector.js"
import type { ExtractionContextContract } from "./extraction-context.js"
import { structuredDefinition } from "./definition.js"

/** Define deterministic collection with an exact application-owned field registry. */
export const defineCollectStage = <
  const Name extends string,
  const Fields extends AnswerFields,
  const Guards extends ModelGuardTuple = readonly [],
  const Profile extends AnyModelProfile | undefined = undefined,
  const Detector extends AnswerDetectorContract | undefined = undefined,
  const Enrichment extends ExtractionContextContract | undefined = undefined,
>(definition: DefineCollectStageInput<Name, Fields, Guards, Profile, Detector, Enrichment>): CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment> => {
  if (definition.detector !== undefined && definition.detector.fields !== definition.fields) throw new Error("Answer detector must be bound to the exact stage fields")
  if (definition.context !== undefined && definition.context.fields !== definition.fields) throw new Error("Extraction context must be bound to the exact stage fields")
  const { runtime, inspection, ...collection } = createAnswerCollection(definition)
  return structuredDefinition("collect_stage")(withAnswerStageRuntime({ ...collection, _tag: "CollectStage" }, runtime, inspection))
}

/** Deterministic collection public contract, backed by shared answer acceptance. */
export {
  InvalidCollectStageResponseReasonSchema, InvalidCollectStageResponse,
  CollectAnswerFieldNameSchema, AnswerValidationRejected,
  withAnswerStageRuntime, isAnswerStage, readCollectStageRuntime, readCollectStageInspection,
} from "./answer-collection.js"
export type {
  AnswerFields, CollectAnswers, AcceptedAnswerEvidence, AcceptedAnswer,
  CollectAcceptedAnswers, IssuedQuestionContext, IssuedCollectQuestion,
  CollectStageState, CollectStageQuestion, CollectStagePrompt, CollectAnswerValidationError,
  CollectAnswerValidationRequirements, CollectStageTurn, RuntimeCollectStageState,
  RuntimeCollectStagePrompt, RuntimeCollectStageTurn, AnswerCollectionResult,
  ProposedQuestionWording, AnswerCollectionInput, CollectStageRuntime,
  CollectStageInspectionField, CollectStageInspection, AnswerStageDefinitionContract,
  CollectStageDefinitionContract, CollectQuestionPolicy, DefineCollectStageInput, CollectStage,
} from "./answer-collection.js"

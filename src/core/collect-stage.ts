import {
  type AnswerFields,
  type CollectStage,
  createAnswerCollection,
  type DefineCollectStageInput,
  withAnswerStageRuntime,
} from "./answer-collection.js"
import type { AnswerDetectorContract } from "./answer-detector.js"
import { structuredDefinition } from "./definition.js"
import type { ExtractionContextContract } from "./extraction-context.js"
import type { ModelGuardTuple } from "./model-guard.js"
import type { AnyModelProfile } from "./model.js"

/** Define deterministic collection with an exact application-owned field registry. */
export const defineCollectStage = <
  const Name extends string,
  const Fields extends AnswerFields,
  const Guards extends ModelGuardTuple = readonly [],
  const Profile extends AnyModelProfile | undefined = undefined,
  const Detector extends AnswerDetectorContract | undefined = undefined,
  const Enrichment extends ExtractionContextContract | undefined = undefined,
>(
  definition: DefineCollectStageInput<
    Name,
    Fields,
    Guards,
    Profile,
    Detector,
    Enrichment
  >,
): CollectStage<Name, Fields, Guards, Profile, Detector, Enrichment> => {
  if (
    definition.detector !== undefined &&
    definition.detector.fields !== definition.fields
  )
    throw new Error("Answer detector must be bound to the exact stage fields")
  if (
    definition.context !== undefined &&
    definition.context.fields !== definition.fields
  )
    throw new Error(
      "Extraction context must be bound to the exact stage fields",
    )
  const { runtime, inspection, ...collection } =
    createAnswerCollection(definition)
  return structuredDefinition("collect_stage")(
    withAnswerStageRuntime(
      { ...collection, _tag: "CollectStage" },
      runtime,
      inspection,
    ),
  )
}

import { Data, Schema } from "effect"

import { StageNameSchema } from "./stage-name.js"

/** Safe reason that a collect-stage model proposal was rejected. */
export const InvalidCollectStageResponseReasonSchema = Schema.Literals([
  "invalid_evidence",
  "invalid_repair",
])

/** A collect-stage proposal was not grounded in a user message. */
export class InvalidCollectStageResponse extends Schema.TaggedError<InvalidCollectStageResponse>()(
  "InvalidCollectStageResponse",
  {
    stage: StageNameSchema,
    reason: InvalidCollectStageResponseReasonSchema,
  },
) {}

/** A domain validator rejected one structurally valid proposed answer. */
export class AnswerValidationRejected<Error, Question> extends Data.TaggedError(
  "AnswerValidationRejected",
)<{
  readonly stage: string
  readonly field: string
  readonly error: Error
  readonly question: Question
}> {}

/** @internal Construct the stage's grounding failure with a safe reason. */
export const invalidCollectResponse = (
  stage: string,
  reason: "invalid_evidence" | "invalid_repair" = "invalid_evidence",
): InvalidCollectStageResponse =>
  new InvalidCollectStageResponse({ stage, reason })

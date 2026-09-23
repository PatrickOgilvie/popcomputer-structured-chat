import { Effect, Function as Fn } from "effect"

import type { ModelGuardTuple } from "./model-guard.js"
import type {
  AnyModelProfile,
  ModelProfileInput,
  TrustedInstruction,
  UntrustedMessage,
} from "./model.js"
import { InvalidQuestionSelection } from "./question-selection.js"
import type { AdaptiveQuestion, FixedQuestion } from "./question.js"
import type { ToolInputsContract } from "./tool-inputs.js"
import { makeToolPlanner } from "./tool-planning.js"
import { type ToolPlanningFrame } from "./tool-selection.js"
import { defineToolSet, type ToolSetCall, type ToolTuple } from "./tool-set.js"

/** @internal Reuse query argument planning after the interview has chosen an action.
 * The fixed target cannot be replaced with another tool or completion.
 */
export const createInterviewTools = <
  P extends AnyModelProfile | undefined,
>(input: {
  readonly name: string
  readonly tools: ToolTuple
  readonly inputs: ToolInputsContract | undefined
  readonly clarification: FixedQuestion | AdaptiveQuestion | undefined
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly guards: ModelGuardTuple
  readonly model: ModelProfileInput<P>
}) => {
  const toolSet = defineToolSet(...input.tools)
  const registered = new Set(toolSet.models.map((tool) => tool.name))
  const plan = makeToolPlanner(input)
  return {
    models: toolSet.models,
    run: Effect.fn("popcomputer.structured_chat.interview.tool")(function* (
      name: string,
      messages: ReadonlyArray<UntrustedMessage>,
      frame: ToolPlanningFrame,
    ) {
      if (!registered.has(name))
        return yield* new InvalidQuestionSelection({
          reason: "target_not_offered",
        })
      const outcome = yield* plan(messages, frame, {
        target: { _tag: "Tool", name },
      })
      if (outcome._tag === "Clarification") return outcome
      // SAFETY: this planner validates arguments against this exact query registry; no repair action is offered.
      const call = Fn.cast<
        typeof outcome.call,
        ToolSetCall<typeof input.tools>
      >(outcome.call)
      const result = yield* toolSet.execute(call)
      return { _tag: "ToolResult" as const, result }
    }),
  }
}

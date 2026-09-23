import { Effect, Function as Fn } from "effect"
import type { AnyModelProfile, ModelProfileInput, TrustedInstruction, UntrustedMessage } from "./model.js"
import type { ModelGuardTuple } from "./model-guard.js"
import type { AdaptiveQuestion, FixedQuestion } from "./question.js"
import { makeToolPlanner } from "./tool-planning.js"
import { defineToolSelector, type ToolPlanningFrame } from "./tool-selection.js"
import type { ToolInputsContract } from "./tool-inputs.js"
import { defineToolSet, type ToolSetCall, type ToolTuple } from "./tool-set.js"
import { InvalidQuestionSelection } from "./question-selection.js"

/** @internal Reuse query argument planning after the interview has chosen an action.
 * The fixed selector cannot replace that action with another tool or completion.
 */
export const createInterviewTools = <P extends AnyModelProfile | undefined>(input: {
  readonly name: string
  readonly tools: ToolTuple
  readonly inputs: ToolInputsContract | undefined
  readonly clarification: FixedQuestion | AdaptiveQuestion | undefined
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly guards: ModelGuardTuple
  readonly model: ModelProfileInput<P>
}) => {
  const toolSet = defineToolSet(...input.tools)
  const planners = new Map(toolSet.models.map(tool => [tool.name, makeToolPlanner({
    ...input,
    selection: defineToolSelector(input.tools, () => Effect.succeed({
      _tag: "Selected", target: { _tag: "Tool", name: tool.name },
    })),
  })]))
  return {
    models: toolSet.models,
    run: Effect.fn("popcomputer.structured_chat.interview.tool")(function* (
      name: string, messages: ReadonlyArray<UntrustedMessage>, frame: ToolPlanningFrame,
    ) {
      const plan = planners.get(name)
      if (plan === undefined) return yield* new InvalidQuestionSelection({ reason: "target_not_offered" })
      const outcome = yield* plan(messages, frame)
      if (outcome._tag === "Clarification") return outcome
      // SAFETY: this planner validates arguments against this exact query registry; no repair action is offered.
      const call = Fn.cast<typeof outcome.call, ToolSetCall<typeof input.tools>>(outcome.call)
      const result = yield* toolSet.execute(call)
      return { _tag: "ToolResult" as const, result }
    }),
  }
}

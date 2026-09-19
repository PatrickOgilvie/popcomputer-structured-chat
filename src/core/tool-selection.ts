import { Effect, Function as Fn, Schema } from "effect"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import type { ToolTuple } from "./tool-set.js"
import type { UntrustedMessage, TrustedInstruction } from "./model.js"
import type { JsonValue } from "./json-value.js"
import type { AcceptedAnswerEvidence } from "./collect-stage.js"

/** Why the runtime is planning this tool step. */
export type ToolStageTrigger =
  "direct" | "stage_entered" | "user_reply" | "after_repair"

/** Accepted values encoded by their owning answer codecs. */
export interface SelectionAcceptedAnswer {
  readonly stage: string
  readonly field: string
  readonly value: JsonValue
  readonly evidence: AcceptedAnswerEvidence
}

/** Runtime context accompanying a tool step; standalone steps default to direct. */
export interface ToolPlanningFrame {
  readonly trigger: ToolStageTrigger
  readonly accepted: ReadonlyArray<SelectionAcceptedAnswer>
}

/** A registered query or the runtime-owned conversation repair. */
export type SelectionTarget<Tools extends ToolTuple = ToolTuple> =
  | { readonly _tag: "Tool"; readonly name: Tools[number]["name"] }
  | { readonly _tag: "Repair" }

/** Classifier context contains data and descriptions, never executors. */
export interface ToolSelectionContext<
  Tools extends ToolTuple = ToolTuple,
> extends ToolPlanningFrame {
  readonly stage: string
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly candidates: ReadonlyArray<{
    readonly target: SelectionTarget<Tools>
    readonly description: string
  }>
  readonly messages: ReadonlyArray<UntrustedMessage>
}

const TargetSchema = Schema.TaggedUnion({
  Tool: { name: Schema.String },
  Repair: {},
})
/** Runtime boundary for a provider-neutral selection decision. */
export const ToolSelectionSchema = Schema.TaggedUnion({
  Selected: { target: TargetSchema },
  Uncertain: {},
  NoMatch: {},
  NotApplicable: {
    reason: Schema.Literals([
      "context_budget_exceeded",
      "candidate_budget_exceeded",
      "disabled",
      "provider_unavailable",
    ]),
  },
})

/** Selection never supplies arguments or grants execution authority. */
export type ToolSelection<Tools extends ToolTuple = ToolTuple> =
  | { readonly _tag: "Selected"; readonly target: SelectionTarget<Tools> }
  | Exclude<typeof ToolSelectionSchema.Type, { readonly _tag: "Selected" }>

/** A selector violated the stage's closed action registry. */
export class InvalidToolSelection extends Schema.TaggedError<InvalidToolSelection>()(
  "InvalidToolSelection",
  { reason: Schema.Literals(["invalid_shape", "target_not_offered"]) },
) {}

/** A collected value could not be encoded for planning. */
export class InvalidToolPlanningContext extends Schema.TaggedError<InvalidToolPlanningContext>()(
  "InvalidToolPlanningContext",
  { stage: Schema.String, field: Schema.String },
) {}

const selectorRuntime = Symbol("ToolSelectorRuntime")
/** Sealed selector definition retaining its registered tools. */
export interface ToolSelectorContract extends StructuredDefinition<"tool_selector"> {
  readonly tools: ToolTuple
  readonly [selectorRuntime]: (
    context: ToolSelectionContext,
  ) => Effect.Effect<ToolSelection, unknown, unknown>
}

/** A composable selector preserves its own errors and required services. */
export interface ToolSelector<
  Tools extends ToolTuple,
  E,
  R,
> extends ToolSelectorContract {
  readonly tools: Tools
  readonly select: (
    context: ToolSelectionContext<Tools>,
  ) => Effect.Effect<ToolSelection<Tools>, E, R>
}

/** Errors introduced by a selector. */
export type SelectorError<S> =
  S extends ToolSelector<infer _T, infer E, infer _R>
    ? E | InvalidToolSelection | InvalidToolPlanningContext
    : never
/** Services introduced by a selector. */
export type SelectorRequirements<S> =
  S extends ToolSelector<infer _T, infer _E, infer R> ? R : never

/** Bind one Effect-native decision function to a closed tool tuple.
 * @template Tools, E, R Registered tools, expected failures and required services.
 */
export const defineToolSelector = <const Tools extends ToolTuple, E, R>(
  tools: Tools,
  select: (
    context: ToolSelectionContext<Tools>,
  ) => Effect.Effect<ToolSelection<Tools>, E, R>,
): ToolSelector<Tools, E, R> => {
  // SAFETY: the stage checks tool definition identity before supplying this context.
  const runtime = Fn.cast<
    typeof select,
    ToolSelectorContract[typeof selectorRuntime]
  >(select)
  return structuredDefinition("tool_selector")({
    tools,
    select,
    [selectorRuntime]: runtime,
  })
}

/** @internal Execute and parse a selector at its capability boundary. */
export const selectTool = (
  selector: ToolSelectorContract,
  context: ToolSelectionContext,
) =>
  selector[selectorRuntime](context).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ToolSelectionSchema)(value, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          () => new InvalidToolSelection({ reason: "invalid_shape" }),
        ),
      ),
    ),
    Effect.flatMap(
      (decision): Effect.Effect<ToolSelection, InvalidToolSelection> => {
        if (decision._tag !== "Selected") return Effect.succeed(decision)
        const target = decision.target
        return context.candidates.some(
          (candidate) =>
            candidate.target._tag === target._tag &&
            (target._tag === "Repair" ||
              (candidate.target._tag === "Tool" &&
                candidate.target.name === target.name)),
        )
          ? Effect.succeed(decision)
          : Effect.fail(
              new InvalidToolSelection({ reason: "target_not_offered" }),
            )
      },
    ),
  )

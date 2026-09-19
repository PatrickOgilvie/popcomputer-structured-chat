import { Effect, Function as Fn, Schema } from "effect"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import type { ToolTuple, ToolSetCall } from "./tool-set.js"
import type { ToolSelectionContext } from "./tool-selection.js"
import type { ToolCall, ToolSchema } from "./tool.js"
import { compileToolRegistry } from "./tool-registry.js"
import { JsonValueSchema } from "./json-value.js"

/** Application input could not be encoded through its selected tool's codec. */
export class InvalidToolInput extends Schema.TaggedError<InvalidToolInput>()(
  "InvalidToolInput",
  { tool: Schema.String },
) {}

/** Resolver map checked against each registered tool's decoded input. */
export type ToolInputResolvers<Tools extends ToolTuple, E, R> = {
  readonly [Name in Tools[number]["name"]]?: (
    context: ToolSelectionContext<Tools>,
  ) => Effect.Effect<
    Extract<ToolSetCall<Tools>, { readonly name: Name }>["arguments"],
    E,
    R
  >
}

const inputRuntime = Symbol("ToolInputsRuntime")
/** Sealed application input bindings for a tool registry. */
export interface ToolInputsContract extends StructuredDefinition<"tool_inputs"> {
  readonly tools: ToolTuple
  readonly [inputRuntime]: ReadonlyMap<
    string,
    (
      context: ToolSelectionContext,
    ) => Effect.Effect<ToolCall<string, ToolSchema>, unknown, unknown>
  >
}

/** Bindings preserve resolver errors and Effect requirements. */
export interface ToolInputs<
  Tools extends ToolTuple,
  E,
  R,
> extends ToolInputsContract {
  readonly tools: Tools
  readonly resolvers: ToolInputResolvers<Tools, E, R>
}

/** Failures introduced by application argument bindings. */
export type ToolInputsError<I> =
  I extends ToolInputs<infer _T, infer E, infer _R>
    ? E | InvalidToolInput
    : never
/** Services introduced by application argument bindings. */
export type ToolInputsRequirements<I> =
  I extends ToolInputs<infer _T, infer _E, infer R> ? R : never

type ResolverEffect<Resolver> = Resolver extends (
  ...args: never[]
) => infer Execution
  ? Execution
  : never
type BindingError<Bindings> = Effect.Error<
  ResolverEffect<Bindings[keyof Bindings]>
>
type BindingRequirements<Bindings> = Effect.Services<
  ResolverEffect<Bindings[keyof Bindings]>
>

/** Bind typed argument resolvers to registered query tools.
 * @template Tools, Bindings Registered tools and their exact resolver functions.
 */
export const defineToolInputs = <
  const Tools extends ToolTuple,
  const Bindings extends ToolInputResolvers<NoInfer<Tools>, unknown, unknown>,
>(
  tools: Tools,
  resolvers: Bindings &
    Readonly<Record<Exclude<keyof Bindings, Tools[number]["name"]>, never>>,
): ToolInputs<Tools, BindingError<Bindings>, BindingRequirements<Bindings>> => {
  const names = new Set(tools.map((tool) => tool.name))
  if (Object.keys(resolvers).some((name) => !names.has(name)))
    throw new Error("Input bindings must name registered tools")
  // SAFETY: registered keys and each callback's decoded input are checked by the
  // constructor contract; this projection unions only their errors and services.
  const typed = Fn.cast<
    typeof resolvers,
    ToolInputResolvers<
      Tools,
      BindingError<Bindings>,
      BindingRequirements<Bindings>
    >
  >(resolvers)
  // SAFETY: the stage checks tool identity before invoking these callbacks and
  // encodes each result with that same tool's codec before execution.
  const entries = Fn.cast<
    typeof resolvers,
    Readonly<
      Record<
        string,
        (
          context: ToolSelectionContext,
        ) => Effect.Effect<unknown, unknown, unknown>
      >
    >
  >(resolvers)
  const registry = compileToolRegistry(tools)
  const bindings = new Map<
    string,
    (
      context: ToolSelectionContext,
    ) => Effect.Effect<ToolCall<string, ToolSchema>, unknown, unknown>
  >()
  for (const tool of tools) {
    const resolve = entries[tool.name]
    if (resolve === undefined) continue
    bindings.set(tool.name, (context) =>
      resolve(context).pipe(
        Effect.flatMap((value) =>
          Schema.encodeUnknownEffect(tool.inputSchema)(value, {
            onExcessProperty: "error",
          }).pipe(
            Effect.flatMap((encoded) =>
              Schema.decodeUnknownEffect(JsonValueSchema)(encoded),
            ),
            Effect.flatMap((arguments_) =>
              registry.parseCall({ name: tool.name, arguments: arguments_ }),
            ),
            Effect.mapError(() => new InvalidToolInput({ tool: tool.name })),
          ),
        ),
      ),
    )
  }
  return structuredDefinition("tool_inputs")({
    tools,
    resolvers: typed,
    [inputRuntime]: bindings,
  })
}

/** @internal Read a binding only after the stage verifies registry identity. */
export const toolInputResolver = (
  inputs: ToolInputsContract | undefined,
  name: string,
) => inputs?.[inputRuntime].get(name)

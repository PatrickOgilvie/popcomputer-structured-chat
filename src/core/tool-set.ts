import { Effect, Function as Fn, Schema } from "effect"
import type {
  InvalidToolCall,
  InvalidToolProjection,
  ModelToolDefinition,
  QueryToolDefinitionContract,
  StructuredTool,
  ToolDefinitionContract,
  ToolExecution,
  ToolCall,
  ToolSchema,
} from "./tool.js"
import {
  InvalidToolCall as InvalidToolCallError,
  InvalidToolCallReasonSchema,
  ToolNameSchema,
} from "./tool.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"

/** Non-empty tuple of model-callable query or command definitions. */
export type ModelToolTuple = readonly [
  ToolDefinitionContract,
  ...ReadonlyArray<ToolDefinitionContract>,
]

/** Non-empty tuple accepted by one repeatable closed query set. */
export type ToolTuple = readonly [
  QueryToolDefinitionContract,
  ...ReadonlyArray<QueryToolDefinitionContract>,
]

type ToolExecutionOf<Tool> = Tool extends StructuredTool<
  infer _Name,
  infer _InputSchema,
  infer ServerResult,
  infer _Error,
  infer _Requirements,
  infer ModelSchema,
  infer Presenters,
  infer _Operation
>
  ? ToolExecution<ServerResult, ModelSchema, Presenters>
  : never

type ToolCallOf<Tool> = Tool extends StructuredTool<
  infer Name,
  infer InputSchema,
  infer _ServerResult,
  infer _Error,
  infer _Requirements,
  infer _ModelSchema,
  infer _Presenters,
  infer _Operation
>
  ? ToolCall<Name, InputSchema>
  : never

/** Parsed call union accepted by any member of one tool set. */
export type ToolSetCall<Tools extends ModelToolTuple> =
  ToolCallOf<Tools[number]>

type ToolErrorOf<Tool> = Tool extends StructuredTool<
  infer _Name,
  infer _InputSchema,
  infer _ServerResult,
  infer Error,
  infer _Requirements,
  infer _ModelSchema,
  infer _Presenters,
  infer _Operation
>
  ? Error
  : never

type ToolRequirementsOf<Tool> = Tool extends StructuredTool<
  infer _Name,
  infer _InputSchema,
  infer _ServerResult,
  infer _Error,
  infer Requirements,
  infer _ModelSchema,
  infer _Presenters,
  infer _Operation
>
  ? Requirements
  : never

/** Execution union produced by any member of a tool set. */
export type ToolSetExecution<Tools extends ToolTuple> =
  ToolExecutionOf<Tools[number]>

/** Application failure union produced by any member of a tool set. */
export type ToolSetError<Tools extends ToolTuple> =
  | InvalidToolCall
  | InvalidToolProjection
  | ToolErrorOf<Tools[number]>

/** Effect services required by any member of a tool set. */
export type ToolSetRequirements<Tools extends ToolTuple> =
  ToolRequirementsOf<Tools[number]>

/** Planning-only registry shared by query and command stages. */
export interface ToolCallPlanner<Tools extends ModelToolTuple> {
  readonly models: ReadonlyArray<ModelToolDefinition>
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolSetCall<Tools>, InvalidToolCall>
}

/** A closed, stage-safe registry of tools that may execute. */
export interface ToolSet<Tools extends ToolTuple>
  extends ToolCallPlanner<Tools> {
  readonly tools: Tools
  readonly models: ReadonlyArray<ModelToolDefinition>

  /** Strictly parse one call to one registered tool without executing it. */
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolSetCall<Tools>, InvalidToolCall>

  /** Execute one already-parsed call without decoding its arguments again. */
  readonly execute: (
    call: ToolSetCall<Tools>,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >

  /** Strictly parse and execute one call to one registered tool. */
  readonly executeCall: (
    input: JsonValue,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >
}

const IncomingToolCallSchema = Schema.Struct({
  name: ToolNameSchema,
  arguments: JsonValueSchema,
})

interface RuntimeTool {
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolCall<string, ToolSchema>, InvalidToolCall>
  readonly execute: (
    input: Schema.Schema.Type<ToolSchema>,
  ) => Effect.Effect<unknown, unknown, unknown>
}

const invalidCall = (
  reason: Schema.Schema.Type<typeof InvalidToolCallReasonSchema>,
  tool: Schema.Schema.Type<typeof ToolNameSchema> | null,
): InvalidToolCall =>
  new InvalidToolCallError({
    tool,
    reason,
    path: null,
  })

/**
 * Define the complete set of tools available to one model step or chat stage.
 *
 * Names must be unique. Unknown, malformed, and out-of-stage calls fail before
 * application execution begins.
 */
export const defineToolSet = <const Tools extends ToolTuple>(
  ...tools: Tools
): ToolSet<Tools> => {
  const runtimeTools = new Map<string, RuntimeTool>()

  for (const tool of tools) {
    if (tool.operation !== "query") {
      throw new Error("Repeatable tool sets accept query tools only")
    }
    if (runtimeTools.has(tool.name)) {
      throw new Error(`Duplicate structured chat tool name: ${tool.name}`)
    }

    // SAFETY: ToolDefinitionContract carries the package-owned nominal identity.
    // Runtime execution is erased here and restored by ToolSet's conditional
    // public result, error, and requirement types.
    runtimeTools.set(
      tool.name,
      Fn.cast<QueryToolDefinitionContract, RuntimeTool>(tool),
    )
  }

  const selectTool = (
    name: string,
  ): Effect.Effect<RuntimeTool, InvalidToolCall> => {
    const tool = runtimeTools.get(name)
    if (tool === undefined) {
      return Effect.fail(invalidCall("unknown_tool", name))
    }

    return Effect.succeed(tool)
  }
  const parseCallRuntime = (input: JsonValue) =>
    Schema.decodeUnknownEffect(IncomingToolCallSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => invalidCall("invalid_envelope", null)),
      Effect.flatMap((call) =>
        selectTool(call.name).pipe(
          Effect.flatMap((tool) => tool.parseCall(call)),
        ),
      ),
      Effect.withSpan("popcomputer.structured_chat.tool_set.parse", {
        attributes: { toolCount: tools.length },
      }),
    )
  // SAFETY: the envelope parser establishes a registered name, then that
  // registered tool parses its own literal name and argument schema.
  const parseCall = Fn.cast<
    typeof parseCallRuntime,
    ToolSet<Tools>["parseCall"]
  >(parseCallRuntime)
  const executeRuntime = (call: ToolSetCall<Tools>) =>
    selectTool(call.name).pipe(
      Effect.flatMap((tool) => tool.execute(call.arguments)),
      Effect.withSpan("popcomputer.structured_chat.tool_set.execute", {
        attributes: { toolCount: tools.length },
      }),
    )
  // SAFETY: call is a parsed member of ToolSetCall<Tools>; dispatch selects
  // that member's registered runtime and passes its decoded arguments to the
  // corresponding Type-side execute operation.
  const execute = Fn.cast<
    typeof executeRuntime,
    ToolSet<Tools>["execute"]
  >(executeRuntime)
  const executeCall = (input: JsonValue) =>
    parseCall(input).pipe(Effect.flatMap(execute))

  return {
    tools,
    models: tools.map(({ model }) => model),
    parseCall,
    execute,
    // SAFETY: dispatch selects a member of Tools by its unique runtime name.
    // Each tool parses itself before executing, so the resulting union exactly
    // matches ToolSetExecution, ToolSetError, and ToolSetRequirements.
    executeCall: Fn.cast<
      typeof executeCall,
      ToolSet<Tools>["executeCall"]
    >(executeCall),
  }
}

import type { Schema } from "effect"
import { Effect } from "effect"
import type {
  InvalidToolCall,
  InvalidToolProjection,
  ModelToolDefinition,
  QueryToolDefinitionContract,
  StructuredTool,
  ToolDefinitionContract,
  ToolExecution,
  ToolCall,
  EncodedToolCallOf,
} from "./tool.js"
import type { JsonValue } from "./json-value.js"
import { compileToolRegistry } from "./tool-registry.js"

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

type ToolExecutionOf<Tool> =
  Tool extends StructuredTool<
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

type ToolCallOf<Tool> =
  Tool extends StructuredTool<
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
export type ToolSetCall<Tools extends ModelToolTuple> = ToolCallOf<
  Tools[number]
>

/** Encoded call union accepted by any member of one tool set. */
export type EncodedToolSetCall<Tools extends ModelToolTuple> =
  EncodedToolCallOf<Tools[number]>

type ToolErrorOf<Tool> =
  Tool extends StructuredTool<
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

type ToolRequirementsOf<Tool> =
  Tool extends StructuredTool<
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
export type ToolSetExecution<Tools extends ModelToolTuple> = ToolExecutionOf<
  Tools[number]
>

type ToolRunOf<Tool> =
  Tool extends StructuredTool<
    infer Name,
    infer InputSchema,
    infer ServerResult,
    infer _Error,
    infer _Requirements,
    infer ModelSchema,
    infer Presenters,
    infer _Operation
  >
    ? {
        readonly name: Name
        readonly input: Schema.Schema.Type<InputSchema>
        readonly execution: ToolExecution<ServerResult, ModelSchema, Presenters>
      }
    : never

/** Correlated call and execution union produced by one tool set. */
export type ToolSetRun<Tools extends ModelToolTuple> = ToolRunOf<Tools[number]>

/** Application failure union produced by any member of a tool set. */
export type ToolSetError<Tools extends ModelToolTuple> =
  InvalidToolCall | InvalidToolProjection | ToolErrorOf<Tools[number]>

/** Effect services required by any member of a tool set. */
export type ToolSetRequirements<Tools extends ModelToolTuple> =
  ToolRequirementsOf<Tools[number]>

/** Planning-only registry shared by query and command stages. */
export interface ToolCallPlanner<Tools extends ModelToolTuple> {
  readonly models: ReadonlyArray<ModelToolDefinition>
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolSetCall<Tools>, InvalidToolCall>
}

/** A closed, stage-safe registry of tools that may execute. */
export interface ToolSet<
  Tools extends ToolTuple,
> extends ToolCallPlanner<Tools> {
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

  /** Parse and execute one call while preserving its correlated identity. */
  readonly runCall: (
    input: JsonValue,
  ) => Effect.Effect<
    ToolSetRun<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >
}

/**
 * Define the complete set of queries available to one model step or stage.
 * Unknown, malformed and out-of-stage calls fail before application execution.
 */
export const defineToolSet = <const Tools extends ToolTuple>(
  ...tools: Tools
): ToolSet<Tools> => {
  for (const tool of tools) {
    if (tool.operation !== "query") {
      throw new Error("Repeatable tool sets accept query tools only")
    }
  }

  const registry = compileToolRegistry(tools)

  const parseCall: ToolSet<Tools>["parseCall"] = (input) =>
    registry.parseCall(input).pipe(
      Effect.withSpan("popcomputer.structured_chat.tool_set.parse", {
        attributes: { toolCount: tools.length },
      }),
    )

  const execute: ToolSet<Tools>["execute"] = (call) =>
    registry.execute(call).pipe(
      Effect.withSpan("popcomputer.structured_chat.tool_set.execute", {
        attributes: { toolCount: tools.length },
      }),
    )

  const executeCall: ToolSet<Tools>["executeCall"] = (input) =>
    parseCall(input).pipe(Effect.flatMap(execute))

  const runCall: ToolSet<Tools>["runCall"] = (input) =>
    parseCall(input).pipe(
      Effect.flatMap((call) =>
        registry.run(call).pipe(
          Effect.withSpan("popcomputer.structured_chat.tool_set.run", {
            attributes: { toolCount: tools.length },
          }),
        ),
      ),
    )

  return {
    tools,
    models: registry.models,
    parseCall,
    execute,
    executeCall,
    runCall,
  }
}

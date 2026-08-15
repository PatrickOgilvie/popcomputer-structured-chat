import {
  Effect,
  Function as Fn,
  JsonSchema,
  Pipeable,
  Result,
  Schema,
  SchemaIssue,
} from "effect"
import type {
  ViewDefinitionContract,
  ViewInput,
  ViewPart,
} from "./view.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import type { CommandId } from "./command.js"
import type { JsonValue } from "./json-value.js"

/** Stable machine-facing name for one structured chat tool. */
export const ToolNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Bounded model-facing description for one structured chat tool. */
export const ToolDescriptionSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_000),
)

/** Safe reason that a model-authored tool call was rejected. */
export const InvalidToolCallReasonSchema = Schema.Literals([
  "invalid_envelope",
  "unknown_tool",
  "invalid_arguments",
])

/** A model-authored tool call failed strict parsing. */
export class InvalidToolCall extends Schema.TaggedError<InvalidToolCall>()(
  "InvalidToolCall",
  {
    tool: Schema.NullOr(ToolNameSchema),
    reason: InvalidToolCallReasonSchema,
    path: Schema.NullOr(
      Schema.Trimmed.check(
        Schema.isNonEmpty(),
        Schema.isMaxLength(500),
      ),
    ),
  },
) {}

/** Safe reason that an application-owned tool projection was rejected. */
export const InvalidToolProjectionReasonSchema = Schema.Literals([
  "invalid_model_result",
  "invalid_view_data",
])

const StandardSchemaPathSegment = Schema.Struct({
  key: Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Symbol,
  ]),
})

const decodeStandardSchemaPathSegment =
  Schema.decodeUnknownResult(StandardSchemaPathSegment)

/** An application-owned model or view projection violated its schema. */
export class InvalidToolProjection extends Schema.TaggedError<InvalidToolProjection>()(
  "InvalidToolProjection",
  {
    tool: ToolNameSchema,
    target: Schema.String,
    reason: InvalidToolProjectionReasonSchema,
  },
) {}

/** Provider-neutral model tool definition derived from Effect Schema. */
export interface ModelToolDefinition<Name extends string = string> {
  readonly name: Name
  readonly description: string
  readonly inputSchema: JsonSchema.JsonSchema
}

/** Schema accepted at tool boundaries without runtime services. */
export type ToolSchema = Schema.Codec<unknown, unknown, never, never>

/** Whether an executable model capability is repeatable or side-effecting. */
export type ToolOperation = "query" | "command"

/** Opaque stable identity supplied when a command executes. */
export interface CommandExecutionContext {
  readonly commandId: CommandId
}

/** Minimum runtime shape retained for every structured chat tool. */
export interface ToolDefinitionContract
  extends StructuredDefinition<"tool"> {
  readonly _tag: "StructuredTool"
  readonly operation: ToolOperation
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolSchema
  readonly model: ModelToolDefinition
}

/** Minimum runtime shape retained for a repeatable read-only query. */
export interface QueryToolDefinitionContract extends ToolDefinitionContract {
  readonly operation: "query"
}

/** Minimum runtime shape retained for a side-effecting command. */
export interface CommandDefinitionContract extends ToolDefinitionContract {
  readonly operation: "command"
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolCall<string, ToolSchema>, InvalidToolCall>
}

/** One model-authored, schema-parsed tool call. */
export type ToolCall<
  Name extends string,
  InputSchema extends ToolSchema,
> = {
  readonly name: Name
  readonly arguments: Schema.Schema.Type<InputSchema>
}

/** One application-owned view projection attached to a tool. */
export interface ToolPresenter<
  ServerResult,
  View extends ViewDefinitionContract,
> {
  readonly view: View
  readonly project: (
    result: ServerResult,
  ) => ViewInput<View> | undefined
}

type PresenterView<Presenter> =
  Presenter extends ToolPresenter<infer _ServerResult, infer View>
    ? View
    : never

/** View-part union produced by one configured tool. */
export type ToolViewPart<
  Presenters extends ReadonlyArray<
    ToolPresenter<never, ViewDefinitionContract>
  >,
> = ViewPart<PresenterView<Presenters[number]>>

type ToolModelResult<
  ModelSchema extends ToolSchema | undefined,
> = ModelSchema extends ToolSchema
  ? Schema.Schema.Type<ModelSchema>
  : undefined

/** Complete trusted result of one parsed and executed tool call. */
export interface ToolExecution<
  ServerResult,
  ModelSchema extends ToolSchema | undefined,
  Presenters extends ReadonlyArray<
    ToolPresenter<ServerResult, ViewDefinitionContract>
  >,
> {
  readonly serverResult: ServerResult
  readonly modelResult: ToolModelResult<ModelSchema>
  readonly views: ReadonlyArray<ToolViewPart<Presenters>>
  readonly [toolExecutionModelContext]: string | undefined
}

interface ToolModelProjection<
  ServerResult,
  ModelSchema extends ToolSchema,
> {
  readonly schema: ModelSchema
  readonly project: (
    result: ServerResult,
  ) => Schema.Schema.Type<ModelSchema>
}

interface ToolRuntime<
  Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
  ModelSchema extends ToolSchema | undefined,
  Presenters extends ReadonlyArray<
    ToolPresenter<ServerResult, ViewDefinitionContract>
  >,
  Operation extends ToolOperation,
> {
  readonly executeServer: (
    input: Schema.Schema.Type<InputSchema>,
    context: Operation extends "command"
      ? CommandExecutionContext
      : undefined,
  ) => Effect.Effect<ServerResult, Error, Requirements>
  readonly modelProjection: ModelSchema extends ToolSchema
    ? ToolModelProjection<ServerResult, ModelSchema>
    : undefined
  readonly presenters: Presenters
  readonly callSchema: ToolSchema
  readonly name: Name
  readonly description: string
  readonly inputSchema: InputSchema
  readonly operation: Operation
}

const toolRuntime = Symbol(
  "@popcomputer/structured-chat/ToolRuntime",
)

const toolExecutionModelContext = Symbol(
  "@popcomputer/structured-chat/ToolExecutionModelContext",
)

const ToolExecutionModelContextSchema =
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(40_000),
  )

interface RuntimeToolExecutionContext {
  readonly [toolExecutionModelContext]?: string | undefined
}

/** @internal Read the bounded model-visible context retained by one execution. */
export const readToolExecutionModelContext = (
  execution: RuntimeToolExecutionContext,
): string | undefined => {
  return execution[toolExecutionModelContext]
}

/** One schema-defined, executable, and pipeable query tool. */
export interface StructuredTool<
  Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
  ModelSchema extends ToolSchema | undefined = undefined,
  Presenters extends ReadonlyArray<
    ToolPresenter<ServerResult, ViewDefinitionContract>
  > = readonly [],
  Operation extends ToolOperation = "query",
> extends Pipeable.Pipeable,
    ToolDefinitionContract {
  readonly name: Name
  readonly operation: Operation
  readonly inputSchema: InputSchema
  readonly callSchema: Schema.Schema<
    ToolCall<Name, InputSchema>
  >
  readonly model: ModelToolDefinition<Name>

  /** Parse an unknown model-authored invocation. */
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolCall<Name, InputSchema>, InvalidToolCall>

  /** Execute already-parsed arguments and produce trusted projections. */
  readonly execute: Operation extends "command"
    ? (
        input: Schema.Schema.Type<InputSchema>,
        context: CommandExecutionContext,
      ) => Effect.Effect<
        ToolExecution<ServerResult, ModelSchema, Presenters>,
        Error | InvalidToolProjection,
        Requirements
      >
    : (
        input: Schema.Schema.Type<InputSchema>,
      ) => Effect.Effect<
        ToolExecution<ServerResult, ModelSchema, Presenters>,
        Error | InvalidToolProjection,
        Requirements
      >

  /** Parse and execute one unknown model-authored invocation. */
  readonly executeCall: Operation extends "command"
    ? (
        input: JsonValue,
        context: CommandExecutionContext,
      ) => Effect.Effect<
        ToolExecution<ServerResult, ModelSchema, Presenters>,
        Error | InvalidToolCall | InvalidToolProjection,
        Requirements
      >
    : (
        input: JsonValue,
      ) => Effect.Effect<
        ToolExecution<ServerResult, ModelSchema, Presenters>,
        Error | InvalidToolCall | InvalidToolProjection,
        Requirements
      >

  readonly [toolRuntime]: ToolRuntime<
    Name,
    InputSchema,
    ServerResult,
    Error,
    Requirements,
    ModelSchema,
    Presenters,
    Operation
  >
}

/** One side-effecting capability accepted only by a terminal command stage. */
export type StructuredCommand<
  Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
  ModelSchema extends ToolSchema | undefined = undefined,
  Presenters extends ReadonlyArray<
    ToolPresenter<ServerResult, ViewDefinitionContract>
  > = readonly [],
> = StructuredTool<
  Name,
  InputSchema,
  ServerResult,
  Error,
  Requirements,
  ModelSchema,
  Presenters,
  "command"
>

/** Definition input for one read-only structured chat tool. */
export interface DefineToolInput<
  Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
> {
  readonly name: Name
  readonly description: string
  readonly input: InputSchema
  readonly execute: (
    input: Schema.Schema.Type<InputSchema>,
  ) => Effect.Effect<ServerResult, Error, Requirements>
}

/** Definition input for one idempotently executed structured command. */
export interface DefineCommandInput<
  Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
> {
  readonly name: Name
  readonly description: string
  readonly input: InputSchema
  readonly execute: (
    input: Schema.Schema.Type<InputSchema>,
    context: CommandExecutionContext,
  ) => Effect.Effect<ServerResult, Error, Requirements>
}

const parseToolCall = <
  Name extends string,
  InputSchema extends ToolSchema,
>(
  name: Name,
  callSchema: Schema.Codec<
    ToolCall<Name, InputSchema>,
    unknown,
    never,
    never
  >,
  input: JsonValue,
): Effect.Effect<ToolCall<Name, InputSchema>, InvalidToolCall> =>
  Schema.decodeUnknownEffect(callSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((error) => {
      const issue =
        SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
          .issues[0]
      const path = issue?.path ?? []
      const issuePath =
        path.length === 0
          ? "#"
          : `#/${path.map((segment) =>
              Result.match(decodeStandardSchemaPathSegment(segment), {
                onFailure: () => String(segment),
                onSuccess: ({ key }) => String(key),
              })
            ).join("/")}`

      return new InvalidToolCall({
        tool: name,
        reason: "invalid_arguments",
        path: issuePath,
      })
    }),
  )

const projectModelResult = <
  ServerResult,
  ModelSchema extends ToolSchema | undefined,
>(
  tool: string,
  projection:
    | ToolModelProjection<
        ServerResult,
        Exclude<ModelSchema, undefined>
      >
    | undefined,
  result: ServerResult,
): Effect.Effect<ToolModelResult<ModelSchema>, InvalidToolProjection> => {
  if (projection === undefined) {
    // SAFETY: The conditional result type is exactly undefined when no model
    // projection schema is configured.
    return Effect.succeed(
      Fn.cast<undefined, ToolModelResult<ModelSchema>>(undefined),
    )
  }

  const invalidProjection = () =>
    new InvalidToolProjection({
      tool,
      target: "model",
      reason: "invalid_model_result",
    })

  return Effect.try({
    try: () => projection.project(result),
    catch: invalidProjection,
  }).pipe(
    Effect.flatMap((projected) =>
      Schema.decodeEffect(Schema.toType(projection.schema))(projected, {
        onExcessProperty: "error",
      }),
    ),
    Effect.mapError(invalidProjection),
    // SAFETY: decoding the Type side returned the configured schema's exact
    // Type side, which is ToolModelResult<ModelSchema> in this branch.
    Effect.map((value) =>
      Fn.cast<typeof value, ToolModelResult<ModelSchema>>(value)
    ),
  )
}

const encodeToolExecutionModelContext = <ModelResult>(
  tool: string,
  projection:
    | { readonly schema: ToolSchema }
    | undefined,
  modelResult: ModelResult,
): Effect.Effect<string | undefined, InvalidToolProjection> => {
  if (projection === undefined) {
    return Effect.succeed(undefined)
  }

  return Schema.encodeUnknownEffect(projection.schema)(modelResult).pipe(
    Effect.flatMap((encodedResult) =>
      Schema.encodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )({
        tool,
        result: encodedResult,
      }),
    ),
    Effect.flatMap((context) =>
      Schema.decodeUnknownEffect(ToolExecutionModelContextSchema)(context),
    ),
    Effect.mapError(
      () =>
        new InvalidToolProjection({
          tool,
          target: "model_context",
          reason: "invalid_model_result",
        }),
    ),
  )
}

const projectViews = <
  ServerResult,
  Presenters extends ReadonlyArray<
    ToolPresenter<ServerResult, ViewDefinitionContract>
  >,
>(
  tool: string,
  presenters: Presenters,
  result: ServerResult,
): Effect.Effect<
  ReadonlyArray<ToolViewPart<Presenters>>,
  InvalidToolProjection
> =>
  Effect.forEach(presenters, (presenter) => {
    const invalidProjection = () =>
      new InvalidToolProjection({
        tool,
        target: presenter.view.name,
        reason: "invalid_view_data",
      })

    return Effect.try({
      try: () => presenter.project(result),
      catch: invalidProjection,
    }).pipe(
      Effect.flatMap((projected) =>
        projected === undefined
          ? Effect.succeed(undefined)
          : presenter.view.parseData(projected),
      ),
      Effect.mapError(invalidProjection),
    )
  }).pipe(
    Effect.map((parts) =>
      parts.flatMap((part) =>
        part === undefined ? [] : [part],
      ),
    ),
    Effect.map((parts) => {
      // SAFETY: Every retained part was parsed by the corresponding presenter
      // view, and the output union is derived from that same presenter tuple.
      return Fn.cast<
        typeof parts,
        ReadonlyArray<ToolViewPart<Presenters>>
      >(parts)
    }),
  )

const makeModelInputSchema = (
  schema: ToolSchema,
): JsonSchema.JsonSchema => {
  const document = JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(schema),
  )
  const definitions = Object.keys(document.definitions).length === 0
    ? {}
    : { definitions: document.definitions }

  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...definitions,
  }
}

const makeTool = <
  const Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
  ModelSchema extends ToolSchema | undefined,
  Presenters extends ReadonlyArray<
    ToolPresenter<ServerResult, ViewDefinitionContract>
  >,
  Operation extends ToolOperation,
>(
  runtime: ToolRuntime<
    Name,
    InputSchema,
    ServerResult,
    Error,
    Requirements,
    ModelSchema,
    Presenters,
    Operation
  >,
): StructuredTool<
  Name,
  InputSchema,
  ServerResult,
  Error,
  Requirements,
  ModelSchema,
  Presenters,
  Operation
> => {
  // SAFETY: ToolRuntime.callSchema is constructed from this tool's exact
  // literal name and InputSchema before makeTool is called.
  const callSchema = Fn.cast<
    typeof runtime.callSchema,
    Schema.Codec<
      ToolCall<Name, InputSchema>,
      unknown,
      never,
      never
    >
  >(runtime.callSchema)
  const parseCall = (input: JsonValue) =>
    parseToolCall(runtime.name, callSchema, input)
  const executeRuntime = (
    input: Schema.Schema.Type<InputSchema>,
    context: CommandExecutionContext | undefined,
  ) =>
    runtime.executeServer(
      input,
      // SAFETY: command constructors expose a required context while query
      // constructors expose no context; runtime.operation owns that invariant.
      Fn.cast<
        CommandExecutionContext | undefined,
        Operation extends "command"
          ? CommandExecutionContext
          : undefined
      >(context),
    ).pipe(
      Effect.flatMap((serverResult) =>
        Effect.all({
          modelResult: projectModelResult(
            runtime.name,
            runtime.modelProjection,
            serverResult,
          ),
          views: projectViews(
            runtime.name,
            runtime.presenters,
            serverResult,
          ),
        }).pipe(
          Effect.flatMap(({ modelResult, views }) =>
            encodeToolExecutionModelContext(
              runtime.name,
              runtime.modelProjection,
              modelResult,
            ).pipe(
              Effect.map((modelContext) => ({
                serverResult,
                modelResult,
                views,
                [toolExecutionModelContext]: modelContext,
              })),
            ),
          ),
        ),
      ),
      Effect.withSpan("popcomputer.structured_chat.tool.execute", {
        attributes: { tool: runtime.name },
      }),
    )
  // SAFETY: command constructors expose a required context while query
  // constructors expose no context; both feed this operation-tagged runtime.
  const execute = Fn.cast<
    typeof executeRuntime,
    StructuredTool<
      Name,
      InputSchema,
      ServerResult,
      Error,
      Requirements,
      ModelSchema,
      Presenters,
      Operation
    >["execute"]
  >(executeRuntime)
  const executeCallRuntime = (
    input: JsonValue,
    context: CommandExecutionContext | undefined,
  ) =>
    parseCall(input).pipe(
      Effect.flatMap((call) => executeRuntime(call.arguments, context)),
    )

  return structuredDefinition("tool")({
    _tag: "StructuredTool",
    operation: runtime.operation,
    name: runtime.name,
    description: runtime.description,
    inputSchema: runtime.inputSchema,
    callSchema,
    model: {
      name: runtime.name,
      description: runtime.description,
      inputSchema: makeModelInputSchema(runtime.inputSchema),
    },
    parseCall,
    execute,
    executeCall: Fn.cast<
      typeof executeCallRuntime,
      StructuredTool<
        Name,
        InputSchema,
        ServerResult,
        Error,
        Requirements,
        ModelSchema,
        Presenters,
        Operation
      >["executeCall"]
    >(executeCallRuntime),
    [toolRuntime]: runtime,
    pipe() {
      return Pipeable.pipeArguments(this, arguments)
    },
  })
}

/** Define one read-only, schema-validated structured chat tool. */
export const defineTool = <
  const Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
>(
  definition: DefineToolInput<
    Name,
    InputSchema,
    ServerResult,
    Error,
    Requirements
  >,
): StructuredTool<
  Name,
  InputSchema,
  ServerResult,
  Error,
  Requirements
> => {
  Schema.decodeSync(ToolNameSchema)(definition.name)
  Schema.decodeSync(ToolDescriptionSchema)(definition.description)
  const name = definition.name
  const description = definition.description
  const rawCallSchema = Schema.Struct({
    name: Schema.Literal(name),
    arguments: definition.input,
  })
  // SAFETY: the literal name and input schema are exactly the two ToolCall
  // fields, and the constituent schemas require no runtime context.
  const callSchema = Fn.cast<
    typeof rawCallSchema,
    Schema.Codec<ToolCall<Name, InputSchema>, unknown, never, never>
  >(rawCallSchema)

  return makeTool({
    name,
    description,
    inputSchema: definition.input,
    executeServer: (input) => definition.execute(input),
    operation: "query",
    modelProjection: undefined,
    presenters: [] as const,
    callSchema,
  })
}

/** Define one side-effecting command requiring a stable idempotency key. */
export const defineCommand = <
  const Name extends string,
  InputSchema extends ToolSchema,
  ServerResult,
  Error,
  Requirements,
>(
  definition: DefineCommandInput<
    Name,
    InputSchema,
    ServerResult,
    Error,
    Requirements
  >,
): StructuredCommand<
  Name,
  InputSchema,
  ServerResult,
  Error,
  Requirements
> => {
  Schema.decodeSync(ToolNameSchema)(definition.name)
  Schema.decodeSync(ToolDescriptionSchema)(definition.description)
  const rawCallSchema = Schema.Struct({
    name: Schema.Literal(definition.name),
    arguments: definition.input,
  })
  // SAFETY: the literal name and input schema exactly form ToolCall.
  const callSchema = Fn.cast<
    typeof rawCallSchema,
    Schema.Codec<ToolCall<Name, InputSchema>, unknown, never, never>
  >(rawCallSchema)

  return makeTool({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.input,
    executeServer: definition.execute,
    operation: "command",
    modelProjection: undefined,
    presenters: [] as const,
    callSchema,
  })
}

/** Add one bounded model-visible result projection to a tool. */
const modelResult = <
  ServerResult,
  ModelSchema extends ToolSchema,
>(
  schema: ModelSchema,
  project: (
    result: ServerResult,
  ) => Schema.Schema.Type<ModelSchema>,
) =>
  <
    Name extends string,
    InputSchema extends ToolSchema,
    Error,
    Requirements,
    Presenters extends ReadonlyArray<
      ToolPresenter<ServerResult, ViewDefinitionContract>
    >,
    Operation extends ToolOperation,
  >(
    tool: StructuredTool<
      Name,
      InputSchema,
      ServerResult,
      Error,
      Requirements,
      undefined,
      Presenters,
      Operation
    >,
  ): StructuredTool<
    Name,
    InputSchema,
    ServerResult,
    Error,
    Requirements,
    ModelSchema,
    Presenters,
    Operation
  > => {
    const runtime = tool[toolRuntime]
    const nextRuntime = {
      ...runtime,
      modelProjection: { schema, project },
    }
    // SAFETY: this combinator changes only the model-projection slot from
    // absent to the exact supplied schema and projector.
    return makeTool(
      Fn.cast<
        typeof nextRuntime,
        ToolRuntime<
          Name,
          InputSchema,
          ServerResult,
          Error,
          Requirements,
          ModelSchema,
          Presenters,
          Operation
        >
      >(nextRuntime),
    )
  }

/** Add one optional display-safe view projection to a tool. */
const present = <
  ServerResult,
  View extends ViewDefinitionContract,
>(
  view: View,
  project: (
    result: ServerResult,
  ) => ViewInput<View> | undefined,
) =>
  <
    Name extends string,
    InputSchema extends ToolSchema,
    Error,
    Requirements,
    ModelSchema extends ToolSchema | undefined,
    Presenters extends ReadonlyArray<
      ToolPresenter<ServerResult, ViewDefinitionContract>
    >,
    Operation extends ToolOperation,
  >(
    tool: StructuredTool<
      Name,
      InputSchema,
      ServerResult,
      Error,
      Requirements,
      ModelSchema,
      Presenters,
      Operation
    >,
  ): StructuredTool<
    Name,
    InputSchema,
    ServerResult,
    Error,
    Requirements,
    ModelSchema,
    readonly [
      ...Presenters,
      ToolPresenter<ServerResult, View>,
    ],
    Operation
  > => {
    const runtime = tool[toolRuntime]
    return makeTool({
      ...runtime,
      presenters: [
        ...runtime.presenters,
        { view, project },
      ],
    })
  }

/** Combinators that add optional capabilities to a structured tool. */
export const Tool = {
  modelResult,
  present,
} as const

/** Parse failure retained only for documentation of owned schema boundaries. */
export type ToolBoundaryParseError = Schema.SchemaError

import { Effect, Either, Layer, Schema } from "effect"
import {
  ChatModelUnavailable,
  StructuredChatModel,
  UnsupportedModelToolSchema,
  type ChatModelUnavailableReasonSchema,
  type StructuredChatModelService,
  type ToolModelRequest,
} from "../core/model.js"
import type { ModelToolDefinition } from "../core/tool.js"
import {
  JsonValueSchema,
  type JsonValue,
} from "../core/json-value.js"

/** Bounded timeout for one provider tool-call request. */
export const StructuredChatRequestTimeoutSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 60_000),
)

interface OpenAICompatibleMessage {
  readonly role: "system" | "user"
  readonly content: string
}

interface OpenAICompatibleTool {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: ModelToolDefinition["inputSchema"]
    readonly strict?: true
  }
}

type OpenAICompatibleInputValue =
  | JsonValue
  | ReadonlyArray<OpenAICompatibleMessage>
  | ReadonlyArray<OpenAICompatibleTool>

interface OpenAICompatibleInput {
  readonly [key: string]: OpenAICompatibleInputValue
}

const OpenAICompatibleToolArgumentsSchema = Schema.Literal(
  "guided",
  "strict",
)

type OpenAICompatibleToolArguments = Schema.Schema.Type<
  typeof OpenAICompatibleToolArgumentsSchema
>

/** Bounded provider model identifier used for routing and diagnostics. */
export const StructuredChatModelIdSchema =
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200))

/** Bounded provider model identifier used for routing and diagnostics. */
export type StructuredChatModelId = Schema.Schema.Type<
  typeof StructuredChatModelIdSchema
>

/** One provider request with its parsed model identifier. */
export interface StructuredChatProviderRequest {
  readonly model: StructuredChatModelId
  readonly input: OpenAICompatibleInput
}

interface OpenAICompatibleProviderConfig {
  readonly model: string
  readonly complete: (
    request: StructuredChatProviderRequest,
    signal: AbortSignal,
  ) => Promise<JsonValue>
  readonly requestOptions?: Readonly<Record<string, JsonValue>>
}

/** Configuration for the built-in Cloudflare Workers AI provider. */
export interface CloudflareWorkersAIProviderConfig
  extends OpenAICompatibleProviderConfig {}

/** Configuration for the built-in OpenAI provider. */
export interface OpenAIProviderConfig
  extends OpenAICompatibleProviderConfig {}

/** Stable identifier for a built-in model provider. */
export const StructuredChatProviderIdSchema = Schema.Literal(
  "cloudflare-workers-ai",
  "openai",
)

/** Stable identifier for a built-in model provider. */
export type StructuredChatProviderId = Schema.Schema.Type<
  typeof StructuredChatProviderIdSchema
>

interface StructuredChatProviderRuntime {
  readonly toolArguments: OpenAICompatibleToolArguments
  readonly complete: (
    input: OpenAICompatibleInput,
    signal: AbortSignal,
  ) => Promise<JsonValue>
  readonly requestOptions: Readonly<Record<string, JsonValue>>
}

const StructuredChatProviderRuntime = Symbol(
  "@popcomputer/structured-chat/StructuredChatProviderRuntime",
)

/** Opaque provider definition consumed by the structured model adapter. */
export interface StructuredChatProvider {
  readonly id: StructuredChatProviderId
  readonly model: StructuredChatModelId
  readonly [StructuredChatProviderRuntime]: StructuredChatProviderRuntime
}

/** Configuration for one provider-backed structured chat model. */
export interface StructuredChatModelConfig {
  readonly provider: StructuredChatProvider
  readonly timeoutMilliseconds: number
  readonly classifyError?: (
    cause: unknown,
  ) => Schema.Schema.Type<typeof ChatModelUnavailableReasonSchema>
}

const openAIModelSupportsStrictToolArguments = (
  model: StructuredChatModelId,
): boolean =>
  /^(?:chat-latest$|gpt-4o(?:-|$)|gpt-4\.1(?:-|$)|gpt-5(?:[.-]|$)|o3(?:-|$)|o4(?:-|$))/u.test(
    model,
  )

const makeProvider = (
  id: StructuredChatProviderId,
  config: OpenAICompatibleProviderConfig,
  toolArguments: OpenAICompatibleToolArguments,
): StructuredChatProvider => {
  const model = Schema.decodeSync(StructuredChatModelIdSchema)(
    config.model,
  )

  return {
    id,
    model,
    [StructuredChatProviderRuntime]: {
      toolArguments,
      requestOptions: config.requestOptions ?? {},
      complete: (input, signal) =>
        config.complete({ model, input }, signal),
    },
  }
}

/** Built-in provider definitions that own their tool-call guarantees. */
export const ModelProvider = {
  /**
   * Define a Cloudflare Workers AI model.
   *
   * Workers AI schemas guide generation but are always validated after the
   * response because Cloudflare does not guarantee schema-constrained output.
   */
  cloudflareWorkersAI: (
    config: CloudflareWorkersAIProviderConfig,
  ): StructuredChatProvider =>
    makeProvider("cloudflare-workers-ai", config, "guided"),

  /**
   * Define an OpenAI model.
   *
   * Known Structured Outputs model families use strict function arguments.
   * Unknown and older model identifiers conservatively use schema guidance.
   */
  openAI: (
    config: OpenAIProviderConfig,
  ): StructuredChatProvider => {
    const model = Schema.decodeSync(StructuredChatModelIdSchema)(
      config.model,
    )

    return makeProvider(
      "openai",
      { ...config, model },
      openAIModelSupportsStrictToolArguments(model)
        ? "strict"
        : "guided",
    )
  },
} as const

const ToolCallResponseSchema = Schema.Struct({
  choices: Schema.Tuple(
    Schema.Struct({
      message: Schema.Struct({
        tool_calls: Schema.Tuple(
          Schema.Struct({
            function: Schema.Struct({
              name: Schema.NonEmptyTrimmedString.pipe(
                Schema.maxLength(100),
              ),
              arguments: Schema.String.pipe(
                Schema.maxLength(20_000),
              ),
            }),
          }),
        ),
      }),
    }),
  ),
})

const unavailable = (
  reason: Schema.Schema.Type<
    typeof ChatModelUnavailableReasonSchema
  >,
) => new ChatModelUnavailable({ reason })

const parseJson = (
  input: string,
): Effect.Effect<JsonValue, ChatModelUnavailable> =>
  Effect.try({
    // SAFETY: JSON.parse without a reviver can only return a JSON value when
    // parsing succeeds; failures are mapped to the typed unavailable reason.
    try: (): JsonValue => JSON.parse(input) as JsonValue,
    catch: () => unavailable("invalid_response"),
  })

const JsonSchemaObjectSchema = Schema.Record({
  key: Schema.String,
  value: JsonValueSchema,
})

type JsonSchemaObject = Schema.Schema.Type<typeof JsonSchemaObjectSchema>

interface StrictSchemaIssue {
  readonly path: string
  readonly reason:
    | "root_not_object"
    | "additional_properties_allowed"
    | "optional_property"
}

const isJsonSchemaObject = (
  value: JsonValue | undefined,
): value is JsonSchemaObject =>
  Schema.is(JsonSchemaObjectSchema)(value)

const appendJsonPointer = (path: string, segment: string): string =>
  `${path}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`

const findStrictObjectIssue = (
  schema: JsonSchemaObject,
  path: string,
): StrictSchemaIssue | undefined => {
  const objectSchema =
    schema.type === "object" || isJsonSchemaObject(schema.properties)

  if (objectSchema) {
    if (schema.additionalProperties !== false) {
      return {
        path,
        reason: "additional_properties_allowed",
      }
    }

    const properties = isJsonSchemaObject(schema.properties)
      ? schema.properties
      : {}
    const required = Array.isArray(schema.required)
      ? new Set(
          schema.required.filter(
            Schema.is(Schema.String),
          ),
        )
      : new Set<string>()

    for (const property of Object.keys(properties)) {
      if (!required.has(property)) {
        return {
          path: appendJsonPointer(
            appendJsonPointer(path, "properties"),
            property,
          ),
          reason: "optional_property",
        }
      }
    }

    for (const [property, propertySchema] of Object.entries(properties)) {
      if (!isJsonSchemaObject(propertySchema)) {
        continue
      }
      const issue = findStrictObjectIssue(
        propertySchema,
        appendJsonPointer(
          appendJsonPointer(path, "properties"),
          property,
        ),
      )
      if (issue !== undefined) {
        return issue
      }
    }
  }

  for (const definitionKey of ["$defs", "definitions"] as const) {
    const definitions = schema[definitionKey]
    if (!isJsonSchemaObject(definitions)) {
      continue
    }
    for (const [name, definition] of Object.entries(definitions)) {
      if (!isJsonSchemaObject(definition)) {
        continue
      }
      const issue = findStrictObjectIssue(
        definition,
        appendJsonPointer(
          appendJsonPointer(path, definitionKey),
          name,
        ),
      )
      if (issue !== undefined) {
        return issue
      }
    }
  }

  for (const unionKey of ["allOf", "anyOf", "oneOf"] as const) {
    const members = schema[unionKey]
    if (!Array.isArray(members)) {
      continue
    }
    for (const [index, member] of members.entries()) {
      if (!isJsonSchemaObject(member)) {
        continue
      }
      const issue = findStrictObjectIssue(
        member,
        appendJsonPointer(appendJsonPointer(path, unionKey), String(index)),
      )
      if (issue !== undefined) {
        return issue
      }
    }
  }

  const items = schema.items
  if (isJsonSchemaObject(items)) {
    return findStrictObjectIssue(items, appendJsonPointer(path, "items"))
  }

  return undefined
}

const findStrictSchemaIssue = (
  schema: JsonSchemaObject,
): StrictSchemaIssue | undefined => {
  if (schema.type !== "object") {
    return { path: "#", reason: "root_not_object" }
  }

  return findStrictObjectIssue(schema, "#")
}

const strictToolIssue = (
  tool: ModelToolDefinition,
): UnsupportedModelToolSchema | undefined => {
  const parsedSchema = Schema.decodeUnknownEither(JsonSchemaObjectSchema)(
    tool.inputSchema,
    { onExcessProperty: "error" },
  )
  if (Either.isLeft(parsedSchema)) {
    return new UnsupportedModelToolSchema({
      tool: tool.name,
      path: "#",
      reason: "root_not_object",
    })
  }

  const issue = findStrictSchemaIssue(parsedSchema.right)
  return issue === undefined
    ? undefined
    : new UnsupportedModelToolSchema({
        tool: tool.name,
        path: issue.path,
        reason: issue.reason,
      })
}

const toProviderTool = (
  tool: ModelToolDefinition,
  toolArguments: OpenAICompatibleToolArguments,
): OpenAICompatibleTool => ({
  type: "function",
  function:
    toolArguments === "strict"
      ? {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: true,
        }
      : {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
})

const toProviderInput = (
  request: ToolModelRequest,
  requestOptions: Readonly<Record<string, JsonValue>>,
  toolArguments: OpenAICompatibleToolArguments,
): Effect.Effect<OpenAICompatibleInput, UnsupportedModelToolSchema> => {
  if (toolArguments === "strict") {
    const unsupported = request.tools
      .map(strictToolIssue)
      .find((issue) => issue !== undefined)
    if (unsupported !== undefined) {
      return Effect.fail(unsupported)
    }
  }

  return Effect.succeed({
    ...requestOptions,
    messages: [
      {
        role: "system",
        content: request.instructions.join("\n\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          untrustedConversation: request.untrustedMessages,
        }),
      },
    ],
    tools: request.tools.map((tool) =>
      toProviderTool(tool, toolArguments),
    ),
    tool_choice: "required",
    parallel_tool_calls: false,
    stream: false,
  })
}

/** Build a structured chat model around one provider definition. */
export const makeStructuredChatModel = (
  config: StructuredChatModelConfig,
): StructuredChatModelService => {
  const timeoutMilliseconds = Schema.decodeSync(
    StructuredChatRequestTimeoutSchema,
  )(config.timeoutMilliseconds)
  const runtime = config.provider[StructuredChatProviderRuntime]
  const classifyError =
    config.classifyError ?? (() => "request_failed" as const)

  return {
    requestTool: (request) =>
      toProviderInput(
        request,
        runtime.requestOptions,
        runtime.toolArguments,
      ).pipe(
        Effect.flatMap((input) =>
          Effect.tryPromise({
            try: (signal) => runtime.complete(input, signal),
            catch: (cause) => unavailable(classifyError(cause)),
          }),
        ),
        Effect.timeoutFail({
          duration: timeoutMilliseconds,
          onTimeout: () => unavailable("timed_out"),
        }),
        Effect.flatMap((response) =>
          Schema.decodeUnknown(ToolCallResponseSchema)(response).pipe(
            Effect.mapError(() => unavailable("invalid_response")),
          ),
        ),
        Effect.flatMap((response) => {
          const tool =
            response.choices[0].message.tool_calls[0].function

          return parseJson(tool.arguments).pipe(
            Effect.map((arguments_) => ({
              name: tool.name,
              arguments: arguments_,
            })),
          )
        }),
      ),
  }
}

/** Build an Effect layer for one provider-backed structured chat model. */
export const structuredChatModelLayer = (
  config: StructuredChatModelConfig,
): Layer.Layer<StructuredChatModel> =>
  Layer.succeed(
    StructuredChatModel,
    makeStructuredChatModel(config),
  )

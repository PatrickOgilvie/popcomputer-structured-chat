import {
  Effect,
  Exit,
  JsonSchema,
  Layer,
  Result,
  Schema,
} from "effect"
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
export const StructuredChatRequestTimeoutSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 60_000 }),
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

const OpenAICompatibleToolArgumentsSchema = Schema.Literals([
  "guided",
  "strict",
])

type OpenAICompatibleToolArguments = Schema.Schema.Type<
  typeof OpenAICompatibleToolArgumentsSchema
>

/** Bounded provider model identifier used for routing and diagnostics. */
export const StructuredChatModelIdSchema =
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(200),
  )

/** Bounded provider model identifier used for routing and diagnostics. */
export type StructuredChatModelId = Schema.Schema.Type<
  typeof StructuredChatModelIdSchema
>

/** One provider request with its parsed model identifier. */
export interface StructuredChatProviderRequest {
  readonly model: StructuredChatModelId
  readonly input: OpenAICompatibleInput
}

/**
 * One provider-facing view of an outgoing tool, built from the tool's derived
 * JSON Schema at request-serialization time.
 *
 * `derivedSchema` is the same document the adapter would send without an
 * override, including the synthesized collect-stage answer tool. Overrides are
 * guidance-only: responses keep being validated against the original Effect
 * Schemas.
 */
export interface ProviderToolSchemaView {
  readonly name: string
  readonly description: string
  readonly derivedSchema: JsonSchema.JsonSchema
}

/**
 * Optional per-tool guidance schema hook applied before transport.
 *
 * Returning `undefined` keeps the derived schema. A returned schema replaces
 * the derived one in the outgoing envelope after preflight validation: its
 * root must be an object schema, otherwise the request fails before transport
 * with `UnsupportedModelToolSchema` reason `invalid_guidance_override`.
 */
export type GuidanceSchemaOverride = (
  tool: ProviderToolSchemaView,
) => JsonSchema.JsonSchema | undefined

interface OpenAICompatibleProviderConfig {
  readonly model: string
  readonly complete: (
    request: StructuredChatProviderRequest,
    signal: AbortSignal,
  ) => Promise<JsonValue>
  readonly requestOptions?: Readonly<Record<string, JsonValue>>
  /**
   * Optional per-tool guidance schema hook applied to every outgoing tool,
   * including the synthesized collect-stage answer tool.
   *
   * Returning `undefined` keeps the derived schema. A returned schema replaces
   * the derived one in the outgoing envelope after preflight validation.
   * Overrides are guidance-only: responses keep being validated against the
   * original Effect Schemas.
   */
  readonly guidanceSchemaOverride?: GuidanceSchemaOverride
}

/** Configuration for the built-in Cloudflare Workers AI provider. */
export interface CloudflareWorkersAIProviderConfig
  extends OpenAICompatibleProviderConfig {}

/** Configuration for the built-in OpenAI provider. */
export interface OpenAIProviderConfig
  extends OpenAICompatibleProviderConfig {}

/** Stable identifier for a built-in model provider. */
export const StructuredChatProviderIdSchema = Schema.Literals([
  "cloudflare-workers-ai",
  "openai",
])

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
  readonly guidanceSchemaOverride: GuidanceSchemaOverride | undefined
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

/** Safe reason that a configured chat model could not complete a step. */
type ChatModelUnavailableReason = Schema.Schema.Type<
  typeof ChatModelUnavailableReasonSchema
>

/** Bounded retry policy applied to provider transport attempts. */
export interface StructuredChatModelRetryPolicy {
  /** Maximum total attempts including the first. */
  readonly maximumAttempts: 1 | 2 | 3
  /** Transport failure reasons eligible for retry. */
  readonly retryableReasons: ReadonlyArray<
    Exclude<
      ChatModelUnavailableReason,
      "invalid_response" | "response_blocked"
    >
  >
  /** Fixed delay between attempts, bounded 0..1000 ms. */
  readonly delayMilliseconds?: number
}

const RetryMaximumAttemptsSchema = Schema.Literals([1, 2, 3])

const RetryDelaySchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 1_000 }),
)

/** Configuration for one provider-backed structured chat model. */
export interface StructuredChatModelConfig {
  readonly provider: StructuredChatProvider
  readonly timeoutMilliseconds: number
  readonly classifyError?: (
    cause: unknown,
  ) => ChatModelUnavailableReason
  readonly retry?: StructuredChatModelRetryPolicy
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
      guidanceSchemaOverride: config.guidanceSchemaOverride,
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
  choices: Schema.Tuple([
    Schema.Struct({
      message: Schema.Struct({
        tool_calls: Schema.Tuple([
          Schema.Struct({
            function: Schema.Struct({
              name: Schema.Trimmed.check(
                Schema.isNonEmpty(),
                Schema.isMaxLength(100),
              ),
              arguments: Schema.String.check(
                Schema.isMaxLength(20_000),
              ),
            }),
          }),
        ]),
      }),
    }),
  ]),
})

const unavailable = (
  reason: Schema.Schema.Type<
    typeof ChatModelUnavailableReasonSchema
  >,
) => new ChatModelUnavailable({ reason })

const parseJson = (
  input: string,
): Effect.Effect<JsonValue, ChatModelUnavailable> =>
  Schema.decodeEffect(Schema.fromJsonString(JsonValueSchema))(input).pipe(
    Effect.mapError(() => unavailable("invalid_response")),
  )

const JsonSchemaObjectSchema = Schema.Record(
  Schema.String,
  JsonValueSchema,
)

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

const parseSchemaDocument = Schema.decodeUnknownExit(
  JsonSchemaObjectSchema,
  { onExcessProperty: "error" },
)

const strictDocumentIssue = (
  toolName: string,
  document: JsonSchemaObject,
): UnsupportedModelToolSchema | undefined => {
  const issue = findStrictSchemaIssue(document)
  return issue === undefined
    ? undefined
    : new UnsupportedModelToolSchema({
        tool: toolName,
        path: issue.path,
        reason: issue.reason,
      })
}

const strictToolIssue = (
  tool: ModelToolDefinition,
): UnsupportedModelToolSchema | undefined => {
  const parsedSchema = parseSchemaDocument(tool.inputSchema)
  if (Exit.isFailure(parsedSchema)) {
    return new UnsupportedModelToolSchema({
      tool: tool.name,
      path: "#",
      reason: "root_not_object",
    })
  }

  return strictDocumentIssue(tool.name, parsedSchema.value)
}

/**
 * Validate one application-supplied guidance override before transport.
 *
 * An override must be an object-rooted JSON Schema document, mirroring the
 * root requirement for derived constrained-provider schemas. Any other shape
 * fails with reason `invalid_guidance_override` before any transport call.
 */
const parseGuidanceOverride = (
  toolName: string,
  overridden: JsonSchema.JsonSchema,
): Result.Result<JsonSchemaObject, UnsupportedModelToolSchema> => {
  const parsedSchema = parseSchemaDocument(overridden)
  if (
    Exit.isFailure(parsedSchema) ||
    parsedSchema.value.type !== "object"
  ) {
    return Result.fail(
      new UnsupportedModelToolSchema({
        tool: toolName,
        path: "#",
        reason: "invalid_guidance_override",
      }),
    )
  }
  return Result.succeed(parsedSchema.value)
}

const toProviderTool = (
  tool: ModelToolDefinition,
  parameters: JsonSchema.JsonSchema,
  toolArguments: OpenAICompatibleToolArguments,
): OpenAICompatibleTool => ({
  type: "function",
  function:
    toolArguments === "strict"
      ? {
          name: tool.name,
          description: tool.description,
          parameters,
          strict: true,
        }
      : {
          name: tool.name,
          description: tool.description,
          parameters,
        },
})

/**
 * Serialize every outgoing tool, applying the guidance override hook first.
 *
 * The hook sees one view per tool — including the synthesized collect-stage
 * answer tool — and may keep the derived schema by returning `undefined`.
 * Strict-mode compatibility checks run on the post-override document.
 */
const serializeProviderTools = (
  request: ToolModelRequest,
  toolArguments: OpenAICompatibleToolArguments,
  guidanceSchemaOverride: GuidanceSchemaOverride | undefined,
): Effect.Effect<
  ReadonlyArray<OpenAICompatibleTool>,
  UnsupportedModelToolSchema
> => {
  const tools: Array<OpenAICompatibleTool> = []
  for (const tool of request.tools) {
    const view: ProviderToolSchemaView = {
      name: tool.name,
      description: tool.description,
      derivedSchema: tool.inputSchema,
    }
    const overridden = guidanceSchemaOverride?.(view)
    let parameters: JsonSchema.JsonSchema = tool.inputSchema
    let issue: UnsupportedModelToolSchema | undefined
    if (overridden === undefined) {
      issue =
        toolArguments === "strict" ? strictToolIssue(tool) : undefined
    } else {
      parameters = overridden
      const parsedOverride = parseGuidanceOverride(tool.name, overridden)
      if (Result.isFailure(parsedOverride)) {
        return Effect.fail(parsedOverride.failure)
      }
      issue =
        toolArguments === "strict"
          ? strictDocumentIssue(tool.name, parsedOverride.success)
          : undefined
    }
    if (issue !== undefined) {
      return Effect.fail(issue)
    }
    tools.push(toProviderTool(tool, parameters, toolArguments))
  }
  return Effect.succeed(tools)
}

const toProviderInput = (
  request: ToolModelRequest,
  requestOptions: Readonly<Record<string, JsonValue>>,
  toolArguments: OpenAICompatibleToolArguments,
  guidanceSchemaOverride: GuidanceSchemaOverride | undefined,
): Effect.Effect<OpenAICompatibleInput, UnsupportedModelToolSchema> =>
  serializeProviderTools(
    request,
    toolArguments,
    guidanceSchemaOverride,
  ).pipe(
    Effect.map((tools) => ({
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
      tools,
      tool_choice: "required",
      parallel_tool_calls: false,
      stream: false,
    })),
  )

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

  const maximumAttempts =
    config.retry === undefined
      ? 1
      : Schema.decodeSync(RetryMaximumAttemptsSchema)(
          config.retry.maximumAttempts,
        )
  // SAFETY: blocked and invalid responses are excluded at the type level; this
  // runtime filter keeps hand-written or untyped configurations fail-closed.
  const isConfiguredRetryable = (
    reason: ChatModelUnavailableReason,
  ): boolean =>
    reason !== "response_blocked" && reason !== "invalid_response"
  const retryableReasons = new Set<ChatModelUnavailableReason>()
  if (config.retry !== undefined) {
    for (const reason of config.retry.retryableReasons) {
      if (isConfiguredRetryable(reason)) {
        retryableReasons.add(reason)
      }
    }
  }
  const delayMilliseconds =
    config.retry?.delayMilliseconds === undefined
      ? 0
      : Schema.decodeSync(RetryDelaySchema)(
          config.retry.delayMilliseconds,
        )

  const parseProviderResponse = (response: JsonValue) =>
    Schema.decodeUnknownEffect(ToolCallResponseSchema)(response).pipe(
      Effect.mapError(() => unavailable("invalid_response")),
    )

  /** One transport-plus-envelope attempt, bounded by the request timeout. */
  const attemptProviderCall = (input: OpenAICompatibleInput) =>
    Effect.tryPromise({
      try: (signal) => runtime.complete(input, signal),
      catch: (cause) => unavailable(classifyError(cause)),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMilliseconds,
        orElse: () => Effect.fail(unavailable("timed_out")),
      }),
      Effect.flatMap(parseProviderResponse),
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
    )

  const isRetryableUnavailable = (
    error: ChatModelUnavailable,
  ): boolean => retryableReasons.has(error.reason)

  /**
   * Retry only the transport and envelope region. Guards and strict-schema
   * parsing stay outside, and interruption never becomes a classified
   * failure.
   */
  const attemptParsedCall = (
    input: OpenAICompatibleInput,
    attemptNumber: number,
    remainingAttempts: number,
  ): Effect.Effect<
    { readonly name: string; readonly arguments: JsonValue },
    ChatModelUnavailable
  > =>
    Effect.suspend(() => {
      const once = attemptProviderCall(input)
      // Content-free observability: the attempt count is annotated only for
      // follow-up attempts; reasons stay behind the stable failure tag.
      const annotatedOnce =
        attemptNumber > 1
          ? once.pipe(
              Effect.withSpan(
                "popcomputer.structured_chat.model.attempt",
                { attributes: { attempt: attemptNumber } },
              ),
            )
            : once
      return annotatedOnce.pipe(
        Effect.catchIf(isRetryableUnavailable, (error) =>
          remainingAttempts <= 0
            ? Effect.fail(error)
            : Effect.sleep(delayMilliseconds).pipe(
                Effect.andThen(() =>
                  attemptParsedCall(
                    input,
                    attemptNumber + 1,
                    remainingAttempts - 1,
                  ),
                ),
              ),
        ),
      )
    })

  return {
    requestTool: (request) =>
      toProviderInput(
        request,
        runtime.requestOptions,
        runtime.toolArguments,
        runtime.guidanceSchemaOverride,
      ).pipe(
        Effect.flatMap((input) =>
          attemptParsedCall(input, 1, maximumAttempts - 1),
        ),
      ),
  }
}

/** Build an Effect layer for one provider-backed structured chat model. */
export const structuredChatModelLayer = (
  config: StructuredChatModelConfig,
): Layer.Layer<StructuredChatModel> =>
  Layer.succeed(
    StructuredChatModel,
    StructuredChatModel.of(makeStructuredChatModel(config)),
  )

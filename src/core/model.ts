import { Context, Effect, Schema } from "effect"
import type {
  InvalidToolCall,
  ModelToolDefinition,
} from "./tool.js"
import {
  runModelCallGuards,
  runModelGuards,
  type ModelGuardError,
  type ModelGuardRequirements,
  type ModelGuardTuple,
} from "./model-guard.js"
import type {
  ToolSet,
  ToolSetCall,
  ToolSetError,
  ToolSetExecution,
  ToolSetRequirements,
  ModelToolTuple,
  ToolCallPlanner,
  ToolTuple,
} from "./tool-set.js"
import type { JsonValue } from "./json-value.js"

/** Bounded application-authored instruction supplied to a model adapter. */
export const TrustedInstructionSchema =
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(20_000),
  ).pipe(
    Schema.brand("TrustedInstruction"),
  )

/** Bounded application-authored instruction supplied to a model adapter. */
export type TrustedInstruction = Schema.Schema.Type<
  typeof TrustedInstructionSchema
>

/** Conversation role accepted as untrusted model context. */
export const ConversationRoleSchema = Schema.Literals([
  "user",
  "assistant",
])

/** One bounded conversation message treated as untrusted model context. */
export const UntrustedMessageSchema = Schema.Struct({
  role: ConversationRoleSchema,
  content: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(50_000),
  ),
})

/** One bounded conversation message treated as untrusted model context. */
export type UntrustedMessage = Schema.Schema.Type<
  typeof UntrustedMessageSchema
>

/** @internal Exact content-character count for bounded message arrays. */
export const countUntrustedMessageCharacters = (
  messages: ReadonlyArray<UntrustedMessage>,
): number =>
  messages.reduce(
    (total, message) => total + message.content.length,
    0,
  )

/** Safe reason that a configured chat model could not complete a step. */
export const ChatModelUnavailableReasonSchema = Schema.Literals([
  "request_failed",
  "timed_out",
  "response_blocked",
  "invalid_response",
])

/** A configured chat model could not complete a structured step. */
export class ChatModelUnavailable extends Schema.TaggedError<ChatModelUnavailable>()(
  "ChatModelUnavailable",
  { reason: ChatModelUnavailableReasonSchema },
) {}

/** Safe reason that a tool schema cannot guide or constrain a provider call. */
export const UnsupportedModelToolSchemaReasonSchema = Schema.Literals([
  "root_not_object",
  "additional_properties_allowed",
  "optional_property",
  "invalid_guidance_override",
])

/** A model tool schema is incompatible with provider schema guidance. */
export class UnsupportedModelToolSchema extends Schema.TaggedError<UnsupportedModelToolSchema>()(
  "UnsupportedModelToolSchema",
  {
    tool: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(100),
    ),
    path: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(2_000),
    ),
    reason: UnsupportedModelToolSchemaReasonSchema,
  },
) {}

/** Provider-neutral request for exactly one model-authored tool call. */
export interface ToolModelRequest {
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly untrustedMessages: ReadonlyArray<UntrustedMessage>
  readonly tools: ReadonlyArray<ModelToolDefinition>
  readonly toolChoice: "required"
  readonly maximumToolCalls: 1
  readonly parallelToolCalls: false
}

/** Narrow provider seam used by structured chat model steps. */
export interface StructuredChatModelService {
  /** Return one untrusted provider tool call for runtime validation. */
  readonly requestTool: (
    request: ToolModelRequest,
  ) => Effect.Effect<
    JsonValue,
    ChatModelUnavailable | UnsupportedModelToolSchema
  >
}

/** Effect service for the configured structured chat model adapter. */
export class StructuredChatModel extends Context.Service<
  StructuredChatModel,
  StructuredChatModelService
>()(
  "@popcomputer/structured-chat/StructuredChatModel",
) {}

/** Input for one required, stage-scoped tool step. */
export interface RunToolStepInput<
  Tools extends ToolTuple,
  Guards extends ModelGuardTuple = readonly [],
> {
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly tools: ToolSet<Tools>
  readonly guards?: Guards
}

interface PlanToolCallInput<
  Tools extends ModelToolTuple,
  Guards extends ModelGuardTuple,
> {
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly tools: ToolCallPlanner<Tools>
  readonly guards?: Guards
}

const invalidOutputRepairInstruction = Schema.decodeSync(
  TrustedInstructionSchema,
)(
  "Your previous response did not satisfy the required tool-call contract. Call exactly one listed tool and return only arguments allowed by its JSON Schema.",
)

const isRepairableModelOutput = (
  error:
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | InvalidToolCall,
): boolean =>
  error._tag === "InvalidToolCall" ||
  (error._tag === "ChatModelUnavailable" &&
    error.reason === "invalid_response")

/** @internal Plan one strictly parsed and guarded call to a closed tool set. */
export const planToolCall = <
  const Tools extends ModelToolTuple,
  const Guards extends ModelGuardTuple = readonly [],
>(
  input: PlanToolCallInput<Tools, Guards>,
): Effect.Effect<
  ToolSetCall<Tools>,
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | InvalidToolCall
  | ModelGuardError<Guards>,
  StructuredChatModel | ModelGuardRequirements<Guards>
> =>
  runModelGuards(input.guards ?? [], {
    messages: input.messages,
    toolNames: input.tools.models.map(({ name }) => name),
  }).pipe(
    Effect.andThen(StructuredChatModel),
    Effect.flatMap((model) => {
      const requestParsedCall = (
        instructions: ReadonlyArray<TrustedInstruction>,
        attempt: 1 | 2,
      ) =>
        model
          .requestTool({
            instructions,
            untrustedMessages: input.messages,
            tools: input.tools.models,
            toolChoice: "required",
            maximumToolCalls: 1,
            parallelToolCalls: false,
          })
          .pipe(
            Effect.withSpan(
              "popcomputer.structured_chat.model.request",
              {
                attributes: {
                  attempt,
                  messageCount: input.messages.length,
                  messageCharacterCount:
                    countUntrustedMessageCharacters(input.messages),
                  instructionCount: instructions.length,
                  toolCount: input.tools.models.length,
                },
              },
            ),
            Effect.flatMap(input.tools.parseCall),
          )

      return requestParsedCall(input.instructions, 1).pipe(
        Effect.catchIf(isRepairableModelOutput, (error) => {
          const annotations =
            error._tag === "InvalidToolCall" && error.path !== null
              ? {
                  attempt: 2,
                  errorTag: error._tag,
                  errorReason: error.reason,
                  errorPath: error.path,
                }
              : {
                  attempt: 2,
                  errorTag: error._tag,
                  errorReason: error.reason,
                }
          return Effect.logWarning(
            "Retrying structured model output",
          ).pipe(
            Effect.annotateLogs(annotations),
            Effect.andThen(
              requestParsedCall(
                [
                  ...input.instructions,
                  invalidOutputRepairInstruction,
                ],
                2,
              ),
            ),
          )
        }),
      )
    }),
    Effect.tap((call) =>
      runModelCallGuards(input.guards ?? [], {
        messages: input.messages,
        toolNames: input.tools.models.map(({ name }) => name),
        call,
      }),
    ),
    Effect.withSpan("popcomputer.structured_chat.tool_step.plan", {
      attributes: {
        messageCount: input.messages.length,
        toolCount: input.tools.models.length,
      },
    }),
  )

/**
 * Ask the configured model for one call to a closed tool set, then execute it.
 *
 * One contract-invalid model output may trigger a bounded repair request
 * before any application tool executes. Model-visible results are returned to
 * the application and are never sent through another model request.
 */
export const runToolStep = <
  const Tools extends ToolTuple,
  const Guards extends ModelGuardTuple = readonly [],
>(
  input: RunToolStepInput<Tools, Guards>,
): Effect.Effect<
  ToolSetExecution<Tools>,
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | ToolSetError<Tools>
  | ModelGuardError<Guards>,
  | StructuredChatModel
  | ToolSetRequirements<Tools>
  | ModelGuardRequirements<Guards>
> =>
  planToolCall(input).pipe(
    Effect.flatMap(input.tools.execute),
    Effect.withSpan("popcomputer.structured_chat.tool_step.run", {
      attributes: {
        messageCount: input.messages.length,
        toolCount: input.tools.models.length,
      },
    }),
  )

const makeInstruction = (value: string): TrustedInstruction =>
  Schema.decodeSync(TrustedInstructionSchema)(value)

const makeMessage = (
  role: UntrustedMessage["role"],
  content: string,
): UntrustedMessage =>
  Schema.decodeSync(UntrustedMessageSchema)({ role, content })

/** Constructors that explicitly mark static application instructions. */
export const Instruction = {
  make: makeInstruction,
} as const

/** Constructors that explicitly mark conversation text as untrusted. */
export const Message = {
  user: (content: string) => makeMessage("user", content),
  assistant: (content: string) => makeMessage("assistant", content),
} as const

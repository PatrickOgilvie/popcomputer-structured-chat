import { Context, Effect, Function as Fn, Schema } from "effect"
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
import { recordLatestDebugModelOutputRejected } from "./debug-trace.js"

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

const ModelProfileTypeId: unique symbol = Symbol.for(
  "@popcomputer/structured-chat/ModelProfile",
)

/** Stable machine-facing name for one named model profile. */
export const ModelProfileNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(
    /^(?!default$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
  ),
)

/** Stable machine-facing name for one named model profile. */
export type ModelProfileName = Schema.Schema.Type<
  typeof ModelProfileNameSchema
>

/** Named provider-neutral Effect service key for one model configuration. */
export interface ModelProfile<Name extends string>
  extends Context.Service<
    ModelProfile<Name>,
    StructuredChatModelService
  > {
  readonly _tag: "ModelProfile"
  readonly profile: Name
  readonly [ModelProfileTypeId]: typeof ModelProfileTypeId
}

/** Any authentic named model-profile service key. */
export type AnyModelProfile = Context.Key<
  unknown,
  StructuredChatModelService
> & {
  readonly _tag: "ModelProfile"
  readonly profile: string
  readonly [ModelProfileTypeId]: typeof ModelProfileTypeId
}

type IsUnion<Value, Whole = Value> = Value extends unknown
  ? [Whole] extends [Value]
    ? false
    : true
  : never

type ConcreteModelProfileName<Name extends string> =
  string extends Name
    ? never
    : true extends IsUnion<Name>
      ? never
      : Record<never, never> extends Record<Name, never>
        ? never
        : Name

/** @internal One exact, non-erased model-profile service identity. */
export type ExactModelProfile<Profile extends AnyModelProfile> =
  true extends IsUnion<Profile>
    ? never
    : ConcreteModelProfileName<Profile["profile"]> extends never
      ? never
      : unknown extends Context.Service.Identifier<Profile>
        ? never
        : Profile

/** Define or reference one named model profile. */
export const defineModelProfile = <const Name extends string>(
  name: ConcreteModelProfileName<Name>,
): ModelProfile<Name> => {
  const profileName = Schema.decodeSync(ModelProfileNameSchema)(name)
  const service = Context.Service<
    ModelProfile<Name>,
    StructuredChatModelService
  >(
    `@popcomputer/structured-chat/ModelProfile/${profileName}`,
  )

  Object.defineProperties(service, {
    _tag: {
      value: "ModelProfile",
      enumerable: true,
      configurable: false,
      writable: false,
    },
    profile: {
      value: profileName,
      enumerable: true,
      configurable: false,
      writable: false,
    },
    [ModelProfileTypeId]: {
      value: ModelProfileTypeId,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  })

  // SAFETY: the schema only refines the literal input; defineProperties adds
  // the exact parsed name and private runtime proof to this Context key.
  return Fn.cast<typeof service, ModelProfile<Name>>(service)
}

/** Sound stage/model input: omission is legal only for the default profile. */
export type ModelProfileInput<
  Profile extends AnyModelProfile | undefined,
> = [Profile] extends [never]
  ? never
  : true extends IsUnion<Profile>
    ? never
    : [Profile] extends [undefined]
      ? { readonly model?: undefined }
      : {
          readonly model: Profile &
            ExactModelProfile<Extract<Profile, AnyModelProfile>>
        }

/** Effect requirement selected by an optional named model profile. */
export type ModelRequirement<
  Profile extends AnyModelProfile | undefined,
> = Profile extends AnyModelProfile
  ? Context.Service.Identifier<Profile>
  : StructuredChatModel

const resolveModel = <
  const Profile extends AnyModelProfile | undefined,
>(
  selected: Profile,
): Effect.Effect<
  StructuredChatModelService,
  never,
  ModelRequirement<Profile>
> => {
  if (selected === undefined) {
    // SAFETY: undefined is the only default selection and therefore requires
    // the existing StructuredChatModel service.
    return Fn.cast<
      typeof StructuredChatModel,
      Effect.Effect<
        StructuredChatModelService,
        never,
        ModelRequirement<Profile>
      >
    >(StructuredChatModel)
  }

  // SAFETY: a selected profile is itself the exact Context key whose
  // identifier is represented by ModelRequirement<Profile>.
  return Fn.cast<
    typeof selected,
    Effect.Effect<
      StructuredChatModelService,
      never,
      ModelRequirement<Profile>
    >
  >(selected)
}

/** Input for one required, stage-scoped tool step. */
export type RunToolStepInput<
  Tools extends ToolTuple,
  Guards extends ModelGuardTuple = readonly [],
  Profile extends AnyModelProfile | undefined = undefined,
> = {
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly tools: ToolSet<Tools>
  readonly guards?: Guards
} & ModelProfileInput<Profile>

type PlanToolCallInput<
  Tools extends ModelToolTuple,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined,
> = {
  readonly instructions: ReadonlyArray<TrustedInstruction>
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly tools: ToolCallPlanner<Tools>
  readonly guards?: Guards
} & ModelProfileInput<Profile>

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
  const Profile extends AnyModelProfile | undefined = undefined,
>(
  input: PlanToolCallInput<Tools, Guards, Profile>,
): Effect.Effect<
  ToolSetCall<Tools>,
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | InvalidToolCall
  | ModelGuardError<Guards>,
  ModelRequirement<Profile> | ModelGuardRequirements<Guards>
> => {
  // SAFETY: ModelProfileInput requires a concrete model whenever Profile is
  // defined; when Profile is undefined, undefined is the only legal value.
  const selected = Fn.cast<typeof input.model, Profile>(input.model)

  return runModelGuards(input.guards ?? [], {
    messages: input.messages,
    toolNames: input.tools.models.map(({ name }) => name),
  }).pipe(
    Effect.andThen(resolveModel(selected)),
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
                  modelProfile:
                    selected?.profile ?? "default",
                  toolCount: input.tools.models.length,
                },
              },
            ),
            Effect.flatMap((call) =>
              input.tools.parseCall(call).pipe(
                Effect.tapError(() =>
                  recordLatestDebugModelOutputRejected(
                    "invalid_tool_call",
                  ),
                ),
              ),
            ),
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
}

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
  const Profile extends AnyModelProfile | undefined = undefined,
>(
  input: RunToolStepInput<Tools, Guards, Profile>,
): Effect.Effect<
  ToolSetExecution<Tools>,
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | ToolSetError<Tools>
  | ModelGuardError<Guards>,
  | ModelRequirement<Profile>
  | ToolSetRequirements<Tools>
  | ModelGuardRequirements<Guards>
> =>
  planToolCall<Tools, Guards, Profile>(input).pipe(
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

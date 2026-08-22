import { Effect } from "effect"
import type {
  AcceptedAnswer,
  CollectAnswers,
  CollectStage,
  CollectStageDefinitionContract,
} from "./core/collect-stage.js"
import type { StructuredDefinition } from "./core/definition.js"
import type {
  ChatError,
  ChatReply,
  ChatReplyError,
  ChatReplyInput,
  ChatRequirements,
  ChatStageTuple,
  ChatState,
  ChatTurn,
  DefineChatInput,
} from "./core/chat.js"
import {
  ChatNameSchema,
  ChatVersionSchema,
  InvalidChatTransition,
  InvalidChatTransitionReasonSchema,
} from "./core/chat.js"
import type {
  PresentChatReplyOptions,
  StructuredChatTurnResponse,
} from "./core/protocol.js"
import {
  AssistantDataPartSchema,
  AssistantMessagePartSchema,
  AssistantTextPartSchema,
  CollectQuestionView,
  findTurnParts,
  InvalidChatPresentation,
  presentAnswerValidationRejection as presentValidationRejection,
  presentChatNotice as notice,
  presentChatReply,
  structuredChatTurnRequestSchema,
  StructuredChatAssistantMessageSchema,
  StructuredChatSessionReferenceSchema,
  StructuredChatTurnRequestSchema,
  StructuredChatTurnResponseSchema,
  Text,
} from "./core/protocol.js"
import { compile, read } from "./internal/chat/definition.js"

/** Declarative definition of one sequential structured chat. */
export interface Definition<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> extends StructuredDefinition<"chat"> {
  readonly name: Name
  readonly version: Version
  readonly stages: Stages
  readonly repair: DefineChatInput<Name, Version, Stages>["repair"]
}

/** Any opaque structured chat definition. */
export type AnyDefinition = Definition<string, number, ChatStageTuple>

/** Extract the stage tuple carried by a chat definition. */
export type StagesOf<Chat extends AnyDefinition> =
  Chat extends Definition<string, number, infer Stages> ? Stages : never

/** Extract the persisted state carried by a chat definition. */
export type State<Chat extends AnyDefinition> =
  Chat extends Definition<infer Name, infer Version, infer Stages>
    ? ChatState<Name, Version, Stages>
    : never

/** Extract one domain turn carried by a chat definition. */
export type Turn<Chat extends AnyDefinition> =
  Chat extends Definition<infer Name, infer Version, infer Stages>
    ? ChatTurn<Name, Version, Stages>
    : never

/** Extract one persisted reply carried by a chat definition. */
export type Reply<Chat extends AnyDefinition> =
  Chat extends Definition<infer Name, infer Version, infer Stages>
    ? ChatReply<Name, Version, Stages>
    : never

/** Extract the expected turn failures carried by a chat definition. */
export type TurnError<Chat extends AnyDefinition> =
  Chat extends Definition<string, number, infer Stages>
    ? ChatReplyError<Stages>
    : never

/** Extract the Effect services required by a chat definition. */
export type Requirements<Chat extends AnyDefinition> =
  Chat extends Definition<string, number, infer Stages>
    ? ChatRequirements<Stages>
    : never

type CollectFields<Stage> = Stage extends CollectStage<
  infer _Name,
  infer Fields,
  infer _Guards
>
  ? Fields
  : never

type PresentableTurn = Parameters<typeof presentChatReply>[0]["turn"]

type PresentableChatTurn<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> = ChatTurn<Name, Version, Stages> & PresentableTurn

type PresentableReply<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> = Omit<ChatReply<Name, Version, Stages>, "turn"> & {
  readonly turn: PresentableChatTurn<Name, Version, Stages>
}

/** Define one opaque sequential structured chat. */
export const define = compile

/**
 * Load, execute, and atomically replace one server-owned chat session.
 *
 * The returned Effect retains every stage requirement and expected failure.
 */
export const turn: <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  input: ChatReplyInput,
) => Effect.Effect<
  ChatReply<Name, Version, Stages>,
  ChatReplyError<Stages>,
  import("./core/session.js").ChatSessionStore |
    ChatRequirements<Stages>
> = Effect.fn("Chat.turn")(function* <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  input: ChatReplyInput,
) {
  return yield* read(chat).reply(input)
})

/** Build a reusable browser-protocol projection for one chat definition. */
export const present = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  options: PresentChatReplyOptions<
    PresentableChatTurn<Name, Version, Stages>
  > = {},
) => {
  read(chat)
  return <Error, Requirements>(
    effect: Effect.Effect<
      PresentableReply<Name, Version, Stages>,
      Error,
      Requirements
    >,
  ): Effect.Effect<
    StructuredChatTurnResponse,
    Error | InvalidChatPresentation,
    Requirements
  > =>
    effect.pipe(
      Effect.flatMap((reply) => presentChatReply(reply, options)),
    )
}

/** Project one persisted reply directly into the browser protocol. */
export const presentReply = presentChatReply

/** Read one accepted answer with its supporting transcript evidence. */
export const acceptedAnswer = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  Stage extends Extract<
    Stages[number],
    CollectStageDefinitionContract
  >,
  Field extends keyof CollectFields<Stage> & string,
>(
  chat: Definition<Name, Version, Stages>,
  state: ChatState<Name, Version, Stages>,
  stage: Stage,
  field: Field,
):
  | AcceptedAnswer<CollectAnswers<CollectFields<Stage>>[Field]>
  | undefined => read(chat).getAcceptedAnswer(state, stage, field)

export {
  AssistantDataPartSchema,
  AssistantMessagePartSchema,
  AssistantTextPartSchema,
  ChatNameSchema as NameSchema,
  ChatVersionSchema as VersionSchema,
  CollectQuestionView,
  findTurnParts,
  InvalidChatPresentation as InvalidPresentation,
  InvalidChatTransition as InvalidTransition,
  InvalidChatTransitionReasonSchema as InvalidTransitionReasonSchema,
  notice,
  presentValidationRejection,
  structuredChatTurnRequestSchema as turnRequestSchema,
  StructuredChatAssistantMessageSchema as AssistantMessageSchema,
  StructuredChatSessionReferenceSchema as SessionReferenceSchema,
  StructuredChatTurnRequestSchema as TurnRequestSchema,
  StructuredChatTurnResponseSchema as TurnResponseSchema,
  Text,
}

export type {
  AssistantMessagePart,
  StructuredChatAssistantMessage as AssistantMessage,
  StructuredChatSessionReference as SessionReference,
  StructuredChatTurnRequest as TurnRequest,
  StructuredChatTurnResponse as TurnResponse,
} from "./core/protocol.js"

export type {
  ChatError as ProcessError,
  ChatReplyInput as TurnInput,
  ChatStageTuple as StageTuple,
  DefineChatInput as DefineInput,
}

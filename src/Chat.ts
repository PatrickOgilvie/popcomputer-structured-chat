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
  ChatExploreError,
  ChatExploreInput,
  ChatExploreRequirements,
  ChatExplorationRun,
  ChatExplorationTuple,
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
  PresentChatExplorationOptions,
  PresentableExploration,
  StructuredChatExplorationResponse,
  StructuredChatTurnResponse,
} from "./core/protocol.js"
import {
  AssistantDataPartSchema,
  AssistantMessagePartSchema,
  AssistantTextPartSchema,
  CollectQuestionView,
  findExplorationParts,
  findTurnParts,
  InvalidChatPresentation,
  presentAnswerValidationRejection as presentValidationRejection,
  presentChatNotice as notice,
  presentChatExploration,
  presentChatReply,
  StructuredChatExplorationCallSchema,
  StructuredChatExplorationRequestSchema,
  StructuredChatExplorationResponseSchema,
  structuredChatTurnRequestSchema,
  StructuredChatAssistantMessageSchema,
  StructuredChatSessionReferenceSchema,
  StructuredChatTurnRequestSchema,
  StructuredChatTurnResponseSchema,
  Text,
} from "./core/protocol.js"
import { compile, read } from "./internal/chat/definition.js"
import type { ToolTuple } from "./core/tool-set.js"

/** Declarative definition of one sequential structured chat. */
export interface Definition<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
  Explorations extends ChatExplorationTuple = readonly [],
> extends StructuredDefinition<"chat"> {
  readonly name: Name
  readonly version: Version
  readonly stages: Stages
  readonly explorations: Explorations
  readonly repair: DefineChatInput<
    Name,
    Version,
    Stages,
    Explorations
  >["repair"]
}

/** Any opaque structured chat definition. */
export type AnyDefinition = Definition<
  string,
  number,
  ChatStageTuple,
  ChatExplorationTuple
>

/** Extract the stage tuple carried by a chat definition. */
export type StagesOf<Chat extends AnyDefinition> =
  Chat extends Definition<string, number, infer Stages, ChatExplorationTuple>
    ? Stages
    : never

/** Extract the exploration tuple carried by a chat definition. */
export type ExplorationsOf<Chat extends AnyDefinition> =
  Chat extends Definition<
    string,
    number,
    ChatStageTuple,
    infer Explorations
  >
    ? Explorations
    : never

/** Extract the persisted state carried by a chat definition. */
export type State<Chat extends AnyDefinition> =
  Chat extends Definition<
    infer Name,
    infer Version,
    infer Stages,
    ChatExplorationTuple
  >
    ? ChatState<Name, Version, Stages>
    : never

/** Extract one domain turn carried by a chat definition. */
export type Turn<Chat extends AnyDefinition> =
  Chat extends Definition<
    infer Name,
    infer Version,
    infer Stages,
    ChatExplorationTuple
  >
    ? ChatTurn<Name, Version, Stages>
    : never

/** Extract one persisted reply carried by a chat definition. */
export type Reply<Chat extends AnyDefinition> =
  Chat extends Definition<
    infer Name,
    infer Version,
    infer Stages,
    ChatExplorationTuple
  >
    ? ChatReply<Name, Version, Stages>
    : never

/** Extract the expected turn failures carried by a chat definition. */
export type TurnError<Chat extends AnyDefinition> =
  Chat extends Definition<
    string,
    number,
    infer Stages,
    ChatExplorationTuple
  >
    ? ChatReplyError<Stages>
    : never

/** Extract the Effect services required by a chat definition. */
export type Requirements<Chat extends AnyDefinition> =
  Chat extends Definition<
    string,
    number,
    infer Stages,
    ChatExplorationTuple
  >
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

type PresentableExplorationRun<Explorations extends ToolTuple> =
  ChatExplorationRun<Explorations> & PresentableExploration

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
  const Explorations extends ChatExplorationTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
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
  const Explorations extends ChatExplorationTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
  input: ChatReplyInput,
) {
  return yield* read(chat).reply(input)
})

/** Load the latest session and run one configured read-only exploration. */
export const explore: <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ToolTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
  input: ChatExploreInput,
) => Effect.Effect<
  ChatExplorationRun<Explorations>,
  ChatExploreError<Explorations>,
  import("./core/session.js").ChatSessionStore |
    ChatExploreRequirements<Explorations>
> = Effect.fn("Chat.explore")(function* <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ToolTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
  input: ChatExploreInput,
) {
  return yield* read(chat).explore(input)
})

/** Build a reusable browser-protocol projection for one chat definition. */
export const present = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
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

/** Build a reusable browser-protocol projection for explorations. */
export const presentExploration = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ToolTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
  options: PresentChatExplorationOptions<
    PresentableExplorationRun<Explorations>
  > = {},
) => {
  read(chat)
  return <Error, Requirements>(
    effect: Effect.Effect<
      PresentableExplorationRun<Explorations>,
      Error,
      Requirements
    >,
  ): Effect.Effect<
    StructuredChatExplorationResponse,
    Error | InvalidChatPresentation,
    Requirements
  > =>
    effect.pipe(
      Effect.flatMap((run) => presentChatExploration(run, options)),
    )
}

/** Project one persisted reply directly into the browser protocol. */
export const presentReply = presentChatReply

/** Project one exploration result directly into the browser protocol. */
export const presentExplorationRun = presentChatExploration

/** Read one accepted answer with its supporting transcript evidence. */
export const acceptedAnswer = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple,
  Stage extends Extract<
    Stages[number],
    CollectStageDefinitionContract
  >,
  Field extends keyof CollectFields<Stage> & string,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
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
  findExplorationParts,
  findTurnParts,
  InvalidChatPresentation as InvalidPresentation,
  InvalidChatTransition as InvalidTransition,
  InvalidChatTransitionReasonSchema as InvalidTransitionReasonSchema,
  notice,
  presentValidationRejection,
  structuredChatTurnRequestSchema as turnRequestSchema,
  StructuredChatAssistantMessageSchema as AssistantMessageSchema,
  StructuredChatExplorationCallSchema as ExplorationCallSchema,
  StructuredChatExplorationRequestSchema as ExplorationRequestSchema,
  StructuredChatExplorationResponseSchema as ExplorationResponseSchema,
  StructuredChatSessionReferenceSchema as SessionReferenceSchema,
  StructuredChatTurnRequestSchema as TurnRequestSchema,
  StructuredChatTurnResponseSchema as TurnResponseSchema,
  Text,
}

export type {
  AssistantMessagePart,
  StructuredChatExplorationCall as ExplorationCall,
  StructuredChatExplorationRequest as ExplorationRequest,
  StructuredChatExplorationResponse as ExplorationResponse,
  StructuredChatAssistantMessage as AssistantMessage,
  StructuredChatSessionReference as SessionReference,
  StructuredChatTurnRequest as TurnRequest,
  StructuredChatTurnResponse as TurnResponse,
} from "./core/protocol.js"

export type {
  ChatError as ProcessError,
  ChatExploreError as ExploreError,
  ChatExploreInput as ExploreInput,
  ChatExploreRequirements as ExploreRequirements,
  ChatExplorationRun as ExplorationRun,
  ChatExplorationTuple as ExplorationTuple,
  ChatReplyInput as TurnInput,
  ChatStageTuple as StageTuple,
  DefineChatInput as DefineInput,
}

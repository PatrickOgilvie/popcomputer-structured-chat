import { Effect, Function as Fn } from "effect"
import type { ChatSessionStore } from "./core/session.js"
import type { ChatContext } from "./core/chat-context.js"
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
  StructuredChatPersistedTurnResponse,
  StructuredChatExplorationResponse,
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
  StructuredChatNonProgressingResponseSchema,
  StructuredChatPersistedTurnResponseSchema,
  structuredChatTurnRequestSchema,
  StructuredChatAssistantMessageSchema,
  StructuredChatSessionReferenceSchema,
  StructuredChatTurnRequestSchema,
  StructuredChatTurnResponseSchema,
  Text,
} from "./core/protocol.js"
import {
  InvalidChatUserAnswerProjection,
  InvalidChatUserAnswerProjectionReasonSchema,
  StructuredChatUserAnswerSnapshotSchema,
  type StructuredChatUserAnswerField,
  type StructuredChatUserAnswerSection,
  type StructuredChatUserAnswerSnapshot,
  type StructuredChatUserAnswerState,
} from "./core/user-answer-projection.js"
import { read } from "./internal/chat/definition.js"
import {
  hasComposition,
  readConversation,
} from "./internal/chat/composition-definition.js"
import type {
  AnyComposedDefinition,
  ConversationReply,
  ConversationError,
  ErrorsOf,
  RequirementsOf,
  StartConversationInput,
  StartedConversation,
  MessagesOf,
  PostMessageInput,
  PostedMessage,
  TurnsOf,
} from "./core/composition.js"
import type { ConversationState } from "./core/conversation-state.js"
import type { OutboundMessageContract } from "./core/outbound-message.js"
import type { ToolTuple } from "./core/tool-set.js"
import { TurnControl } from "./core/turn-control.js"
import type { TurnControlFailure } from "./core/turn-control.js"
import type {
  AdvanceResult as ControlledResult,
  ControlledTurnInput,
  InvalidObservedTurn,
} from "./core/observed-turn.js"

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
  Chat extends Definition<string, number, ChatStageTuple, infer Explorations>
    ? Explorations
    : never

/** Extract the persisted state carried by a chat definition. */
export type State<Chat extends AnyDefinition> =
  Chat extends AnyComposedDefinition
    ? ConversationState
    : Chat extends Definition<
          infer Name,
          infer Version,
          infer Stages,
          ChatExplorationTuple
        >
      ? ChatState<Name, Version, Stages>
      : never

/** Extract one domain turn carried by a chat definition. */
export type Turn<Chat extends AnyDefinition> =
  Chat extends AnyComposedDefinition
    ? TurnsOf<Chat>
    : Chat extends Definition<
          infer Name,
          infer Version,
          infer Stages,
          ChatExplorationTuple
        >
      ? ChatTurn<Name, Version, Stages>
      : never

/** Extract one persisted reply carried by a chat definition. */
export type Reply<Chat extends AnyDefinition> =
  Chat extends AnyComposedDefinition
    ? ConversationReply<Chat>
    : Chat extends Definition<
          infer Name,
          infer Version,
          infer Stages,
          ChatExplorationTuple
        >
      ? ChatReply<Name, Version, Stages>
      : never

/** Extract the expected turn failures carried by a chat definition. */
export type TurnError<Chat extends AnyDefinition> =
  Chat extends AnyComposedDefinition
    ? ErrorsOf<Chat>
    : Chat extends Definition<
          string,
          number,
          infer Stages,
          ChatExplorationTuple
        >
      ? ChatReplyError<Stages>
      : never

/** Extract the Effect services required by a chat definition. */
export type Requirements<Chat extends AnyDefinition> =
  Chat extends AnyComposedDefinition
    ? RequirementsOf<Chat>
    : Chat extends Definition<
          string,
          number,
          infer Stages,
          ChatExplorationTuple
        >
      ? ChatRequirements<Stages>
      : never

type CollectFields<Stage> =
  Stage extends CollectStage<
    infer _Name,
    infer Fields,
    infer _Guards,
    infer _Profile,
    infer _Resolver
  >
    ? Fields
    : never

type PresentableTurn = Parameters<typeof presentChatReply>[0]["turn"]

type PresentableExplorationRun<Explorations extends ToolTuple> =
  ChatExplorationRun<Explorations> & PresentableExploration

/** Define one opaque sequential structured chat. */
export { define, branch } from "./internal/chat/composition-definition.js"

export {
  chatInput as input,
  ChatContextUnavailable,
} from "./core/chat-context.js"

export { returned } from "./core/branch.js"

export type {
  InputOf as Input,
  OutputOf as Output,
  Branch,
  BranchContract,
} from "./core/branch.js"

export type { ChatOutcome as Outcome } from "./core/chat-context.js"

export { InvalidConversation } from "./core/conversation-state.js"

export type {
  ConversationState,
  Invocation,
} from "./core/conversation-state.js"

export type {
  ComposedDefinition,
  ConversationReply,
  PostedMessage,
  StartedConversation,
} from "./core/composition.js"

/**
 * Load, execute, and atomically replace one server-owned chat session.
 *
 * The returned Effect retains every stage requirement and expected failure.
 */
export const turn = <C extends AnyDefinition>(
  chat: C,
  input: ChatReplyInput,
): Effect.Effect<
  Reply<C>,
  TurnError<C>,
  ChatSessionStore | Requirements<C>
> => {
  const effect = hasComposition(chat)
    ? readConversation(chat).reply(input)
    : read(chat).reply(input)

  // SAFETY: the opaque definition selects the runtime compiled from its exact stages and child contracts.
  return Fn.cast<
    typeof effect,
    Effect.Effect<Reply<C>, TurnError<C>, ChatSessionStore | Requirements<C>>
  >(effect)
}

/** Result of a new controlled turn or an exact previously committed observation batch. */
export type AdvanceResult<C extends AnyDefinition> = ControlledResult<Reply<C>>

/** Expected failures of controlled input, execution, and persisted chat transitions. */
export type AdvanceError<C extends AnyDefinition> =
  TurnError<C> | InvalidObservedTurn | TurnControlFailure

export {
  TurnControl,
  TurnSuperseded,
  TurnControlUnavailable,
} from "./core/turn-control.js"

export type { TurnControlService } from "./core/turn-control.js"

export { InvalidObservedTurn } from "./core/observed-turn.js"

export type { ControlledTurnInput as AdvanceInput } from "./core/observed-turn.js"

/**
 * Advance one submitted or observed turn under an explicit session owner's
 * execution authority. Exact observed replays never execute another turn.
 * @template C The opaque definition retaining its precise replies, failures, and services.
 */
export const advance = <C extends AnyDefinition>(
  chat: C,
  input: ControlledTurnInput,
): Effect.Effect<
  AdvanceResult<C>,
  AdvanceError<C>,
  ChatSessionStore | TurnControl | Requirements<C>
> =>
  Effect.gen(function* () {
    const control = yield* TurnControl

    const effect = hasComposition(chat)
      ? readConversation(chat).advance(input, control)
      : read(chat).advance(input, control)

    // SAFETY: the opaque definition selects the exact leaf/composed runtime;
    // controlled execution adds only its explicit input and supersession failures.
    return yield* Fn.cast<
      typeof effect,
      Effect.Effect<
        AdvanceResult<C>,
        AdvanceError<C>,
        ChatSessionStore | Requirements<C>
      >
    >(effect)
  })

/** Initialize a standalone root invocation with its declared input; retries preserve the session. */
export const start = <C extends AnyComposedDefinition>(
  chat: C,
  input: StartConversationInput<C>,
): Effect.Effect<StartedConversation, ConversationError, ChatSessionStore> => {
  const effect = readConversation(chat).start(input)

  // SAFETY: start uses only input/state parsers and the session store, with failures classified by that runtime.
  return Fn.cast<
    typeof effect,
    Effect.Effect<StartedConversation, ConversationError, ChatSessionStore>
  >(effect)
}

/** Persist an application-authored message and its reply hints without running a user turn. */
export const post = <
  C extends AnyComposedDefinition,
  M extends MessagesOf<C> & OutboundMessageContract,
>(
  chat: C,
  input: PostMessageInput<M>,
): Effect.Effect<PostedMessage, ConversationError, ChatSessionStore> => {
  const effect = readConversation(chat).post(input)

  // SAFETY: post checks message membership and uses only message codecs and the session store.
  return Fn.cast<
    typeof effect,
    Effect.Effect<PostedMessage, ConversationError, ChatSessionStore>
  >(effect)
}

type ExplorationError<C extends AnyDefinition> =
  | ChatExploreError<ExplorationsOf<C>>
  | (C extends AnyComposedDefinition ? ConversationError : never)

type ExplorationRequirements<C extends AnyDefinition> =
  | ChatSessionStore
  | (C extends AnyComposedDefinition
      ? Exclude<ChatExploreRequirements<ExplorationsOf<C>>, ChatContext>
      : ChatExploreRequirements<ExplorationsOf<C>>)

/** Load the latest session and run one configured read-only exploration. */
export const explore = <
  C extends Definition<string, number, ChatStageTuple, ToolTuple>,
>(
  chat: C,
  input: ChatExploreInput,
): Effect.Effect<
  ChatExplorationRun<ExplorationsOf<C>>,
  ExplorationError<C>,
  ExplorationRequirements<C>
> => {
  const effect = hasComposition(chat)
    ? readConversation(chat).explore(input)
    : read(chat).explore(input)

  // SAFETY: both runtimes execute only this definition's root exploration tuple.
  return Fn.cast<
    typeof effect,
    Effect.Effect<
      ChatExplorationRun<ExplorationsOf<C>>,
      ExplorationError<C>,
      ExplorationRequirements<C>
    >
  >(effect)
}

/** Build a reusable browser-protocol projection for one chat definition. */
export const present = <C extends AnyDefinition>(
  chat: C,
  options: PresentChatReplyOptions<Turn<C> & PresentableTurn> = {},
) => {
  read(chat)

  return <Error, Requirements>(
    effect: Effect.Effect<Reply<C>, Error, Requirements>,
  ): Effect.Effect<
    StructuredChatPersistedTurnResponse,
    Error | InvalidChatPresentation,
    Requirements
  > =>
    effect.pipe(
      Effect.flatMap((reply) => {
        // SAFETY: both compiled runtimes emit the same presentation variants; composition adds invocation scope and issued messages.
        const presentable = Fn.cast<
          typeof reply,
          Parameters<typeof presentChatReply>[0]
        >(reply)

        // SAFETY: each callback receives the exact turn union carried by this opaque chat.
        const projections = Fn.cast<
          typeof options,
          PresentChatReplyOptions<PresentableTurn>
        >(options)

        return presentChatReply(presentable, projections)
      }),
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
    effect.pipe(Effect.flatMap((run) => presentChatExploration(run, options)))
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
  Stage extends Extract<Stages[number], CollectStageDefinitionContract>,
  Field extends keyof CollectFields<Stage> & string,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
  state: ChatState<Name, Version, Stages>,
  stage: Stage,
  field: Field,
): AcceptedAnswer<CollectAnswers<CollectFields<Stage>>[Field]> | undefined =>
  read(chat).getAcceptedAnswer(state, stage, field)

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
  InvalidChatUserAnswerProjection as InvalidUserAnswerProjection,
  InvalidChatUserAnswerProjectionReasonSchema as InvalidUserAnswerProjectionReasonSchema,
  notice,
  presentValidationRejection,
  structuredChatTurnRequestSchema as turnRequestSchema,
  StructuredChatAssistantMessageSchema as AssistantMessageSchema,
  StructuredChatExplorationCallSchema as ExplorationCallSchema,
  StructuredChatExplorationRequestSchema as ExplorationRequestSchema,
  StructuredChatExplorationResponseSchema as ExplorationResponseSchema,
  StructuredChatNonProgressingResponseSchema as NonProgressingResponseSchema,
  StructuredChatPersistedTurnResponseSchema as PersistedTurnResponseSchema,
  StructuredChatSessionReferenceSchema as SessionReferenceSchema,
  StructuredChatTurnRequestSchema as TurnRequestSchema,
  StructuredChatTurnResponseSchema as TurnResponseSchema,
  StructuredChatUserAnswerSnapshotSchema as UserAnswerSnapshotSchema,
  Text,
}

export type {
  AssistantMessagePart,
  StructuredChatExplorationCall as ExplorationCall,
  StructuredChatExplorationRequest as ExplorationRequest,
  StructuredChatExplorationResponse as ExplorationResponse,
  StructuredChatNonProgressingResponse as NonProgressingResponse,
  StructuredChatPersistedTurnResponse as PersistedTurnResponse,
  StructuredChatAssistantMessage as AssistantMessage,
  StructuredChatSessionReference as SessionReference,
  StructuredChatTurnRequest as TurnRequest,
  StructuredChatTurnResponse as TurnResponse,
} from "./core/protocol.js"

export type {
  StructuredChatUserAnswerField as UserAnswerField,
  StructuredChatUserAnswerSection as UserAnswerSection,
  StructuredChatUserAnswerSnapshot as UserAnswerSnapshot,
  StructuredChatUserAnswerState as UserAnswerState,
}

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

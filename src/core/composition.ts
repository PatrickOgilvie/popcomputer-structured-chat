import type { Schema } from "effect"
import type { AnyDefinition, Definition } from "../Chat.js"
import type { Branch, Branches, InputOf, OutputOf } from "./branch.js"
import type { ChatContext, ChatOutcome } from "./chat-context.js"
import type {
  ChatError,
  ChatExplorationTuple,
  ChatRequirements,
  ChatStageTuple,
  ChatTurn,
  InvalidChatTransition,
} from "./chat.js"
import type {
  ConversationState,
  InvalidConversation,
} from "./conversation-state.js"
import type {
  ChatModelUnavailable,
  StructuredChatModel,
  UnsupportedModelToolSchema,
} from "./model.js"
import type {
  InvalidOutboundMessage,
  MessageCollector,
  OutboundMessageContract,
} from "./outbound-message.js"
import type {
  AssistantMessagePart,
  InvalidChatPresentation,
  StructuredChatAssistantMessage,
  StructuredChatSessionReference,
} from "./protocol.js"
import type {
  ChatSessionConflict,
  ChatSessionExpired,
  ChatSessionNotFound,
  ChatSessionStoreUnavailable,
  InvalidChatSession,
} from "./session.js"
import type {
  InvalidToolCall,
  InvalidToolProjection,
  ToolSchema,
} from "./tool.js"
import type {
  InvalidChatUserAnswerProjection,
  StructuredChatUserAnswerSnapshot,
} from "./user-answer-projection.js"

/** Typed completion projection owned by a chat definition. */
export interface ChatOutput<
  Stages extends ChatStageTuple,
  Output extends ToolSchema,
> {
  readonly schema: Output
  readonly project: (
    turn: Extract<
      ChatTurn<string, number, Stages>,
      { readonly _tag: "Complete" }
    >,
  ) => Schema.Schema.Type<Output>
}

/** Declarative input, output, branches, and outbound messages for a composed chat. */
export interface CompositionOptions<
  Stages extends ChatStageTuple,
  Input extends ToolSchema,
  Output extends ToolSchema,
  Calls extends Branches,
  Messages extends ReadonlyArray<OutboundMessageContract>,
> {
  readonly input?: Input
  readonly output?: ChatOutput<Stages, Output>
  readonly branches?: Calls
  readonly messages?: Messages
  readonly limits?: {
    readonly maximumDepth?: number
    readonly maximumTransitionsPerTurn?: number
  }
}

/** A normal chat definition with additional composition contracts. */
export interface ComposedDefinition<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
  Explorations extends ChatExplorationTuple,
  Input extends ToolSchema,
  Output extends ToolSchema,
  Calls extends Branches,
  Messages extends ReadonlyArray<OutboundMessageContract>,
> extends Definition<Name, Version, Stages, Explorations> {
  readonly composition: {
    readonly inputSchema: Input
    readonly outputSchema: Output
    readonly branches: Calls
    readonly messages: Messages
  }
}

/** Minimum opaque definition accepted by composition operations. */
export type AnyComposedDefinition = ComposedDefinition<
  string,
  number,
  ChatStageTuple,
  ChatExplorationTuple,
  ToolSchema,
  ToolSchema,
  Branches,
  ReadonlyArray<OutboundMessageContract>
>

type BranchError<B> =
  B extends Branch<infer _N, infer _A, infer C, infer E, infer _R>
    ? E | ErrorsOf<C>
    : never

type BranchRequirements<B> =
  B extends Branch<infer _N, infer _A, infer C, infer _E, infer R>
    ? R | RequirementsOf<C>
    : never

/** Expected composition, model, projection, and session failures. */
export type ConversationError =
  | InvalidConversation
  | InvalidChatTransition
  | InvalidOutboundMessage
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | InvalidToolCall
  | InvalidToolProjection
  | InvalidChatSession
  | ChatSessionConflict
  | ChatSessionExpired
  | ChatSessionNotFound
  | ChatSessionStoreUnavailable
  | InvalidChatUserAnswerProjection
  | InvalidChatPresentation

/** Exact stage and transitive branch failures carried by a chat. */
export type ErrorsOf<C> =
  C extends ComposedDefinition<
    infer _N,
    infer _V,
    infer S,
    infer _X,
    infer _I,
    infer _O,
    infer B,
    infer _M
  >
    ? ConversationError | ChatError<S> | BranchError<B[number]>
    : C extends Definition<infer _N, infer _V, infer S, infer _X>
      ? ChatError<S>
      : never

/** Exact caller-provided services; invocation services are runtime-owned. */
export type RequirementsOf<C> =
  C extends ComposedDefinition<
    infer _N,
    infer _V,
    infer S,
    infer _X,
    infer _I,
    infer _O,
    infer B,
    infer M
  >
    ? Exclude<
        | ChatRequirements<S>
        | ([B[number] | M[number]] extends [never]
            ? never
            : StructuredChatModel)
        | BranchRequirements<B[number]>,
        ChatContext | MessageCollector
      >
    : C extends Definition<infer _N, infer _V, infer S, infer _X>
      ? Exclude<ChatRequirements<S>, ChatContext | MessageCollector>
      : never

/** Location of the invocation which produced the visible response. */
export interface InvocationReference {
  readonly id: number
  readonly chat: string
  readonly version: number
}

/** Common presentation shape produced by the existing stage runner. */
export type ConversationTurn =
  | {
      readonly _tag: "Clarification"
      readonly stage: string
      readonly state: ConversationState
      readonly clarification: { readonly text: string }
    }
  | {
      readonly _tag: "Question"
      readonly stage: string
      readonly state: ConversationState
      readonly question: {
        readonly field: string
        readonly text: string
        readonly options: ReadonlyArray<{ readonly label: string }>
        readonly escape?: { readonly label: string }
      }
    }
  | {
      readonly _tag: "ToolResult" | "Complete"
      readonly stage: string
      readonly state: ConversationState
      readonly result: {
        readonly serverResult: unknown
        readonly modelResult: unknown
        readonly views: ReadonlyArray<AssistantMessagePart>
      }
    }

type WithConversationState<T> = T extends { readonly state: object }
  ? Omit<T, "state"> & { readonly state: ConversationState }
  : never

type ChildTurns<B> =
  B extends Branch<infer _N, infer _A, infer C, infer _E, infer _R>
    ? TurnsOf<C> extends infer T
      ? T extends { readonly _tag: "Complete" }
        ? Omit<T, "_tag"> & { readonly _tag: "ToolResult" }
        : T
      : never
    : never

/** Preserve each stage's correlated server result across declared chat calls. */
export type TurnsOf<C> =
  C extends ComposedDefinition<
    infer N,
    infer V,
    infer S,
    infer _X,
    infer _I,
    infer _O,
    infer B,
    infer _M
  >
    ? WithConversationState<ChatTurn<N, V, S>> | ChildTurns<B[number]>
    : C extends Definition<infer N, infer V, infer S, infer _X>
      ? WithConversationState<ChatTurn<N, V, S>>
      : never

/** A committed reply identifies its invocation and optional root completion. */
export interface ConversationReply<C extends AnyDefinition> {
  readonly sessionId: string
  readonly revision: string
  readonly turn: TurnsOf<C>
  readonly invocation: InvocationReference
  readonly userAnswers: StructuredChatUserAnswerSnapshot
  readonly emittedMessages: ReadonlyArray<StructuredChatAssistantMessage>
  readonly outcome: ChatOutcome<OutputOf<C>> | undefined
}

/** Start one root invocation with decoded, typed input. */
export interface StartConversationInput<C> {
  readonly namespace?: string
  readonly sessionId: string
  readonly input: InputOf<C>
}

/** A committed initialized session, ready for application messages or user turns. */
export interface StartedConversation {
  readonly sessionId: string
  readonly revision: string
  readonly state: ConversationState
}

/** Definitions registered for outbound messages in a chat. */
type BranchMessages<B> =
  B extends Branch<infer _N, infer _A, infer C, infer _E, infer _R>
    ? MessagesOf<C>
    : never

export type MessagesOf<C> =
  C extends ComposedDefinition<
    infer _N,
    infer _V,
    infer _S,
    infer _X,
    infer _I,
    infer _O,
    infer B,
    infer M
  >
    ? M[number] | BranchMessages<B[number]>
    : never

/** Post a registered message with a retry-stable application identity. */
export interface PostMessageInput<M extends OutboundMessageContract> {
  readonly namespace?: string
  readonly sessionId: string
  readonly expectedRevision: string
  readonly messageId: string
  readonly message: M
  readonly input: Schema.Schema.Type<M["inputSchema"]>
}

/** A recorded message can be published or replayed without rearming its hints. */
export interface PostedMessage {
  readonly disposition: "recorded" | "replayed"
  readonly messageId: string
  readonly session: StructuredChatSessionReference
  readonly message: StructuredChatAssistantMessage
}

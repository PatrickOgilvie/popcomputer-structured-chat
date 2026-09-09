import { Effect, Function as Fn, Result, Schema } from "effect"
import {
  turn as runTurn,
  type AnyDefinition,
  type Reply as ReplyOf,
  type TurnError,
  type Requirements,
  type Turn as TurnOf,
  type State as StateOf,
} from "./Chat.js"
import type {
  ChatReply,
  ChatReplyInput,
  ChatStageTuple,
  ChatState,
} from "./core/chat.js"
import {
  inspectChatState,
  type InspectChatStateOptions,
  InvalidChatDebugProjection,
  type StructuredChatDebugSnapshot,
} from "./core/debug.js"
import {
  presentChatDebugReply,
  type CapturedChatDebugOutcome,
  type PresentChatDebugReplyOptions,
  type StructuredChatDebugTurnResponse,
} from "./core/debug-protocol.js"
import { captureDebugEvents } from "./core/debug-trace.js"
import {
  presentChatReply,
  type PresentChatReplyOptions,
  type InvalidChatPresentation,
} from "./core/protocol.js"
import type { StructuredChatDebugEvent } from "./core/debug-trace.js"
import { StructuredChatDebugTurnResponseSchema } from "./core/debug-protocol.js"
import {
  hasComposition,
  readConversation,
} from "./internal/chat/composition-definition.js"
import type { AnyComposedDefinition } from "./core/composition.js"
import { ChatSessionIdSchema } from "./core/session.js"
import { read } from "./internal/chat/definition.js"

const TurnOptionsSchema = Schema.Struct({
  modelPayloads: Schema.Literal("literal"),
})

/** Required acknowledgement that a debug run captures sensitive model data. */
export interface TurnOptions {
  readonly modelPayloads: "literal"
}

/**
 * Run one persisted chat turn while capturing literal provider I/O and
 * semantic annotations for the explicit debug response.
 *
 * Captured values remain in the returned outcome and are not written to the
 * structured-chat session store. `modelPayloads: "literal"` is required
 * because prompts and responses can contain secrets or personal data.
 */
export type CapturedOutcome<C extends AnyDefinition> =
  | {
      readonly _tag: "Succeeded"
      readonly reply: ReplyOf<C>
      readonly events: ReadonlyArray<StructuredChatDebugEvent>
    }
  | {
      readonly _tag: "Failed"
      readonly sessionId: string | null
      readonly error: TurnError<C>
      readonly events: ReadonlyArray<StructuredChatDebugEvent>
    }

export const turn = <C extends AnyDefinition>(
  chat: C,
  input: ChatReplyInput,
  options: TurnOptions,
): Effect.Effect<
  CapturedOutcome<C>,
  never,
  import("./core/session.js").ChatSessionStore | Requirements<C>
> => {
  Schema.decodeSync(TurnOptionsSchema)(options, {
    onExcessProperty: "error",
  })
  const sessionId = Schema.is(ChatSessionIdSchema)(input.sessionId)
    ? input.sessionId
    : null

  return captureDebugEvents(runTurn(chat, input)).pipe(
    Effect.map(({ result, events }) =>
      Result.isFailure(result)
        ? {
            _tag: "Failed" as const,
            sessionId,
            error: result.failure,
            events: [
              ...events,
              { _tag: "TurnFailed" as const, sequence: events.length },
            ],
          }
        : {
            _tag: "Succeeded" as const,
            reply: result.success,
            events,
          },
    ),
  )
}

/** Project one opaque chat state into safe inspector data. */
export const inspect = <C extends AnyDefinition>(
  chat: C,
  state: StateOf<C>,
  options: InspectChatStateOptions = {},
): Effect.Effect<StructuredChatDebugSnapshot, InvalidChatDebugProjection> => {
  if (hasComposition(chat)) {
    // SAFETY: composition membership selects this definition's conversation state contract.
    const conversation = Fn.cast<
      typeof state,
      import("./core/conversation-state.js").ConversationState
    >(state)
    return inspectInvocation(chat, conversation, conversation.active, options)
  }
  // SAFETY: the ordinary definition owns the corresponding sequential state schema.
  return inspectChatState(
    read(chat),
    Fn.cast<typeof state, ChatState<string, number, ChatStageTuple>>(state),
    options,
  )
}

const inspectInvocation = (
  chat: AnyDefinition,
  state: import("./core/conversation-state.js").ConversationState,
  id: number,
  options: InspectChatStateOptions,
) =>
  readConversation(chat)
    .getInvocation(state, id)
    .pipe(
      Effect.mapError(
        () => new InvalidChatDebugProjection({ reason: "invalid_state" }),
      ),
      Effect.flatMap((invocation) =>
        inspectChatState(invocation.definition, invocation.state, options),
      ),
    )

type PresentationOptions<C extends AnyDefinition> = {
  readonly presentation?: PresentChatReplyOptions<
    TurnOf<C> & Parameters<typeof presentChatReply>[0]["turn"]
  >
  readonly inspection?: InspectChatStateOptions
}

/** Project a reply or captured outcome, inspecting the invocation that produced it. */
export const present = <C extends AnyDefinition>(
  chat: C,
  input: ReplyOf<C> | CapturedOutcome<C>,
  options: PresentationOptions<C> = {},
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatPresentation | InvalidChatDebugProjection
> => {
  if (!hasComposition(chat)) {
    // SAFETY: ordinary definitions retain the existing debug protocol and exact stage callbacks.
    return presentChatDebugReply(
      read(chat),
      Fn.cast<
        typeof input,
        | ChatReply<string, number, ChatStageTuple>
        | CapturedChatDebugOutcome<string, number, ChatStageTuple>
      >(input),
      Fn.cast<
        typeof options,
        PresentChatDebugReplyOptions<string, number, ChatStageTuple>
      >(options),
    )
  }
  const outcome =
    "_tag" in input
      ? input
      : { _tag: "Succeeded" as const, reply: input, events: [] }
  const trace = { schemaVersion: 1 as const, events: outcome.events }
  const parse = Schema.decodeUnknownEffect(
    StructuredChatDebugTurnResponseSchema,
  )
  if (outcome._tag === "Failed")
    return parse(
      {
        schemaVersion: 2,
        outcome: "failure",
        session: outcome.sessionId === null ? null : { id: outcome.sessionId },
        trace,
      },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new InvalidChatDebugProjection({ reason: "invalid_trace" }),
      ),
    )
  return Effect.gen(function* () {
    // SAFETY: the runtime membership check above identifies a composed reply with an invocation reference.
    const reply = Fn.cast<typeof outcome.reply, ReplyOf<AnyComposedDefinition>>(
      outcome.reply,
    )
    const response = yield* presentChatReply(
      reply,
      Fn.cast<
        typeof options.presentation,
        | PresentChatReplyOptions<
            Parameters<typeof presentChatReply>[0]["turn"]
          >
        | undefined
      >(options.presentation),
    )
    const debug = yield* inspectInvocation(
      chat,
      reply.turn.state,
      reply.invocation.id,
      options.inspection ?? {},
    )
    return yield* parse(
      { ...response, outcome: "success", debug, trace },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new InvalidChatDebugProjection({ reason: "invalid_trace" }),
      ),
    )
  })
}

/** Project an ordinary persisted reply into the state-only debug protocol. */
export const presentState = <C extends AnyDefinition>(
  chat: C,
  reply: ReplyOf<C>,
  options: PresentationOptions<C> = {},
) => present(chat, reply, options)

export {
  InvalidChatDebugProjection as InvalidProjection,
  StructuredChatDebugSnapshotSchema as SnapshotSchema,
} from "./core/debug.js"

export { StructuredChatDebugTurnResponseSchema as TurnResponseSchema } from "./core/debug-protocol.js"

export {
  StructuredChatDebugEventSchema as EventSchema,
  StructuredChatDebugTraceSchema as TraceSchema,
} from "./core/debug-trace.js"

export type {
  InspectChatStateOptions as InspectOptions,
  StructuredChatDebugSnapshot as Snapshot,
} from "./core/debug.js"

export type {
  PresentChatDebugReplyOptions as PresentOptions,
  StructuredChatDebugTurn as Turn,
  StructuredChatDebugTurnResponse as TurnResponse,
  CapturedChatDebugOutcome as Outcome,
} from "./core/debug-protocol.js"

export type {
  StructuredChatDebugEvent as Event,
  StructuredChatDebugTrace as Trace,
} from "./core/debug-trace.js"

/** Debuggable persisted reply for one opaque chat definition. */
export type Reply<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> = ChatReply<Name, Version, Stages>

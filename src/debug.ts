import { Effect, Result, Schema } from "effect"
import type { Definition } from "./Chat.js"
import type {
  ChatReply,
  ChatReplyInput,
  ChatRequirements,
  ChatExplorationTuple,
  ChatStageTuple,
  ChatState,
} from "./core/chat.js"
import {
  inspectChatState,
  type InspectChatStateOptions,
  type InvalidChatDebugProjection,
  type StructuredChatDebugSnapshot,
} from "./core/debug.js"
import {
  presentChatDebugReply,
  type CapturedChatDebugOutcome,
  type PresentChatDebugReplyOptions,
  type StructuredChatDebugTurnResponse,
} from "./core/debug-protocol.js"
import { captureDebugEvents } from "./core/debug-trace.js"
import type { InvalidChatPresentation } from "./core/protocol.js"
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
export const turn = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple,
>(
  chat: Definition<Name, Version, Stages, Explorations>,
  input: ChatReplyInput,
  options: TurnOptions,
): Effect.Effect<
  CapturedChatDebugOutcome<Name, Version, Stages>,
  never,
  import("./core/session.js").ChatSessionStore | ChatRequirements<Stages>
> => {
  Schema.decodeSync(TurnOptionsSchema)(options, {
    onExcessProperty: "error",
  })
  const sessionId = Schema.is(ChatSessionIdSchema)(input.sessionId)
    ? input.sessionId
    : null

  return captureDebugEvents(read(chat).reply(input)).pipe(
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
export const inspect = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  state: ChatState<Name, Version, Stages>,
  options: InspectChatStateOptions = {},
): Effect.Effect<StructuredChatDebugSnapshot, InvalidChatDebugProjection> =>
  inspectChatState(read(chat), state, options)

/** Project one persisted reply or captured debug outcome into the protocol. */
export const present = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  input:
    | ChatReply<Name, Version, Stages>
    | CapturedChatDebugOutcome<Name, Version, Stages>,
  options: PresentChatDebugReplyOptions<Name, Version, Stages> = {},
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatPresentation | InvalidChatDebugProjection
> =>
  presentChatDebugReply(
    read(chat),
    input,
    options,
  )

/** Project an ordinary persisted reply into the state-only debug protocol. */
export const presentState = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  reply: ChatReply<Name, Version, Stages>,
  options: PresentChatDebugReplyOptions<Name, Version, Stages> = {},
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatPresentation | InvalidChatDebugProjection
> =>
  presentChatDebugReply(
    read(chat),
    reply,
    options,
  )

export {
  InvalidChatDebugProjection as InvalidProjection,
  StructuredChatDebugSnapshotSchema as SnapshotSchema,
} from "./core/debug.js"

export {
  StructuredChatDebugTurnResponseSchema as TurnResponseSchema,
} from "./core/debug-protocol.js"

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

import type { Effect } from "effect"
import type { Definition } from "./Chat.js"
import type {
  ChatReply,
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
  type PresentChatDebugReplyOptions,
  type StructuredChatDebugTurnResponse,
} from "./core/debug-protocol.js"
import type { InvalidChatPresentation } from "./core/protocol.js"
import { read } from "./internal/chat/definition.js"

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

/** Project one persisted reply into the opt-in debug browser protocol. */
export const present = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: Definition<Name, Version, Stages>,
  reply: Parameters<typeof presentChatDebugReply<Name, Version, Stages>>[1],
  options: PresentChatDebugReplyOptions<Name, Version, Stages> = {},
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatPresentation | InvalidChatDebugProjection
> => presentChatDebugReply(read(chat), reply, options)

export {
  InvalidChatDebugProjection as InvalidProjection,
  StructuredChatDebugSnapshotSchema as SnapshotSchema,
} from "./core/debug.js"

export {
  StructuredChatDebugTurnResponseSchema as TurnResponseSchema,
} from "./core/debug-protocol.js"

export type {
  InspectChatStateOptions as InspectOptions,
  StructuredChatDebugSnapshot as Snapshot,
} from "./core/debug.js"

export type {
  PresentChatDebugReplyOptions as PresentOptions,
  StructuredChatDebugTurnResponse as TurnResponse,
} from "./core/debug-protocol.js"

/** Debuggable persisted reply for one opaque chat definition. */
export type Reply<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> = ChatReply<Name, Version, Stages>

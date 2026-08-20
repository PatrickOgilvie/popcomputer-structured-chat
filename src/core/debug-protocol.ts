import { Effect, Schema } from "effect"
import type {
  ChatDefinition,
  ChatReply,
  ChatStageTuple,
} from "./chat.js"
import {
  inspectChatState,
  type InspectChatStateOptions,
  type InvalidChatDebugProjection,
  StructuredChatDebugSnapshotSchema,
} from "./debug.js"
import {
  presentChatReply,
  StructuredChatTurnResponseSchema,
  type InvalidChatPresentation,
  type PresentChatReplyOptions,
} from "./protocol.js"

type BrowserPresentableTurn = Parameters<
  typeof presentChatReply
>[0]["turn"]

type DebugChatTurn<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> = ChatReply<Name, Version, Stages>["turn"] & BrowserPresentableTurn

type DebugChatReply<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> = Omit<ChatReply<Name, Version, Stages>, "turn"> & {
  readonly sessionId: string
  readonly turn: DebugChatTurn<Name, Version, Stages>
}

/** Explicit opt-in browser response carrying one debug state projection. */
export const StructuredChatDebugTurnResponseSchema = Schema.Struct({
  ...StructuredChatTurnResponseSchema.fields,
  debug: StructuredChatDebugSnapshotSchema,
})

/** Explicit opt-in browser response carrying one debug state projection. */
export type StructuredChatDebugTurnResponse = Schema.Schema.Type<
  typeof StructuredChatDebugTurnResponseSchema
>

/** Presentation and state-inspection policies for one debug chat reply. */
export interface PresentChatDebugReplyOptions<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> {
  readonly presentation?: PresentChatReplyOptions<
    DebugChatTurn<Name, Version, Stages>
  >
  readonly inspection?: InspectChatStateOptions
}

/**
 * Project one persisted reply into the explicit debug browser protocol.
 *
 * Applications must select this presenter deliberately and should authorize
 * its endpoint independently from whether a debug panel is visually mounted.
 */
export const presentChatDebugReply = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
>(
  chat: ChatDefinition<Name, Version, Stages>,
  reply: DebugChatReply<Name, Version, Stages>,
  options: PresentChatDebugReplyOptions<Name, Version, Stages> = {},
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatPresentation | InvalidChatDebugProjection
> =>
  Effect.gen(function* () {
    const response = yield* presentChatReply(
      reply,
      options.presentation,
    )
    const debug = yield* inspectChatState(
      chat,
      reply.turn.state,
      options.inspection,
    )

    return { ...response, debug }
  })

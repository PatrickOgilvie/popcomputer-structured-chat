import { cast, Effect, Schema } from "effect"
import type {
  ChatDefinition,
  ChatReply,
  ChatReplyError,
  ChatStageTuple,
} from "./chat.js"
import {
  inspectChatState,
  InvalidChatDebugProjection,
  type InspectChatStateOptions,
  type StructuredChatDebugSnapshot,
  StructuredChatDebugSnapshotSchema,
} from "./debug.js"
import {
  StructuredChatDebugTraceSchema,
  type StructuredChatDebugEvent,
  type StructuredChatDebugTrace,
} from "./debug-trace.js"
import {
  presentChatReply,
  StructuredChatPersistedTurnResponseSchema,
  StructuredChatSessionReferenceSchema,
  type InvalidChatPresentation,
  type PresentChatReplyOptions,
} from "./protocol.js"
import { ChatSessionIdSchema } from "./session.js"

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

/** A successful persisted reply together with its captured debug events. */
export interface CapturedChatDebugSuccess<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> {
  readonly _tag: "Succeeded"
  readonly reply: ChatReply<Name, Version, Stages>
  readonly events: ReadonlyArray<StructuredChatDebugEvent>
}

/** A typed failed reply together with events captured before that failure. */
export interface CapturedChatDebugFailure<Stages extends ChatStageTuple> {
  readonly _tag: "Failed"
  /** Parsed request identity, or null when boundary validation rejected it. */
  readonly sessionId: string | null
  readonly error: ChatReplyError<Stages>
  readonly events: ReadonlyArray<StructuredChatDebugEvent>
}

/** Explicit success-or-failure result returned by one literal debug run. */
export type CapturedChatDebugOutcome<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> =
  | CapturedChatDebugSuccess<Name, Version, Stages>
  | CapturedChatDebugFailure<Stages>

const StructuredChatDebugFailureSessionSchema = Schema.Struct({
  id: ChatSessionIdSchema,
})

/** Successful debug response carrying state and one literal turn trace. */
export const StructuredChatDebugTurnSuccessResponseSchema = Schema.Struct({
  ...StructuredChatPersistedTurnResponseSchema.fields,
  outcome: Schema.Literal("success"),
  debug: StructuredChatDebugSnapshotSchema,
  trace: StructuredChatDebugTraceSchema,
})

/** Failed debug response carrying events captured before the turn stopped. */
export const StructuredChatDebugTurnFailureResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  outcome: Schema.Literal("failure"),
  session: Schema.NullOr(StructuredChatDebugFailureSessionSchema),
  trace: StructuredChatDebugTraceSchema,
})

/** Explicit opt-in browser response for a successful or failed debug turn. */
export const StructuredChatDebugTurnResponseSchema = Schema.Union([
  StructuredChatDebugTurnSuccessResponseSchema,
  StructuredChatDebugTurnFailureResponseSchema,
])

/** Explicit opt-in browser response for a successful or failed debug turn. */
export type StructuredChatDebugTurnResponse = Schema.Schema.Type<
  typeof StructuredChatDebugTurnResponseSchema
>

/** State and trace update delivered atomically to browser debug consumers. */
export type StructuredChatDebugTurn =
  | {
      readonly _tag: "Succeeded"
      readonly session: Schema.Schema.Type<
        typeof StructuredChatSessionReferenceSchema
      >
      readonly snapshot: StructuredChatDebugSnapshot
      readonly trace: StructuredChatDebugTrace
    }
  | {
      readonly _tag: "Failed"
      readonly session: Schema.Schema.Type<
        typeof StructuredChatDebugTurnFailureResponseSchema
      >["session"]
      readonly trace: StructuredChatDebugTrace
    }

type ChatDebugPresentationInput<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> =
  | ChatReply<Name, Version, Stages>
  | CapturedChatDebugOutcome<Name, Version, Stages>

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

const invalidTrace = (): InvalidChatDebugProjection =>
  new InvalidChatDebugProjection({ reason: "invalid_trace" })

const parseDebugResponse = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this protocol projection boundary strictly parses the complete browser response
  input: unknown,
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatDebugProjection
> =>
  Schema.decodeUnknownEffect(StructuredChatDebugTurnResponseSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(invalidTrace))

/**
 * Project one persisted reply or explicit captured outcome into the debug
 * browser protocol.
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
  input: ChatDebugPresentationInput<Name, Version, Stages>,
  options: PresentChatDebugReplyOptions<Name, Version, Stages> = {},
): Effect.Effect<
  StructuredChatDebugTurnResponse,
  InvalidChatPresentation | InvalidChatDebugProjection
> => {
  const outcome: CapturedChatDebugOutcome<Name, Version, Stages> =
    "_tag" in input
      ? input
      : { _tag: "Succeeded", reply: input, events: [] }
  const trace = {
    schemaVersion: 1 as const,
    events: outcome.events,
  }
  if (outcome._tag === "Failed") {
    return parseDebugResponse({
      schemaVersion: 2,
      outcome: "failure",
      session:
        outcome.sessionId === null
          ? null
          : { id: outcome.sessionId },
      trace,
    })
  }

  return Effect.gen(function* () {
    // SAFETY: Debug.turn obtains replies from this definition's sealed runtime;
    // every public stage result carries the views required by presentation.
    const reply = cast<
      typeof outcome.reply,
      DebugChatReply<Name, Version, Stages>
    >(outcome.reply)
    const response = yield* presentChatReply(
      reply,
      options.presentation,
    )
    const debug = yield* inspectChatState(
      chat,
      reply.turn.state,
      options.inspection,
    )
    return yield* parseDebugResponse({
      ...response,
      outcome: "success",
      debug,
      trace,
    })
  })
}

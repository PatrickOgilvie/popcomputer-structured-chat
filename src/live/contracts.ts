import type { Effect } from "effect"
import { Context, Data, Schema, type Stream } from "effect"
import { StructuredChatPersistedTurnResponseSchema } from "../core/protocol.js"
import { ChatNameSchema, ChatVersionSchema } from "../core/chat-identity.js"
import {
  ChatSessionIdSchema,
  ChatSessionNamespaceSchema,
} from "../core/session.js"

/** Opaque provider identity; never interpret a provider-specific prefix. */
export const Id = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
)

const Offset = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** One original speech fragment, retaining its role and session-relative interval. */
export const Fragment = Schema.Struct({
  eventId: Id,
  role: Schema.Literals(["user", "assistant"]),
  delta: Schema.String.check(Schema.isMaxLength(50_000)),
  startMs: Offset,
  endMs: Offset,
}).check(Schema.makeFilter((fragment) => fragment.endMs >= fragment.startMs))

/** One original speech fragment, before any application turn grouping. */
export interface Fragment extends Schema.Schema.Type<typeof Fragment> {}

/** Provider-neutral events required by the client-delegation runtime. */
export const Event = Schema.TaggedUnion({
  Transcript: { fragment: Fragment },
  Delegated: { eventId: Id, delegationId: Id, offsetMs: Offset },
  Accepted: { eventId: Id, clientEventId: Id },
  Rejected: { eventId: Id, clientEventId: Schema.NullOr(Id) },
  Usage: { seconds: Offset },
  Closed: { seconds: Offset },
})

/** A decoded provider event, never a raw socket payload. */
export type Event = typeof Event.Type

/** Application-authorized binding of one provider session to one workflow scope. */
export const Binding = Schema.Struct({
  liveSessionId: Id,
  namespace: ChatSessionNamespaceSchema,
  sessionId: ChatSessionIdSchema,
  chat: ChatNameSchema,
  version: ChatVersionSchema,
})

/** Construct only after authenticating and authorizing the requested workflow scope. */
export interface Binding extends Schema.Schema.Type<typeof Binding> {}

/** Explicit, serializable output: speech and browser views have separate consumers. */
export const Presentation = Schema.Struct({
  speech: Schema.NullOr(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(50_000)),
  ),
  browser: Schema.NullOr(StructuredChatPersistedTurnResponseSchema),
}).check(
  Schema.makeFilter(
    (presentation) =>
      presentation.speech !== null || presentation.browser !== null,
  ),
)

/** Only this projection is retained for delivery; arbitrary server results never cross this seam. */
export interface Presentation extends Schema.Schema.Type<typeof Presentation> {}

/** Safe failure at the provider connection boundary. */
export class ConnectionFailure extends Schema.TaggedError<ConnectionFailure>()(
  "LiveConnectionFailure",
  {
    reason: Schema.Literals([
      "invalid_event",
      "read_failed",
      "write_failed",
      "unexpected_end",
      "provider_rejected",
      "session_mismatch",
      "invalid_input",
    ]),
  },
) {}

/** A presentation cannot be safely sent to its intended consumers. */
export class InvalidPresentation extends Schema.TaggedError<InvalidPresentation>()(
  "InvalidLivePresentation",
  {
    reason: Schema.Literals([
      "invalid_output",
      "missing_speech_projection",
      "speech_budget",
      "token_count_unavailable",
    ]),
  },
) {}

/** A binding, policy decision, or action violates the Live runtime contract. */
export class InvalidAction extends Schema.TaggedError<InvalidAction>()(
  "InvalidLiveAction",
  {
    reason: Schema.Literals([
      "invalid_binding",
      "wrong_chat",
      "multiple_turns",
      "invalid_decision",
      "missing_candidate",
      "stale_candidate",
      "invalid_state",
      "history_limit",
      "identity_conflict",
    ]),
  },
) {}

/** An interrupted or uncertain session cannot safely resume automatically. */
export class RecoveryRequired extends Schema.TaggedError<RecoveryRequired>()(
  "LiveRecoveryRequired",
  {
    reason: Schema.Literals([
      "session_already_owned",
      "session_interrupted",
      "backend_outcome_unknown",
      "committed_presentation_missing",
    ]),
  },
) {}

/** Provider command correlation is distinct from backend idempotency. */
export interface Commentary {
  readonly eventId: string
  readonly delegationId: string
  readonly content: string
}

/** A connected provider session. Acquisition and cleanup belong to its supplying layer. */
export interface ConnectionService {
  readonly sessionId: string
  readonly events: Stream.Stream<Event, ConnectionFailure>
  readonly commentary: (
    input: Commentary,
  ) => Effect.Effect<void, ConnectionFailure | InvalidPresentation>
  readonly close: () => Effect.Effect<void, ConnectionFailure>
}

/** Media/provider transport, independent of application workflow execution. */
export class Connection extends Context.Service<
  Connection,
  ConnectionService
>()("@popcomputer/structured-chat/live/Connection") {}

/** An idempotent application notification or browser update. */
export type Publication = Data.TaggedEnum<{
  Presentation: {
    readonly id: string
    readonly delegationId: string
    readonly presentation: Presentation
    readonly superseded: boolean
  }
  Notice: {
    readonly id: string
    readonly reason: "superseded" | "delivery_unknown" | "delivery_rejected"
  }
}>

/** @internal Construct a typed application notification after output validation. */
export const Publication = Data.taggedEnum<Publication>()

/** The application channel could not publish an update. */
export class PublicationFailure extends Schema.TaggedError<PublicationFailure>()(
  "LivePublicationFailure",
  { reason: Schema.Literal("publish_failed") },
) {}

/** Browser/application channel; repeated publication IDs must be upserted, not appended. */
export class Publisher extends Context.Service<
  Publisher,
  {
    readonly publish: (
      publication: Publication,
    ) => Effect.Effect<void, PublicationFailure>
  }
>()("@popcomputer/structured-chat/live/Publisher") {}

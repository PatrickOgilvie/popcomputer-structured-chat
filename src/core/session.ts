import { Context, Effect, Schema } from "effect"
import { UntrustedMessageSchema, type UntrustedMessage } from "./model.js"

/** Stable application-owned identifier for one chat session. */
export const ChatSessionIdSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

/** Optional application-owned partition for otherwise public session IDs. */
export const ChatSessionNamespaceSchema =
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(200),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  )

/** Opaque optimistic revision emitted by a session store adapter. */
export const ChatSessionRevisionSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
)

/** Persisted session snapshot revalidated by the chat runtime after loading. */
export const ChatSessionSnapshotSchema = Schema.Struct({
  revision: ChatSessionRevisionSchema,
  state: Schema.Unknown,
  messages: Schema.Array(UntrustedMessageSchema).check(
    Schema.isMaxLength(200),
  ),
})

/** Parsed persisted chat session snapshot. */
export type ChatSessionSnapshot = Schema.Schema.Type<
  typeof ChatSessionSnapshotSchema
>

/** Successful optimistic session replacement returned by an adapter. */
export const ChatSessionReplacementSchema = Schema.Struct({
  revision: ChatSessionRevisionSchema,
})

/** Successful optimistic session replacement returned by an adapter. */
export type ChatSessionReplacement = Schema.Schema.Type<
  typeof ChatSessionReplacementSchema
>

/** Safe reason that a session store dependency was unavailable. */
export const ChatSessionStoreUnavailableReasonSchema = Schema.Literals([
  "load_failed",
  "write_failed",
])

/** A session store adapter could not load or replace state. */
export class ChatSessionStoreUnavailable extends Schema.TaggedError<ChatSessionStoreUnavailable>()(
  "ChatSessionStoreUnavailable",
  { reason: ChatSessionStoreUnavailableReasonSchema },
) {}

/** A concurrent or stale transition attempted to replace newer state. */
export class ChatSessionConflict extends Schema.TaggedError<ChatSessionConflict>()(
  "ChatSessionConflict",
  { reason: Schema.Literal("concurrent_update") },
) {}

/** Safe reason that a requested persisted session was not found. */
export const ChatSessionNotFoundReasonSchema = Schema.Literal("not_found")

/** A requested persisted chat session does not exist. */
export class ChatSessionNotFound extends Schema.TaggedError<ChatSessionNotFound>()(
  "ChatSessionNotFound",
  { reason: ChatSessionNotFoundReasonSchema },
) {}

/** Safe reason that session input or persisted data was rejected. */
export const InvalidChatSessionReasonSchema = Schema.Literals([
  "invalid_input",
  "invalid_snapshot",
  "invalid_state",
  "invalid_replacement",
  "history_limit",
])

/** Session input or persisted state failed runtime validation. */
export class InvalidChatSession extends Schema.TaggedError<InvalidChatSession>()(
  "InvalidChatSession",
  { reason: InvalidChatSessionReasonSchema },
) {}

/** Stable scope supplied to every session store operation. */
export interface ChatSessionScope {
  readonly namespace: string
  readonly sessionId: string
  readonly chat: string
  readonly version: number
}

/** Complete optimistic replacement supplied to a session store adapter. */
export interface ReplaceChatSessionInput extends ChatSessionScope {
  readonly expectedRevision: string | null
  readonly state: unknown
  readonly messages: ReadonlyArray<UntrustedMessage>
}

/** Narrow persistence seam for server-owned structured chat sessions. */
export interface ChatSessionStoreService {
  /** Load one raw snapshot, or null when the session has not started. */
  readonly load: (
    scope: ChatSessionScope,
  ) => Effect.Effect<unknown | null, ChatSessionStoreUnavailable>

  /** Atomically replace one complete session at its expected revision. */
  readonly replace: (
    input: ReplaceChatSessionInput,
  ) => Effect.Effect<
    unknown,
    ChatSessionStoreUnavailable | ChatSessionConflict
  >
}

/** Effect service for the configured server-owned chat session store. */
export class ChatSessionStore extends Context.Service<
  ChatSessionStore,
  ChatSessionStoreService
>()(
  "@popcomputer/structured-chat/ChatSessionStore",
) {}

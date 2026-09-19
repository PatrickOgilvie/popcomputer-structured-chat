import { Clock, Effect, Schema } from "effect"
import { ConversationMessageSchema } from "../core/conversation-message.js"
import {
  ChatSessionConflict,
  ChatSessionExpired,
  ChatSessionNamespaceSchema,
  ChatSessionStoreUnavailable,
  type ChatSessionScope,
  type ChatSessionStoreService,
  type ReplaceChatSessionInput,
} from "../core/session.js"

/** Effect-native SQLite execution supplied by a driver or application repository. */
export interface ChatSessionSql {
  /** Return an untrusted row, or null when no row matches. */
  readonly read: (query: string, values: ReadonlyArray<unknown>) => Effect.Effect<unknown, ChatSessionStoreUnavailable>
  /** Return the number of rows changed by this statement, within its execution scope. */
  readonly write: (query: string, values: ReadonlyArray<unknown>) => Effect.Effect<number, ChatSessionStoreUnavailable>
}

/** Time-based expiry policy applied to selected session namespaces. */
export interface ChatSessionRetentionOptions {
  /**
   * Non-empty namespace prefixes whose sessions expire; at most 49 prefixes
   * using the same ASCII alphabet as session namespaces.
   */
  readonly expiringNamespacePrefixes: ReadonlyArray<string>
  /** Age in milliseconds after which matching rows expire; positive integer. */
  readonly retentionMillis: number
}

const SessionsTable = "structured_chat_sessions"

const identityPredicate =
  "namespace = ?1 AND session_id = ?2 AND chat = ?3 AND version = ?4"

const SelectSnapshotSql = `SELECT lifecycle, revision, state, messages, updated_at, expired_at FROM ${SessionsTable} WHERE ${identityPredicate} LIMIT 1`

const ExpireSnapshotSql = `UPDATE ${SessionsTable} SET lifecycle = 'expired', revision = NULL, state = NULL, messages = NULL, updated_at = NULL, expired_at = `

const GuardedExpirySql = `${ExpireSnapshotSql}?7 WHERE ${identityPredicate} AND lifecycle = 'active' AND revision = ?5 AND updated_at = ?6`

const InsertInitialSql = `INSERT INTO ${SessionsTable} (namespace, session_id, chat, version, revision, state, messages, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7) ON CONFLICT (namespace, session_id, chat, version) DO NOTHING`

const ReplaceAtRevisionSql = `UPDATE ${SessionsTable} SET revision = ?5, state = ?6, messages = ?7, updated_at = ?8 WHERE ${identityPredicate} AND lifecycle = 'active' AND revision = ?9`

/** Positive-integer bound for retention windows. */
const RetentionMillisSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)

/**
 * Strict retention configuration bounded by D1's 100-parameter query limit.
 *
 * Bulk cleanup uses two parameters per prefix, a cutoff, and an expiry timestamp, so 49
 * prefixes consume exactly 100 parameters.
 */
const ChatSessionRetentionOptionsSchema = Schema.Struct({
  expiringNamespacePrefixes: Schema.Array(ChatSessionNamespaceSchema).check(
    Schema.isMaxLength(49),
  ),
  retentionMillis: RetentionMillisSchema,
})

/** Strict persisted-row shape; excess columns are rejected on load. */
const PersistedRowSchema = Schema.Union([
  Schema.Struct({
    lifecycle: Schema.Literal("active"),
    revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    state: Schema.String,
    messages: Schema.String,
    updated_at: Schema.Finite,
    expired_at: Schema.Null,
  }),
  Schema.Struct({
    lifecycle: Schema.Literal("expired"),
    revision: Schema.Null,
    state: Schema.Null,
    messages: Schema.Null,
    updated_at: Schema.Null,
    expired_at: Schema.Finite,
  }),
])

/** Codec between arbitrary JSON-representable session state and its text form. */
const EncodedStateCodec = Schema.fromJsonString(Schema.Unknown)

/** Codec between bounded untrusted history and its text form. */
const EncodedMessagesCodec = Schema.fromJsonString(
  Schema.Array(ConversationMessageSchema),
)

const loadUnavailable = () =>
  new ChatSessionStoreUnavailable({ reason: "load_failed" })

const writeUnavailable = () =>
  new ChatSessionStoreUnavailable({ reason: "write_failed" })

const conflict = () => new ChatSessionConflict({ reason: "concurrent_update" })

/** Safe revision literal accepted for optimistic replacement. */
const ExpectedRevisionPattern = /^[1-9][0-9]*$/u

const decodePersistedRow = Schema.decodeUnknownEffect(PersistedRowSchema, {
  onExcessProperty: "error",
})

const decodeEncodedState = (encoded: string) =>
  Schema.decodeEffect(EncodedStateCodec)(encoded).pipe(
    Effect.mapError(loadUnavailable),
  )

const decodeEncodedMessages = (encoded: string) =>
  Schema.decodeEffect(EncodedMessagesCodec)(encoded).pipe(
    Effect.mapError(loadUnavailable),
  )

const runWriteStatement = (
  database: ChatSessionSql,
  query: string,
  values: ReadonlyArray<unknown>,
) => database.write(query, values)

const readFirstRow = (
  database: ChatSessionSql,
  values: ReadonlyArray<unknown>,
) => database.read(SelectSnapshotSql, values)

/** Strictly decode one persisted row into the runtime-revalidated payload. */
const decodeSnapshotPayload = (
  revision: number,
  encodedState: string,
  encodedMessages: string,
): Effect.Effect<unknown, ChatSessionStoreUnavailable> =>
  Effect.all({
    state: decodeEncodedState(encodedState),
    messages: decodeEncodedMessages(encodedMessages),
  }).pipe(
    Effect.map(({ state, messages }) => ({
      revision: String(revision),
      state,
      messages,
    })),
  )

const matchesRetentionPrefix = (
  namespace: string,
  prefixes: ReadonlyArray<string>,
): boolean => prefixes.some((prefix) => namespace.startsWith(prefix))

/**
 * Load one raw snapshot payload for the runtime to revalidate, or `null`.
 *
 * When retention is configured and the namespace matches an expiring prefix,
 * an aged row becomes a terminal tombstone guarded by revision and timestamp.
 * A concurrently refreshed row survives and is served instead. Tombstones
 * always fail with `ChatSessionExpired`, even without a retention policy.
 */
const loadSnapshot = (
  database: ChatSessionSql,
  scope: ChatSessionScope,
  retention: ChatSessionRetentionOptions | undefined,
): Effect.Effect<
  unknown | null,
  ChatSessionStoreUnavailable | ChatSessionExpired
> =>
  Effect.gen(function* () {
    const identityValues = [
      scope.namespace,
      scope.sessionId,
      scope.chat,
      scope.version,
    ] as const

    const rawRow = yield* readFirstRow(database, identityValues)

    if (rawRow === null) {
      return null
    }

    const row = yield* decodePersistedRow(rawRow).pipe(
      Effect.mapError(loadUnavailable),
    )

    if (row.lifecycle === "expired") {
      return yield* new ChatSessionExpired({ reason: "expired" })
    }

    if (
      retention !== undefined &&
      matchesRetentionPrefix(
        scope.namespace,
        retention.expiringNamespacePrefixes,
      )
    ) {
      const now = yield* Clock.currentTimeMillis
      const cutoff = now - retention.retentionMillis

      if (row.updated_at <= cutoff) {
        const expired = yield* runWriteStatement(database, GuardedExpirySql, [
          ...identityValues,
          row.revision,
          row.updated_at,
          now,
        ])

        if (expired === 1) {
          return yield* new ChatSessionExpired({ reason: "expired" })
        }

        // The guarded transition lost a race: classify the winning row.
        const refreshedRow = yield* readFirstRow(database, identityValues)

        if (refreshedRow === null) {
          return null
        }

        const refreshed = yield* decodePersistedRow(refreshedRow).pipe(
          Effect.mapError(loadUnavailable),
        )

        if (refreshed.lifecycle === "expired") {
          return yield* new ChatSessionExpired({ reason: "expired" })
        }

        return yield* decodeSnapshotPayload(
          refreshed.revision,
          refreshed.state,
          refreshed.messages,
        )
      }
    }

    return yield* decodeSnapshotPayload(row.revision, row.state, row.messages)
  })

/**
 * Validate retention options eagerly so misconfiguration fails at wiring
 * time rather than mid-request.
 */
const parseRetention = (
  retention: ChatSessionRetentionOptions,
): ChatSessionRetentionOptions =>
  Schema.decodeSync(ChatSessionRetentionOptionsSchema)(retention, {
    onExcessProperty: "error",
  })

const parseOptionalRetention = (
  retention: ChatSessionRetentionOptions | undefined,
): ChatSessionRetentionOptions | undefined =>
  retention === undefined ? undefined : parseRetention(retention)

/**
 * Build a durable structured chat session store on one SQLite execution capability.
 *
 * The returned service performs strict JSON encoding and decoding, optimistic
 * integer revisions, and guarded retention expiry, and validates retention at construction. Operation failures surface as `ChatSessionStoreUnavailable` or
 * `ChatSessionConflict` or `ChatSessionExpired`. Time always comes from the Effect Clock.
 *
 * @param database - Effect-native SQLite execution capability.
 * @param options - Optional behaviour; currently the retention policy.
 * @returns A {@link ChatSessionStoreService} for `Layer.succeed(ChatSessionStore, ...)`.
 */
export const makeSqlChatSessionStore = (
  database: ChatSessionSql,
  options?: { readonly retention?: ChatSessionRetentionOptions },
): ChatSessionStoreService => {
  const retention = parseOptionalRetention(options?.retention)

  return {
    load: (scope: ChatSessionScope) => loadSnapshot(database, scope, retention),
    replace: (input: ReplaceChatSessionInput) =>
      Effect.gen(function* () {
        const encodedState = yield* Schema.encodeEffect(EncodedStateCodec)(
          input.state,
        ).pipe(Effect.mapError(writeUnavailable))

        const encodedMessages = yield* Schema.encodeEffect(
          EncodedMessagesCodec,
        )(input.messages).pipe(Effect.mapError(writeUnavailable))

        const updatedAt = yield* Clock.currentTimeMillis

        if (input.expectedRevision === null) {
          const inserted = yield* runWriteStatement(
            database,
            InsertInitialSql,
            [
              input.namespace,
              input.sessionId,
              input.chat,
              input.version,
              encodedState,
              encodedMessages,
              updatedAt,
            ],
          )

          if (inserted !== 1) {
            return yield* conflict()
          }

          return { revision: "1" }
        }

        if (!ExpectedRevisionPattern.test(input.expectedRevision)) {
          return yield* conflict()
        }

        const expectedRevision = Number(input.expectedRevision)

        if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
          return yield* conflict()
        }

        const nextRevision = expectedRevision + 1

        const updated = yield* runWriteStatement(
          database,
          ReplaceAtRevisionSql,
          [
            input.namespace,
            input.sessionId,
            input.chat,
            input.version,
            nextRevision,
            encodedState,
            encodedMessages,
            updatedAt,
            expectedRevision,
          ],
        )

        if (updated !== 1) {
          return yield* conflict()
        }

        return { revision: String(nextRevision) }
      }),
  }
}

/**
 * Erase every expired snapshot and retain its terminal identity whose namespace matches one retention prefix.
 *
 * Matching uses exact `substr` prefix comparison (no SQL wildcard escaping),
 * and only rows whose `updated_at` is at or before `now - retentionMillis`
 * become tombstones. The Effect resolves with the number of newly expired rows.
 *
 * @param database - Effect-native SQLite execution capability.
 * @param retention - Prefixes and positive-integer age window for expiry.
 * @returns Newly expired row count, failing with `ChatSessionStoreUnavailable`.
 */
export const cleanupExpiredSqlChatSessions = (
  database: ChatSessionSql,
  retention: ChatSessionRetentionOptions,
): Effect.Effect<number, ChatSessionStoreUnavailable> => {
  const parsedRetention = parseRetention(retention)

  if (parsedRetention.expiringNamespacePrefixes.length === 0) {
    return Effect.succeed(0)
  }

  const predicates: Array<string> = []
  const prefixValues: Array<unknown> = []
  parsedRetention.expiringNamespacePrefixes.forEach((prefix, index) => {
    const lengthPlaceholder = index * 2 + 1
    const prefixPlaceholder = index * 2 + 2
    predicates.push(
      `substr(namespace, 1, ?${lengthPlaceholder}) = ?${prefixPlaceholder}`,
    )
    prefixValues.push(prefix.length, prefix)
  })

  const cutoffPlaceholder =
    parsedRetention.expiringNamespacePrefixes.length * 2 + 1

  const expiredAtPlaceholder = cutoffPlaceholder + 1
  const query = `${ExpireSnapshotSql}?${expiredAtPlaceholder} WHERE lifecycle = 'active' AND updated_at <= ?${cutoffPlaceholder} AND (${predicates.join(" OR ")})`

  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const cutoff = now - parsedRetention.retentionMillis

    return yield* runWriteStatement(database, query, [
      ...prefixValues,
      cutoff,
      now,
    ])
  })
}

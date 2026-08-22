import { Clock, Effect, Schema } from "effect"
import { UntrustedMessageSchema } from "../core/model.js"
import {
  ChatSessionConflict,
  ChatSessionNamespaceSchema,
  ChatSessionStoreUnavailable,
  type ChatSessionScope,
  type ChatSessionStoreService,
  type ReplaceChatSessionInput,
} from "../core/session.js"

/**
 * Cloudflare D1 adapter for server-owned structured chat sessions.
 *
 * The store speaks the minimal {@link D1ChatSessionDatabase} port so an
 * application can pass its existing D1 binding straight through. Rows are
 * keyed by the full `(namespace, session_id, chat, version)` tuple and
 * replaced optimistically at an integer revision. The bundled SQL migration
 * lives at `migrations/d1/0001_structured_chat_sessions.sql` in the package
 * root.
 *
 * The shipped tests prove SQL, JSON, optimistic replacement, and retention
 * semantics against SQLite and exercise this exact adapter through a real D1
 * binding inside workerd. Network retries and replication remain deployment
 * concerns outside the local runtime suite.
 */

/**
 * Narrow structural port of one Cloudflare D1 database binding.
 *
 * Applications adapt `env.DB` (or any SQLite-backed client) to this shape;
 * `?N` positional placeholders are native to SQLite and D1.
 */
export interface D1ChatSessionDatabase {
  /** Prepare one SQL statement for repeated binding and execution. */
  readonly prepare: (query: string) => D1ChatSessionStatement
}

/**
 * Narrow structural port of one prepared Cloudflare D1 statement.
 *
 * `bind` accepts positional values and returns a statement ready to execute,
 * mirroring D1's chainable binding style.
 */
export interface D1ChatSessionStatement {
  /** Bind one statement's positional `?N` values in ascending order. */
  readonly bind: (
    ...values: ReadonlyArray<unknown>
  ) => D1ChatSessionStatement
  /** Execute a read and resolve the first row, or `null` when empty. */
  readonly first: (
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw driver port
    ) => Promise<unknown | null>
  /** Execute a write and resolve the driver's raw run result. */
  readonly run: (
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw driver port
    ) => Promise<unknown>
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

const SelectSnapshotSql = `SELECT revision, state, messages, updated_at FROM ${SessionsTable} WHERE ${identityPredicate} LIMIT 1`

const GuardedExpiryDeleteSql = `DELETE FROM ${SessionsTable} WHERE ${identityPredicate} AND updated_at = ?5`

const InsertInitialSql = `INSERT INTO ${SessionsTable} (namespace, session_id, chat, version, revision, state, messages, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7) ON CONFLICT (namespace, session_id, chat, version) DO NOTHING`

const ReplaceAtRevisionSql = `UPDATE ${SessionsTable} SET revision = ?5, state = ?6, messages = ?7, updated_at = ?8 WHERE ${identityPredicate} AND revision = ?9`

/** Positive-integer bound for retention windows. */
const RetentionMillisSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)

/**
 * Strict retention configuration bounded by D1's 100-parameter query limit.
 *
 * Bulk cleanup uses two parameters per prefix and one cutoff parameter, so 49
 * prefixes consume at most 99 parameters.
 */
const ChatSessionRetentionOptionsSchema = Schema.Struct({
  expiringNamespacePrefixes: Schema.Array(
    ChatSessionNamespaceSchema,
  ).check(Schema.isMaxLength(49)),
  retentionMillis: RetentionMillisSchema,
})

/** Strict persisted-row shape; excess columns are rejected on load. */
const PersistedRowSchema = Schema.Struct({
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
  ),
  state: Schema.String,
  messages: Schema.String,
  updated_at: Schema.Finite,
})

/** Minimal D1 run-result shape carrying the changed-row count. */
const RunResultSchema = Schema.Struct({
  meta: Schema.Struct({
    changes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  }),
})

/** Codec between arbitrary JSON-representable session state and its text form. */
const EncodedStateCodec = Schema.fromJsonString(Schema.Unknown)

/** Codec between bounded untrusted history and its text form. */
const EncodedMessagesCodec = Schema.fromJsonString(
  Schema.Array(UntrustedMessageSchema),
)

const loadUnavailable = () =>
  new ChatSessionStoreUnavailable({ reason: "load_failed" })

const writeUnavailable = () =>
  new ChatSessionStoreUnavailable({ reason: "write_failed" })

const conflict = () =>
  new ChatSessionConflict({ reason: "concurrent_update" })

/** Safe revision literal accepted for optimistic replacement. */
const ExpectedRevisionPattern = /^[1-9][0-9]*$/u

const decodePersistedRow = Schema.decodeUnknownEffect(
  PersistedRowSchema,
  { onExcessProperty: "error" },
)

const decodeEncodedState = (encoded: string) =>
  Schema.decodeEffect(EncodedStateCodec)(encoded).pipe(
    Effect.mapError(loadUnavailable),
  )

const decodeEncodedMessages = (encoded: string) =>
  Schema.decodeEffect(EncodedMessagesCodec)(encoded).pipe(
    Effect.mapError(loadUnavailable),
  )

/**
 * Execute one write statement and validate the minimal run result.
 *
 * Any driver rejection or malformed result becomes `write_failed`; the
 * natural-number `meta.changes` count is the only consumed field.
 */
const runWriteStatement = (
  database: D1ChatSessionDatabase,
  query: string,
  values: ReadonlyArray<unknown>,
): Effect.Effect<number, ChatSessionStoreUnavailable> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).run(),
    catch: writeUnavailable,
  }).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(RunResultSchema)(result).pipe(
        Effect.mapError(writeUnavailable),
        Effect.map((parsed) => parsed.meta.changes),
      ),
    ),
  )

const readFirstRow = (
  database: D1ChatSessionDatabase,
  values: ReadonlyArray<unknown>,
): Effect.Effect<unknown | null, ChatSessionStoreUnavailable> =>
  Effect.tryPromise({
    try: () =>
      database.prepare(SelectSnapshotSql).bind(...values).first(),
    catch: loadUnavailable,
  })

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
 * an aged row is removed with a guarded compare-and-delete on `updated_at`
 * before `null` is returned; a row refreshed between the read and the delete
 * survives and is served instead.
 */
const loadSnapshot = (
  database: D1ChatSessionDatabase,
  scope: ChatSessionScope,
  retention: ChatSessionRetentionOptions | undefined,
): Effect.Effect<unknown | null, ChatSessionStoreUnavailable> =>
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
    if (
      retention !== undefined &&
      matchesRetentionPrefix(
        scope.namespace,
        retention.expiringNamespacePrefixes,
      )
    ) {
      const cutoff =
        (yield* Clock.currentTimeMillis) - retention.retentionMillis
      if (row.updated_at <= cutoff) {
        const deleted = yield* runWriteStatement(
          database,
          GuardedExpiryDeleteSql,
          [...identityValues, row.updated_at],
        )
        if (deleted === 1) {
          return null
        }
        // The compare-and-delete lost a refresh race: serve the fresh row.
        const refreshedRow = yield* readFirstRow(database, identityValues)
        if (refreshedRow === null) {
          return null
        }
        const refreshed = yield* decodePersistedRow(refreshedRow).pipe(
          Effect.mapError(loadUnavailable),
        )
        return yield* decodeSnapshotPayload(
          refreshed.revision,
          refreshed.state,
          refreshed.messages,
        )
      }
    }
    return yield* decodeSnapshotPayload(
      row.revision,
      row.state,
      row.messages,
    )
  })

/**
 * Validate retention options eagerly so misconfiguration fails at wiring
 * time rather than mid-request.
 */
const parseRetention = (
  retention: ChatSessionRetentionOptions,
): ChatSessionRetentionOptions =>
  Schema.decodeUnknownSync(ChatSessionRetentionOptionsSchema)(retention, {
    onExcessProperty: "error",
  })

const parseOptionalRetention = (
  retention: ChatSessionRetentionOptions | undefined,
): ChatSessionRetentionOptions | undefined =>
  retention === undefined
    ? undefined
    : parseRetention(retention)

/**
 * Build a durable structured chat session store on one Cloudflare D1
 * database binding.
 *
 * The returned service performs strict JSON encoding and decoding, optimistic
 * integer revisions, and guarded retention expiry, and never throws: every
 * failure surfaces as `ChatSessionStoreUnavailable` or
 * `ChatSessionConflict`. Time always comes from the Effect Clock.
 *
 * @param database - Application-adapted D1 (or SQLite) binding port.
 * @param options - Optional behaviour; currently the retention policy.
 * @returns A {@link ChatSessionStoreService} for `Layer.succeed(ChatSessionStore, ...)`.
 */
export const makeD1ChatSessionStore = (
  database: D1ChatSessionDatabase,
  options?: { readonly retention?: ChatSessionRetentionOptions },
): ChatSessionStoreService => {
  const retention = parseOptionalRetention(options?.retention)

  return {
    load: (scope: ChatSessionScope) =>
      loadSnapshot(database, scope, retention),
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
            return yield* Effect.fail(conflict())
          }
          return { revision: "1" }
        }

        if (!ExpectedRevisionPattern.test(input.expectedRevision)) {
          return yield* Effect.fail(conflict())
        }
        const expectedRevision = Number(input.expectedRevision)
        if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
          return yield* Effect.fail(conflict())
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
          return yield* Effect.fail(conflict())
        }
        return { revision: String(nextRevision) }
      }),
  }
}

/**
 * Delete every expired session whose namespace matches one retention prefix.
 *
 * Matching uses exact `substr` prefix comparison (no SQL wildcard escaping),
 * and only rows whose `updated_at` is at or before `now - retentionMillis`
 * are removed. The Effect resolves with the exact number of deleted rows.
 *
 * @param database - Application-adapted D1 (or SQLite) binding port.
 * @param retention - Prefixes and positive-integer age window for expiry.
 * @returns Deleted-row count, failing with `ChatSessionStoreUnavailable`.
 */
export const cleanupExpiredD1ChatSessions = (
  database: D1ChatSessionDatabase,
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
  const query = `DELETE FROM ${SessionsTable} WHERE updated_at <= ?${cutoffPlaceholder} AND (${predicates.join(" OR ")})`

  return Effect.gen(function* () {
    const cutoff =
      (yield* Clock.currentTimeMillis) - parsedRetention.retentionMillis
    return yield* runWriteStatement(database, query, [
      ...prefixValues,
      cutoff,
    ])
  })
}

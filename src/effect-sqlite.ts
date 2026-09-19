import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ChatSessionStore, ChatSessionStoreUnavailable } from "./core/session.js"
import {
  makeSqlChatSessionStore,
  cleanupExpiredSqlChatSessions,
  type ChatSessionSql,
  type ChatSessionRetentionOptions,
} from "./integrations/sqlite-sessions.js"

export {
  makeSqlChatSessionStore,
  cleanupExpiredSqlChatSessions,
  type ChatSessionSql,
  type ChatSessionRetentionOptions,
} from "./integrations/sqlite-sessions.js"

const makeSessionSql = Effect.gen(function* () {
  // Persisted column names and JSON keys must not inherit application transforms.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms()
  return {
    read: (query, values) => sql.unsafe(query, values).pipe(
      // Persisted revisions and timestamps use numbers regardless of caller settings.
      Effect.provideService(SqlClient.SafeIntegers, false),
      Effect.withTracerEnabled(false),
      Effect.map(rows => rows[0] ?? null),
      Effect.mapError(() => new ChatSessionStoreUnavailable({ reason: "load_failed" })),
    ),
    // RETURNING ties the count to this statement, including within caller transactions.
    write: (query, values) => sql.unsafe(`${query} RETURNING 1 AS changed`, values).pipe(
      Effect.withTracerEnabled(false),
      Effect.map(rows => rows.length),
      Effect.mapError(() => new ChatSessionStoreUnavailable({ reason: "write_failed" })),
    ),
  } satisfies ChatSessionSql
})

/** Use an existing SQLite SqlClient; the caller owns its scope, migrations and transactions. */
export const makeSqliteChatSessionStore = (options?: { readonly retention?: ChatSessionRetentionOptions }) =>
  Effect.map(makeSessionSql, sql => makeSqlChatSessionStore(sql, options))

/** Provide Session.Store from the caller's SQLite SqlClient. */
export const layer = (options?: { readonly retention?: ChatSessionRetentionOptions }) =>
  Layer.effect(ChatSessionStore, makeSqliteChatSessionStore(options))

/** Expire matching snapshots through the caller's SQLite client, retaining identity tombstones. */
export const cleanupExpiredSqliteChatSessions = (retention: ChatSessionRetentionOptions) =>
  Effect.flatMap(makeSessionSql, sql => cleanupExpiredSqlChatSessions(sql, retention))

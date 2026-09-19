import { Effect, Schema } from "effect"
import { ChatSessionStoreUnavailable } from "../core/session.js"
import {
  makeSqlChatSessionStore,
  cleanupExpiredSqlChatSessions,
  type ChatSessionSql,
  type ChatSessionRetentionOptions,
} from "./sqlite-sessions.js"

export type { ChatSessionRetentionOptions } from "./sqlite-sessions.js"

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
  readonly bind: (...values: ReadonlyArray<unknown>) => D1ChatSessionStatement
  /** Execute a read and resolve the first row, or `null` when empty. */
  readonly first: (
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw driver port
  ) => Promise<unknown | null>
  /** Execute a write and resolve the driver's raw run result. */
  readonly run: (
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- raw driver port
  ) => Promise<unknown>
}

const RunResultSchema = Schema.Struct({
  meta: Schema.Struct({ changes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)) }),
})

const makeSessionSql = (database: D1ChatSessionDatabase): ChatSessionSql => ({
  read: (query, values) => Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first(),
    catch: () => new ChatSessionStoreUnavailable({ reason: "load_failed" }),
  }),
  write: (query, values) => Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).run(),
    catch: () => new ChatSessionStoreUnavailable({ reason: "write_failed" }),
  }).pipe(Effect.flatMap(result => Schema.decodeUnknownEffect(RunResultSchema)(result)),
    Effect.mapError(() => new ChatSessionStoreUnavailable({ reason: "write_failed" })),
    Effect.map(result => result.meta.changes)),
})

/** Build a D1 session store using the shared SQLite codecs, revisions and retention policy. */
export const makeD1ChatSessionStore = (
  database: D1ChatSessionDatabase,
  options?: { readonly retention?: ChatSessionRetentionOptions },
) => makeSqlChatSessionStore(makeSessionSql(database), options)

/** Erase expired D1 snapshots and retain terminal identity tombstones. */
export const cleanupExpiredD1ChatSessions = (
  database: D1ChatSessionDatabase,
  retention: ChatSessionRetentionOptions,
) => cleanupExpiredSqlChatSessions(makeSessionSql(database), retention)

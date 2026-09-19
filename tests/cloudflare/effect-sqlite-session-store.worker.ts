import { SqliteClient } from "@effect/sql-sqlite-do"
import { runInDurableObject } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { expect, test } from "vitest"
import { Session } from "../../src/index.js"
import { makeSqliteChatSessionStore, cleanupExpiredSqliteChatSessions } from "../../src/effect-sqlite.js"

const scope = { namespace: "preview:sqlite", sessionId: "session", chat: "sqlite_workerd", version: 1 }
const messages = [Session.Message.submitted("submitted"), Session.Message.authored("authored"),
  Session.Message.observed({ role: "user", content: "observed", batchId: "batch", id: "observation" })]
const snapshot = Schema.decodeUnknownSync(Session.SnapshotSchema)

test("Effect SQLite preserves provenance, conflicts and expiry in a Durable Object", async () => {
  await runInDurableObject(env.SQLITE_SESSIONS.getByName("session-store"), async (_instance, state) => {
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (const query of env.TEST_MIGRATIONS.flatMap(migration => migration.queries)) yield* sql.unsafe(query)
      const store = yield* makeSqliteChatSessionStore()
      expect(yield* store.replace({ ...scope, expectedRevision: null, state: { accepted: true }, messages })).toEqual({ revision: "1" })
      const reopened = yield* makeSqliteChatSessionStore()
      expect(snapshot(yield* reopened.load(scope)).messages).toEqual(messages)
      expect(yield* reopened.replace({ ...scope, expectedRevision: null, state: {}, messages }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionConflict" } })
      yield* sql`UPDATE structured_chat_sessions SET updated_at = 0`
      expect(yield* cleanupExpiredSqliteChatSessions({ expiringNamespacePrefixes: ["preview:"], retentionMillis: 1000 })).toBe(1)
      expect(yield* reopened.load(scope).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionExpired" } })
    }).pipe(Effect.provide(SqliteClient.layer({ storage: state.storage }))))
  })
})

test("Durable Object caller transactions roll back session writes on failure and interruption", async () => {
  await runInDurableObject(env.SQLITE_SESSIONS.getByName("transaction-store"), async (_instance, state) => {
    await Effect.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      for (const query of env.TEST_MIGRATIONS.flatMap(migration => migration.queries)) yield* sql.unsafe(query)
      const store = yield* makeSqliteChatSessionStore()
      const failed = yield* store.replace({ ...scope, expectedRevision: null, state: {}, messages })
        .pipe(Effect.andThen(Effect.fail("caller_failure")), sql.withTransaction, Effect.result)
      expect(failed).toMatchObject({ _tag: "Failure", failure: "caller_failure" })
      expect(yield* store.load(scope)).toBeNull()
      const written = yield* Deferred.make<void>()
      const fiber = yield* Effect.gen(function* () {
        yield* store.replace({ ...scope, expectedRevision: null, state: {}, messages })
        yield* Deferred.succeed(written, undefined)
        yield* Effect.never
      }).pipe(sql.withTransaction, Effect.forkScoped)
      yield* Deferred.await(written)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
      expect(yield* store.load(scope)).toBeNull()
    }).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ storage: state.storage }))))
  })
})

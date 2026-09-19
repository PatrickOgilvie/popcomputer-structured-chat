import { SqliteClient } from "@effect/sql-sqlite-bun"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema, Tracer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql"
import { Chat, Model, Session, Stage, Tool } from "../src/index.js"
import { makeSqliteChatSessionStore, cleanupExpiredSqliteChatSessions, layer } from "../src/effect-sqlite.js"

const migration = readFileSync(new URL("../migrations/d1/0001_structured_chat_sessions.sql", import.meta.url), "utf8")
const scope = { namespace: "account:sqlite", sessionId: "session", chat: "sqlite_chat", version: 1 }
const messages = [
  Session.Message.submitted("A submitted answer"),
  Session.Message.authored("An authored question"),
  Session.Message.observed({ role: "user", content: "An observation", batchId: "batch", id: "speech" }),
]
const snapshot = Schema.decodeUnknownSync(Session.SnapshotSchema)

const withDatabase = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(migration)
    return yield* program
  }).pipe(Effect.scoped, Effect.provide(SqliteClient.layer({ filename: ":memory:" }))))

test.each([false, true])("Effect SQLite preserves all message sources and snapshot state on reload (SafeIntegers=%s)", safeIntegers => withDatabase(Effect.gen(function* () {
  const store = yield* makeSqliteChatSessionStore()
  expect(yield* store.replace({ ...scope, expectedRevision: null, state: { accepted: "answer" }, messages })).toEqual({ revision: "1" })
  const reopened = yield* makeSqliteChatSessionStore()
  expect(snapshot(yield* reopened.load(scope))).toEqual({ revision: "1", state: { accepted: "answer" }, messages })
  const sql = yield* SqlClient.SqlClient
  expect(yield* sql`SELECT 1 AS value`).toEqual([{ value: safeIntegers ? 1n : 1 }])
}).pipe(Effect.provideService(SqlClient.SafeIntegers, safeIntegers))))

test("full session identities remain isolated and concurrent writes preserve one winner", () => withDatabase(Effect.gen(function* () {
  const store = yield* makeSqliteChatSessionStore()
  const input = { ...scope, expectedRevision: null, state: {}, messages }
  const created = yield* Effect.all([store.replace(input).pipe(Effect.result), store.replace(input).pipe(Effect.result)], { concurrency: 2 })
  expect(created.filter(Result.isSuccess)).toHaveLength(1)
  expect(created.filter(Result.isFailure).map(result => result.failure._tag)).toEqual(["ChatSessionConflict"])
  for (const other of [{ ...scope, namespace: "other" }, { ...scope, sessionId: "other" }, { ...scope, chat: "other" }, { ...scope, version: 2 }]) {
    expect(yield* store.load(other)).toBeNull()
  }
  const writes = yield* Effect.all(["left", "right"].map(writer => store.replace({ ...input, expectedRevision: "1", state: { writer } }).pipe(Effect.result)), { concurrency: 2 })
  expect(writes.filter(Result.isSuccess)).toHaveLength(1)
  expect(writes.filter(Result.isFailure).map(result => result.failure._tag)).toEqual(["ChatSessionConflict"])
  expect(snapshot(yield* store.load(scope)).revision).toBe("2")
})))

test("corrupt and provenance-free persisted messages fail with a safe typed error", () => withDatabase(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* makeSqliteChatSessionStore()
  yield* store.replace({ ...scope, expectedRevision: null, state: {}, messages })
  for (const invalid of ["not-json-private", JSON.stringify([{ role: "user", content: "private untagged message" }])]) {
    yield* sql`UPDATE structured_chat_sessions SET messages = ${invalid}`
    const result = yield* store.load(scope).pipe(Effect.result)
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionStoreUnavailable", reason: "load_failed" } })
    expect(JSON.stringify(result)).not.toContain("private")
  }
})))

test("driver failures translate to operation-specific errors without leaking SQL", () => withDatabase(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* makeSqliteChatSessionStore()
  yield* sql`DROP TABLE structured_chat_sessions`
  expect(yield* store.load(scope).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionStoreUnavailable", reason: "load_failed" } })
  const write = yield* store.replace({ ...scope, expectedRevision: null, state: { secret: "private-value" }, messages }).pipe(Effect.result)
  expect(write).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionStoreUnavailable", reason: "write_failed" } })
  expect(JSON.stringify(write)).not.toContain("private-value")
})))

test.each([false, true])("expiry erases contents, retains a tombstone and prevents the identity restarting (SafeIntegers=%s)", safeIntegers => withDatabase(Effect.gen(function* () {
  yield* TestClock.setTime(1000)
  const retention = { expiringNamespacePrefixes: ["account:"], retentionMillis: 1000 }
  const store = yield* makeSqliteChatSessionStore({ retention })
  yield* store.replace({ ...scope, expectedRevision: null, state: { private: true }, messages })
  yield* TestClock.setTime(2000)
  expect(yield* store.load(scope).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionExpired" } })
  const sql = yield* SqlClient.SqlClient
  expect(yield* sql`SELECT lifecycle, state, messages FROM structured_chat_sessions`).toEqual([{ lifecycle: "expired", state: null, messages: null }])
  const reopened = yield* makeSqliteChatSessionStore()
  expect(yield* reopened.load(scope).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionExpired" } })
  expect(yield* reopened.replace({ ...scope, expectedRevision: null, state: {}, messages }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionConflict" } })
}).pipe(Effect.provideService(SqlClient.SafeIntegers, safeIntegers), Effect.provide(TestClock.layer()))))

test.each([false, true])("cleanup counts only matching active snapshots and is repeatable (SafeIntegers=%s)", safeIntegers => withDatabase(Effect.gen(function* () {
  yield* TestClock.setTime(1000)
  const store = yield* makeSqliteChatSessionStore()
  for (const namespace of ["account:sqlite", "account:other", "permanent:sqlite"]) {
    yield* store.replace({ ...scope, namespace, expectedRevision: null, state: {}, messages })
  }
  yield* TestClock.setTime(2000)
  const retention = { expiringNamespacePrefixes: ["account:"], retentionMillis: 1000 }
  expect(yield* cleanupExpiredSqliteChatSessions(retention)).toBe(2)
  expect(yield* cleanupExpiredSqliteChatSessions(retention)).toBe(0)
  for (const namespace of ["account:sqlite", "account:other"]) {
    expect(yield* store.load({ ...scope, namespace }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionExpired" } })
  }
  expect(snapshot(yield* store.load({ ...scope, namespace: "permanent:sqlite" })).messages).toEqual(messages)
}).pipe(Effect.provideService(SqlClient.SafeIntegers, safeIntegers), Effect.provide(TestClock.layer()))))

test.each(["failure", "defect"] as const)("session writes roll back with the caller transaction on %s", failure => withDatabase(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* makeSqliteChatSessionStore()
  const exit = yield* Effect.gen(function* () {
    yield* store.replace({ ...scope, expectedRevision: null, state: {}, messages })
    return yield* failure === "failure" ? Effect.fail("caller_failure") : Effect.die("caller_defect")
  }).pipe(sql.withTransaction, Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(yield* store.load(scope)).toBeNull()
  // The client remains usable after rollback; the adapter does not close it.
  expect(yield* store.replace({ ...scope, expectedRevision: null, state: {}, messages })).toEqual({ revision: "1" })
})))

test("interrupting a caller transaction rolls back its session write", () => withDatabase(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* makeSqliteChatSessionStore()
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
})))

test("a chat resumes a persisted nonempty history through a newly acquired store", () => withDatabase(Effect.gen(function* () {
  const inspect = Tool.define({ name: "inspect", description: "Inspect the accepted request", input: Schema.Struct({}), execute: () => Effect.succeed({ ready: true }) })
  const chat = Chat.define({ name: scope.chat, version: scope.version, stages: [Stage.interact({ name: "conversation", instructions: ["Inspect the request"], tools: [inspect] })] })
  const model = Layer.succeed(Model.Service, { requestTool: () => Effect.succeed({ name: "inspect", arguments: {} }) })
  const first = yield* Chat.turn(chat, { namespace: scope.namespace, sessionId: scope.sessionId, message: "Inspect this" }).pipe(Effect.provide(layer()), Effect.provide(model))
  const second = yield* Chat.turn(chat, { namespace: scope.namespace, sessionId: scope.sessionId, expectedRevision: first.revision, message: "Inspect again" }).pipe(Effect.provide(layer()), Effect.provide(model))
  expect(second.revision).toBe("2")
  const reopened = yield* makeSqliteChatSessionStore()
  const saved = snapshot(yield* reopened.load(scope))
  expect(saved.messages.filter(message => message._tag === "Submitted").map(message => message.content)).toEqual(["Inspect this", "Inspect again"])
})))

test("storage column codecs are independent of application result-name transforms", () => Effect.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe(migration)
  const store = yield* makeSqliteChatSessionStore()
  yield* store.replace({ ...scope, expectedRevision: null, state: { original_key: true }, messages })
  expect(snapshot(yield* store.load(scope)).state).toEqual({ original_key: true })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", transformResultNames: name => name.toUpperCase() })))))

test("adapter queries keep private payloads out of tracing while preserving the caller span", () => withDatabase(Effect.gen(function* () {
  const spans: Tracer.Span[] = []
  const tracer = Tracer.make({ span: options => {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  } })
  const store = yield* makeSqliteChatSessionStore()
  yield* Effect.gen(function* () {
    yield* store.replace({ ...scope, expectedRevision: null, state: { secret: "private-trace-value" }, messages })
    yield* store.load(scope)
  }).pipe(Effect.withSpan("application.chat"), Effect.withTracer(tracer))
  expect(spans.map(span => span.name)).toEqual(["application.chat"])
  expect(JSON.stringify(spans.map(span => [...span.attributes]))).not.toContain("private-trace-value")
})))

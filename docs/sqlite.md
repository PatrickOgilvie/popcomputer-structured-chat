# SQLite session persistence

Structured-chat owns session serialization, optimistic revisions and expiry.
Your application supplies a database, applies migrations, authorizes session
access, and owns the database lifetime. The adapters do not open connections,
apply migrations, start cleanup jobs, or run an Effect runtime.

## Effect SQL

Use an existing SQLite-backed `SqlClient` through the optional
`@popcomputer/structured-chat/effect-sqlite` entry point:

```ts
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Session } from "@popcomputer/structured-chat"
import * as ChatSqlite from "@popcomputer/structured-chat/effect-sqlite"
import { Effect, Layer } from "effect"

const database = SqliteClient.layer({ filename: "chat.sqlite" })
const sessions = ChatSqlite.layer({
  retention: {
    expiringNamespacePrefixes: ["preview:"],
    retentionMillis: 24 * 60 * 60 * 1000,
  },
}).pipe(Layer.provide(database))

// Supply sessions alongside your model and application services to Chat.turn.
const program = Effect.gen(function* () {
  const store = yield* Session.Store
  return yield* store.load({
    namespace: "account:42", sessionId: "conversation", chat: "support", version: 1,
  })
}).pipe(Effect.provide(sessions))
```

For an application that already composes its own `Session.Store` layer,
`makeSqliteChatSessionStore(options?)` returns
`Effect<Session.StoreService, never, SqlClient.SqlClient>`.
The driver is an application dependency, not a dependency of structured-chat.
The package tests use matching Effect v4 SQLite drivers for Bun and Cloudflare
Durable Objects. This is a SQLite adapter, not a portable adapter for other SQL
dialects; writes use SQLite's `RETURNING` support.

### Schema and migration ownership

Apply `migrations/d1/0001_structured_chat_sessions.sql` from the package to your
SQLite database before using either adapter. Despite its historical directory
name, this is the single shared SQLite schema used by D1 and Effect SQL. There is
no second copy of the migration to keep synchronized. Existing D1 users require
no schema change for this adapter release.

This schema includes active snapshots and terminal expiry tombstones. Adapting a
custom older schema or provenance-free session history is the application's
explicit upgrade work; this adapter does not silently rewrite stored sessions.

### Transactions and cancellation

When session writes must commit with other application writes, create the store
from the same client and use the client's `withTransaction`:

```ts
import { SqlClient } from "effect/unstable/sql"

const commit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const store = yield* ChatSqlite.makeSqliteChatSessionStore()
  return yield* Effect.gen(function* () {
    // Other application database work can participate here.
    return yield* store.replace({
      namespace: "account:42", sessionId: "conversation", chat: "support", version: 1,
      expectedRevision: null,
      state: {},
      messages: [Session.Message.submitted("Hello")],
    })
  }).pipe(sql.withTransaction)
})
```

The adapter executes queries in the caller's fiber and transaction context.
Typed failures, defects and interruption therefore retain the driver's rollback
behavior. Each individual replacement is also an atomic guarded statement;
concurrent creates or replacements have at most one winner. The adapter does not
retry a conflict or rerun application operations. The store must not outlive the
client scope that created it.

For Durable Objects, provide `@effect/sql-sqlite-do` with the full
`DurableObjectStorage` (`{ storage: ctx.storage }`) when transactions are needed.
The driver owns the Cloudflare transaction integration. D1 retains its existing
Promise-based execution mechanism and does not acquire Effect SQL transactions.

### Expiry, errors and tracing

A never-created identity loads as `null`; a tombstone fails with `Session.Expired`.
Expiry erases state and messages and retains the identity, so a new conversation
needs a new session ID. Stale writes and attempts to recreate expired identities
fail with `Session.Conflict`. Driver/codec failures become `Session.StoreUnavailable`
with `load_failed` or `write_failed`; SQL, payloads and driver error messages are
not included.

`cleanupExpiredSqliteChatSessions(retention)` uses the current `SqlClient` and
returns the number of newly expired rows. The application decides when to run
it. Retention supports at most 49 namespace prefixes, matching the shared D1
parameter budget. Invalid retention configuration fails during store acquisition
or cleanup setup. Time comes from Effect's Clock.

The adapter bypasses application result-name transforms for persistence columns
and reads persisted integers as numbers, even when the caller enables
`SqlClient.SafeIntegers`. The caller’s own queries retain their integer setting.
The adapter disables tracing only around its SQL statements, which contain
private chat state. Caller spans remain enabled.

## Existing application SQL capabilities

The driver-independent `/sqlite` entry exports `ChatSessionSql`,
`makeSqlChatSessionStore`, `cleanupExpiredSqlChatSessions`, and
`ChatSessionRetentionOptions`. The same exports are available from `/effect-sqlite`.

```ts
interface ChatSessionSql {
  readonly read: (query: string, values: ReadonlyArray<unknown>) =>
    Effect.Effect<unknown, Session.StoreUnavailable>
  readonly write: (query: string, values: ReadonlyArray<unknown>) =>
    Effect.Effect<number, Session.StoreUnavailable>
}
```

`read` returns an untrusted row or `null`. `write` returns this statement's
nonnegative affected-row count. Both functions must preserve the caller's Effect
lifetime and map their driver failures to safe session errors. The shared store
owns row parsing, source-bearing message codecs, revision checks and retention.
The shipped D1 adapter implements this same capability.

## Reference implementations

The design follows the official Effect repository's
[SQL-backed persistence](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/persistence/Persistence.ts)
separation between stores and caller-supplied clients. Driver lifetime and
transaction ownership are demonstrated by the
[Bun SQLite driver](https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-bun/src/SqliteClient.ts)
and [Durable Object SQLite driver](https://github.com/Effect-TS/effect/blob/main/packages/sql/sqlite-do/src/SqliteClient.ts).
The tests verify behavior against the pinned package versions rather than assuming
GitHub's main branch is the same API.

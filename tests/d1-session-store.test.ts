import { Chat, Model, Session, Stage, Tool } from "../src/index.js"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Result, Schema } from "effect"
import {
  cleanupExpiredD1ChatSessions,
  makeD1ChatSessionStore,
  type D1ChatSessionDatabase,
  type D1ChatSessionStatement,
} from "../src/integrations/d1.js"

const migrationPath = join(
  import.meta.dir,
  "..",
  "migrations",
  "d1",
  "0001_structured_chat_sessions.sql",
)
const migrationSql = readFileSync(migrationPath, "utf8")

// SAFETY: the store binds only identity text, JSON document strings, and
// integer revisions/timestamps produced by its own strict encoders.
const asSqliteBindings = (
  values: ReadonlyArray<unknown>,
): SQLQueryBindings[] => values as SQLQueryBindings[]

/** Wrap one real SQLite database in the narrow D1 statement port. */
const makeSqliteD1Database = (db: Database): D1ChatSessionDatabase => ({
  prepare: (query: string): D1ChatSessionStatement => {
    const statement = db.prepare(query)
    const bind = (...values: ReadonlyArray<unknown>) => {
      const executeFirst = () =>
        statement.get(...asSqliteBindings(values)) ?? null
      const executeRun = () => {
        const info = statement.run(...asSqliteBindings(values))
        return { meta: { changes: info.changes } }
      }
      return {
        bind,
        first: () => Promise.resolve(executeFirst()),
        run: () => Promise.resolve(executeRun()),
      }
    }
    return bind()
  },
})

const openMigratedDatabase = (): Database => {
  const db = new Database(":memory:")
  db.exec(migrationSql)
  return db
}

const scope = {
  namespace: "account:1",
  sessionId: "session:1",
  chat: "d1_store_test",
  version: 1,
} as const

const replacement = (
  expectedRevision: string | null,
  writer: string,
): Session.ReplaceInput => ({
  ...scope,
  expectedRevision,
  state: { writer },
  messages: [],
})

const decodeSnapshot = Schema.decodeUnknownSync(
  Session.SnapshotSchema,
)

const expectLoadUnavailable = (
  result: Result.Result<unknown, Session.StoreUnavailable | Session.Expired>,
) => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(Session.StoreUnavailable)
    expect(result.failure.reason).toBe("load_failed")
  }
}

const countRows = (db: Database): number => {
  // SAFETY: the migration guarantees the counted column alias on this row.
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM structured_chat_sessions")
    .get() as { total: number }
  return row.total
}

describe("makeD1ChatSessionStore", () => {
  test.each([
    ["an empty prefix", [""]],
    ["a non-namespace character", ["tenant*"]],
    [
      "more prefixes than one D1 cleanup query can bind",
      Array.from({ length: 50 }, (_value, index) => `tenant:${index}`),
    ],
  ])("rejects retention with %s", (_name, expiringNamespacePrefixes) => {
    const db = openMigratedDatabase()
    const adapter = makeSqliteD1Database(db)
    const retention = {
      expiringNamespacePrefixes,
      retentionMillis: 1_000,
    }

    expect(() =>
      makeD1ChatSessionStore(adapter, { retention }),
    ).toThrow()
    expect(() =>
      cleanupExpiredD1ChatSessions(adapter, retention),
    ).toThrow()
  })

  test("copies parsed retention prefixes at construction", async () => {
    const db = openMigratedDatabase()
    const prefixes = ["account:"]
    const store = makeD1ChatSessionStore(makeSqliteD1Database(db), {
      retention: {
        expiringNamespacePrefixes: prefixes,
        retentionMillis: 1_000,
      },
    })
    prefixes[0] = "other:"

    await Effect.runPromise(store.replace(replacement(null, "expired")))
    db.exec("UPDATE structured_chat_sessions SET updated_at = 1000")

    expect(Result.isFailure(await Effect.runPromise(Effect.result(store.load(scope))))).toBe(true)
  })

  test("creates once and round-trips the snapshot at revision '1'", async () => {
    const db = openMigratedDatabase()
    const store = makeD1ChatSessionStore(makeSqliteD1Database(db))

    const created = await Effect.runPromise(
      store.replace(replacement(null, "initial")),
    )
    expect(created).toEqual({ revision: "1" })

    const loaded = await Effect.runPromise(store.load(scope))
    expect(decodeSnapshot(loaded)).toEqual({
      revision: "1",
      state: { writer: "initial" },
      messages: [],
    })
  })

  test("accepts only one of two racing creates", async () => {
    const db = openMigratedDatabase()
    const store = makeD1ChatSessionStore(makeSqliteD1Database(db))

    const attempts = await Effect.runPromise(
      Effect.all(
        ["first", "second"].map((writer) =>
          store.replace(replacement(null, writer)).pipe(
            Effect.as(writer),
            Effect.result,
          ),
        ),
        { concurrency: 2 },
      ),
    )

    const winners = attempts.filter(Result.isSuccess)
    const conflicts = attempts.filter(Result.isFailure)
    expect(winners).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.failure).toBeInstanceOf(Session.Conflict)

    const loaded = await Effect.runPromise(store.load(scope))
    expect(decodeSnapshot(loaded).state).toEqual({
      writer: winners[0]?.success,
    })
  })

  test("rejects a stale expectedRevision and keeps the winner intact", async () => {
    const db = openMigratedDatabase()
    const store = makeD1ChatSessionStore(makeSqliteD1Database(db))

    await Effect.runPromise(store.replace(replacement(null, "initial")))
    const winnerReplacement = await Effect.runPromise(
      store.replace(replacement("1", "winner")),
    )
    expect(winnerReplacement).toEqual({ revision: "2" })

    const stale = await Effect.runPromise(
      Effect.result(store.replace(replacement("1", "stale"))),
    )
    expect(Result.isFailure(stale)).toBe(true)
    if (Result.isFailure(stale)) {
      expect(stale.failure).toBeInstanceOf(Session.Conflict)
    }

    const loaded = await Effect.runPromise(store.load(scope))
    const snapshot = decodeSnapshot(loaded)
    expect(snapshot.revision).toBe("2")
    expect(snapshot.state).toEqual({ writer: "winner" })
  })

  test("maps corrupted rows to unavailable instead of throwing", async () => {
    const badJsonState = `
INSERT INTO structured_chat_sessions (namespace, session_id, chat, version, revision, state, messages, updated_at)
VALUES ('account:1', 'session:1', 'd1_store_test', 1, 1, '{oops', '[]', 1)`
    const dbBadJson = openMigratedDatabase()
    dbBadJson.exec(badJsonState)
    const badJsonResult = await Effect.runPromise(
      Effect.result(
        makeD1ChatSessionStore(makeSqliteD1Database(dbBadJson)).load(
          scope,
        ),
      ),
    )
    expectLoadUnavailable(badJsonResult)

    const dbExcess = openMigratedDatabase()
    const baseDatabase = makeSqliteD1Database(dbExcess)
    const cleanStore = makeD1ChatSessionStore(baseDatabase)
    await Effect.runPromise(cleanStore.replace(replacement(null, "clean")))
    const corruptingDatabase: D1ChatSessionDatabase = {
      prepare: (query) => {
        const baseStatement = baseDatabase.prepare(query)
        let bound: D1ChatSessionStatement = baseStatement
        const decorated: D1ChatSessionStatement = {
          bind: (...values) => {
            bound = baseStatement.bind(...values)
            return decorated
          },
          first: async () => {
            const row = await bound.first()
            if (row === null) {
              return null
            }
            // Deliberately injecting an unexpected column value to prove
            // strict row parsing rejects excess properties.
            return Object.assign({}, row, { legacy_flag: 1 })
          },
          run: () => bound.run(),
        }
        return decorated
      },
    }
    const excessResult = await Effect.runPromise(
      Effect.result(
        makeD1ChatSessionStore(corruptingDatabase).load(scope),
      ),
    )
    expectLoadUnavailable(excessResult)

    const dbZeroRevision = openMigratedDatabase()
    dbZeroRevision.exec("PRAGMA ignore_check_constraints = ON")
    dbZeroRevision.exec(`
INSERT INTO structured_chat_sessions (namespace, session_id, chat, version, revision, state, messages, updated_at)
VALUES ('account:1', 'session:1', 'd1_store_test', 1, 0, '{}', '[]', 1)`)
    dbZeroRevision.exec("PRAGMA ignore_check_constraints = OFF")
    const zeroRevisionResult = await Effect.runPromise(
      Effect.result(
        makeD1ChatSessionStore(
          makeSqliteD1Database(dbZeroRevision),
        ).load(scope),
      ),
    )
    expectLoadUnavailable(zeroRevisionResult)
  })

  test("keeps aged rows when no retention is configured and cleanup matches nothing", async () => {
    const db = openMigratedDatabase()
    const adapter = makeSqliteD1Database(db)
    const store = makeD1ChatSessionStore(adapter)

    await Effect.runPromise(store.replace(replacement(null, "aged")))
    db.exec(
      "UPDATE structured_chat_sessions SET updated_at = 1000",
    )

    const removed = await Effect.runPromise(
      cleanupExpiredD1ChatSessions(adapter, {
        expiringNamespacePrefixes: ["other:"],
        retentionMillis: 1_000,
      }),
    )

    expect(removed).toBe(0)
    expect(countRows(db)).toBe(1)
    const loaded = await Effect.runPromise(store.load(scope))
    expect(decodeSnapshot(loaded).state).toEqual({ writer: "aged" })
  })

  test("expires a session permanently and erases its snapshot", async () => {
    const db = openMigratedDatabase()
    const adapter = makeSqliteD1Database(db)
    const store = makeD1ChatSessionStore(adapter, {
      retention: { expiringNamespacePrefixes: ["account:"], retentionMillis: 1_000 },
    })
    await Effect.runPromise(store.replace(replacement(null, "private")))
    db.exec("UPDATE structured_chat_sessions SET updated_at = 1000")
    const expired = await Effect.runPromise(Effect.result(store.load(scope)))
    expect(Result.isFailure(expired)).toBe(true)
    if (Result.isFailure(expired)) {
      expect(expired.failure._tag).toBe("ChatSessionExpired")
    }
    expect(countRows(db)).toBe(1)
    expect(db.prepare("SELECT lifecycle, revision, state, messages, updated_at FROM structured_chat_sessions").get()).toEqual({
      lifecycle: "expired", revision: null, state: null, messages: null, updated_at: null,
    })
    for (const expectedRevision of [null, "1"]) {
      const retry = await Effect.runPromise(Effect.result(store.replace(replacement(expectedRevision, "resurrected"))))
      expect(Result.isFailure(retry)).toBe(true)
      if (Result.isFailure(retry)) expect(retry.failure).toBeInstanceOf(Session.Conflict)
    }
    // Disabling retention cannot make a terminal identity available again.
    const reload = await Effect.runPromise(Effect.result(makeD1ChatSessionStore(adapter).load(scope)))
    expect(Result.isFailure(reload)).toBe(true)
    if (Result.isFailure(reload)) expect(reload.failure._tag).toBe("ChatSessionExpired")
  })

  test("a same-millisecond refresh wins against an observed expiry revision", async () => {
    const db = openMigratedDatabase()
    const adapter = makeSqliteD1Database(db)
    const store = makeD1ChatSessionStore(adapter)
    await Effect.runPromise(store.replace(replacement(null, "old")))
    db.exec("UPDATE structured_chat_sessions SET updated_at = 1000")
    let refreshed = false
    const racingAdapter: D1ChatSessionDatabase = {
      prepare: (query) => {
        const statement = adapter.prepare(query)
        const bind = (...values: ReadonlyArray<unknown>): D1ChatSessionStatement => {
          const bound = statement.bind(...values)
          return {
            bind,
            first: async () => {
              const observed = await bound.first()
              if (!refreshed) {
                refreshed = true
                // Commit a competing revision without advancing the millisecond.
                db.exec(`UPDATE structured_chat_sessions SET revision = 2, state = '{"writer":"winner"}'`)
              }
              return observed
            },
            run: () => bound.run(),
          }
        }
        return bind()
      },
    }
    const racingStore = makeD1ChatSessionStore(racingAdapter, {
      retention: { expiringNamespacePrefixes: ["account:"], retentionMillis: 1_000 },
    })
    const loaded = await Effect.runPromise(racingStore.load(scope))
    expect(decodeSnapshot(loaded)).toMatchObject({ revision: "2", state: { writer: "winner" } })
    expect(countRows(db)).toBe(1)
  })

  test("expired chat IDs stop before model and tool execution; a new ID gets a new command identity", async () => {
    const db = openMigratedDatabase()
    const store = makeD1ChatSessionStore(makeSqliteD1Database(db), {
      retention: { expiringNamespacePrefixes: ["account:"], retentionMillis: 1_000 },
    })
    const commandIds: string[] = []
    let modelCalls = 0
    let queries = 0
    const Edit = Tool.command({
      name: "edit", description: "Edit the draft.", input: Schema.Struct({}),
      execute: (_, { commandId }) => Effect.sync(() => { commandIds.push(commandId); return { edited: true } }),
    })
    const Inspect = Tool.define({
      name: "inspect", description: "Inspect the draft.", input: Schema.Struct({}),
      execute: () => Effect.sync(() => { queries += 1; return { inspected: true } }),
    })
    const definition = Chat.define({
      name: scope.chat, version: scope.version,
      stages: [Stage.interact({ name: "author", instructions: ["Edit the draft."], tools: [Edit, Inspect] })],
      explorations: [Inspect],
    })
    const live = Layer.mergeAll(Layer.succeed(Session.Store, store), Layer.succeed(Model.Service, {
      requestTool: () => Effect.sync(() => { modelCalls += 1; return { name: "edit", arguments: {} } }),
    }), TestClock.layer())
    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const first = yield* Chat.turn(definition, { namespace: scope.namespace, sessionId: scope.sessionId, message: "Edit it" })
      yield* TestClock.adjust(1_000)
      for (const expectedRevision of [undefined, first.revision]) {
        const expired = yield* Effect.result(Chat.turn(definition, {
          namespace: scope.namespace, sessionId: scope.sessionId, expectedRevision, message: "Edit again",
        }))
        expect(Result.isFailure(expired)).toBe(true)
        if (Result.isFailure(expired)) expect(expired.failure).toBeInstanceOf(Session.Expired)
      }
      const explored = yield* Effect.result(Chat.explore(definition, {
        namespace: scope.namespace, sessionId: scope.sessionId, call: { name: "inspect", arguments: {} },
      }))
      expect(Result.isFailure(explored)).toBe(true)
      if (Result.isFailure(explored)) expect(explored.failure).toBeInstanceOf(Session.Expired)
      expect(modelCalls).toBe(1)
      expect(commandIds).toHaveLength(1)
      expect(queries).toBe(0)
      yield* Chat.turn(definition, { namespace: scope.namespace, sessionId: "new-session", message: "Edit it" })
    }).pipe(Effect.provide(live)))
    expect(commandIds).toHaveLength(2)
    expect(commandIds[0]).not.toBe(commandIds[1])
  })

  test("cleanup during an admitted command makes its final replacement conflict", async () => {
    const db = openMigratedDatabase()
    const adapter = makeSqliteD1Database(db)
    const retention = { expiringNamespacePrefixes: ["account:"], retentionMillis: 1_000 }
    const store = makeD1ChatSessionStore(adapter, { retention })
    let executed = 0
    const Edit = Tool.command({
      name: "edit", description: "Edit the draft.", input: Schema.Struct({}),
      execute: () => Effect.gen(function* () {
        executed += 1
        if (executed === 2) {
          // Time passes after admission while the application operation runs.
          yield* TestClock.adjust(1_000)
          expect(yield* cleanupExpiredD1ChatSessions(adapter, retention)).toBe(1)
        }
        return { edited: true }
      }),
    })
    const definition = Chat.define({
      name: scope.chat, version: scope.version,
      stages: [Stage.interact({ name: "author", instructions: ["Edit the draft."], tools: [Edit] })],
    })
    const live = Layer.mergeAll(
      Layer.succeed(Session.Store, store),
      Layer.succeed(Model.Service, { requestTool: () => Effect.succeed({ name: "edit", arguments: {} }) }),
      TestClock.layer(),
    )
    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const first = yield* Chat.turn(definition, { namespace: scope.namespace, sessionId: scope.sessionId, message: "Edit it" })
      const second = yield* Effect.result(Chat.turn(definition, {
        namespace: scope.namespace, sessionId: scope.sessionId, expectedRevision: first.revision, message: "Edit again",
      }))
      expect(Result.isFailure(second)).toBe(true)
      if (Result.isFailure(second)) expect(second.failure).toBeInstanceOf(Session.Conflict)
      const loaded = yield* Effect.result(store.load(scope))
      expect(Result.isFailure(loaded)).toBe(true)
      if (Result.isFailure(loaded)) expect(loaded.failure).toBeInstanceOf(Session.Expired)
    }).pipe(Effect.provide(live)))
    expect(executed).toBe(2)
    expect(countRows(db)).toBe(1)
  })

  test("tombstones only prefix-matching expired rows once", async () => {
    const db = openMigratedDatabase()
    const adapter = makeSqliteD1Database(db)
    const store = makeD1ChatSessionStore(adapter)

    const expiredA = {
      ...scope,
      namespace: "tenant-a:1",
      sessionId: "expired-a",
    }
    const expiredB = {
      ...scope,
      namespace: "tenant-b:1",
      sessionId: "expired-b",
    }
    const freshA = { ...scope, sessionId: "fresh-a" }
    await Effect.runPromise(
      store.replace({
        ...expiredA,
        expectedRevision: null,
        state: {},
        messages: [],
      }),
    )
    await Effect.runPromise(
      store.replace({
        ...expiredB,
        expectedRevision: null,
        state: {},
        messages: [],
      }),
    )
    await Effect.runPromise(
      store.replace({
        ...freshA,
        expectedRevision: null,
        state: {},
        messages: [],
      }),
    )
    db.exec(
      "UPDATE structured_chat_sessions SET updated_at = 1000 WHERE session_id IN ('expired-a', 'expired-b')",
    )

    const removed = await Effect.runPromise(
      cleanupExpiredD1ChatSessions(adapter, {
        expiringNamespacePrefixes: ["tenant-a"],
        retentionMillis: 1_000,
      }),
    )

    expect(removed).toBe(1)
    expect(await Effect.runPromise(cleanupExpiredD1ChatSessions(adapter, {
      expiringNamespacePrefixes: ["tenant-a"], retentionMillis: 1_000,
    }))).toBe(0)
    // SAFETY: the migration guarantees these selected columns on every row.
    const remaining = db
      .prepare(
        "SELECT session_id FROM structured_chat_sessions WHERE lifecycle = 'active' ORDER BY session_id",
      )
      .all() as Array<{ session_id: string }>
    expect(remaining.map((row) => row.session_id)).toEqual([
      "expired-b",
      "fresh-a",
    ])
  })

  test("conflicts on expected revisions at or beyond MAX_SAFE_INTEGER", async () => {
    const db = openMigratedDatabase()
    const store = makeD1ChatSessionStore(makeSqliteD1Database(db))

    await Effect.runPromise(store.replace(replacement(null, "initial")))

    for (const expectedRevision of [
      String(Number.MAX_SAFE_INTEGER),
      "9007199254740992",
    ]) {
      const attempt = await Effect.runPromise(
        Effect.result(store.replace(replacement(expectedRevision, "giant"))),
      )
      expect(Result.isFailure(attempt)).toBe(true)
      if (Result.isFailure(attempt)) {
        expect(attempt.failure).toBeInstanceOf(Session.Conflict)
      }
    }

    const loaded = await Effect.runPromise(store.load(scope))
    const snapshot = decodeSnapshot(loaded)
    expect(snapshot.revision).toBe("1")
    expect(snapshot.state).toEqual({ writer: "initial" })
  })
})

describe("./d1 package entry point", () => {
  test("declares and resolves the dedicated export", () => {
    // SAFETY: this repository owns the package.json shape being asserted.
    const packageJson = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "package.json"),
        "utf8",
      ),
    ) as { exports: Record<string, { import: string }> }
    const d1Export = packageJson.exports["./d1"]

    expect(d1Export?.import).toBe("./dist/integrations/d1.js")

    const resolved = Bun.resolveSync(
      "@popcomputer/structured-chat/d1",
      import.meta.dir,
    )
    expect(resolved.replace(/\\/gu, "/")).toMatch(
      /dist\/integrations\/d1\.js$/u,
    )
  })
})

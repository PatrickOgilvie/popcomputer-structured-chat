import { env } from "cloudflare:workers"
import { Deferred, Effect, Fiber, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { Session } from "../../src/index.js"
import * as Live from "../../src/integrations/live.js"
import {
  cleanupExpiredD1ChatSessions,
  makeD1ChatSessionStore,
} from "../../src/integrations/d1.js"

const scope = {
  namespace: "runtime:account",
  sessionId: "runtime-session",
  chat: "runtime_d1_store_test",
  version: 1,
} as const

const decodeSnapshot = Schema.decodeUnknownSync(Session.SnapshotSchema)

describe("D1 chat session store in workerd", () => {
  test("retains observed evidence and enforces durable Live ownership across connections", async () => {
    const store = makeD1ChatSessionStore(env.SESSIONS_DB)

    const workflow = {
      ...scope,
      namespace: "live-runtime-account",
      sessionId: "live-runtime-session",
    }

    const messages = [
      Session.Message.observed({
        role: "user",
        content: "Observed speech",
        batchId: "batch",
        id: "fragment",
      }),
    ]

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* store.replace({
          ...workflow,
          expectedRevision: null,
          state: {},
          messages,
        })
        const snapshot = yield* store.load(workflow)
        const journal = yield* Live.Journal
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const binding = { ...workflow, liveSessionId: "first-connection" }

        const first = yield* journal
          .own(
            binding,
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(Effect.forkScoped)

        yield* Deferred.await(started)

        const competing = yield* journal
          .own({ ...binding, liveSessionId: "second-connection" }, Effect.void)
          .pipe(Effect.result)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)

        const next = yield* journal.own(
          { ...binding, liveSessionId: "third-connection" },
          Effect.succeed("owned"),
        )

        return { snapshot, competing, next }
      }).pipe(
        Effect.scoped,
        Effect.provide(Live.journal({ namespace: "live-runtime-journals" })),
        Effect.provideService(Session.Store, store),
      ),
    )

    expect(decodeSnapshot(result.snapshot).messages).toEqual(messages)
    expect(result.competing).toMatchObject({
      _tag: "Failure",
      failure: { reason: "session_already_owned" },
    })
    expect(result.next).toBe("owned")
  })

  test("applies the migration and exercises the real D1 binding", async () => {
    const store = makeD1ChatSessionStore(env.SESSIONS_DB)

    expect(
      await Effect.runPromise(
        store.replace({
          ...scope,
          expectedRevision: null,
          state: { writer: "initial" },
          messages: [],
        }),
      ),
    ).toEqual({ revision: "1" })

    expect(decodeSnapshot(await Effect.runPromise(store.load(scope)))).toEqual({
      revision: "1",
      state: { writer: "initial" },
      messages: [],
    })

    expect(
      await Effect.runPromise(
        store.replace({
          ...scope,
          expectedRevision: "1",
          state: { writer: "winner" },
          messages: [],
        }),
      ),
    ).toEqual({ revision: "2" })

    const stale = await Effect.runPromise(
      Effect.result(
        store.replace({
          ...scope,
          expectedRevision: "1",
          state: { writer: "stale" },
          messages: [],
        }),
      ),
    )

    expect(Result.isFailure(stale)).toBe(true)

    if (Result.isFailure(stale)) {
      expect(stale.failure).toBeInstanceOf(Session.Conflict)
    }

    await env.SESSIONS_DB.prepare(
      "UPDATE structured_chat_sessions SET updated_at = 0 WHERE namespace = ?1",
    )
      .bind(scope.namespace)
      .run()

    expect(
      await Effect.runPromise(
        cleanupExpiredD1ChatSessions(env.SESSIONS_DB, {
          expiringNamespacePrefixes: ["runtime:"],
          retentionMillis: 1,
        }),
      ),
    ).toBe(1)
    const expired = await Effect.runPromise(Effect.result(store.load(scope)))
    expect(Result.isFailure(expired)).toBe(true)

    if (Result.isFailure(expired))
      expect(expired.failure).toBeInstanceOf(Session.Expired)

    for (const expectedRevision of [null, "2"]) {
      const recreate = await Effect.runPromise(
        Effect.result(
          store.replace({
            ...scope,
            expectedRevision,
            state: {},
            messages: [],
          }),
        ),
      )

      expect(Result.isFailure(recreate)).toBe(true)

      if (Result.isFailure(recreate))
        expect(recreate.failure).toBeInstanceOf(Session.Conflict)
    }

    expect(
      await Effect.runPromise(
        cleanupExpiredD1ChatSessions(env.SESSIONS_DB, {
          expiringNamespacePrefixes: ["runtime:"],
          retentionMillis: 1,
        }),
      ),
    ).toBe(0)
  })
})

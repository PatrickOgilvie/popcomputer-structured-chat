import { env } from "cloudflare:workers"
import { Effect, Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { Session } from "../../src/index.js"
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

const decodeSnapshot = Schema.decodeUnknownSync(
  Session.SnapshotSchema,
)

describe("D1 chat session store in workerd", () => {
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

    expect(
      decodeSnapshot(await Effect.runPromise(store.load(scope))),
    ).toEqual({
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
    expect(await Effect.runPromise(store.load(scope))).toBeNull()
  })
})

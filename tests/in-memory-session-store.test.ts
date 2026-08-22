import { Session } from "../src/index.js"
import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { inMemoryChatSessionStore } from "../src/testing.js"

const scope = {
  namespace: "account:1",
  sessionId: "session:1",
  chat: "store_test",
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

describe("inMemoryChatSessionStore", () => {
  test("atomically accepts one of two competing replacements", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Session.Store
        yield* store.replace(replacement(null, "initial"))

        const attempts = yield* Effect.all(
          ["first", "second"].map((writer) =>
            store.replace(replacement("1", writer)).pipe(
              Effect.as(writer),
              Effect.result,
            ),
          ),
          { concurrency: 2 },
        )
        const loaded = yield* store.load(scope)

        return { attempts, loaded }
      }).pipe(Effect.provide(inMemoryChatSessionStore)),
    )

    const winners = result.attempts.filter(Result.isSuccess)
    const conflicts = result.attempts.filter(Result.isFailure)
    expect(winners).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.failure).toBeInstanceOf(Session.Conflict)

    const snapshot = Schema.decodeUnknownSync(
      Session.SnapshotSchema,
    )(result.loaded)
    expect(snapshot.revision).toBe("2")
    expect(snapshot.state).toEqual({ writer: winners[0]?.success })
  })
})

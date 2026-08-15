import { describe, expect, test } from "bun:test"
import { Effect, Either, Schema } from "effect"
import {
  ChatSessionConflict,
  ChatSessionSnapshotSchema,
  ChatSessionStore,
  type ReplaceChatSessionInput,
} from "../src/index.js"
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
): ReplaceChatSessionInput => ({
  ...scope,
  expectedRevision,
  state: { writer },
  messages: [],
})

describe("inMemoryChatSessionStore", () => {
  test("atomically accepts one of two competing replacements", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ChatSessionStore
        yield* store.replace(replacement(null, "initial"))

        const attempts = yield* Effect.all(
          ["first", "second"].map((writer) =>
            store.replace(replacement("1", writer)).pipe(
              Effect.as(writer),
              Effect.either,
            ),
          ),
          { concurrency: 2 },
        )
        const loaded = yield* store.load(scope)

        return { attempts, loaded }
      }).pipe(Effect.provide(inMemoryChatSessionStore)),
    )

    const winners = result.attempts.filter(Either.isRight)
    const conflicts = result.attempts.filter(Either.isLeft)
    expect(winners).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.left).toBeInstanceOf(ChatSessionConflict)

    const snapshot = Schema.decodeUnknownSync(
      ChatSessionSnapshotSchema,
    )(result.loaded)
    expect(snapshot.revision).toBe("2")
    expect(snapshot.state).toEqual({ writer: winners[0]?.right })
  })
})

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CommandIdSchema, deriveCommandId } from "../src/core/command.js"

const identity = {
  namespace: "tenant/a",
  chat: "lookup",
  version: 1,
  sessionId: "session:1",
  expectedRevision: null,
}

test("command identity preserves the exact serialized tuple digest", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* deriveCommandId(identity)
      const replay = yield* deriveCommandId(identity)

      const next = yield* deriveCommandId({
        ...identity,
        expectedRevision: "r1",
      })

      expect(first).toBe(
        CommandIdSchema.make(
          "cmd_075bf5b3542eb74add2c4a808e4eb6ec1a71540eed8b2626643595731fc78271",
        ),
      )
      expect(replay).toBe(first)
      expect(next).toBe(
        CommandIdSchema.make(
          "cmd_0cfbab5b91aed54eb9f859115f3ee055ca8312bac765878a3a5b220bb8de090f",
        ),
      )
    }),
  ))

test("command identity retains tuple boundaries for delimiter-containing names", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const left = yield* deriveCommandId({
        ...identity,
        namespace: "a:b",
        chat: "c",
      })

      const right = yield* deriveCommandId({
        ...identity,
        namespace: "a",
        chat: "b:c",
      })

      expect(left).not.toBe(right)
    }),
  ))

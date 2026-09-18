import { env } from "cloudflare:workers"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { describe, expect, test } from "vitest"
import {
  Answer,
  Chat,
  Model,
  Question,
  Session,
  Stage,
  Tool,
} from "../../src/index.js"
import { makeD1ChatSessionStore } from "../../src/integrations/d1.js"
import * as TypeSafe from "../../src/typesafe.js"
import { runtimeConfig } from "../typesafe-runtime.js"

const fields = {
  interval: Answer.explicit(Schema.Literals(["monthly", "annual"]), {
    description: "Billing interval",
    ask: Question.fixed("Monthly or annual?"),
  }),
  invoice: Answer.explicit(Schema.Boolean, {
    description: "Whether to provide an invoice",
    ask: Question.fixed("Would you like an invoice?"),
  }),
}
const details = Stage.collect({
  name: "details",
  fields,
  resolver: TypeSafe.collection(fields, {
    choices: {
      interval: [
        { value: "monthly", meaning: "Monthly" },
        { value: "annual", meaning: "Annual" },
      ],
      invoice: [
        { value: true, meaning: "Invoice requested" },
        { value: false, meaning: "Invoice declined" },
      ],
    },
    acceptance: {
      interval: { minimumProbability: 0.9, minimumConfidence: 0.8 },
      invoice: { minimumProbability: 0.9, minimumConfidence: 0.8 },
    },
  }),
})
const finish = Tool.define({
  name: "finish",
  description: "Finish collecting",
  input: Schema.Struct({}),
  execute: () => Effect.void,
})
const chat = Chat.define({
  name: "typesafe_d1",
  version: 1,
  stages: [
    details,
    Stage.tools({ name: "finish", instructions: ["Finish"], tools: [finish] }),
  ],
})
const noModel = Layer.succeed(Model.Service, {
  requestTool: () => Effect.die(new Error("Unexpected model call")),
})
const control = Layer.succeed(Chat.TurnControl, {
  check: () => Effect.void,
  admitCommand: () => Effect.void,
  beforeCommit: () => Effect.void,
})
const response = () =>
  Response.json({
    model: "jev-test",
    usage: { input_tokens: 10, output_tokens: 2 },
    answers: {
      interval: {
        type: "choice",
        choice: "candidate_1",
        confidence: 1,
        probabilities: {
          candidate_0: 0,
          candidate_1: 1,
          no_answer: 0,
          ambiguous: 0,
        },
      },
      invoice: {
        type: "choice",
        choice: "no_answer",
        confidence: 1,
        probabilities: {
          candidate_0: 0,
          candidate_1: 0,
          no_answer: 1,
          ambiguous: 0,
        },
      },
    },
  })
const identity = (sessionId: string) => ({ namespace: "typesafe-runtime", sessionId })
const scope = (sessionId: string) => ({
  namespace: "typesafe-runtime",
  sessionId,
  chat: chat.name,
  version: chat.version,
})

describe("TypeSafe collection persisted in D1", () => {
  test("replays an observed batch without another evaluation or write", async () => {
    let requests = 0
    const store = makeD1ChatSessionStore(env.SESSIONS_DB)
    const input = {
      ...identity("replay"),
      turn: {
        _tag: "Observed" as const,
        batchId: "billing",
        messages: [
          { id: "speech", role: "user" as const, content: "Annual please" },
        ],
      },
    }
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Chat.advance(chat, input)
        const before = yield* store.load(scope("replay"))
        const replay = yield* Chat.advance(chat, input)
        const after = yield* store.load(scope("replay"))
        return { first, replay, before, after }
      }).pipe(
        Effect.provide(
          TypeSafe.layer(
            runtimeConfig(async () => {
              requests += 1
              return response()
            }),
          ),
        ),
        Effect.provide(noModel),
        Effect.provide(control),
        Effect.provideService(Session.Store, store),
      ),
    )
    expect(result.first._tag).toBe("Applied")
    expect(result.replay).toEqual({
      _tag: "AlreadyApplied",
      currentRevision: "1",
    })
    expect(result.before).not.toBeNull()
    expect(result.after).toEqual(result.before)
    expect(requests).toBe(1)
  })

  test("provider failure leaves the persisted session unchanged", async () => {
    let requests = 0
    const store = makeD1ChatSessionStore(env.SESSIONS_DB)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* Chat.turn(chat, {
          ...identity("failure"),
          message: "Annual please",
        })
        const before = yield* store.load(scope("failure"))
        const failed = yield* Chat.turn(chat, {
          ...identity("failure"),
          expectedRevision: initial.revision,
          message: "No invoice",
        }).pipe(Effect.result)
        const after = yield* store.load(scope("failure"))
        return { before, failed, after }
      }).pipe(
        Effect.provide(
          TypeSafe.layer(
            runtimeConfig(async () => {
              requests += 1
              return requests === 1
                ? response()
                : Response.json({ error: "Unavailable" }, { status: 401 })
            }),
          ),
        ),
        Effect.provide(noModel),
        Effect.provideService(Session.Store, store),
      ),
    )
    expect(result.failed).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TypeSafeRequestRejected", reason: "unauthorized" },
    })
    expect(result.after).toEqual(result.before)
    expect(requests).toBe(2)
  })

  test("concurrent evaluations cannot overwrite a newer revision", async () => {
    let requests = 0
    const store = makeD1ChatSessionStore(env.SESSIONS_DB)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bothStarted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const layer = TypeSafe.layer(
          runtimeConfig(async () => {
            requests += 1
            if (requests > 1) {
              if (requests === 3)
                await Effect.runPromise(
                  Deferred.succeed(bothStarted, undefined),
                )
              await Effect.runPromise(Deferred.await(release))
            }
            return response()
          }),
        )
        return yield* Effect.gen(function* () {
          const initial = yield* Chat.turn(chat, {
            ...identity("conflict"),
            message: "Annual please",
          })
          const turn = Chat.turn(chat, {
            ...identity("conflict"),
            expectedRevision: initial.revision,
            message: "Still annual",
          }).pipe(Effect.result)
          const first = yield* turn.pipe(Effect.forkScoped)
          const second = yield* turn.pipe(Effect.forkScoped)
          yield* Deferred.await(bothStarted)
          yield* Deferred.succeed(release, undefined)
          const results = [yield* Fiber.join(first), yield* Fiber.join(second)]
          const snapshot = yield* store.load(scope("conflict"))
          const stale = yield* Chat.turn(chat, {
            ...identity("conflict"),
            expectedRevision: initial.revision,
            message: "Annual",
          }).pipe(Effect.result)
          return { results, snapshot, stale }
        }).pipe(Effect.provide(layer))
      }).pipe(
        Effect.scoped,
        Effect.provide(noModel),
        Effect.provideService(Session.Store, store),
      ),
    )
    expect(
      result.results.filter((entry) => entry._tag === "Success"),
    ).toHaveLength(1)
    expect(
      result.results.find((entry) => entry._tag === "Failure"),
    ).toMatchObject({ failure: { _tag: "ChatSessionConflict" } })
    expect(Schema.decodeUnknownSync(Session.SnapshotSchema)(result.snapshot).revision).toBe("2")
    expect(result.stale).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ChatSessionConflict" },
    })
    expect(requests).toBe(3)
  })
})

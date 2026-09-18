import { Effect, Redacted } from "effect"
import { describe, expect, test } from "vitest"
import * as TypeSafe from "../../src/typesafe.js"
import { cancellationCase, runtimeConfig } from "../typesafe-runtime.js"

describe("optional TypeSafe adapter in workerd", () => {
  test("runs the real SDK and parses its typed response", async () => {
    const layer = TypeSafe.layer({
      ...runtimeConfig(async () =>
        Response.json({
          model: "jev-test",
          answers: { ready: { type: "noul", noul: 0.95 } },
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      ),
      apiKey: Redacted.make("worker-test-key"),
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TypeSafe.Service
        return yield* service.evaluate({
          state: "Ready",
          questions: TypeSafe.batch({
            ready: TypeSafe.noul("Is the user ready?"),
          }),
        })
      }).pipe(Effect.provide(layer)),
    )
    expect(result.answers.ready.probability).toBe(0.95)
  })
  test("propagates interruption through the SDK transport", async () => {
    expect(await Effect.runPromise(cancellationCase())).toEqual({
      aborted: true,
      requests: 1,
      interrupted: true,
      failed: false,
    })
  })
})

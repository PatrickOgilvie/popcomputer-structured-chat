import { Effect, Layer, Redacted, Schema } from "effect"
import { describe, expect, test } from "vitest"
import {
  Answer,
  Model,
  Question,
  Session,
  Stage,
} from "../../src/index.js"
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
  test("detects answered fields and gates generative extraction", async () => {
    const fields = {
      need: Answer.explicit(Schema.Literals(["strategy", "creative"]), {
        description: "The agency need",
        ask: Question.fixed("What do you need?"),
      }),
      budget: Answer.explicit(Schema.Literals(["under_25k", "50k_plus"]), {
        description: "The budget band",
        ask: Question.fixed("What budget?"),
      }),
    }
    const stage = Stage.collect({
      name: "brief",
      fields,
      detector: TypeSafe.detection(fields, {
        acceptance: {
          need: { minimumProbability: 0.9 },
          budget: { minimumProbability: 0.9 },
        },
      }),
    })
    const layer = TypeSafe.layer({
      ...runtimeConfig(async (_url, init) => {
        const request = Schema.decodeUnknownSync(
          Schema.Struct({
            questions: Schema.Record(Schema.String, Schema.Json),
          }),
        )(JSON.parse(String(init?.body)))
        return Response.json({
          model: "jev-test",
          usage: { input_tokens: 5, output_tokens: 1 },
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              { type: "noul", noul: id === "need" ? 0.99 : 0.1 },
            ]),
          ),
        })
      }),
      apiKey: Redacted.make("worker-detection-key"),
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("We need strategy help")],
        })
        .pipe(
          Effect.provide(layer),
          Effect.provide(
            Layer.succeed(
              Model.Service,
              Model.Service.of({
                requestTool: () =>
                  Effect.succeed(
                    Schema.decodeUnknownSync(Schema.Json)({
                      name: "submit_answers",
                      arguments: {
                        answers: { need: "strategy", budget: "50k_plus" },
                        evidence: [
                          { field: "need", quote: "strategy" },
                          { field: "budget", quote: "strategy" },
                        ],
                        nextQuestion: null,
                      },
                    }),
                  ),
              }),
            ),
          ),
        ),
    )
    expect(result.state.accepted.need?.value).toBe("strategy")
    expect(result.state.accepted.budget).toBeUndefined()
  })
})

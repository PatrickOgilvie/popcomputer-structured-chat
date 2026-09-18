import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cancellationCase, timeoutCase } from "./typesafe-runtime.js"
import * as TypeSafe from "../src/typesafe.js"

const questions = () =>
  TypeSafe.batch({
    department: TypeSafe.choice("Which department handles this request?", {
      billing: "Invoices and payments",
      support: "Product support",
    }),
    urgent: TypeSafe.noul("Does the user need help immediately?"),
    severity: TypeSafe.score("How disruptive is the problem?", [
      "No disruption",
      "Blocked work",
    ]),
  })

const validResponse = () => ({
  model: "jev-test",
  answers: {
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, support: 0.1 },
      confidence: 0.8,
    },
    urgent: { type: "noul", noul: 0.2 },
    severity: {
      type: "score",
      score: 0.3,
      probabilities: { "0": 0.7, "1": 0.3 },
      legend: { "0": "No disruption", "1": "Blocked work" },
      confidence: 0.4,
    },
  },
  usage: { input_tokens: 50, output_tokens: 5 },
})

const config = (fetch: NonNullable<TypeSafe.Config["fetch"]>) => ({
  apiKey: Redacted.make("private-test-key"),
  model: "jev-test",
  totalTimeoutMilliseconds: 1_000,
  retry: { maximumAttempts: 1 as const, delayMilliseconds: 0 },
  limits: {
    maximumQuestions: 20,
    maximumStateCharacters: 10_000,
  },
  fetch,
})

const evaluate = () =>
  Effect.gen(function* () {
    const client = yield* TypeSafe.Service
    return yield* client.evaluate({
      state: "Please check this invoice",
      questions: questions(),
    })
  })

describe("TypeSafe", () => {
  test("evaluates a mixed batch with typed answers and explicit transport configuration", async () => {
    const requests: Array<{
      url: string
      body: unknown
      authorization: string | null
    }> = []
    const result = await Effect.runPromise(
      evaluate().pipe(
        Effect.provide(
          TypeSafe.layer(
            config(async (url, init) => {
              if (!Schema.is(Schema.String)(init?.body))
                throw new Error("Expected JSON body")
              requests.push({
                url,
                body: JSON.parse(init.body),
                authorization: new Headers(init.headers).get("authorization"),
              })
              return Response.json(validResponse())
            }),
          ),
        ),
      ),
    )
    const department: "billing" | "support" = result.answers.department.value
    expect(department).toBe("billing")
    expect(result.answers.urgent).toEqual({ _tag: "Noul", probability: 0.2 })
    expect(result.answers.severity).toEqual({
      _tag: "Score",
      value: 0.3,
      probabilities: [0.7, 0.3],
      confidence: 0.4,
    })
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 5 })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(requests[0]?.authorization).toBe("Bearer private-test-key")
    expect(requests[0]?.body).toMatchObject({
      model: "jev-test",
      questions: { urgent: { type: "noul" } },
    })
  })

  test("preserves structured yes/no criteria through the SDK transport", async () => {
    const instructions = { question: "Is dataset attachment needed?", focus: "Remaining work only" }
    const criteria = {
      true: { what: "Attach an existing dataset", examples: ["Attach the published invoices dataset"] },
      false: { what: "Importing a new file", examples: ["Import this CSV"] },
    }
    const requests: unknown[] = []
    const result = await Effect.runPromise(Effect.gen(function* () {
      const client = yield* TypeSafe.Service
      return yield* client.evaluate({
        state: "Attach the published invoices dataset",
        questions: TypeSafe.batch({ attach: TypeSafe.noul(instructions, criteria) }),
      })
    }).pipe(Effect.provide(TypeSafe.layer(config(async (_url, init) => {
      if (!Schema.is(Schema.String)(init?.body)) throw new Error("Expected JSON body")
      requests.push(JSON.parse(init.body))
      return Response.json({
        model: "jev-test", answers: { attach: { type: "noul", noul: 0.93 } },
        usage: { input_tokens: 50, output_tokens: 5 },
      })
    })))))
    expect(result.answers.attach.probability).toBe(0.93)
    expect(requests).toEqual([expect.objectContaining({
      questions: { attach: { type: "noul", instructions, criteria } },
    })])
  })

  test("rejects missing answers and out-of-set selections", async () => {
    for (const answers of [
      {},
      {
        ...validResponse().answers,
        department: {
          type: "choice",
          choice: "admin",
          probabilities: { admin: 1 },
          confidence: 1,
        },
      },
    ]) {
      const error = await Effect.runPromise(
        evaluate().pipe(
          Effect.provide(
            TypeSafe.layer(
              config(async () =>
                Response.json({ ...validResponse(), answers }),
              ),
            ),
          ),
          Effect.flip,
        ),
      )
      expect(error._tag).toBe("TypeSafeInvalidResponse")
    }
  })

  test("does not expose provider response bodies in authentication failures", async () => {
    const error = await Effect.runPromise(
      evaluate().pipe(
        Effect.provide(
          TypeSafe.layer(
            config(async () =>
              Response.json(
                { detail: "private-test-key and confidential material" },
                { status: 401 },
              ),
            ),
          ),
        ),
        Effect.flip,
      ),
    )
    expect(error).toMatchObject({
      _tag: "TypeSafeRequestRejected",
      reason: "unauthorized",
    })
    expect(JSON.stringify(error)).not.toContain("private-test-key")
    expect(JSON.stringify(error)).not.toContain("confidential material")
  })
})

describe("TypeSafe boundaries", () => {
  test("preserves rounded probabilities without promoting their confidence", async () => {
    for (const support of [0.09, 0.11]) {
      const response = validResponse()
      response.answers.department.probabilities.support = support
      const result = await Effect.runPromise(evaluate().pipe(Effect.provide(
        TypeSafe.layer(config(async () => Response.json(response))),
      )))
      expect(result.answers.department.probabilities).toEqual({ billing: 0.9, support })
      expect(result.answers.department.confidence).toBe(0.8)
    }
  })

  test("caps rounding tolerance for large candidate sets", async () => {
    const criteria = Object.fromEntries(Array.from({ length: 106 }, (_, i) => [`tool_${i}`, `Tool ${i}`]))
    for (const selected of [0.99, 0.94]) {
      const response = { model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 }, answers: { next: {
        type: "choice", choice: "tool_0", confidence: 0.9,
        probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === "tool_0" ? selected : 0])),
      } } }
      const configuration = config(async () => Response.json(response))
      const result = await Effect.runPromise(Effect.gen(function* () {
        return yield* (yield* TypeSafe.Service).evaluate({ state: "Choose next tool", questions: TypeSafe.batch({ next: TypeSafe.choice("Next?", criteria) }) })
      }).pipe(Effect.provide(TypeSafe.layer(configuration)), Effect.result))
      expect(result._tag).toBe(selected === 0.99 ? "Success" : "Failure")
    }
  })

  test("parses provider distributions and rejects unrelated answers", async () => {
    const responses = [
      {
        ...validResponse(),
        answers: {
          ...validResponse().answers,
          unexpected: { type: "noul", noul: 1 },
        },
      },
      {
        ...validResponse(),
        answers: {
          ...validResponse().answers,
          urgent: { type: "noul", noul: -1 },
        },
      },
      {
        ...validResponse(),
        answers: {
          ...validResponse().answers,
          urgent: { type: "noul", noul: "yes" },
        },
      },
      {
        ...validResponse(),
        answers: {
          ...validResponse().answers,
          department: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.9, support: 0.9 },
            confidence: 0.8,
          },
        },
      },
      {
        ...validResponse(),
        answers: {
          ...validResponse().answers,
          severity: { ...validResponse().answers.severity, score: 5 },
        },
      },
      { ...validResponse(), usage: { input_tokens: -1, output_tokens: 0 } },
    ]
    for (const response of responses) {
      const error = await Effect.runPromise(
        evaluate().pipe(
          Effect.provide(
            TypeSafe.layer(config(async () => Response.json(response))),
          ),
          Effect.flip,
        ),
      )
      expect(error._tag).toBe("TypeSafeInvalidResponse")
    }
  })

  test("validates input budgets before making a request", async () => {
    let calls = 0
    const settings = config(async () => {
      calls += 1
      return Response.json(validResponse())
    })
    const error = await Effect.runPromise(
      evaluate().pipe(
        Effect.provide(
          TypeSafe.layer({
            ...settings,
            limits: { ...settings.limits, maximumQuestions: 1 },
          }),
        ),
        Effect.flip,
      ),
    )
    expect(error).toMatchObject({
      _tag: "EvaluationInputRejected",
      reason: "budget_exceeded",
    })
    expect(calls).toBe(0)
  })

  test("retries transient responses only up to the adapter limit", async () => {
    let calls = 0
    const settings = config(async () => {
      calls += 1
      return calls === 1
        ? Response.json({}, { status: 429 })
        : Response.json(validResponse())
    })
    const result = await Effect.runPromise(
      evaluate().pipe(
        Effect.provide(
          TypeSafe.layer({
            ...settings,
            retry: { maximumAttempts: 2, delayMilliseconds: 0 },
          }),
        ),
      ),
    )
    expect(result.answers.department.value).toBe("billing")
    expect(calls).toBe(2)
    calls = 0
    const exhausted = await Effect.runPromise(
      evaluate().pipe(
        Effect.provide(
          TypeSafe.layer({
            ...settings,
            retry: { maximumAttempts: 2, delayMilliseconds: 0 },
            fetch: async () => {
              calls += 1
              return Response.json({}, { status: 529 })
            },
          }),
        ),
        Effect.flip,
      ),
    )
    expect(exhausted).toMatchObject({
      _tag: "TypeSafeUnavailable",
      reason: "overloaded",
    })
    expect(calls).toBe(2)
  })

  test("does not retry permanent or malformed responses", async () => {
    for (const status of [401, 403, 404, 422, 200]) {
      let calls = 0
      const settings = config(async () => {
        calls += 1
        return new Response("not valid JSON", { status })
      })
      await Effect.runPromise(
        evaluate().pipe(
          Effect.provide(
            TypeSafe.layer({
              ...settings,
              retry: { maximumAttempts: 3, delayMilliseconds: 0 },
            }),
          ),
          Effect.flip,
        ),
      )
      expect(calls).toBe(1)
    }
  })

  test("propagates interruption into the SDK without converting it to a failure", async () => {
    expect(await Effect.runPromise(cancellationCase())).toEqual({
      aborted: true,
      requests: 1,
      interrupted: true,
      failed: false,
    })
  })

  test("enforces a total evaluation deadline", async () => {
    const result = await Effect.runPromise(timeoutCase())
    expect(result.aborted).toBe(true)
    expect(result.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TypeSafeUnavailable", reason: "timeout" },
    })
  })
})


describe("TypeSafe configuration and retry waits", () => {
  test("rejects invalid server configuration before transport", async () => {
    let requests = 0
    const settings = config(async () => {
      requests += 1
      return Response.json(validResponse())
    })
    for (const invalid of [
      { ...settings, apiKey: Redacted.make("") },
      { ...settings, model: "" },
      { ...settings, totalTimeoutMilliseconds: 0 },
      { ...settings, retry: { maximumAttempts: 2 as const, delayMilliseconds: -1 } },
      { ...settings, limits: { ...settings.limits, maximumQuestions: 0 } },
    ]) {
      const result = await Effect.runPromise(evaluate().pipe(
        Effect.provide(TypeSafe.layer(invalid)), Effect.result,
      ))
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "TypeSafeConfigurationInvalid" } })
    }
    expect(requests).toBe(0)
  })

  test("cancels retry waits and includes them in the total deadline", async () => {
    for (const interrupt of [true, false]) {
      let requests = 0
      const result = await Effect.runPromise(Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const settings = config(async () => {
          requests += 1
          await Effect.runPromise(Deferred.succeed(started, undefined))
          return Response.json({}, { status: 503 })
        })
        const fiber = yield* evaluate().pipe(
          Effect.provide(TypeSafe.layer({
            ...settings,
            totalTimeoutMilliseconds: 500,
            retry: { maximumAttempts: 3, delayMilliseconds: 1_000 },
          })),
          Effect.result,
          Effect.forkChild,
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust(100)
        if (interrupt) {
          yield* Fiber.interrupt(fiber)
          yield* TestClock.adjust(2_000)
          return undefined
        }
        yield* TestClock.adjust(1_000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())))
      expect(requests).toBe(1)
      if (!interrupt) expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "TypeSafeUnavailable", reason: "timeout" } })
    }
  })
})

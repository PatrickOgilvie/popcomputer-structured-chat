import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"
import { Answer, Chat, Model, Question, Session, Stage, Tool } from "../src/index.js"
import { inMemoryChatSessionStore } from "../src/testing.js"
import { captureDebugEvents } from "../src/core/debug-trace.js"
import type { JsonValue } from "../src/core/json-value.js"

const fields = {
  location: Answer.explicit(Schema.String, { description: "Agency location", ask: Question.fixed("Local or remote?") }),
  market: Answer.explicit(Schema.String, { description: "Team country", ask: Question.fixed("Which country is your team based in?") }),
  timeline: Answer.explicit(Schema.String, { description: "Start timing", ask: Question.fixed("When would you like to get started?") }),
}

const makeBrief = (detection = false) => Stage.collect({
  name: "brief", fields,
  detector: detection ? Stage.detector(fields, context => Effect.succeed({
    _tag: "Resolved", selections: context.fields.map(({ field }) => ({ _tag: "Uncertain", field })),
  })) : undefined,
})

const call = (answers: JsonValue, evidence: JsonValue = [], nextQuestion: JsonValue = null): JsonValue => ({
  name: "submit_answers", arguments: { answers, evidence, nextQuestion },
})

const scripted = (responses: ReadonlyArray<JsonValue>) => {
  const requests: Array<Model.ToolRequest> = []
  const layer = Layer.succeed(Model.Service, Model.Service.of({ requestTool: request => Effect.sync(() => {
    requests.push(request)
    const response = responses[requests.length - 1]
    if (response === undefined) throw new Error("Unexpected model request in test")
    return response
  }) }))
  return { requests, layer }
}

const ukMessages = [
  Session.Message.submitted("We need a local agency."),
  Session.Message.authored("Which country is your team based in?"),
  Session.Message.submitted("the UK"),
]
const ukState = {
  accepted: { location: { value: "local", evidence: { messageIndex: 0, quote: "local agency" } } },
  asked: { market: { messageIndex: 1, text: "Which country is your team based in?" } },
}

describe("collection proposal recovery", () => {
  test.each([false, true])("accepts UK beside an unchanged location without another request (detection: %s)", async detection => {
    const brief = makeBrief(detection)
    const model = scripted([call({ location: "local", market: "UK", timeline: null }, [{ field: "market", quote: "the UK" }])])
    const captured = await Effect.runPromise(captureDebugEvents(brief.run({ state: ukState, messages: ukMessages })).pipe(Effect.provide(model.layer)))
    expect(Result.isSuccess(captured.result)).toBe(true)
    if (Result.isFailure(captured.result)) throw new Error("Expected a successful collection")
    const turn = captured.result.success
    expect(model.requests).toHaveLength(1)
    expect(turn.state.accepted.location).toEqual(ukState.accepted.location)
    expect(turn.state.accepted.market).toEqual({ value: "UK", evidence: { messageIndex: 2, quote: "the UK" } })
    expect(turn.question?.field).toBe("timeline")
    expect(captured.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ _tag: "AnswerProposalAssessed", field: "location", decision: "unchanged" }),
      expect.objectContaining({ _tag: "AnswerProposalAssessed", field: "market", decision: "grounded" }),
    ]))
  })

  test("compares decoded objects and dates by schema and never revalidates unchanged answers", async () => {
    let validations = 0
    const brief = Stage.collect({ name: "brief", fields: {
      profile: Answer.explicit(Schema.Struct({ market: Schema.String, since: Schema.DateFromString }), {
        description: "Profile", ask: Question.fixed("Profile?"),
        validate: () => Effect.sync(() => { validations += 1 }), reject: { ask: Question.fixed("Try again?") },
      }),
      timeline: fields.timeline,
    } })
    const state = { accepted: { profile: { value: { market: "UK", since: new Date("2026-01-01T00:00:00.000Z") }, evidence: { messageIndex: 0, quote: "UK since January" } } }, asked: {} }
    const model = scripted([call({ profile: { since: "2026-01-01T00:00:00.000Z", market: "UK" }, timeline: "ASAP" }, [{ field: "timeline", quote: "ASAP" }])])
    const turn = await Effect.runPromise(brief.run({ state, messages: [Session.Message.submitted("UK since January"), Session.Message.submitted("ASAP")] }).pipe(Effect.provide(model.layer)))
    expect(turn.complete).toBe(true)
    expect(turn.state.accepted.profile).toEqual(state.accepted.profile)
    expect(validations).toBe(0)
    expect(model.requests).toHaveLength(1)
  })

  test("repairs only the invalid field, keeps good proposals, and validates each once afterward", async () => {
    const validated: Array<string> = []
    let beforeModel = 0
    let beforeValidation = 0
    const guard = Model.guard({ name: "combined-proposal", check: () => Effect.sync(() => { beforeModel += 1 }), checkCall: ({ call }) => Effect.sync(() => {
      beforeValidation += 1
      expect(validated).toEqual([])
      expect(call.arguments).toMatchObject({ answers: { market: "UK", budget: 20000 } })
    }) })
    const brief = Stage.collect({ name: "brief", guards: [guard], fields: {
      market: Answer.explicit(Schema.String, { description: "Country", ask: fields.market.question, validate: value => Effect.sync(() => { validated.push(value) }), reject: { ask: Question.fixed("Country?") } }),
      budget: Answer.explicit(Schema.Number, { description: "Budget", ask: Question.fixed("Budget?"), validate: value => Effect.sync(() => { validated.push(String(value)) }), reject: { ask: Question.fixed("Budget?") } }),
    } })
    const model = scripted([
      call({ market: "UK", budget: "twenty thousand" }, [{ field: "market", quote: "UK" }, { field: "budget", quote: "20k" }]),
      call({ budget: 20000 }, [{ field: "budget", quote: "20k" }]),
    ])
    const turn = await Effect.runPromise(brief.run({ state: brief.initialState, messages: [Session.Message.submitted("UK, budget 20k")] }).pipe(Effect.provide(model.layer)))
    expect(turn.complete).toBe(true)
    expect(turn.state.accepted.market?.value).toBe("UK")
    expect(turn.state.accepted.budget?.value).toBe(20000)
    expect(validated).toEqual(["UK", "20000"])
    expect(beforeModel).toBe(1)
    expect(beforeValidation).toBe(1)
    expect(model.requests).toHaveLength(2)
    const repair = model.requests[1]
    expect(repair?.tools[0]?.inputSchema).toMatchObject({ properties: { answers: { properties: { budget: expect.anything() } } } })
    expect(repair?.tools[0]?.inputSchema).not.toMatchObject({ properties: { answers: { properties: { market: expect.anything() } } } })
    expect(repair?.instructions.join(" ")).toContain("invalid_value")
  })

  test.each(["missing", "duplicate", "ineligible", "wrong_type"])("retains a valid answer when %s evidence repair is exhausted", async kind => {
    const brief = makeBrief()
    const badEvidence = kind === "missing" ? [] : kind === "duplicate"
      ? [{ field: "market", quote: "UK" }, { field: "market", quote: "UK" }]
      : [{ field: "market", quote: kind === "wrong_type" ? 42 : "USA" }]
    const model = scripted([
      call({ location: "local", market: "UK", timeline: null }, [{ field: "location", quote: "local" }, ...badEvidence]),
      call({ market: "UK" }, badEvidence),
    ])
    const turn = await Effect.runPromise(brief.run({ state: brief.initialState, messages: [Session.Message.submitted("local, UK")] }).pipe(Effect.provide(model.layer)))
    expect(model.requests).toHaveLength(2)
    expect(turn.state.accepted.location?.value).toBe("local")
    expect(turn.state.accepted.market).toBeUndefined()
    expect(turn.state.clarifying).toEqual(["market"])
    expect(turn.question).toMatchObject({ field: "market", text: "Could you clarify your answer? Which country is your team based in?" })
  })

  test.each(["malformed", "overwrite"])("retains good answers if repair is %s", async kind => {
    const brief = makeBrief()
    const model = scripted([
      call({ location: "local", market: "UK" }, [{ field: "location", quote: "local" }]),
      kind === "malformed" ? { name: "submit_answers", arguments: {} } : call({ location: "remote", market: "UK" }, [{ field: "market", quote: "UK" }]),
    ])
    const turn = await Effect.runPromise(brief.run({ state: brief.initialState, messages: [Session.Message.submitted("local, UK")] }).pipe(Effect.provide(model.layer)))
    expect(model.requests).toHaveLength(2)
    expect(turn.state.accepted.location?.value).toBe("local")
    expect(turn.state.accepted.market).toBeUndefined()
    expect(turn.question?.field).toBe("market")
  })

  test("shares a two-request budget between structural and evidence repair", async () => {
    const brief = makeBrief()
    const model = scripted([
      { name: "wrong_tool", arguments: {} },
      call({ location: "local", market: "UK" }, [{ field: "market", quote: "UK" }]),
    ])
    const turn = await Effect.runPromise(brief.run({ state: brief.initialState, messages: [Session.Message.submitted("local, UK")] }).pipe(Effect.provide(model.layer)))
    expect(model.requests).toHaveLength(2)
    expect(turn.state.accepted.market?.value).toBe("UK")
    expect(turn.state.accepted.location).toBeUndefined()
  })

  test("ignores invalid optional wording without losing grounded values", async () => {
    const brief = makeBrief()
    const model = scripted([call({ location: "local" }, [{ field: "location", quote: "local" }], { bad: true })])
    const turn = await Effect.runPromise(brief.run({ state: brief.initialState, messages: [Session.Message.submitted("local")] }).pipe(Effect.provide(model.layer)))
    expect(turn.state.accepted.location?.value).toBe("local")
    expect(turn.question?.field).toBe("market")
    expect(model.requests).toHaveLength(1)
  })

  test("keeps an unsupported correction pending across persistence and allows reaffirming the old value", async () => {
    const brief = makeBrief()
    const model = scripted([
      call({ location: "remote", market: "UK", timeline: "ASAP" }, [{ field: "market", quote: "the UK" }, { field: "timeline", quote: "ASAP" }]),
      call({ location: "remote" }),
      call({ location: "local" }, [{ field: "location", quote: "keep it local" }]),
    ])
    const first = await Effect.runPromise(brief.run({ state: ukState, messages: [...ukMessages, Session.Message.submitted("ASAP")] }).pipe(Effect.provide(model.layer)))
    expect(first.complete).toBe(false)
    expect(first.state.accepted.location).toEqual(ukState.accepted.location)
    expect(first.state.clarifying).toEqual(["location"])
    expect(first.question?.field).toBe("location")
    if (first.question === undefined) throw new Error("Expected clarification")
    const restored = await Effect.runPromise(Schema.encodeEffect(brief.stateSchema)(first.state).pipe(Effect.flatMap(Schema.decodeUnknownEffect(brief.stateSchema))))
    const second = await Effect.runPromise(brief.run({ state: restored, messages: [...ukMessages, Session.Message.submitted("ASAP"), Session.Message.authored(first.question.text), Session.Message.submitted("keep it local")] }).pipe(Effect.provide(model.layer)))
    expect(second.complete).toBe(true)
    expect(second.state.clarifying).toBeUndefined()
    expect(second.state.accepted.location).toEqual(ukState.accepted.location)
    expect(model.requests).toHaveLength(3)
  })

  test("rejects stale correction evidence while preserving other new answers", async () => {
    const brief = makeBrief()
    const state = { accepted: { location: { value: "local", evidence: { messageIndex: 1, quote: "local" } } }, asked: {} }
    const model = scripted([
      call({ location: "remote", market: "UK" }, [{ field: "location", quote: "remote" }, { field: "market", quote: "UK" }]),
      call({ location: "remote" }, [{ field: "location", quote: "remote" }]),
    ])
    const turn = await Effect.runPromise(brief.run({ state, messages: [Session.Message.submitted("remote"), Session.Message.submitted("Actually local"), Session.Message.submitted("UK")] }).pipe(Effect.provide(model.layer)))
    expect(turn.state.accepted.location).toEqual(state.accepted.location)
    expect(turn.state.accepted.market?.value).toBe("UK")
    expect(turn.question?.field).toBe("location")
  })

  test("an unchanged proposal cannot clear a clarification without fresh evidence", async () => {
    const brief = makeBrief()
    const model = scripted([call({ location: "local" }), call({ location: "local" }, [{ field: "location", quote: "local agency" }])])
    const turn = await Effect.runPromise(brief.run({
      state: { ...ukState, clarifying: ["location"], asked: { ...ukState.asked, location: { messageIndex: 3, text: "Local or remote?" } } },
      messages: [...ukMessages, Session.Message.authored("Local or remote?"), Session.Message.submitted("I guess")],
    }).pipe(Effect.provide(model.layer)))
    expect(turn.complete).toBe(false)
    expect(turn.state.clarifying).toEqual(["location"])
    expect(turn.state.accepted.location).toEqual(ukState.accepted.location)
    expect(model.requests).toHaveLength(2)
  })

  test("saves good answers once and blocks search until clarification is resolved", async () => {
    const brief = makeBrief()
    let searches = 0
    const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.sync(() => { searches += 1; return "done" }) })
    const chat = Chat.define({ name: "recovery", version: 1, stages: [brief, Stage.tools({ name: "results", instructions: ["Search"], tools: [search] })] })
    const model = scripted([
      call({ location: "local", market: "UK", timeline: "ASAP" }, [{ field: "location", quote: "local" }, { field: "timeline", quote: "ASAP" }]),
      call({ market: "UK" }),
      call({ market: "UK" }, [{ field: "market", quote: "the UK" }]),
      { name: "search", arguments: {} },
    ])
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "clarify", message: "local, UK, ASAP" })
      expect(first.revision).toBe("1")
      expect(first.turn._tag).toBe("Question")
      expect(searches).toBe(0)
      const second = yield* Chat.turn(chat, { sessionId: "clarify", expectedRevision: first.revision, message: "the UK" })
      expect(second.revision).toBe("2")
      expect(searches).toBe(1)
    }).pipe(Effect.provide(Layer.merge(model.layer, inMemoryChatSessionStore))))
  })

  test.each(["validator", "transport"])("a %s failure after recovery leaves the session unchanged", async failure => {
    class BudgetRejected extends Schema.TaggedError<BudgetRejected>()("BudgetRejected", {}) {}
    let validations = 0
    const brief = Stage.collect({ name: "brief", fields: {
      market: fields.market,
      budget: Answer.explicit(Schema.Number, {
        description: "Budget", ask: Question.fixed("Budget?"),
        validate: budget => Effect.sync(() => { validations += 1 }).pipe(Effect.andThen(budget < 5000 ? Effect.fail(new BudgetRejected({})) : Effect.void)),
        reject: { ask: Question.fixed("Our minimum is 5000. Can you revise the budget?") },
      }),
    } })
    const chat = Chat.define({ name: "atomic_recovery", version: 1, stages: [brief, Stage.tools({
      name: "results", instructions: ["Search"], tools: [Tool.define({
        name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.die("Rejected answers must not reach search"),
      })],
    })] })
    let requests = 0
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => {
      requests += 1
      if (requests === 1) return Effect.succeed(call({ market: null, budget: null }))
      if (requests === 2) return Effect.succeed(call({ market: "UK", budget: "2000" }, [{ field: "market", quote: "UK" }]))
      return failure === "transport"
        ? Effect.fail(new Model.Unavailable({ reason: "request_failed" }))
        : Effect.succeed(call({ budget: 2000 }, [{ field: "budget", quote: "2000" }]))
    } }))
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Session.Store
      const scope = { namespace: "", chat: chat.name, version: chat.version, sessionId: "atomic" }
      const opening = yield* Chat.turn(chat, { sessionId: scope.sessionId, message: "Hello" })
      const before = yield* store.load(scope)
      const rejected = yield* Chat.turn(chat, { sessionId: scope.sessionId, expectedRevision: opening.revision, message: "UK, 2000" }).pipe(Effect.result)
      expect(Result.isFailure(rejected)).toBe(true)
      if (Result.isSuccess(rejected)) throw new Error("Expected a rejected turn")
      expect(rejected.failure._tag).toBe(failure === "transport" ? "ChatModelUnavailable" : "AnswerValidationRejected")
      expect(yield* store.load(scope)).toEqual(before)
      expect(requests).toBe(3)
      expect(validations).toBe(failure === "transport" ? 0 : 1)
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))))
  })

  test("hands an existing clarification to extraction even when detection says undetected", async () => {
    const brief = Stage.collect({ name: "brief", fields, detector: Stage.detector(fields, context => Effect.succeed({
      _tag: "Resolved", selections: context.fields.map(({ field }) => ({ _tag: "Undetected", field })),
    })) })
    const model = scripted([call({ market: "UK" }, [{ field: "market", quote: "the UK" }])])
    const turn = await Effect.runPromise(brief.run({
      state: { ...ukState, clarifying: ["market"] }, messages: ukMessages,
    }).pipe(Effect.provide(model.layer)))
    expect(turn.state.accepted.market?.value).toBe("UK")
    expect(turn.state.clarifying).toBeUndefined()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.untrustedMessages.map(message => message.content).join(" ")).toContain('"clarifying":["market"]')
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Answer, Chat, Model, Question, Session, Stage, Tool } from "../src/index.js"
import { inMemoryChatSessionStore } from "../src/testing.js"
import * as TypeSafe from "../src/typesafe.js"
import { runtimeConfig } from "./typesafe-runtime.js"

const fields = {
  need: Answer.semantic(Schema.String, {
    description: "The work the agency should do",
    ask: Question.fixed("What work do you need?"),
  }),
  budget: Answer.explicit(Schema.String, {
    description: "The project budget in GBP",
    ask: Question.fixed("What is your budget?"),
  }),
  timeline: Answer.explicit(Schema.String, {
    description: "When work should start",
    ask: Question.fixed("When should work start?"),
  }),
}

describe("composable detection policies", () => {
  test("rejects overlapping and out-of-range probability bands", () => {
    expect(TypeSafe.detectionPolicy({ detectedAtOrAbove: 0.9, undetectedAtOrBelow: 0.1 })).toEqual({ detectedAtOrAbove: 0.9, undetectedAtOrBelow: 0.1 })
    for (const [no, yes] of [[0.9, 0.8], [0.8, 0.8], [-0.1, 0.9], [0.1, 1.1]] as const) {
      expect(() => TypeSafe.detectionPolicy({
        detectedAtOrAbove: yes,
        undetectedAtOrBelow: no,
      })).toThrow()
    }
  })

  test("distinguishes yes, no, and uncertainty at inclusive boundaries", async () => {
    const detector = TypeSafe.detection(fields, {
      policy: TypeSafe.detectionPolicy({ detectedAtOrAbove: 0.9, undetectedAtOrBelow: 0.1 }),
      overrides: {
        need: { policy: TypeSafe.detectionPolicy({ detectedAtOrAbove: 0.8, undetectedAtOrBelow: 0.2 }) },
      },
    })
    const result = await Effect.runPromise(detector.detect({
      fields: Object.entries(fields).map(([field, answer]) => ({ field, mode: answer.mode, description: answer.description })),
      evidence: [{ id: "message_0", messageIndex: 0, quote: "A brief" }],
    }).pipe(Effect.provide(TypeSafe.layer(runtimeConfig(async () => Response.json({
      model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        need: { type: "noul", noul: 0.8 },
        budget: { type: "noul", noul: 0.1 },
        timeline: { type: "noul", noul: 0.5 },
      },
    }))))))
    expect(result).toEqual({ _tag: "Resolved", selections: [
      { _tag: "Detected", field: "need" },
      { _tag: "Undetected", field: "budget" },
      { _tag: "Uncertain", field: "timeline" },
    ] })
  })
})

describe("labelled extraction plans", () => {
  test.each([true, false])("accepts user-supplied values outside choice suggestions (detection: %s)", async detectionEnabled => {
    const openFields = {
      timeline: Answer.explicit(Schema.Trimmed.check(Schema.isNonEmpty()), {
        description: "When work should start",
        ask: Question.choice("When should work start?", [{ label: "Next month", value: "next_month" }, { label: "Flexible", value: "flexible" }]),
      }),
      location: Answer.explicit(Schema.Trimmed.check(Schema.isNonEmpty()), {
        description: "Where the agency should work",
        ask: Question.choice("Where should the agency work?", [{ label: "Local", value: "local" }, { label: "Remote", value: "remote" }]),
      }),
      budget: Answer.explicit(Schema.Finite.check(Schema.isGreaterThan(0)), {
        description: "Project budget in GBP",
        ask: Question.choice("What is the budget?", [{ label: "£10k", value: 10000 }, { label: "£20k", value: 20000 }]),
      }),
    }
    const detector = TypeSafe.detection(openFields, {
      policy: TypeSafe.detectionPolicy({ detectedAtOrAbove: 0.9, undetectedAtOrBelow: 0.1 }),
    })
    const stage = Stage.collect({ name: "brief", fields: openFields, detector: detectionEnabled ? detector : undefined })
    const requests: Array<Model.ToolRequest> = []
    const result = await Effect.runPromise(stage.run({ state: stage.initialState, messages: [
      Session.Message.submitted("After funding is approved; two days on site in Glasgow; budget £25k."),
    ] }).pipe(Effect.provide(Layer.merge(
      TypeSafe.layer(runtimeConfig(async () => Response.json({ model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
        timeline: { type: "noul", noul: 0.57 }, location: { type: "noul", noul: 0.57 }, budget: { type: "noul", noul: 0.57 },
      } }))),
      Layer.succeed(Model.Service, Model.Service.of({ requestTool: request => {
        requests.push(request)
        return Effect.succeed({ name: "submit_answers", arguments: {
          answers: { timeline: "After funding is approved", location: "two days on site in Glasgow", budget: 25000 },
          evidence: [{ field: "timeline", quote: "After funding is approved" }, { field: "location", quote: "two days on site in Glasgow" }, { field: "budget", quote: "£25k" }],
          nextQuestion: null,
        } })
      } })),
    ))))
    expect(requests).toHaveLength(1)
    if (detectionEnabled) expect(requests[0]?.untrustedMessages.map(message => message.content).join("\n")).toContain('"assessment":"Uncertain"')
    expect(result.state.accepted.timeline).toMatchObject({ value: "After funding is approved", evidence: { quote: "After funding is approved" } })
    expect(result.state.accepted.location).toMatchObject({ value: "two days on site in Glasgow", evidence: { quote: "two days on site in Glasgow" } })
    expect(result.state.accepted.budget).toMatchObject({ value: 25000, evidence: { quote: "£25k" } })
    expect(result.question).toBeUndefined()
  })

  test("extracts several upfront answers through a narrowed schema and labelled context", async () => {
    const requests: Array<Model.ToolRequest> = []
    const detector = Stage.detector(fields, () => Effect.succeed({
      _tag: "Resolved" as const,
      selections: [
        { _tag: "Detected" as const, field: "need" },
        { _tag: "Uncertain" as const, field: "budget" },
        { _tag: "Undetected" as const, field: "timeline" },
      ],
    }))
    const stage = Stage.collect({
      name: "brief", fields, detector,
      context: Stage.extractionContext(fields, ({ extracting }) => Effect.succeed({ currency: "GBP", extracting })),
    })
    const result = await Effect.runPromise(stage.run({
      state: stage.initialState,
      messages: [Session.Message.submitted("Brand strategy, budget £20k")],
    }).pipe(Effect.provide(Layer.succeed(Model.Service, Model.Service.of({
      requestTool: request => {
        requests.push(request)
        return Effect.succeed({ name: "submit_answers", arguments: {
          answers: { need: "Brand strategy", budget: "under_25k_gbp" },
          evidence: [{ field: "need", quote: "Brand strategy" }, { field: "budget", quote: "£20k" }],
          nextQuestion: null,
        } })
      },
    })))))
    expect(result.state.accepted.need?.value).toBe("Brand strategy")
    expect(result.state.accepted.budget?.value).toBe("under_25k_gbp")
    expect(result.question?.field).toBe("timeline")
    expect(requests).toHaveLength(1)
    const schema = Schema.decodeUnknownSync(Schema.Struct({
      properties: Schema.Struct({ answers: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) }) }),
    }))(requests[0]?.tools[0]?.inputSchema)
    expect(Object.keys(schema.properties.answers.properties)).toEqual(["need", "budget"])
    const data = requests[0]?.untrustedMessages.map(message => message.content).join("\n") ?? ""
    expect(data).toContain('"Uncertain"')
    expect(data).toContain('"currency":"GBP"')
    expect(requests[0]?.instructions.join("\n")).not.toContain('"currency":"GBP"')
  })

  test("rejects model attempts to change excluded fields", async () => {
    let attempts = 0
    const stage = Stage.collect({ name: "brief", fields, detector: Stage.detector(fields, () => Effect.succeed({
      _tag: "Resolved" as const,
      selections: [
        { _tag: "Detected" as const, field: "need" },
        { _tag: "Undetected" as const, field: "budget" },
        { _tag: "Undetected" as const, field: "timeline" },
      ],
    })) })
    const result = await Effect.runPromise(stage.run({ state: stage.initialState, messages: [Session.Message.submitted("Brand strategy")] }).pipe(
      Effect.provide(Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => {
        attempts += 1
        return Effect.succeed({ name: "submit_answers", arguments: {
          answers: { need: "Brand strategy", budget: "invented" },
          evidence: [{ field: "need", quote: "Brand strategy" }], nextQuestion: null,
        } })
      } }))),
    ))
    expect(attempts).toBe(2)
    expect(result.state.accepted).toEqual({})
    expect(result.question?.field).toBe("need")
  })

  test("accumulates values while reducing history and preserving guard context", async () => {
    const requests: Array<Model.ToolRequest> = []
    const guardMessages: Array<number> = []
    const guard = Model.guard({
      name: "full_conversation",
      check: ({ messages }) => Effect.sync(() => { guardMessages.push(messages.length) }),
      checkCall: ({ messages, call }) => Effect.sync(() => {
        guardMessages.push(messages.length)
        expect(Object.keys(Schema.decodeUnknownSync(Schema.Struct({ answers: Schema.Record(Schema.String, Schema.Json) }))(call.arguments).answers)).toEqual(["need", "budget", "timeline"])
      }),
    })
    const stage = Stage.collect({ name: "brief", fields, guards: [guard], detector: Stage.detector(fields, context => {
      const target = context.evidence[0]?.quote.includes("£20k") === true ? "budget" : "need"
      return Effect.succeed({ _tag: "Resolved" as const, selections: context.fields.map(({ field }) => field === target
        ? { _tag: "Detected" as const, field }
        : { _tag: "Undetected" as const, field }) })
    }) })
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: request => {
      requests.push(request)
      const budget = requests.length === 2
      return Effect.succeed({ name: "submit_answers", arguments: {
        answers: budget ? { budget: "under_25k_gbp" } : { need: "Brand strategy" },
        evidence: [{ field: budget ? "budget" : "need", quote: budget ? "£20k" : "Brand strategy" }], nextQuestion: null,
      } })
    } }))
    const messages = [Session.Message.submitted("DISCARDED_OLD_CONTEXT"), ...Array.from({ length: 7 }, () => Session.Message.submitted("Earlier conversation")), Session.Message.submitted("Brand strategy")]
    const first = await Effect.runPromise(stage.run({ state: stage.initialState, messages }).pipe(Effect.provide(model)))
    const second = await Effect.runPromise(stage.run({ state: first.state, messages: [...messages, Session.Message.authored("What is your budget?"), Session.Message.submitted("£20k")] }).pipe(Effect.provide(model)))
    expect(second.state.accepted.need?.value).toBe("Brand strategy")
    expect(second.state.accepted.budget?.value).toBe("under_25k_gbp")
    expect(second.question?.field).toBe("timeline")
    expect(guardMessages).toEqual([9, 9, 11, 11])
    const context = requests[1]?.untrustedMessages.map(message => message.content).join("\n") ?? ""
    expect(context).not.toContain("DISCARDED_OLD_CONTEXT")
    expect(context).toContain('"accepted":{"need"')
    expect(context).toContain("Brand strategy")
  })

  test("uses the latest follow-up wording without moving the first issuance boundary", async () => {
    const firstQuestion = "What do you need?"
    const followup = "Would a new website help?"
    const adaptiveFields = { need: Answer.semantic(Schema.String, { description: "Agency work", ask: Question.adaptive("Clarify the need", { fallback: firstQuestion }) }) }
    const seenQuestions: Array<string | undefined> = []
    const stage = Stage.collect({ name: "brief", fields: adaptiveFields, questions: { escape: "Not sure" }, detector: Stage.detector(adaptiveFields, context => {
      seenQuestions.push(context.fields[0]?.issuedQuestion)
      return Effect.succeed({ _tag: "Resolved" as const, selections: [{ _tag: "Uncertain" as const, field: "need" }] })
    }) })
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => Effect.succeed({ name: "submit_answers", arguments: {
      answers: { need: null }, evidence: [], nextQuestion: { field: "need", text: followup, options: [] },
    } }) }))
    const messages = [Session.Message.authored(firstQuestion), Session.Message.submitted("Not sure")]
    const first = await Effect.runPromise(stage.run({ state: stage.markAsked(stage.initialState, "need", 0, firstQuestion), messages }).pipe(Effect.provide(model)))
    const restored = await Effect.runPromise(stage.parseState(first.state))
    expect(restored.asked.need?.messageIndex).toBe(0)
    expect(restored.asked.need?.latest).toEqual({ messageIndex: 2, text: followup })
    await Effect.runPromise(stage.run({ state: restored, messages: [...messages, Session.Message.authored(followup), Session.Message.submitted("Yes")] }).pipe(Effect.provide(model)))
    expect(seenQuestions).toEqual([followup])
  })

  test("context enrichment works independently of a detector and validates its output", async () => {
    let requests = 0
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => {
      requests += 1
      return Effect.succeed({ name: "submit_answers", arguments: { answers: { need: "Brand", budget: null, timeline: null }, evidence: [{ field: "need", quote: "Brand" }], nextQuestion: null } })
    } }))
    const stage = Stage.collect({ name: "brief", fields, context: Stage.extractionContext(fields, () => Effect.succeed({ currency: "GBP" })) })
    const turn = await Effect.runPromise(stage.run({ state: stage.initialState, messages: [Session.Message.submitted("Brand")] }).pipe(Effect.provide(model)))
    expect(turn.state.accepted.need?.value).toBe("Brand")
    const invalid = Stage.collect({ name: "brief", fields, context: Stage.extractionContext(fields,
      // @ts-expect-error Exercise an untyped application's invalid JSON output.
      () => Effect.succeed({ bad: undefined }),
    ) })
    const failure = await Effect.runPromise(invalid.run({ state: invalid.initialState, messages: [Session.Message.submitted("Brand")] }).pipe(Effect.provide(model), Effect.flip))
    expect(failure).toMatchObject({ _tag: "InvalidExtractionContext", reason: "invalid_shape" })
    expect(requests).toBe(1)
  })

  test("context failure leaves the session unchanged and permits retry at the same revision", async () => {
    class ContextUnavailable extends Schema.TaggedError<ContextUnavailable>()(
      "ContextUnavailable", {},
    ) {}
    let unavailable = false
    let requests = 0
    const stage = Stage.collect({
      name: "brief",
      fields,
      context: Stage.extractionContext(fields, () => unavailable
        ? Effect.fail(new ContextUnavailable({}))
        : Effect.succeed({ currency: "GBP" })),
    })
    const search = Stage.tools({
      name: "search",
      instructions: ["Search using the completed brief"],
      tools: [Tool.define({
        name: "search",
        description: "Find agencies",
        input: Schema.Struct({}),
        execute: () => Effect.die("Incomplete brief cannot reach search"),
      })],
    })
    const chat = Chat.define({ name: "enriched_brief", version: 1, stages: [stage, search] })
    const model = Layer.succeed(Model.Service, Model.Service.of({
      requestTool: () => {
        requests += 1
        return Effect.succeed({ name: "submit_answers", arguments: {
          answers: { need: null, budget: null, timeline: null },
          evidence: [],
          nextQuestion: null,
        } })
      },
    }))
    await Effect.runPromise(Effect.gen(function* () {
      const scope = { namespace: "", sessionId: "context_failure", chat: chat.name, version: 1 }
      const store = yield* Session.Store
      const opening = yield* Chat.turn(chat, { sessionId: scope.sessionId, message: "Help me" })
      const before = yield* store.load(scope)
      unavailable = true
      const failed = yield* Chat.turn(chat, {
        sessionId: scope.sessionId, expectedRevision: opening.revision, message: "Branding",
      }).pipe(Effect.flip)
      expect(failed).toBeInstanceOf(ContextUnavailable)
      expect(requests).toBe(1)
      expect(yield* store.load(scope)).toEqual(before)
      unavailable = false
      const retried = yield* Chat.turn(chat, {
        sessionId: scope.sessionId, expectedRevision: opening.revision, message: "Branding",
      })
      expect(retried.revision).toBe("2")
      expect(requests).toBe(2)
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))))
  })

  test("collects three of five opening answers, then searches once after the remaining answers", async () => {
    const briefFields = {
      ...fields,
      market: Answer.explicit(Schema.String, { description: "Client market", ask: Question.fixed("Where is your team?") }),
      location: Answer.explicit(Schema.String, { description: "Locality requirement", ask: Question.fixed("Must the agency be local?") }),
    }
    let searchCount = 0
    const brief = Stage.collect({ name: "brief", fields: briefFields, detector: Stage.detector(briefFields, context => {
      const opening = context.evidence[0]?.quote.includes("£20k") === true
      const selected = opening ? ["need", "budget", "location"] : ["timeline", "market"]
      return Effect.succeed({ _tag: "Resolved" as const, selections: context.fields.map(({ field }) => selected.includes(field)
        ? { _tag: "Detected" as const, field }
        : { _tag: "Undetected" as const, field }) })
    }) })
    const search = Tool.define({ name: "search", description: "Search for agencies", input: Schema.Struct({}), execute: () => Effect.sync(() => { searchCount += 1; return "Found agencies" }) })
    const chat = Chat.define({ name: "matchmaker", version: 1, stages: [brief, Stage.tools({ name: "matching", instructions: ["Search for the completed brief"], tools: [search] })] })
    let extractionCount = 0
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: request => {
      if (request.tools[0]?.name === "search") return Effect.succeed({ name: "search", arguments: {} })
      extractionCount += 1
      return Effect.succeed({ name: "submit_answers", arguments: extractionCount === 1 ? {
        answers: { need: "Branding", budget: "under_25k_gbp", location: "same_market_required" },
        evidence: [{ field: "need", quote: "branding" }, { field: "budget", quote: "£20k" }, { field: "location", quote: "must be local" }], nextQuestion: null,
      } : {
        answers: { timeline: "within_one_month", market: "United Kingdom" },
        evidence: [{ field: "timeline", quote: "next month" }, { field: "market", quote: "UK" }], nextQuestion: null,
      } })
    } }))
    const result = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "brief", message: "We need branding, our budget is £20k, and the agency must be local" })
      expect(first.turn._tag).toBe("Question")
      if (first.turn._tag === "Question") expect(first.turn.question.field).toBe("timeline")
      expect(searchCount).toBe(0)
      const second = yield* Chat.turn(chat, { sessionId: "brief", expectedRevision: first.revision, message: "Start next month; our team is in the UK" })
      return { first, second }
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))))
    expect(searchCount).toBe(1)
    expect(extractionCount).toBe(2)
    expect(Chat.acceptedAnswer(chat, result.second.turn.state, brief, "budget")?.value).toBe("under_25k_gbp")
    expect(Chat.acceptedAnswer(chat, result.second.turn.state, brief, "market")?.value).toBe("United Kingdom")
  })

  test("observed speech cannot confirm an answer even if a detector would say yes", async () => {
    const confirmFields = { permission: Answer.confirmed(Schema.Boolean, { description: "Explicit permission", ask: Question.fixed("Do you agree?") }) }
    let detections = 0
    const stage = Stage.collect({ name: "permission", fields: confirmFields, detector: Stage.detector(confirmFields, context => {
      detections += 1
      return Effect.succeed({ _tag: "Resolved" as const, selections: context.fields.map(({ field }) => ({ _tag: "Detected" as const, field })) })
    }) })
    const result = await Effect.runPromise(stage.run({
      state: stage.markAsked(stage.initialState, "permission", 0, "Do you agree?"),
      messages: [Session.Message.authored("Do you agree?"), Session.Message.observed({ batchId: "batch", id: "speech", role: "user", content: "Yes" })],
    }).pipe(Effect.provide(Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => Effect.die("Unexpected extraction") })))))
    expect(detections).toBe(0)
    expect(result.complete).toBe(false)
    expect(result.state.accepted).toEqual({})
  })

  test("keeps enrichment on budget fallbacks and rejects oversized context before extraction", async () => {
    let detections = 0
    let modelCalls = 0
    const detector = Stage.detector(fields, () => {
      detections += 1
      return Effect.succeed({ _tag: "NotApplicable" as const, reason: "question_budget_exceeded" as const })
    })
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: request => {
      modelCalls += 1
      expect(request.untrustedMessages.map(message => message.content).join("\n")).toContain('"currency":"GBP"')
      return Effect.succeed({ name: "submit_answers", arguments: { answers: { need: null, budget: null, timeline: null }, evidence: [], nextQuestion: null } })
    } }))
    const stage = Stage.collect({ name: "fallback", fields, detector, context: Stage.extractionContext(fields, () => Effect.succeed({ currency: "GBP" })) })
    for (const text of ["A brief", "x".repeat(2_001)]) {
      await Effect.runPromise(stage.run({ state: stage.initialState, messages: [Session.Message.submitted(text)] }).pipe(Effect.provide(model)))
    }
    expect(detections).toBe(1)
    expect(modelCalls).toBe(2)
    const oversized = Stage.collect({ name: "oversized", fields, context: Stage.extractionContext(fields, () => Effect.succeed("x".repeat(20_001))) })
    const failure = await Effect.runPromise(oversized.run({ state: oversized.initialState, messages: [Session.Message.submitted("A brief")] }).pipe(Effect.provide(model), Effect.flip))
    expect(failure).toMatchObject({ _tag: "InvalidExtractionContext", reason: "budget_exceeded" })
    expect(modelCalls).toBe(2)
  })

  test("decodes extracted domain values once and encodes accepted values in subsequent context", async () => {
    const datedFields = {
      date: Answer.explicit(Schema.DateFromString, { description: "Launch date", ask: Question.fixed("When do you launch?") }),
      need: fields.need,
    }
    let turn = 0
    const stage = Stage.collect({ name: "dates", fields: datedFields, detector: Stage.detector(datedFields, context => {
      const target = context.evidence[0]?.quote === "Branding" ? "need" : "date"
      return Effect.succeed({ _tag: "Resolved" as const, selections: context.fields.map(({ field }) => field === target
        ? { _tag: "Detected" as const, field } : { _tag: "Undetected" as const, field }) })
    }) })
    const model = Layer.succeed(Model.Service, Model.Service.of({ requestTool: request => {
      turn += 1
      if (turn === 2) expect(request.untrustedMessages.map(message => message.content).join("\n")).toContain('"value":"2026-10-01T00:00:00.000Z"')
      return Effect.succeed({ name: "submit_answers", arguments: turn === 1
        ? { answers: { date: "2026-10-01T00:00:00.000Z" }, evidence: [{ field: "date", quote: "October 1" }], nextQuestion: null }
        : { answers: { need: "Branding" }, evidence: [{ field: "need", quote: "Branding" }], nextQuestion: null } })
    } }))
    const messages = [Session.Message.submitted("October 1")]
    const first = await Effect.runPromise(stage.run({ state: stage.initialState, messages }).pipe(Effect.provide(model)))
    expect(first.state.accepted.date?.value).toBeInstanceOf(Date)
    const second = await Effect.runPromise(stage.run({ state: first.state, messages: [...messages, Session.Message.authored("What work do you need?"), Session.Message.submitted("Branding")] }).pipe(Effect.provide(model)))
    expect(second.complete).toBe(true)
    expect(second.state.accepted.date?.value).toBeInstanceOf(Date)
  })
})

import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { Answer, Chat, Model, Question, Repair, Session, Stage, Tool } from "../src/index.js"
import { inMemoryChatSessionStore, Chat as ChatTest } from "../src/testing.js"
import * as Debug from "../src/debug.js"
import type { JsonValue } from "../src/core/json-value.js"

const bank = {
  required: {
    goal: Answer.explicit(Schema.String, { description: "The desired outcome", ask: Question.fixed("What do you need?") }),
    budget: Answer.explicit(Schema.Number, { description: "Available budget", ask: Question.fixed("What is your budget?") }),
  },
  optional: {
    timeline: Answer.explicit(Schema.String, { description: "When the work is needed", ask: Question.fixed("When do you need it?") }),
  },
} as const

const model = (...responses: ReadonlyArray<JsonValue>) => {
  let index = 0
  return Layer.succeed(Model.Service, Model.Service.of({
    requestTool: () => Effect.sync(() => {
      const response = responses[index++]
      if (response === undefined) throw new Error("Unexpected model request")
      return response
    }),
  }))
}

const proposal = (answers: { goal: string | null; budget: number | null; timeline: string | null }, evidence: ReadonlyArray<{ field: string; quote: string }>) => ({
  name: "submit_answers", arguments: { answers, evidence, nextQuestion: null },
})

describe("interview stage", () => {
  test("runtime-authored banks still reject overlapping required and optional fields", () => {
    const required = Object.fromEntries([["goal", bank.required.goal]])
    const optional = Object.fromEntries([["goal", bank.required.goal]])
    expect(() => Stage.interview({ name: "dynamic", required, optional, instructions: ["Gather the brief"] })).toThrow("disjoint")
  })

  test("a typed uncertainty answer satisfies a required question and survives reload", async () => {
    const interview = Stage.interview({
      name: "brief",
      instructions: ["Collect a budget; explicitly undecided is a complete answer."],
      optional: {},
      required: {
        budget: Answer.explicit(Schema.Union([Schema.Finite, Schema.Literal("undecided")]), {
          description: "Budget in GBP or explicitly undecided",
          ask: Question.choice("What is your budget?", [{ label: "£20k", value: 20000 }]),
          escape: { value: "undecided" },
        }),
      },
      questions: { escape: "Not sure yet" },
    })
    const empty = { name: "submit_answers", arguments: { answers: { budget: null }, evidence: [], nextQuestion: null } }
    await Effect.runPromise(Effect.gen(function* () {
      const messages = [Session.Message.submitted("We need branding")]
      const first = yield* interview.run({ state: interview.initialState, messages })
      expect(first.complete).toBe(false)
      expect(first.state.accepted.budget).toBeUndefined()
      expect(first.question?.text).toBe("What is your budget?")
      const next = yield* interview.run({
        state: yield* interview.parseState(first.state),
        messages: [...messages, Session.Message.authored(first.question?.text ?? ""), Session.Message.submitted("Not sure yet")],
      })
      expect(next.complete).toBe(true)
      if (next.complete) expect(next.answers.budget).toBe("undecided")
      const resumed = yield* interview.parseState(next.state)
      expect(resumed.accepted.budget).toEqual({ value: "undecided", evidence: { messageIndex: 2, quote: "Not sure yet" } })
      expect(resumed.phase).toEqual({ _tag: "Complete" })
    }).pipe(Effect.provide(model(
      empty,
      { name: "select_next_question", arguments: { choice: "action_0", text: null, options: [] } },
      empty,
    ))))
  })

  test.each([false, true])("uncertainty adapts numeric choice wording and preserves values (selected by application: %s)", async selected => {
    const budget = Answer.explicit(Schema.Number, {
      description: "The project budget in GBP",
      ask: Question.choice(Question.adaptive("Help establish a budget after uncertainty", { fallback: "What budget have you set aside?" }), [
        { label: "£10k", value: 10000 }, { label: "£20k", value: 20000 },
      ]),
    })
    const questions = { required: { budget }, optional: {} }
    const interview = Stage.interview({ name: "brief", ...questions, instructions: ["Collect a budget"], questions: { escape: "Not sure yet" },
      selection: Stage.questionSelector(questions, () => Effect.succeed(selected ? { _tag: "Selected", target: { _tag: "Question", field: "budget" } } : { _tag: "Uncertain" })),
    })
    const empty = { name: "submit_answers", arguments: { answers: { budget: null }, evidence: [], nextQuestion: null } }
    const followUp = "No problem. What would feel comfortable spending on an initial batch of videos?"
    await Effect.runPromise(Effect.gen(function* () {
      const messages = [Session.Message.submitted("We need social video content")]
      const first = yield* interview.run({ state: interview.initialState, messages })
      const uncertainMessages = [...messages, Session.Message.authored(first.question?.text ?? ""), Session.Message.submitted("Not sure yet")]
      const second = yield* interview.run({ state: first.state, messages: uncertainMessages })
      expect(second.question?.text).toBe(followUp)
      // Generated options cannot replace the application's typed suggestions.
      expect(second.question?.options).toEqual([{ label: "£10k", value: 10000 }, { label: "£20k", value: 20000 }])
      expect(second.state.accepted.budget).toBeUndefined()
      expect(second.complete).toBe(false)
      expect(second.state.asked.budget?.latest).toMatchObject({ text: followUp, messageIndex: 3 })
      const resumed = yield* interview.parseState(second.state)
      const third = yield* interview.run({ state: resumed, messages: [...uncertainMessages, Session.Message.authored(followUp), Session.Message.submitted("£20k")] })
      expect(third.complete).toBe(true)
      if (third.complete) expect(third.answers.budget).toBe(20000)
    }).pipe(Effect.provide(model(
      empty,
      { name: "select_next_question", arguments: { choice: "action_0", text: "What budget have you set aside?", options: [] } },
      empty,
      { name: "select_next_question", arguments: { choice: "action_0", text: followUp, options: ["£1"] } },
      { name: "submit_answers", arguments: { answers: { budget: 20000 }, evidence: [{ field: "budget", quote: "£20k" }], nextQuestion: null } },
    ))))
  })

  test("ordinary fixed choices ignore generated wording", async () => {
    const interview = Stage.interview({ name: "brief", required: {
      budget: Answer.explicit(Schema.Number, { description: "Budget", ask: Question.choice("Fixed budget question", [{ label: "£20k", value: 20000 }]) }),
    }, optional: {}, instructions: ["Collect a budget"] })
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Hello")] }).pipe(Effect.provide(model(
      { name: "submit_answers", arguments: { answers: { budget: null }, evidence: [], nextQuestion: null } },
      { name: "select_next_question", arguments: { choice: "action_0", text: "Unexpected rewording", options: ["£1"] } },
    ))))
    expect(turn.question?.text).toBe("Fixed budget question")
    expect(turn.question?.options).toEqual([{ label: "£20k", value: 20000 }])
  })

  test("adaptive typed choices also work through ordinary collection", async () => {
    const stage = Stage.collect({ name: "brief", fields: {
      budget: Answer.explicit(Schema.Number, { description: "Budget", ask: Question.choice(Question.adaptive("Help establish a budget", { fallback: "What budget?" }), [{ label: "£20k", value: 20000 }]) }),
    } })
    const turn = await Effect.runPromise(stage.run({ state: stage.initialState, messages: [Session.Message.submitted("Not sure yet")] }).pipe(Effect.provide(model({
      name: "submit_answers", arguments: { answers: { budget: null }, evidence: [], nextQuestion: { field: "budget", text: "Do you have a spending ceiling in mind?", options: [] } },
    }))))
    expect(turn.question?.text).toBe("Do you have a spending ceiling in mind?")
    expect(turn.question?.options).toEqual([{ label: "£20k", value: 20000 }])
  })

  test("selects an optional question after accepting answers using the whole conversation", async () => {
    const contexts: Array<Stage.QuestionSelectionContext<"goal" | "budget" | "timeline">> = []
    const interview = Stage.interview({
      name: "brief", ...bank, instructions: ["Find suitable agencies"],
      selection: Stage.questionSelector(bank, context => {
        contexts.push(context)
        return Effect.succeed({ _tag: "Selected", target: { _tag: "Question", field: "timeline" } })
      }),
    })
    const messages = [Session.Message.submitted("The conference is in November"), Session.Message.authored("What do you need?"), Session.Message.submitted("Brand strategy")]
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages }).pipe(Effect.provide(model(proposal({ goal: "Brand strategy", budget: null, timeline: null }, [{ field: "goal", quote: "Brand strategy" }])))))
    expect(turn.question?.field).toBe("timeline")
    expect(turn.state.accepted.goal?.value).toBe("Brand strategy")
    expect(contexts[0]?.conversation.map(item => item.message.content)).toEqual(messages.map(item => item.content))
    expect(contexts[0]?.accepted.find(answer => answer.field === "goal")?.value).toBe("Brand strategy")
    expect(contexts[0]?.candidates.some(candidate => candidate.target._tag === "Finish")).toBe(false)
  })

  test("finishes with optional answers absent once required answers are accepted", async () => {
    const interview = Stage.interview({
      name: "brief", ...bank, instructions: ["Collect a useful brief"],
      selection: Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Finish" } })),
    })
    const turn = await Effect.runPromise(interview.run({
      state: interview.initialState, messages: [Session.Message.submitted("Brand strategy for 20000")],
    }).pipe(Effect.provide(model(proposal({ goal: "Brand strategy", budget: 20000, timeline: null }, [{ field: "goal", quote: "Brand strategy" }, { field: "budget", quote: "20000" }])))))
    expect(turn.complete).toBe(true)
    expect(interview.isComplete(turn.state)).toBe(true)
    expect(turn.state.accepted.timeline).toBeUndefined()
    if (turn.complete) expect(turn.answers).toEqual({ goal: "Brand strategy", budget: 20000 })
  })

  test("rejects completion while a required answer is missing", async () => {
    const interview = Stage.interview({
      name: "brief", ...bank, instructions: ["Collect a useful brief"],
      selection: Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Finish" } })),
    })
    const result = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Hello")] }).pipe(
      Effect.provide(model(proposal({ goal: null, budget: null, timeline: null }, []))), Effect.result,
    ))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidQuestionSelection", reason: "target_not_offered" } })
  })

  test("retains a chosen question across reload and permits search with absent optional answers", async () => {
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a useful brief"], selection: Stage.questionSelector(bank, context => Effect.succeed({
      _tag: "Selected", target: context.candidates.find(candidate => candidate.target._tag === "Finish")?.target ?? { _tag: "Question", field: "budget" },
    })) })
    const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.succeed("results") })
    const chat = Chat.define({ name: "interview_chat", version: 1, stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })], repair: Repair.standard() })
    const layer = Layer.merge(inMemoryChatSessionStore, model(
      proposal({ goal: "Brand strategy", budget: null, timeline: null }, [{ field: "goal", quote: "Brand strategy" }]),
      proposal({ goal: null, budget: 20000, timeline: null }, [{ field: "budget", quote: "20000" }]),
      { name: "search", arguments: {} },
    ))
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "interview-session", message: "Brand strategy" })
      expect(first.turn._tag).toBe("Question")
      expect(first.turn.state.stages.brief.phase).toEqual({ _tag: "AwaitingReply", field: "budget", issuedMessageIndex: 1 })
      const saved = yield* ChatTest.parseState(chat, first.turn.state)
      const debug = yield* Debug.inspect(chat, saved)
      expect(debug.stages[0]).toMatchObject({ _tag: "InterviewStage", requiredFields: ["goal", "budget"], focus: "budget" })
      const second = yield* Chat.turn(chat, { sessionId: "interview-session", expectedRevision: first.revision, message: "20000" })
      expect(second.turn._tag).toBe("ToolResult")
      expect(second.turn.state.stages.brief.phase._tag).toBe("Complete")
      expect(Chat.acceptedAnswer(chat, second.turn.state, interview, "budget")?.value).toBe(20000)
      expect(Chat.acceptedAnswer(chat, second.turn.state, interview, "timeline")).toBeUndefined()
      const stale = yield* Chat.turn(chat, { sessionId: "interview-session", expectedRevision: first.revision, message: "again" }).pipe(Effect.result)
      expect(stale).toMatchObject({ _tag: "Failure", failure: { _tag: "ChatSessionConflict" } })
    }).pipe(Effect.provide(layer)))
  })

  test("declines optional information without accepting it, and does not offer it again", async () => {
    const contexts: Array<Stage.QuestionSelectionContext> = []
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a useful brief"], selection: Stage.questionSelector(bank, context => {
      contexts.push(context)
      return Effect.succeed({ _tag: "Selected", target: { _tag: "Question", field: "budget" } })
    }) })
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Brand strategy; I do not know the timeline")] }).pipe(Effect.provide(model({
      name: "submit_answers", arguments: {
        answers: { goal: "Brand strategy", budget: null, timeline: null }, evidence: [{ field: "goal", quote: "Brand strategy" }], nextQuestion: null,
        declines: [{ field: "timeline", quote: "I do not know the timeline" }],
      },
    }))))
    expect(turn.state.declined.timeline?.quote).toBe("I do not know the timeline")
    expect(turn.state.accepted.timeline).toBeUndefined()
    expect(contexts[0]?.candidates.some(candidate => candidate.target._tag === "Question" && candidate.target.field === "timeline")).toBe(false)
  })

  test("parses completion and focus invariants rather than trusting persisted flags", async () => {
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"] })
    for (const phase of [{ _tag: "Complete" }, { _tag: "AwaitingReply", field: "budget", issuedMessageIndex: 0 }]) {
      const result = await Effect.runPromise(interview.parseState({ ...interview.initialState, phase }).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
    }
  })

  test("the default model selects from the post-validation candidate set", async () => {
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Follow the conversation"] })
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Brand strategy")] }).pipe(Effect.provide(model(
      proposal({ goal: "Brand strategy", budget: null, timeline: null }, [{ field: "goal", quote: "Brand strategy" }]),
      { name: "select_next_question", arguments: { choice: "action_1", text: null, options: [] } },
    ))))
    expect(turn.question?.field).toBe("timeline")
  })

  test("an out-of-order confirmation requires the issued question and a later submission", async () => {
    const questions = { required: { goal: bank.required.goal, consent: Answer.confirmed(Schema.Boolean, { description: "Permission to search", ask: Question.fixed("May I search?") }) }, optional: {} }
    const interview = Stage.interview({ name: "brief", ...questions, instructions: ["Collect the brief"], selection: Stage.questionSelector(questions, context => Effect.succeed({
      _tag: "Selected", target: context.accepted.some(answer => answer.field === "consent") ? { _tag: "Question", field: "goal" } : { _tag: "Question", field: "consent" },
    })) })
    const messages = [Session.Message.submitted("yes")]
    const response = { name: "submit_answers", arguments: { answers: { goal: null, consent: true }, evidence: [{ field: "consent", quote: "yes" }], nextQuestion: null } }
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* interview.run({ state: interview.initialState, messages })
      expect(first.state.accepted.consent).toBeUndefined()
      expect(first.question?.field).toBe("consent")
      const second = yield* interview.run({ state: first.state, messages: [...messages, Session.Message.authored("May I search?"), Session.Message.submitted("yes")] })
      expect(second.state.accepted.consent).toEqual({ value: true, evidence: { messageIndex: 2, quote: "yes" } })
      expect(second.question?.field).toBe("goal")
    }).pipe(Effect.provide(model(response, response))))
  })

  test("interrupting a selector leaves the session uncommitted", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect the brief"], selection: Stage.questionSelector(bank, () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))) })
      const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.void })
      const chat = Chat.define({ name: "cancelled_interview", version: 1, stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
      const fiber = yield* Chat.turn(chat, { sessionId: "cancelled", message: "Brand strategy" }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const store = yield* Session.Store
      expect(yield* store.load({ namespace: "", sessionId: "cancelled", chat: "cancelled_interview", version: 1 })).toBeNull()
    }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(proposal({ goal: "Brand strategy", budget: null, timeline: null }, [{ field: "goal", quote: "Brand strategy" }]))))))
  })

  test("finishing a required-only interview needs no selection request", async () => {
    const interview = Stage.interview({ name: "brief", required: bank.required, optional: {}, instructions: ["Collect the essentials"] })
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Brand strategy 20000")] }).pipe(Effect.provide(model({
      name: "submit_answers", arguments: { answers: { goal: "Brand strategy", budget: 20000 }, evidence: [{ field: "goal", quote: "Brand strategy" }, { field: "budget", quote: "20000" }], nextQuestion: null },
    }))))
    expect(turn.complete).toBe(true)
  })

  test("guards can deny selection before the custom selector is invoked", async () => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
    let calls = 0
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"],
      guards: [Model.guard({ name: "deny_selection", check: context => context.toolNames.includes("select_next_question") ? Effect.fail(new Denied()) : Effect.void })],
      selection: Stage.questionSelector(bank, () => { calls += 1; return Effect.succeed({ _tag: "Selected", target: { _tag: "Question", field: "budget" } }) }),
    })
    const result = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Hello")] }).pipe(Effect.provide(model(proposal({ goal: null, budget: null, timeline: null }, []))), Effect.result))
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Denied" } })
    expect(calls).toBe(0)
  })

  test("entry uses earlier evidence and optional declines survive an Undetected assessment", async () => {
    const fields = { ...bank.required, ...bank.optional }
    const detector = Stage.detector(fields, context => Effect.succeed({
      _tag: "Resolved", selections: context.fields.map(({ field }) => ({ _tag: "Undetected", field })),
    }))
    const interview = Stage.interview({ name: "brief", ...bank, detector, instructions: ["Collect a brief"],
      selection: Stage.questionSelector(bank, context => Effect.succeed({ _tag: "Selected", target: {
        _tag: "Question", field: context.candidates.some(candidate => candidate.target._tag === "Question" && candidate.target.field === "timeline") ? "timeline" : "budget",
      } })),
    })
    await Effect.runPromise(Effect.gen(function* () {
      const messages = [Session.Message.submitted("Brand strategy"), Session.Message.authored("Tell me more"), Session.Message.submitted("Hello")]
      const first = yield* interview.run({ state: interview.initialState, messages })
      expect(first.state.accepted.goal?.evidence.messageIndex).toBe(0)
      const second = yield* interview.run({ state: first.state, messages: [...messages, Session.Message.authored("When do you need it?"), Session.Message.submitted("I would rather not share the timeline")] })
      expect(second.state.declined.timeline).toEqual({ messageIndex: 4, quote: "rather not share the timeline" })
      expect(second.question?.field).toBe("budget")
    }).pipe(Effect.provide(model(
      proposal({ goal: "Brand strategy", budget: null, timeline: null }, [{ field: "goal", quote: "Brand strategy" }]),
      { name: "submit_answers", arguments: { answers: { timeline: null }, evidence: [], declines: [{ field: "timeline", quote: "rather not share the timeline" }], nextQuestion: null } },
    ))))
  })

  test("malformed model selection falls back to an eligible required question", async () => {
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"],
      selection: Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Uncertain" })),
    })
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Brand strategy")] }).pipe(Effect.provide(model(
      proposal({ goal: "Brand strategy", budget: null, timeline: null }, [{ field: "goal", quote: "Brand strategy" }]),
      { name: "select_next_question", arguments: { choice: "finish_without_budget", text: null, options: [] } },
    ))))
    expect(turn.question?.field).toBe("budget")
    expect(turn.complete).toBe(false)
  })

  test("a completed interview accepts grounded corrections before rerunning search", async () => {
    const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"],
      selection: Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Finish" } })),
    })
    const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.void })
    const chat = Chat.define({ name: "repair_interview", version: 1, repair: Repair.standard(), stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "repair", message: "Brand strategy for 20000" })
      const corrected = yield* Chat.turn(chat, { sessionId: "repair", expectedRevision: first.revision, message: "Actually make the budget 30000" })
      expect(corrected.turn.state.stages.brief.phase._tag).toBe("Complete")
      expect(Chat.acceptedAnswer(chat, corrected.turn.state, interview, "budget")?.value).toBe(30000)
      expect(corrected.turn.state.stages.brief.accepted.budget?.evidence.quote).toBe("30000")
    }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(
      proposal({ goal: "Brand strategy", budget: 20000, timeline: null }, [{ field: "goal", quote: "Brand strategy" }, { field: "budget", quote: "20000" }]),
      { name: "search", arguments: {} },
      { name: "apply_conversation_repairs", arguments: { corrections: [{ _tag: "ReplaceAcceptedAnswer", stage: "brief", field: "budget", value: 30000, evidence: { quote: "30000" } }] } },
      { name: "search", arguments: {} },
    )))))
  })

  test.each(["confirm", "decline"] as const)("an optional reconfirmation stays pending until the user chooses to %s", async resolution => {
    const questions = {
      required: { goal: bank.required.goal },
      optional: { timeline: Answer.confirmed(Schema.String, { description: "Timeline", ask: Question.fixed("When do you need it?") }) },
    }
    const contexts: Array<Stage.QuestionSelectionContext> = []
    const interview = Stage.interview({
      name: "brief", ...questions, instructions: ["Collect a brief"],
      selection: Stage.questionSelector(questions, context => {
        contexts.push(context)
        // Prefer finishing once the original timeline has been asked. Repairs
        // must remove Finish from the offered actions while confirmation is due.
        const finish = context.focus._tag === "Issued" || context.trigger === "after_repair"
          ? context.candidates.find(candidate => candidate.target._tag === "Finish") : undefined
        return Effect.succeed({ _tag: "Selected", target: finish?.target ?? { _tag: "Question", field: "timeline" } })
      }),
    })
    let searches = 0
    const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.sync(() => { searches += 1 }) })
    const chat = Chat.define({ name: "optional_confirmation", version: 1, repair: Repair.standard(), stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
    const empty = { name: "submit_answers", arguments: { answers: { goal: null, timeline: null }, evidence: [], declines: [], nextQuestion: null } }
    const reply = resolution === "confirm" ? "Next year" : "I do not know the timeline anymore"
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "optional-confirmation", message: "Branding" })
      const complete = yield* Chat.turn(chat, { sessionId: "optional-confirmation", expectedRevision: first.revision, message: "Next month" })
      expect(complete.turn._tag).toBe("ToolResult")
      const repaired = yield* Chat.turn(chat, { sessionId: "optional-confirmation", expectedRevision: complete.revision, message: "Actually next year" })
      expect(repaired.turn._tag).toBe("Question")
      expect(searches).toBe(1)
      const saved = yield* ChatTest.parseState(chat, repaired.turn.state)
      expect(saved.repair?.pendingStages).toEqual([0])
      expect(saved.stages.brief.phase).toMatchObject({ _tag: "AwaitingReply", field: "timeline" })
      expect(saved.stages.brief.accepted.timeline).toBeUndefined()
      expect(interview.canFinish(saved.stages.brief)).toBe(false)
      expect(contexts.at(-1)?.candidates.some(candidate => candidate.target._tag === "Finish")).toBe(false)
      const pending = yield* Chat.turn(chat, { sessionId: "optional-confirmation", expectedRevision: repaired.revision, message: "Please search now" })
      expect(pending.turn._tag).toBe("Question")
      expect(searches).toBe(1)
      const resolved = yield* Chat.turn(chat, { sessionId: "optional-confirmation", expectedRevision: pending.revision, message: reply })
      expect(resolved.turn._tag).toBe("ToolResult")
      expect(searches).toBe(2)
      expect(resolved.turn.state.repair?.pendingStages).toEqual([])
      expect(resolved.turn.state.stages.brief.phase._tag).toBe("Complete")
      expect(resolved.turn.state.stages.brief.accepted.timeline?.value).toBe(resolution === "confirm" ? "Next year" : undefined)
      expect(resolved.turn.state.stages.brief.declined.timeline?.quote).toBe(resolution === "decline" ? reply : undefined)
    }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(
      { name: "submit_answers", arguments: { answers: { goal: "Branding", timeline: null }, evidence: [{ field: "goal", quote: "Branding" }], declines: [], nextQuestion: null } },
      { name: "submit_answers", arguments: { answers: { goal: null, timeline: "Next month" }, evidence: [{ field: "timeline", quote: "Next month" }], declines: [], nextQuestion: null } },
      { name: "search", arguments: {} },
      { name: "apply_conversation_repairs", arguments: { corrections: [{ _tag: "ReconfirmAnswer", stage: "brief", field: "timeline", evidence: { quote: "next year" } }] } },
      { name: "submit_answers", arguments: { answers: { goal: null, timeline: "next year" }, evidence: [{ field: "timeline", quote: "next year" }], declines: [], nextQuestion: null } },
      empty,
      { name: "submit_answers", arguments: {
        answers: { goal: null, timeline: resolution === "confirm" ? reply : null },
        evidence: resolution === "confirm" ? [{ field: "timeline", quote: reply }] : [],
        declines: resolution === "decline" ? [{ field: "timeline", quote: reply }] : [], nextQuestion: null,
      } },
      { name: "search", arguments: {} },
    )))))
  })
})

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Result, Schema } from "effect"
import {
  Answer,
  AnswerValidationRejected,
  defineChat,
  defineCommand,
  defineTool,
  InvalidCollectStageResponse,
  InvalidToolCall,
  Question,
  Repair,
  Stage,
  StructuredChatModel,
  type ToolModelRequest,
} from "../src/index.js"
import { inMemoryChatSessionStore } from "../src/testing.js"

const Brief = Stage.collect({
  name: "brief",
  fields: {
    project: Answer.semantic(Schema.String, {
      description: "The project",
      ask: Question.fixed("What should we create?"),
    }),
    location: Answer.explicit(Schema.String, {
      description: "The location",
      ask: Question.fixed("Where are you based?"),
    }),
    localOnly: Answer.confirmed(Schema.Boolean, {
      description: "Whether results must be local",
      ask: Question.fixed("Only show local firms?"),
    }),
  },
})

const Search = defineTool({
  name: "repair_search",
  description: "Search from the accepted brief.",
  input: Schema.Struct({ location: Schema.String }),
  execute: ({ location }) => Effect.succeed({ location }),
})

const Matching = Stage.tools({
  name: "matching",
  instructions: ["Search using the accepted brief."],
  tools: [Search],
})

const RepairableChat = defineChat({
  name: "repairable_chat",
  version: 1,
  stages: [Brief, Matching],
  repair: Repair.standard(),
})

class BudgetTooLow extends Schema.TaggedError<BudgetTooLow>()(
  "BudgetTooLow",
  { minimum: Schema.Number },
) {}

const initialAnswers = {
  name: "submit_answers",
  arguments: {
    answers: {
      project: "A public service website",
      location: "Leeds",
      localOnly: null,
    },
    evidence: [
      {
        field: "project",
        quote: "public service website",
      },
      { field: "location", quote: "Leeds" },
    ],
    nextQuestion: null,
  },
} as const

const confirmedAnswer = {
  name: "submit_answers",
  arguments: {
    answers: {
      project: null,
      location: null,
      localOnly: false,
    },
    evidence: [
      {
        field: "localOnly",
        quote: "search anywhere",
      },
    ],
    nextQuestion: null,
  },
} as const

describe("Repair.standard", () => {
  test("leaves ordinary query chats unchanged when repair is omitted", async () => {
    const PlainChat = defineChat({
      name: "plain_chat",
      version: 1,
      stages: [Brief, Matching],
    })
    const requests = await Effect.runPromise(
      Ref.make<ReadonlyArray<ToolModelRequest>>([]),
    )
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.andThen(Ref.updateAndGet(calls, (count) => count + 1)),
          Effect.map((count) =>
            count === 1
              ? initialAnswers
              : count === 2
                ? confirmedAnswer
                : {
                    name: "repair_search",
                    arguments: { location: "Leeds" },
                  },
          ),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    await Effect.runPromise(
      Effect.gen(function* () {
        const question = yield* PlainChat.reply({
          sessionId: "plain-chat",
          message: "We need a public service website in Leeds.",
        })
        const initial = yield* PlainChat.reply({
          sessionId: "plain-chat",
          expectedRevision: question.revision,
          message: "No, search anywhere.",
        })
        yield* PlainChat.reply({
          sessionId: "plain-chat",
          expectedRevision: initial.revision,
          message: "Prefer accessibility experience.",
        })
      }).pipe(Effect.provide(live)),
    )

    const observed = await Effect.runPromise(Ref.get(requests))
    expect(observed[3]?.tools.map(({ name }) => name)).toEqual([
      "repair_search",
    ])
    expect(PlainChat.initialState.repair).toBeUndefined()
  })

  test("enforces maximumCorrections through a persisted chat reply", async () => {
    const BoundedRepairChat = defineChat({
      name: "bounded_repair_chat",
      version: 1,
      stages: [Brief, Matching],
      repair: Repair.standard({ maximumCorrections: 1 }),
    })
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) => {
            switch (count) {
              case 1:
                return initialAnswers
              case 2:
                return confirmedAnswer
              case 3:
                return {
                  name: "repair_search",
                  arguments: { location: "Leeds" },
                }
              default:
                return {
                  name: "apply_conversation_repairs",
                  arguments: {
                    corrections: [
                      {
                        _tag: "ReplaceAcceptedAnswer",
                        stage: "brief",
                        field: "project",
                        value: "A mobile app",
                        evidence: { quote: "mobile app" },
                      },
                      {
                        _tag: "ReplaceAcceptedAnswer",
                        stage: "brief",
                        field: "location",
                        value: "Manchester",
                        evidence: { quote: "Manchester" },
                      },
                    ],
                  },
                }
            }
          }),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const question = yield* BoundedRepairChat.reply({
          sessionId: "bounded-repair",
          message: "We need a public service website in Leeds.",
        })
        const initial = yield* BoundedRepairChat.reply({
          sessionId: "bounded-repair",
          expectedRevision: question.revision,
          message: "No, search anywhere.",
        })
        return yield* Effect.result(
          BoundedRepairChat.reply({
            sessionId: "bounded-repair",
            expectedRevision: initial.revision,
            message:
              "Actually, make it a mobile app based in Manchester.",
          }),
        )
      }).pipe(Effect.provide(live)),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidToolCall)
      if (result.failure instanceof InvalidToolCall) {
        expect(result.failure).toMatchObject({
          tool: "apply_conversation_repairs",
          reason: "invalid_arguments",
        })
      }
    }
    expect(await Effect.runPromise(Ref.get(calls))).toBe(5)
  })

  test("replaces explicit answers then reruns a query in a bounded second step", async () => {
    const requests = await Effect.runPromise(
      Ref.make<ReadonlyArray<ToolModelRequest>>([]),
    )
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.andThen(
            Ref.updateAndGet(calls, (count) => count + 1),
          ),
          Effect.map((count) => {
            switch (count) {
              case 1:
                return initialAnswers
              case 2:
                return confirmedAnswer
              case 3:
                return {
                  name: "repair_search",
                  arguments: { location: "Leeds" },
                }
              case 4:
                return {
                  name: "apply_conversation_repairs",
                  arguments: {
                    corrections: [
                      {
                        _tag: "ReplaceAcceptedAnswer",
                        stage: "brief",
                        field: "location",
                        value: "Manchester",
                        evidence: {
                          quote: "Manchester",
                        },
                      },
                    ],
                  },
                }
              case 5:
              case 6:
                return {
                  name: "repair_search",
                  arguments: { location: "Manchester" },
                }
              default:
                // SAFETY: every expected request index is handled above; the
                // cast keeps the impossible defect branch out of the fixture.
                return Effect.die("unexpected request") as never
            }
          }),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const question = yield* RepairableChat.reply({
          sessionId: "replace-repair",
          message: "We need a public service website in Leeds.",
        })
        const initial = yield* RepairableChat.reply({
          sessionId: "replace-repair",
          expectedRevision: question.revision,
          message: "No, search anywhere.",
        })
        const corrected = yield* RepairableChat.reply({
          sessionId: "replace-repair",
          expectedRevision: initial.revision,
          message: "Actually, we are in Manchester.",
        })
        const followUp = yield* RepairableChat.reply({
          sessionId: "replace-repair",
          expectedRevision: corrected.revision,
          message: "Prefer teams with accessibility experience.",
        })
        return { corrected, followUp }
      }).pipe(Effect.provide(live)),
    )

    expect(replies.corrected.turn._tag).toBe("ToolResult")
    expect(
      RepairableChat.getAcceptedAnswer(
        replies.corrected.turn.state,
        Brief,
        "location",
      ),
    ).toEqual({
      value: "Manchester",
      evidence: { messageIndex: 3, quote: "Manchester" },
    })
    expect(await Effect.runPromise(Ref.get(calls))).toBe(6)
    const observed = await Effect.runPromise(Ref.get(requests))
    expect(observed[3]?.tools.map(({ name }) => name)).toEqual([
      "apply_conversation_repairs",
      "repair_search",
    ])
    expect(observed[5]?.tools.map(({ name }) => name)).toEqual([
      "apply_conversation_repairs",
      "repair_search",
    ])
  })

  test("clears confirmed answers, rewinds, reissues, and reconfirms", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) => {
            switch (count) {
              case 1:
                return initialAnswers
              case 2:
                return confirmedAnswer
              case 3:
                return {
                  name: "repair_search",
                  arguments: { location: "Leeds" },
                }
              case 4:
                return {
                  name: "apply_conversation_repairs",
                  arguments: {
                    corrections: [
                      {
                        _tag: "ReconfirmAnswer",
                        stage: "brief",
                        field: "localOnly",
                        evidence: {
                          quote: "only local firms",
                        },
                      },
                    ],
                  },
                }
              case 5:
                return {
                  name: "submit_answers",
                  arguments: {
                    answers: {
                      project: null,
                      location: null,
                      localOnly: null,
                    },
                    evidence: [],
                    nextQuestion: null,
                  },
                }
              case 6:
                return {
                  name: "submit_answers",
                  arguments: {
                    answers: {
                      project: null,
                      location: null,
                      localOnly: true,
                    },
                    evidence: [
                      {
                        field: "localOnly",
                        quote: "Yes, local only",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              case 7:
                return {
                  name: "repair_search",
                  arguments: { location: "Leeds" },
                }
              default:
                // SAFETY: every expected request index is handled above; the
                // cast keeps the impossible defect branch out of the fixture.
                return Effect.die("unexpected request") as never
            }
          }),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const question = yield* RepairableChat.reply({
          sessionId: "confirmed-repair",
          message: "We need a public service website in Leeds.",
        })
        const initial = yield* RepairableChat.reply({
          sessionId: "confirmed-repair",
          expectedRevision: question.revision,
          message: "No, search anywhere.",
        })
        const correction = yield* RepairableChat.reply({
          sessionId: "confirmed-repair",
          expectedRevision: initial.revision,
          message: "Actually, only local firms.",
        })
        const reconfirmed = yield* RepairableChat.reply({
          sessionId: "confirmed-repair",
          expectedRevision: correction.revision,
          message: "Yes, local only.",
        })
        return { correction, reconfirmed }
      }).pipe(Effect.provide(live)),
    )

    expect(replies.correction.turn._tag).toBe("Question")
    expect(replies.correction.turn.state.stage).toBe(0)
    expect(replies.correction.turn.state.repair?.pendingStages).toEqual([0])
    expect(
      RepairableChat.getAcceptedAnswer(
        replies.correction.turn.state,
        Brief,
        "localOnly",
      ),
    ).toBeUndefined()
    expect(replies.reconfirmed.turn._tag).toBe("ToolResult")
    expect(replies.reconfirmed.turn.state.repair?.pendingStages).toEqual([])
    expect(
      RepairableChat.getAcceptedAnswer(
        replies.reconfirmed.turn.state,
        Brief,
        "localOnly",
      ),
    ).toEqual({
      value: true,
      evidence: { messageIndex: 5, quote: "Yes, local only" },
    })
  })

  test("persists an ordered reconfirmation queue across collect stages", async () => {
    const First = Stage.collect({
      name: "first_confirmation",
      fields: {
        first: Answer.confirmed(Schema.Boolean, {
          description: "The first approval",
          ask: Question.fixed("Confirm the first approval?"),
        }),
      },
    })
    const Second = Stage.collect({
      name: "second_confirmation",
      fields: {
        second: Answer.confirmed(Schema.Boolean, {
          description: "The second approval",
          ask: Question.fixed("Confirm the second approval?"),
        }),
      },
    })
    const QueuedChat = defineChat({
      name: "queued_repair",
      version: 1,
      stages: [First, Second, Matching],
      repair: Repair.standard(),
    })
    const calls = await Effect.runPromise(Ref.make(0))
    const emptyFirstAnswers = {
      name: "submit_answers",
      arguments: {
        answers: { first: null },
        evidence: [],
        nextQuestion: null,
      },
    } as const
    const emptySecondAnswers = {
      name: "submit_answers",
      arguments: {
        answers: { second: null },
        evidence: [],
        nextQuestion: null,
      },
    } as const
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) => {
            switch (count) {
              case 1:
              case 7:
                return emptyFirstAnswers
              case 3:
              case 9:
                return emptySecondAnswers
              case 2:
                return {
                  name: "submit_answers",
                  arguments: {
                    answers: { first: true },
                    evidence: [
                      {
                        field: "first",
                        quote: "First confirmed",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              case 4:
                return {
                  name: "submit_answers",
                  arguments: {
                    answers: { second: true },
                    evidence: [
                      {
                        field: "second",
                        quote: "Second confirmed",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              case 5:
              case 11:
                return {
                  name: "repair_search",
                  arguments: { location: "anywhere" },
                }
              case 6:
                return {
                  name: "apply_conversation_repairs",
                  arguments: {
                    corrections: [
                      {
                        _tag: "ReconfirmAnswer",
                        stage: "first_confirmation",
                        field: "first",
                        evidence: {
                          quote: "Change both approvals",
                        },
                      },
                      {
                        _tag: "ReconfirmAnswer",
                        stage: "second_confirmation",
                        field: "second",
                        evidence: {
                          quote: "Change both approvals",
                        },
                      },
                    ],
                  },
                }
              case 8:
                return {
                  name: "submit_answers",
                  arguments: {
                    answers: { first: false },
                    evidence: [
                      {
                        field: "first",
                        quote: "First changed",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              case 10:
                return {
                  name: "submit_answers",
                  arguments: {
                    answers: { second: false },
                    evidence: [
                      {
                        field: "second",
                        quote: "Second changed",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              default:
                // SAFETY: every expected request index is handled above; the
                // cast keeps the impossible defect branch out of the fixture.
                return Effect.die("unexpected request") as never
            }
          }),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const firstQuestion = yield* QueuedChat.reply({
          sessionId: "queued-repair",
          message: "Start approvals.",
        })
        const secondQuestion = yield* QueuedChat.reply({
          sessionId: "queued-repair",
          expectedRevision: firstQuestion.revision,
          message: "First confirmed.",
        })
        const initial = yield* QueuedChat.reply({
          sessionId: "queued-repair",
          expectedRevision: secondQuestion.revision,
          message: "Second confirmed.",
        })
        const repair = yield* QueuedChat.reply({
          sessionId: "queued-repair",
          expectedRevision: initial.revision,
          message: "Change both approvals.",
        })
        const first = yield* QueuedChat.reply({
          sessionId: "queued-repair",
          expectedRevision: repair.revision,
          message: "First changed: no.",
        })
        const second = yield* QueuedChat.reply({
          sessionId: "queued-repair",
          expectedRevision: first.revision,
          message: "Second changed: no.",
        })
        return { repair, first, second }
      }).pipe(Effect.provide(live)),
    )

    expect(result.repair.turn.state.repair?.pendingStages).toEqual([0, 1])
    expect(result.first.turn.state.repair?.pendingStages).toEqual([1])
    expect(result.second.turn.state.repair?.pendingStages).toEqual([])
    expect(result.second.turn._tag).toBe("ToolResult")
    expect(await Effect.runPromise(Ref.get(calls))).toBe(11)
  })

  test("rejects repair evidence that does not come from the current user message", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) =>
            count === 1
              ? initialAnswers
              : count === 2
                ? confirmedAnswer
                : count === 3
                  ? {
                      name: "repair_search",
                      arguments: { location: "Leeds" },
                    }
                  : {
                      name: "apply_conversation_repairs",
                      arguments: {
                        corrections: [
                          {
                            _tag: "ReplaceAcceptedAnswer",
                            stage: "brief",
                            field: "location",
                            value: "Manchester",
                            evidence: {
                              quote: "Leeds",
                            },
                          },
                        ],
                      },
                    },
          ),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const question = yield* RepairableChat.reply({
          sessionId: "invalid-repair",
          message: "We need a public service website in Leeds.",
        })
        const initial = yield* RepairableChat.reply({
          sessionId: "invalid-repair",
          expectedRevision: question.revision,
          message: "No, search anywhere.",
        })
        return yield* Effect.result(
          RepairableChat.reply({
            sessionId: "invalid-repair",
            expectedRevision: initial.revision,
            message: "Actually, we are in Manchester.",
          }),
        )
      }).pipe(Effect.provide(live)),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidCollectStageResponse)
      if (result.failure instanceof InvalidCollectStageResponse) {
        expect(result.failure.reason).toBe("invalid_repair")
      }
    }
  })

  test("classifies duplicate field corrections as an invalid repair", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) => {
            switch (count) {
              case 1:
                return initialAnswers
              case 2:
                return confirmedAnswer
              case 3:
                return {
                  name: "repair_search",
                  arguments: { location: "Leeds" },
                }
              case 4:
                return {
                  name: "apply_conversation_repairs",
                  arguments: {
                    corrections: [
                      {
                        _tag: "ReplaceAcceptedAnswer",
                        stage: "brief",
                        field: "location",
                        value: "Manchester",
                        evidence: {
                          quote: "Manchester",
                        },
                      },
                      {
                        _tag: "ReplaceAcceptedAnswer",
                        stage: "brief",
                        field: "location",
                        value: "Liverpool",
                        evidence: {
                          quote: "Manchester",
                        },
                      },
                    ],
                  },
                }
              default:
                // SAFETY: every expected request index is handled above; the
                // cast keeps the impossible defect branch out of the fixture.
                return Effect.die("unexpected request") as never
            }
          }),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const question = yield* RepairableChat.reply({
          sessionId: "duplicate-repair",
          message: "We need a public service website in Leeds.",
        })
        const initial = yield* RepairableChat.reply({
          sessionId: "duplicate-repair",
          expectedRevision: question.revision,
          message: "No, search anywhere.",
        })
        return yield* Effect.result(
          RepairableChat.reply({
            sessionId: "duplicate-repair",
            expectedRevision: initial.revision,
            message: "Actually, we are in Manchester.",
          }),
        )
      }).pipe(Effect.provide(live)),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidCollectStageResponse)
      if (result.failure instanceof InvalidCollectStageResponse) {
        expect(result.failure.reason).toBe("invalid_repair")
      }
    }
  })

  test("runs domain validation before accepting a replacement", async () => {
    const Budget = Stage.collect({
      name: "budget",
      fields: {
        amount: Answer.explicit(Schema.Number, {
          description: "The budget; must be at least 5,000",
          ask: Question.fixed("What is the budget?"),
          validate: (amount) =>
            amount >= 5_000
              ? Effect.void
              : Effect.fail(new BudgetTooLow({ minimum: 5_000 })),
          reject: {
            ask: Question.fixed("Could you revise the budget?"),
          },
        }),
      },
    })
    const BudgetChat = defineChat({
      name: "budget_repair",
      version: 1,
      stages: [Budget, Matching],
      repair: Repair.standard(),
    })
    const calls = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(calls, (count) => count + 1).pipe(
          Effect.map((count) =>
            count === 1
              ? {
                  name: "submit_answers",
                  arguments: {
                    answers: { amount: 6_000 },
                    evidence: [
                      {
                        field: "amount",
                        quote: "£6,000",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              : count === 2
                ? {
                    name: "repair_search",
                    arguments: { location: "anywhere" },
                  }
                : {
                    name: "apply_conversation_repairs",
                    arguments: {
                      corrections: [
                        {
                          _tag: "ReplaceAcceptedAnswer",
                          stage: "budget",
                          field: "amount",
                          value: 2_000,
                          evidence: {
                            quote: "£2,000",
                          },
                        },
                      ],
                    },
                  },
          ),
        ),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* BudgetChat.reply({
          sessionId: "budget-repair",
          message: "The budget is £6,000.",
        })
        return yield* Effect.result(
          BudgetChat.reply({
            sessionId: "budget-repair",
            expectedRevision: initial.revision,
            message: "Actually, the budget is £2,000.",
          }),
        )
      }).pipe(Effect.provide(live)),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AnswerValidationRejected)
      if (result.failure instanceof AnswerValidationRejected) {
        expect(result.failure.error).toBeInstanceOf(BudgetTooLow)
      }
    }
    expect(await Effect.runPromise(Ref.get(calls))).toBe(3)
  })

  test("cannot be enabled for a command chat", () => {
    const command = defineCommand({
      name: "repair_forbidden_command",
      description: "A command must never be repaired or rerun.",
      input: Schema.Struct({}),
      execute: () => Effect.succeed({ done: true }),
    })
    const terminal = Stage.command({
      name: "repair_forbidden",
      instructions: ["Run once."],
      command,
    })

    expect(() =>
      defineChat({
        name: "invalid_repair_command_chat",
        version: 1,
        stages: [terminal],
        repair: Repair.standard(),
      }),
    ).toThrow("repeatable final query stage")
  })

  test("cannot be enabled for a completing tool chat", () => {
    const terminal = Stage.tools({
      name: "repair_forbidden_terminal_query",
      instructions: ["Search once."],
      tools: [Search],
      afterExecution: "complete",
    })

    expect(() =>
      defineChat({
        name: "invalid_repair_terminal_query_chat",
        version: 1,
        stages: [Brief, terminal],
        repair: Repair.standard(),
      }),
    ).toThrow("repeatable final query stage")
  })
})

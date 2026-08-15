import { describe, expect, test } from "bun:test"
import {
  Context,
  Effect,
  Either,
  Layer,
  Ref,
  Schema,
} from "effect"
import {
  Answer,
  AnswerValidationRejected,
  InvalidCollectStageResponse,
  Message,
  Question,
  Stage,
  StructuredChatModel,
  type CollectAnswers,
} from "../src/index.js"

const accepted = <Value>(
  value: Value,
  messageIndex: number,
  quote: string,
) => ({ value, evidence: { messageIndex, quote } })

const Brief = Stage.collect({
  name: "brief",
  fields: {
    project: Answer.semantic(Schema.String, {
      description: "What the client needs help creating",
      ask: Question.adaptive("Clarify the project or desired outcome", {
        fallback: "What do you need help creating?",
      }),
    }),
    location: Answer.explicit(Schema.String, {
      description: "Where the client is based",
      ask: Question.fixed("Where are you based?"),
    }),
    localOnly: Answer.confirmed(Schema.Boolean, {
      description: "Whether to restrict results to local firms",
      ask: Question.choice("Only show local firms?", [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ]),
    }),
  },
})

const AdaptiveBrief = Stage.collect({
  name: "adaptive_brief",
  fields: {
    priority: Answer.confirmed(Schema.String, {
      description: "The unmet need the client most wants to solve",
      ask: Question.adaptiveChoice("Which area needs the most help?", {
        minimumOptions: 3,
        maximumOptions: 5,
        fallbackOptions: ["Strategy", "Creative", "Delivery"],
      }),
    }),
  },
})

const ExploratoryBrief = Stage.collect({
  name: "exploratory_brief",
  questions: {
    guidance:
      "Ask one conversational question and explain why the answer improves the result.",
    escape: "Not sure yet",
  },
  fields: {
    priority: Answer.semantic(Schema.String, {
      description: "The concrete outcome where outside help is needed",
      ask: Question.adaptiveChoice(
        "Where could outside help make the biggest difference?",
        { minimumOptions: 3, maximumOptions: 5 },
      ),
    }),
  },
})

const MultiAdaptiveBrief = Stage.collect({
  name: "multi_adaptive_brief",
  fields: {
    project: Answer.semantic(Schema.String, {
      description: "The project",
      ask: Question.adaptive("Clarify the project", {
        fallback: "What are you hoping to create?",
      }),
    }),
    location: Answer.semantic(Schema.String, {
      description: "The location",
      ask: Question.adaptive("Clarify the location", {
        fallback: "Where is the project based?",
      }),
    }),
  },
})

class BudgetTooLow extends Schema.TaggedError<BudgetTooLow>()(
  "BudgetTooLow",
  { minimum: Schema.Number },
) {}

class BudgetPolicy extends Context.Tag("BudgetPolicy")<
  BudgetPolicy,
  { readonly minimum: number }
>() {}

const BudgetBrief = Stage.collect({
  name: "budget_brief",
  fields: {
    budget: Answer.explicit(Schema.Number, {
      description: "The project budget in GBP; must be at least 5,000",
      ask: Question.fixed("What budget have you set aside?"),
      validate: (budget) =>
        BudgetPolicy.pipe(
          Effect.flatMap(({ minimum }) =>
            budget >= minimum
              ? Effect.void
              : Effect.fail(new BudgetTooLow({ minimum })),
          ),
        ),
      reject: {
        ask: Question.fixed(
          "Our minimum engagement is £5,000. Could you revise the budget?",
        ),
      },
    }),
  },
})

describe("Stage.collect", () => {
  test("rejects an empty uncertainty escape at definition time", () => {
    expect(() =>
      Stage.collect({
        name: "invalid_question_policy",
        questions: { escape: "   " },
        fields: {
          project: Answer.semantic(Schema.String, {
            description: "The project",
            ask: Question.adaptive("Clarify the project", {
              fallback: "What is the project?",
            }),
          }),
        },
      }),
    ).toThrow()
  })

  test("rejects field names that are not lowercase identifiers", () => {
    const project = Answer.semantic(Schema.String, {
      description: "The project",
      ask: Question.fixed("What is the project?"),
    })

    expect(() =>
      Stage.collect({
        name: "integer_field_name",
        fields: { "0": project },
      }),
    ).toThrow("Collect-stage field names")
    expect(() =>
      Stage.collect({
        name: "uppercase_field_name",
        fields: { Project: project },
      }),
    ).toThrow("Collect-stage field names")
  })

  test("rejects invalid adaptive-choice fallbacks at definition time", () => {
    expect(() =>
      Question.adaptiveChoice("Which area needs help?", {
        minimumOptions: 2,
        maximumOptions: 3,
        fallbackOptions: ["Strategy", "strategy"],
      }),
    ).toThrow("Adaptive choice fallback options must be unique")

    expect(() =>
      Question.adaptiveChoice("Which area needs help?", {
        minimumOptions: 3,
        maximumOptions: 5,
        fallbackOptions: ["Strategy", "Creative"],
      }),
    ).toThrow(
      "Adaptive choice fallback options must satisfy the configured bounds",
    )
  })

  test("runs validators in definition order and stops after the first rejection", async () => {
    const order: Array<string> = []
    const Ordered = Stage.collect({
      name: "ordered",
      fields: {
        first: Answer.explicit(Schema.String, {
          description: "The first answer",
          ask: Question.fixed("First?"),
          validate: () =>
            Effect.sync(() => order.push("first")).pipe(
              Effect.zipRight(
                Effect.fail(new BudgetTooLow({ minimum: 1 })),
              ),
            ),
          reject: { ask: Question.fixed("Please revise first.") },
        }),
        second: Answer.explicit(Schema.String, {
          description: "The second answer",
          ask: Question.fixed("Second?"),
          validate: () =>
            Effect.sync(() => {
              order.push("second")
            }),
          reject: { ask: Question.fixed("Please revise second.") },
        }),
      },
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { first: "one", second: "two" },
            evidence: [
              { field: "first", quote: "one" },
              { field: "second", quote: "two" },
            ],
            nextQuestion: null,
          },
        }),
    })

    const result = await Effect.runPromise(
      Effect.either(
        Ordered.run({
          state: Ordered.initialState,
          messages: [Message.user("one then two")],
        }).pipe(Effect.provide(model)),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    expect(order).toEqual(["first"])
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(AnswerValidationRejected)
      if (result.left instanceof AnswerValidationRejected) {
        expect(result.left.field).toBe("first")
      }
    }
  })

  test("returns a typed domain rejection with a deterministic retry question", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { budget: 2_000 },
            evidence: [
              {
                field: "budget",
                quote: "£2,000",
              },
            ],
            nextQuestion: null,
          },
        }),
    })
    const policy = Layer.succeed(BudgetPolicy, { minimum: 5_000 })

    const result = await Effect.runPromise(
      Effect.either(
        BudgetBrief.run({
          state: BudgetBrief.initialState,
          messages: [Message.user("We can spend £2,000.")],
        }).pipe(Effect.provide(Layer.merge(model, policy))),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(AnswerValidationRejected)
      if (result.left instanceof AnswerValidationRejected) {
        expect(result.left.stage).toBe("budget_brief")
        expect(result.left.field).toBe("budget")
        expect(result.left.error).toBeInstanceOf(BudgetTooLow)
        expect(result.left.question).toEqual({
          field: "budget",
          mode: "explicit",
          text: "Our minimum engagement is £5,000. Could you revise the budget?",
          options: [],
        })
      }
    }
  })

  test("persists provenance only after domain validation succeeds", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { budget: 6_000 },
            evidence: [
              {
                field: "budget",
                quote: "£6,000",
              },
            ],
            nextQuestion: null,
          },
        }),
    })
    const policy = Layer.succeed(BudgetPolicy, { minimum: 5_000 })

    const turn = await Effect.runPromise(
      BudgetBrief.run({
        state: BudgetBrief.initialState,
        messages: [Message.user("We can spend £6,000.")],
      }).pipe(Effect.provide(Layer.merge(model, policy))),
    )

    expect(turn.complete).toBe(true)
    expect(turn.state.accepted.budget).toEqual(
      accepted(6_000, 0, "£6,000"),
    )
  })

  test("re-asks the confirmation when evidence predates question issuance", async () => {
    const state = {
      accepted: {
        project: accepted(
          "A public service website",
          0,
          "public service website",
        ),
        location: accepted("Leeds", 0, "Leeds"),
      },
      asked: {
        localOnly: { messageIndex: 1, text: "Only show local firms?" },
      },
    }
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
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
        }),
    })
    const turn = await Effect.runPromise(
      Brief.run({
        state,
        messages: [
          Message.user(
            "We need a public service website in Leeds. No, search anywhere.",
          ),
          Message.assistant("Only show local firms?"),
          Message.user("What are my options?"),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(false)
    expect(turn.state).toEqual(state)
    expect(turn.question).toMatchObject({
      field: "localOnly",
      mode: "confirmed",
      text: "Only show local firms?",
    })
  })

  test("routes adaptive wording to the server-owned pending field", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { project: null, location: null },
            evidence: [],
            nextQuestion: {
              field: "project",
              text: "What outcome would make this project worthwhile?",
              options: [],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      MultiAdaptiveBrief.run({
        state: MultiAdaptiveBrief.initialState,
        messages: [Message.user("I need some help.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "project",
      mode: "semantic",
      text: "What outcome would make this project worthwhile?",
      options: [],
    })
  })

  test("discards adaptive wording attributed to the wrong field", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { project: "A public service website", location: null },
            evidence: [
              { field: "project", quote: "public service website" },
            ],
            nextQuestion: {
              field: "project",
              text: "What outcome would make this project worthwhile?",
              options: [],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      MultiAdaptiveBrief.run({
        state: MultiAdaptiveBrief.initialState,
        messages: [Message.user("We need a public service website.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.state.accepted).toEqual({
      project: accepted(
        "A public service website",
        0,
        "public service website",
      ),
    })
    expect(turn.question).toEqual({
      field: "location",
      mode: "semantic",
      text: "Where is the project based?",
      options: [],
    })
  })

  test("presents the authored fallback text when the model omits adaptive wording", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { project: null, location: null },
            evidence: [],
            nextQuestion: null,
          },
        }),
    })
    const turn = await Effect.runPromise(
      MultiAdaptiveBrief.run({
        state: MultiAdaptiveBrief.initialState,
        messages: [Message.user("I need some help.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "project",
      mode: "semantic",
      text: "What are you hoping to create?",
      options: [],
    })
  })

  test("derives complete typed answers from one field definition", () => {
    const answers: CollectAnswers<typeof Brief.fields> = {
      project: "A public service website",
      location: "Leeds",
      localOnly: false,
    }

    expect(Schema.decodeSync(Brief.answersSchema)(answers)).toEqual(answers)
  })

  test("selects the first missing field in declaration order", () => {
    expect(Brief.nextQuestion(Brief.initialState)).toMatchObject({
      field: "project",
      mode: "semantic",
      question: {
        _tag: "AdaptiveQuestion",
        goal: "Clarify the project or desired outcome",
      },
    })
    expect(
      Brief.nextQuestion({
        accepted: {
          project: accepted(
            "A public service website",
            0,
            "public service website",
          ),
        },
        asked: {
          project: {
            messageIndex: 1,
            text: "What are you hoping to create?",
          },
        },
      }),
    ).toMatchObject({
      field: "location",
      mode: "explicit",
      question: {
        _tag: "FixedQuestion",
        text: "Where are you based?",
      },
    })
  })

  test("treats false as a populated answer and completes deterministically", () => {
    const state = {
      accepted: {
        project: accepted("A public service website", 0, "website"),
        location: accepted("Leeds", 0, "Leeds"),
        localOnly: accepted(false, 6, "No"),
      },
      asked: {
        project: {
          messageIndex: 1,
          text: "What are you hoping to create?",
        },
        location: { messageIndex: 3, text: "Where are you based?" },
        localOnly: { messageIndex: 5, text: "Only show local firms?" },
      },
    }

    expect(Brief.isComplete(state)).toBe(true)
    expect(Brief.nextQuestion(state)).toBeUndefined()
  })

  test("strictly parses persisted state and registered asked fields", async () => {
    const excess = await Effect.runPromise(
      Effect.either(
        Brief.parseState({
          accepted: {},
          asked: {},
          activeStage: "matching",
        }),
      ),
    )
    const unknownField = await Effect.runPromise(
      Effect.either(
        Brief.parseState({
          accepted: {},
          asked: {
            budget: { messageIndex: 1, text: "What is the budget?" },
          },
        }),
      ),
    )
    const missingEvidence = await Effect.runPromise(
      Effect.either(
        Brief.parseState({
          accepted: {
            project: { value: "A public service website" },
          },
          asked: {},
        }),
      ),
    )

    expect(Either.isLeft(excess)).toBe(true)
    expect(Either.isLeft(unknownField)).toBe(true)
    expect(Either.isLeft(missingEvidence)).toBe(true)
  })

  test("marks issued questions idempotently", () => {
    const once = Brief.markAsked(
      Brief.initialState,
      "project",
      1,
      "What are you hoping to create?",
    )
    const twice = Brief.markAsked(
      once,
      "project",
      3,
      "A different question",
    )

    expect(once.asked).toEqual({
      project: {
        messageIndex: 1,
        text: "What are you hoping to create?",
      },
    })
    expect(twice.asked).toEqual(once.asked)
  })

  test("rejects an issued question that is not grounded in assistant history", async () => {
    let modelCalls = 0
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.sync(() => {
          modelCalls += 1
          return {
            name: "submit_answers",
            arguments: {
              answers: { priority: null },
              evidence: [],
              nextQuestion: null,
            },
          }
        }),
    })
    const result = await Effect.runPromise(
      Effect.either(
        AdaptiveBrief.run({
          state: {
            accepted: {},
            asked: {
              priority: {
                messageIndex: 0,
                text: "Which area needs the most help?",
              },
            },
          },
          messages: [Message.user("We need an agency partner.")],
        }).pipe(Effect.provide(model)),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidCollectStageResponse)
    }
    expect(modelCalls).toBe(0)
  })

  test("rejects adaptive-choice fallbacks that fail the answer schema", () => {
    expect(() =>
      Answer.confirmed(Schema.String.pipe(Schema.maxLength(5)), {
        description: "A tightly bounded answer",
        ask: Question.adaptiveChoice("Choose one", {
          minimumOptions: 2,
          maximumOptions: 3,
          fallbackOptions: ["Short", "Beyond the bound"],
        }),
      }),
    ).toThrow()
  })

  test("uses schema fallbacks when model options fail the answer schema", async () => {
    const BoundedBrief = Stage.collect({
      name: "bounded_brief",
      fields: {
        priority: Answer.confirmed(
          Schema.String.pipe(Schema.maxLength(20)),
          {
            description: "The priority",
            ask: Question.adaptiveChoice("Which area needs the most help?", {
              minimumOptions: 2,
              maximumOptions: 3,
              fallbackOptions: ["Strategy", "Creative"],
            }),
          },
        ),
      },
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: null },
            evidence: [],
            nextQuestion: {
              field: "priority",
              text: "Where would outside expertise help most?",
              options: [
                "Strategy",
                "A very long option label beyond bounds",
              ],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      BoundedBrief.run({
        state: BoundedBrief.initialState,
        messages: [Message.user("We need an agency partner.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "priority",
      mode: "confirmed",
      text: "Where would outside expertise help most?",
      options: [
        { label: "Strategy", value: "Strategy" },
        { label: "Creative", value: "Creative" },
      ],
    })
  })

  test("validates choice values against the answer schema", () => {
    expect(() =>
      Answer.confirmed(Schema.Boolean, {
        description: "A boolean choice",
        // SAFETY: This test deliberately violates the question/answer generic
        // to prove that runtime construction rejects the mismatch.
        ask: Question.choice("Choose", [
          { label: "Invalid", value: "yes" },
        ]) as never,
      }),
    ).toThrow()
  })

  test("accepts grounded facts but cannot skip an unasked confirmation", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: (request) => {
        expect(request.tools.map(({ name }) => name)).toEqual([
          "submit_answers",
        ])

        return Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: {
              project: "A public service website",
              location: "Leeds",
              localOnly: false,
            },
            evidence: [
              {
                field: "project",
                quote: "public service website",
              },
              {
                field: "location",
                quote: "Leeds",
              },
              {
                field: "localOnly",
                quote: "Leeds",
              },
            ],
            nextQuestion: null,
          },
        })
      },
    })
    const turn = await Effect.runPromise(
      Brief.run({
        state: Brief.initialState,
        messages: [
          Message.user(
            "We are in Leeds and need a public service website.",
          ),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(false)
    expect(turn.state.accepted).toEqual({
      project: accepted(
        "A public service website",
        0,
        "public service website",
      ),
      location: accepted("Leeds", 0, "Leeds"),
    })
    expect(turn.state.asked).toEqual({
      localOnly: { messageIndex: 1, text: "Only show local firms?" },
    })
    expect(turn.question).toEqual({
      field: "localOnly",
      mode: "confirmed",
      text: "Only show local firms?",
      options: [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ],
    })
  })

  test("completes only after the issued confirmation is grounded", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
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
        }),
    })
    const turn = await Effect.runPromise(
      Brief.run({
        state: {
          accepted: {
            project: accepted(
              "A public service website",
              0,
              "public service website",
            ),
            location: accepted("Leeds", 0, "Leeds"),
          },
          asked: {
            localOnly: {
              messageIndex: 1,
              text: "Only show local firms?",
            },
          },
        },
        messages: [
          Message.user(
            "We are in Leeds and need a public service website.",
          ),
          Message.assistant("Only show local firms?"),
          Message.user("No, search anywhere."),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(true)
    expect(turn.question).toBeUndefined()
    expect(turn.state.accepted.localOnly).toEqual(
      accepted(false, 2, "search anywhere"),
    )
  })

  test("re-asks the trusted question when evidence is not an exact user-message quote", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: {
              project: "A secret project",
              location: null,
              localOnly: null,
            },
            evidence: [
              {
                field: "project",
                quote: "text that was never supplied",
              },
            ],
            nextQuestion: null,
          },
        }),
    })
    const turn = await Effect.runPromise(
      Brief.run({
        state: Brief.initialState,
        messages: [Message.user("We need a public service website.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(false)
    expect(turn.state.accepted).toEqual({})
    expect(turn.question).toMatchObject({ field: "project" })
  })

  test("uses model wording only for an adaptive question", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: {
              project: null,
              location: null,
              localOnly: null,
            },
            evidence: [],
            nextQuestion: {
              field: "project",
              text: "What outcome should the new service achieve?",
              options: [],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      Brief.run({
        state: Brief.initialState,
        messages: [Message.user("We would like some help.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question?.field).toBe("project")
    expect(turn.question?.text).toBe(
      "What outcome should the new service achieve?",
    )
  })

  test("accepts simple adaptive question text from a guided provider", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: {
              project: null,
              location: null,
              localOnly: null,
            },
            evidence: [],
            nextQuestion: {
              field: "project",
              text: "What outcome would make this project worthwhile?",
              options: [],
            },
          },
        }),
    })

    const turn = await Effect.runPromise(
      Brief.run({
        state: Brief.initialState,
        messages: [Message.user("We need some help")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toMatchObject({
      field: "project",
      text: "What outcome would make this project worthwhile?",
      options: [],
    })
  })

  test("accepts a bounded unique set of contextual adaptive choices", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: null },
            evidence: [],
            nextQuestion: {
              field: "priority",
              text: "Where would outside expertise help most?",
              options: [
                "Brand strategy",
                "Website conversion",
                "Campaign production",
              ],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      AdaptiveBrief.run({
        state: AdaptiveBrief.initialState,
        messages: [Message.user("We need an agency partner.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "priority",
      mode: "confirmed",
      text: "Where would outside expertise help most?",
      options: [
        { label: "Brand strategy", value: "Brand strategy" },
        { label: "Website conversion", value: "Website conversion" },
        { label: "Campaign production", value: "Campaign production" },
      ],
    })
  })

  test("applies stage question guidance and exposes one uncertainty escape", async () => {
    let instructions = ""
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: (request) => {
        instructions = request.instructions.join(" ")
        return Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: null },
            evidence: [],
            nextQuestion: {
              field: "priority",
              text: "What would you most like to improve? Even a rough direction helps me find more relevant work.",
              options: [
                "Brand strategy",
                "Website conversion",
                "Campaign production",
              ],
            },
          },
        })
      },
    })
    const turn = await Effect.runPromise(
      ExploratoryBrief.run({
        state: ExploratoryBrief.initialState,
        messages: [Message.user("We may need an agency.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "priority",
      mode: "semantic",
      text: "What would you most like to improve? Even a rough direction helps me find more relevant work.",
      options: [
        { label: "Brand strategy", value: "Brand strategy" },
        { label: "Website conversion", value: "Website conversion" },
        { label: "Campaign production", value: "Campaign production" },
      ],
      escape: { label: "Not sure yet" },
    })
    expect(instructions).toContain(
      "Ask one conversational question and explain why the answer improves the result.",
    )
    expect(instructions).toContain(
      "provide 3-5 contextual options",
    )
    expect(instructions).toContain('"Not sure yet"')
  })

  test("resolves an escaped field with the declared application value", async () => {
    const ResolvableBrief = Stage.collect({
      name: "resolvable_brief",
      questions: { escape: "Not sure yet" },
      fields: {
        priority: Answer.semantic(Schema.String, {
          description: "The concrete outcome where outside help is needed",
          ask: Question.adaptive("Clarify the priority", {
            fallback: "Where would outside help matter most?",
          }),
          escape: { value: "Open to suggestions" },
        }),
      },
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: null },
            evidence: [],
            nextQuestion: null,
          },
        }),
    })
    const turn = await Effect.runPromise(
      ResolvableBrief.run({
        state: {
          accepted: {},
          asked: {
            priority: {
              messageIndex: 1,
              text: "Where would outside help matter most?",
            },
          },
        },
        messages: [
          Message.user("We may need an agency."),
          Message.assistant("Where would outside help matter most?"),
          Message.user("Not sure yet"),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(true)
    expect(turn.state.accepted).toEqual({
      priority: accepted("Open to suggestions", 2, "Not sure yet"),
    })
  })

  test("rejects escape resolution without a stage escape label", () => {
    expect(() =>
      Stage.collect({
        name: "missing_escape_label",
        fields: {
          priority: Answer.semantic(Schema.String, {
            description: "The priority",
            ask: Question.fixed("What is the priority?"),
            escape: { value: "Open to suggestions" },
          }),
        },
      }),
    ).toThrow("questions.escape")
  })

  test("keeps an uncertainty response unresolved despite a model proposal", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: "Not sure yet" },
            evidence: [
              { field: "priority", quote: "Not sure yet" },
            ],
            nextQuestion: {
              field: "priority",
              text: "No problem — is the bigger challenge finding the right direction, or making the current direction work harder?",
              options: [
                "Finding the direction",
                "Improving the current idea",
                "Reaching the right audience",
              ],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      ExploratoryBrief.run({
        state: {
          accepted: {},
          asked: {
            priority: {
              messageIndex: 1,
              text: "What would you most like to improve?",
            },
          },
        },
        messages: [
          Message.user("We may need an agency."),
          Message.assistant("What would you most like to improve?"),
          Message.user("Not sure yet"),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(false)
    expect(turn.state.accepted).toEqual({})
    expect(turn.question).toMatchObject({
      field: "priority",
      text: "No problem — is the bigger challenge finding the right direction, or making the current direction work harder?",
      escape: { label: "Not sure yet" },
    })
  })

  test("uses schema fallbacks for invalid adaptive choices", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: null },
            evidence: [],
            nextQuestion: {
              field: "priority",
              text: "Where would outside expertise help most?",
              options: [
                "Brand strategy",
                "brand strategy",
                "Campaign production",
              ],
            },
          },
        }),
    })
    const turn = await Effect.runPromise(
      AdaptiveBrief.run({
        state: AdaptiveBrief.initialState,
        messages: [Message.user("We need an agency partner.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "priority",
      mode: "confirmed",
      text: "Where would outside expertise help most?",
      options: [
        { label: "Strategy", value: "Strategy" },
        { label: "Creative", value: "Creative" },
        { label: "Delivery", value: "Delivery" },
      ],
    })
  })

  test("uses schema fallbacks when the model omits an adaptive choice", async () => {
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { priority: null },
            evidence: [],
            nextQuestion: null,
          },
        }),
    })
    const turn = await Effect.runPromise(
      AdaptiveBrief.run({
        state: AdaptiveBrief.initialState,
        messages: [Message.user("We need an agency partner.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "priority",
      mode: "confirmed",
      text: "Which area needs the most help?",
      options: [
        { label: "Strategy", value: "Strategy" },
        { label: "Creative", value: "Creative" },
        { label: "Delivery", value: "Delivery" },
      ],
    })
  })

  test("falls back to the trusted question after model repair is exhausted", async () => {
    const requests = await Effect.runPromise(Ref.make(0))
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.update(requests, (count) => count + 1).pipe(
          Effect.as({
            name: "submit_answers",
            arguments: { invalid: true },
          }),
        ),
    })

    const turn = await Effect.runPromise(
      AdaptiveBrief.run({
        state: AdaptiveBrief.initialState,
        messages: [Message.user("We need an agency partner.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.question).toEqual({
      field: "priority",
      mode: "confirmed",
      text: "Which area needs the most help?",
      options: [
        { label: "Strategy", value: "Strategy" },
        { label: "Creative", value: "Creative" },
        { label: "Delivery", value: "Delivery" },
      ],
    })
    expect(await Effect.runPromise(Ref.get(requests))).toBe(2)
  })
})

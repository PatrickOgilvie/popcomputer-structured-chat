import {
  Answer,
  Chat,
  Model,
  Question,
  Session,
  Stage,
  Tool,
} from "../src/index.js"
import {
  InvalidChatUserAnswerProjection,
  projectUserAnswers,
} from "../src/core/user-answer-projection.js"
import * as Debug from "../src/debug.js"
import { Chat as ChatTest } from "../src/testing.js"
import { describe, expect, test } from "bun:test"
import {
  cast,
  Effect,
  Layer,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect"

const accepted = <Value>(value: Value) => ({
  value,
  evidence: { messageIndex: 0, quote: "supporting text" },
})

describe("projectUserAnswers", () => {
  test("projects only annotated fields in declaration order", async () => {
    const ProjectSummary = Stage.collect({
      name: "project_summary",
      fields: {
        launchDate: Answer.semantic(Schema.DateFromString, {
          description: "The planned launch date",
          ask: Question.fixed("When should it launch?"),
        }).pipe(Answer.visibleToUser()),
        privateAmount: Answer.explicit(Schema.BigInt, {
          description: "An internal non-JSON amount",
          ask: Question.fixed("What is the exact amount?"),
        }),
        site_contact: Answer.explicit(Schema.String, {
          description: "The site contact",
          ask: Question.fixed("Who is the site contact?"),
        }).pipe(Answer.visibleToUser({ label: "Primary contact" })),
      },
    })
    const DeliveryDetails = Stage.collect({
      name: "delivery_details",
      fields: {
        dayRate: Answer.explicit(Schema.Number, {
          description: "The proposed day rate",
          ask: Question.fixed("What is the day rate?"),
        }).pipe(Answer.visibleToUser()),
      },
    })

    const snapshot = await Effect.runPromise(
      projectUserAnswers({
        definition: {
          name: "supplier_onboarding",
          version: 1,
          stages: [ProjectSummary, DeliveryDetails],
        },
        state: {
          stages: {
            project_summary: {
              accepted: {
                launchDate: accepted(new Date("2026-09-01T00:00:00.000Z")),
                privateAmount: accepted(10n),
              },
              asked: {
                site_contact: {
                  messageIndex: 1,
                  text: "Who is the site contact?",
                },
              },
            },
            delivery_details: {
              accepted: {},
              asked: {},
            },
          },
        },
      }),
    )

    expect(snapshot).toEqual({
      schemaVersion: 1,
      chat: { name: "supplier_onboarding", version: 1 },
      sections: [
        {
          key: "project_summary",
          label: "Project summary",
          fields: [
            {
              key: "launchDate",
              label: "Launch Date",
              state: {
                _tag: "Accepted",
                value: "2026-09-01T00:00:00.000Z",
              },
            },
            {
              key: "site_contact",
              label: "Primary contact",
              state: { _tag: "Missing" },
            },
          ],
        },
        {
          key: "delivery_details",
          label: "Delivery details",
          fields: [
            {
              key: "dayRate",
              label: "Day Rate",
              state: { _tag: "Missing" },
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("privateAmount")
    expect(JSON.stringify(snapshot)).not.toContain("supporting text")
    expect(JSON.stringify(snapshot)).not.toContain("Who is the site contact?")
  })

  test("preserves falsy accepted JSON values", async () => {
    const FalsyDetails = Stage.collect({
      name: "falsy_details",
      fields: {
        enabled: Answer.semantic(Schema.Boolean, {
          description: "Whether the feature is enabled",
          ask: Question.fixed("Enable it?"),
        }).pipe(Answer.visibleToUser()),
        quantity: Answer.semantic(Schema.Number, {
          description: "The requested quantity",
          ask: Question.fixed("How many?"),
        }).pipe(Answer.visibleToUser()),
        note: Answer.semantic(Schema.String, {
          description: "An optional note",
          ask: Question.fixed("Any note?"),
        }).pipe(Answer.visibleToUser()),
        selection: Answer.semantic(Schema.Null, {
          description: "An explicitly empty selection",
          ask: Question.fixed("Leave this empty?"),
        }).pipe(Answer.visibleToUser()),
      },
    })

    const snapshot = await Effect.runPromise(
      projectUserAnswers({
        definition: {
          name: "falsy_chat",
          version: 1,
          stages: [FalsyDetails],
        },
        state: {
          stages: {
            falsy_details: {
              accepted: {
                enabled: accepted(false),
                quantity: accepted(0),
                note: accepted(""),
                selection: accepted(null),
              },
              asked: {},
            },
          },
        },
      }),
    )

    expect(
      snapshot.sections[0]?.fields.map((field) => field.state),
    ).toEqual([
      { _tag: "Accepted", value: false },
      { _tag: "Accepted", value: 0 },
      { _tag: "Accepted", value: "" },
      { _tag: "Accepted", value: null },
    ])
  })

  test("keeps prototype-colliding visible fields missing", async () => {
    const PrototypeDetails = Stage.collect({
      name: "prototype_details",
      fields: {
        constructor: Answer.semantic(Schema.String, {
          description: "A field whose valid key exists on Object.prototype",
          ask: Question.fixed("What constructor should be used?"),
        }).pipe(Answer.visibleToUser()),
      },
    })

    const snapshot = await Effect.runPromise(
      projectUserAnswers({
        definition: {
          name: "prototype_collision_chat",
          version: 1,
          stages: [PrototypeDetails],
        },
        state: {
          stages: {
            prototype_details: {
              accepted: {},
              asked: {},
            },
          },
        },
      }),
    )

    expect(snapshot.sections).toEqual([
      {
        key: "prototype_details",
        label: "Prototype details",
        fields: [
          {
            key: "constructor",
            label: "Constructor",
            state: { _tag: "Missing" },
          },
        ],
      },
    ])

    const Finish = Tool.define({
      name: "finish_prototype_details",
      description: "Finish the prototype-collision inspection test.",
      input: Schema.Struct({}),
      execute: () => Effect.succeed({ complete: true }),
    })
    const PrototypeChat = Chat.define({
      name: "prototype_inspection_chat",
      version: 1,
      stages: [
        PrototypeDetails,
        Stage.tools({
          name: "finish",
          instructions: ["Finish the chat."],
          tools: [Finish],
        }),
      ],
    })
    const debug = await Effect.runPromise(
      Debug.inspect(
        PrototypeChat,
        ChatTest.initialState(PrototypeChat),
      ),
    )

    expect(debug.stages[0]).toMatchObject({
      _tag: "CollectStage",
      fields: [
        {
          field: "constructor",
          state: { _tag: "Missing" },
        },
      ],
    })

    let replacements = 0
    const model = Layer.succeed(Model.Service, {
      requestTool: () =>
        Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { constructor: null },
            evidence: [],
            nextQuestion: {
              field: "constructor",
              text: "What constructor should be used?",
              options: [],
            },
          },
        }),
    })
    const store = Layer.succeed(Session.Store, {
      load: () => Effect.succeed(null),
      replace: () =>
        Effect.sync(() => {
          replacements += 1
          return { revision: "persisted-constructor" }
        }),
    })
    const reply = await Effect.runPromise(
      Chat.turn(PrototypeChat, {
        sessionId: "prototype-collision",
        message: "I do not know which constructor to use.",
      }).pipe(Effect.provide(Layer.merge(model, store))),
    )

    expect(replacements).toBe(1)
    expect(reply.revision).toBe("persisted-constructor")
    expect(reply.userAnswers.sections[0]?.fields).toEqual([
      {
        key: "constructor",
        label: "Constructor",
        state: { _tag: "Missing" },
      },
    ])
    expect(
      Chat.acceptedAnswer(
        PrototypeChat,
        reply.turn.state,
        PrototypeDetails,
        "constructor",
      ),
    ).toBeUndefined()
  })

  test("returns an empty complete snapshot when no answers are annotated", async () => {
    const PrivateDetails = Stage.collect({
      name: "private_details",
      fields: {
        secret: Answer.semantic(Schema.BigInt, {
          description: "A private non-JSON value",
          ask: Question.fixed("What is the private value?"),
        }),
      },
    })

    const snapshot = await Effect.runPromise(
      projectUserAnswers({
        definition: {
          name: "private_chat",
          version: 1,
          stages: [PrivateDetails],
        },
        state: {
          stages: {
            private_details: {
              accepted: { secret: accepted(1n) },
              asked: {},
            },
          },
        },
      }),
    )

    expect(snapshot).toEqual({
      schemaVersion: 1,
      chat: { name: "private_chat", version: 1 },
      sections: [],
    })
  })

  test("returns safe failures for invalid state and answer encoding", async () => {
    const VisibleAmount = Stage.collect({
      name: "visible_amount",
      fields: {
        amount: Answer.semantic(Schema.Number, {
          description: "A visible numeric amount",
          ask: Question.fixed("What is the amount?"),
        }).pipe(Answer.visibleToUser()),
      },
    })
    const definition = {
      name: "invalid_projection_chat",
      version: 1,
      stages: [VisibleAmount],
    } as const
    const invalidState = await Effect.runPromise(
      Effect.result(
        projectUserAnswers({ definition, state: { stages: {} } }),
      ),
    )
    const invalidValue = await Effect.runPromise(
      Effect.result(
        projectUserAnswers({
          definition,
          state: {
            stages: {
              visible_amount: {
                // This deliberately violates the trusted-state precondition to
                // prove the shared encoder classifies rather than leaks values.
                accepted: { amount: accepted(1n) },
                asked: {},
              },
            },
          },
        }),
      ),
    )

    expect(Result.isFailure(invalidState)).toBe(true)
    if (Result.isFailure(invalidState)) {
      expect(invalidState.failure).toBeInstanceOf(
        InvalidChatUserAnswerProjection,
      )
      expect(invalidState.failure.reason).toBe("invalid_state")
    }
    expect(Result.isFailure(invalidValue)).toBe(true)
    if (Result.isFailure(invalidValue)) {
      expect(invalidValue.failure.reason).toBe("invalid_answer_value")
    }
  })

  test("validates the public snapshot before replacing the session", async () => {
    let encodeCount = 0
    const FailsOnSecondEncode = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: (value) => Effect.succeed(value),
          encode: (value, options) => {
            encodeCount += 1
            return encodeCount === 1
              ? Effect.succeed(value)
              : Effect.fail(
                  new SchemaIssue.InvalidValue(
                    { message: "second encoding rejected" },
                    value,
                    options,
                  ),
                )
          },
        }),
      ),
    )
    const AtomicDetails = Stage.collect({
      name: "atomic_details",
      fields: {
        value: Answer.semantic(FailsOnSecondEncode, {
          description: "A value whose repeated encoding is rejected",
          ask: Question.fixed("What value should be used?"),
        }).pipe(Answer.visibleToUser()),
      },
    })
    const Finish = Tool.define({
      name: "finish_atomic_projection",
      description: "Finish the atomic projection test.",
      input: Schema.Struct({}),
      execute: () => Effect.succeed({ complete: true }),
    })
    const AtomicChat = Chat.define({
      name: "atomic_projection_chat",
      version: 1,
      stages: [
        AtomicDetails,
        Stage.tools({
          name: "finish",
          instructions: ["Finish the chat."],
          tools: [Finish],
        }),
      ],
    })
    let modelCalls = 0
    let replacements = 0
    const model = Layer.succeed(Model.Service, {
      requestTool: () => {
        modelCalls += 1
        return modelCalls === 1
          ? Effect.succeed({
              name: "submit_answers",
              arguments: {
                answers: { value: "accepted" },
                evidence: [{ field: "value", quote: "accepted" }],
                nextQuestion: null,
              },
            })
          : Effect.succeed({
              name: "finish_atomic_projection",
              arguments: {},
            })
      },
    })
    const store = Layer.succeed(Session.Store, {
      load: () => Effect.succeed(null),
      replace: () =>
        Effect.sync(() => {
          replacements += 1
          return { revision: "1" }
        }),
    })

    const result = await Effect.runPromise(
      Effect.result(
        Chat.turn(AtomicChat, {
          sessionId: "atomic-projection",
          message: "Use accepted as the value",
        }).pipe(Effect.provide(Layer.merge(model, store))),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(
        Chat.InvalidUserAnswerProjection,
      )
      expect(result.failure.reason).toBe("invalid_answer_value")
    }
    expect(encodeCount).toBe(2)
    expect(replacements).toBe(0)
  })
})

describe("Answer.visibleToUser", () => {
  test("is immutable and strictly parses label options", async () => {
    const original = Answer.semantic(Schema.String, {
      description: "A reusable answer",
      ask: Question.fixed("What is the answer?"),
    })
    const visible = original.pipe(Answer.visibleToUser())
    const Details = Stage.collect({
      name: "visibility_details",
      fields: { original, visible },
    })
    const snapshot = await Effect.runPromise(
      projectUserAnswers({
        definition: {
          name: "visibility_chat",
          version: 1,
          stages: [Details],
        },
        state: {
          stages: {
            visibility_details: {
              accepted: {
                original: accepted("private"),
                visible: accepted("public"),
              },
              asked: {},
            },
          },
        },
      }),
    )

    expect(snapshot.sections[0]?.fields.map(({ key }) => key)).toEqual([
      "visible",
    ])
    expect(() =>
      original.pipe(Answer.visibleToUser({ label: "   " })),
    ).toThrow()

    const optionsWithExcess = {
      label: "Answer",
      unexpected: true,
    }
    expect(() =>
      original.pipe(
        Answer.visibleToUser(
          // SAFETY: the test deliberately crosses the typed configuration
          // boundary to prove excess runtime options are rejected.
          cast<typeof optionsWithExcess, Answer.VisibleToUserOptions>(
            optionsWithExcess,
          ),
        ),
      ),
    ).toThrow()
  })
})

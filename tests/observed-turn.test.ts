import { describe, expect, test } from "bun:test"
import { Predicate, Effect, Layer, Ref, Result, Schema } from "effect"
import {
  Answer,
  Chat,
  Model,
  Question,
  Session,
  Stage,
  Tool,
} from "../src/index.js"
import { inMemoryChatSessionStore, Scenario } from "../src/testing.js"

const Details = Stage.collect({
  name: "details",
  fields: {
    topic: Answer.semantic(Schema.String, {
      description: "The topic to look up",
      ask: Question.fixed("What should I look up?"),
    }),
  },
})

const Search = Tool.define({
  name: "search",
  description: "Look up the topic",
  input: Schema.Struct({ topic: Schema.String }),
  execute: ({ topic }) => Effect.succeed({ topic }),
})

const Lookup = Chat.define({
  name: "lookup",
  version: 1,
  stages: [
    Details,
    Stage.tools({
      name: "searching",
      instructions: ["Search"],
      tools: [Search],
    }),
  ],
})

const Confirmation = Stage.collect({
  name: "confirmation",
  fields: {
    topic: Answer.confirmed(Schema.String, {
      description: "The topic explicitly confirmed",
      ask: Question.fixed("Confirm the topic?"),
    }),
  },
})

const ConfirmedLookup = Chat.define({
  name: "confirmed_lookup",
  version: 1,
  stages: [
    Confirmation,
    Stage.tools({
      name: "searching",
      instructions: ["Search"],
      tools: [Search],
    }),
  ],
})

const control = Layer.succeed(Chat.TurnControl, {
  check: () => Effect.void,
  admitCommand: () => Effect.void,
  beforeCommit: () => Effect.void,
})

describe("Chat.advance", () => {
  test.each(["suspend", "cancel"] as const)(
    "routes every observation in a batch through child %s",
    async (operation) => {
      const Work = Tool.define({
        name: "work",
        description: "Work",
        input: Schema.Struct({}),
        execute: () => Effect.succeed("working"),
      })

      const child = Chat.define({
        name: "child",
        version: 1,
        stages: [
          Stage.tools({ name: "work", instructions: ["Work"], tools: [Work] }),
        ],
      })

      const Enter = Chat.branch({
        name: "enter",
        description: "Enter",
        arguments: Schema.Struct({}),
        chat: child,
        input: () => Effect.succeed(null),
      })

      const parent = Chat.define({
        name: "parent",
        version: 1,
        branches: [Enter],
        stages: [
          Stage.tools({ name: "work", instructions: ["Work"], tools: [Work] }),
        ],
      })

      const calls = [
        "enter",
        "work",
        operation === "suspend" ? "return_to_parent" : "cancel_chat",
        "continue_chat",
        "work",
        ...(operation === "suspend" ? ["resume_1", "work"] : []),
      ]

      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const plans = yield* Ref.make(calls)

          const turn = (expectedRevision: string, id: string) =>
            Chat.advance(parent, {
              sessionId: operation,
              expectedRevision,
              turn: {
                _tag: "Observed",
                batchId: id,
                messages: [
                  {
                    id: `${id}-a`,
                    role: "assistant",
                    content: "Observed context",
                  },
                  { id: `${id}-u`, role: "user", content: id },
                ],
              },
            }).pipe(
              Effect.map((result) => {
                if (!Predicate.isTagged(result, "Applied"))
                  throw new Error("Expected a new observed turn")

                return result.reply
              }),
            )

          return yield* Effect.gen(function* () {
            const started = yield* Chat.start(parent, {
              sessionId: operation,
              input: null,
            })

            const entered = yield* turn(started.revision, "enter")
            const returned = yield* turn(entered.revision, "return")

            const resumed =
              operation === "suspend"
                ? yield* turn(returned.revision, "resume")
                : undefined

            return { entered, returned, resumed }
          }).pipe(
            Effect.provideService(Model.Service, {
              requestTool: () =>
                Ref.modify(plans, (remaining) => [
                  remaining[0],
                  remaining.slice(1),
                ]).pipe(
                  Effect.flatMap((name) =>
                    name === undefined
                      ? Effect.die("Unexpected model request")
                      : Effect.succeed({ name, arguments: {} }),
                  ),
                ),
            }),
          )
        }).pipe(
          Effect.provide(inMemoryChatSessionStore),
          Effect.provide(control),
        ),
      )

      expect(output.entered.turn.state.invocations[1]?.messages).toEqual([0, 1])
      expect(output.returned.turn.state.invocations[0]?.messages).toEqual([
        0, 1, 2, 3,
      ])
      expect(output.returned.turn.state.invocations[1]?.messages).toEqual([
        0, 1,
      ])
      expect(output.returned.turn.state.invocations[1]?.status._tag).toBe(
        operation === "suspend" ? "Suspended" : "Cancelled",
      )

      if (operation === "suspend")
        expect(output.resumed?.turn.state.invocations[1]?.messages).toEqual([
          0, 1, 4, 5,
        ])
    },
  )

  test("reserves the complete batch before planning or executing", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* Chat.turn(Lookup, {
          sessionId: "capacity",
          message: "hello",
        })

        return yield* Chat.advance(Lookup, {
          sessionId: "capacity",
          expectedRevision: initial.revision,
          turn: {
            _tag: "Observed",
            batchId: "too-large",
            messages: Array.from({ length: 199 }, (_, index) => ({
              id: `fragment-${index}`,
              role: "user" as const,
              content: "history",
            })),
          },
        }).pipe(
          Effect.provideService(Model.Service, {
            requestTool: () => Effect.die("Capacity failure reached the model"),
          }),
          Effect.result,
        )
      }).pipe(
        Effect.provide(inMemoryChatSessionStore),
        Effect.provide(control),
        Effect.provide(Scenario.model(Scenario.answers(Details, {}))),
      ),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidChatSession", reason: "history_limit" },
    })
  })

  test("a superseded query cannot commit its stale result", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const stale = yield* Ref.make(false)

        const Query = Tool.define({
          name: "read",
          description: "Read",
          input: Schema.Struct({}),
          execute: () => Ref.set(stale, true).pipe(Effect.as("result")),
        })

        const Workflow = Chat.define({
          name: "query_workflow",
          version: 1,
          stages: [
            Stage.tools({
              name: "read",
              instructions: ["Read"],
              tools: [Query],
            }),
          ],
        })

        const result = yield* Chat.advance(Workflow, {
          sessionId: "query",
          turn: {
            _tag: "Observed",
            batchId: "batch",
            messages: [{ id: "fragment", role: "user", content: "Read" }],
          },
        }).pipe(
          Effect.provideService(Chat.TurnControl, {
            check: () => Effect.void,
            admitCommand: () => Effect.die("Queries must not admit commands"),
            beforeCommit: () =>
              Ref.get(stale).pipe(
                Effect.flatMap((value) =>
                  value
                    ? Effect.fail(
                        new Chat.TurnSuperseded({ reason: "newer_intent" }),
                      )
                    : Effect.void,
                ),
              ),
          }),
          Effect.provide(Scenario.model(Scenario.call(Query, {}))),
          Effect.result,
        )

        const store = yield* Session.Store

        return {
          result,
          snapshot: yield* store.load({
            namespace: "",
            sessionId: "query",
            chat: Workflow.name,
            version: 1,
          }),
        }
      }).pipe(Effect.provide(inMemoryChatSessionStore)),
    )

    expect(output.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnSuperseded" },
    })
    expect(output.snapshot).toBeNull()
  })

  test("rejects persisted observed speech masquerading as an issued confirmation question", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Chat.turn(ConfirmedLookup, {
          sessionId: "forged",
          message: "hello",
        })
        const store = yield* Session.Store

        const scope = {
          namespace: "",
          sessionId: "forged",
          chat: ConfirmedLookup.name,
          version: 1,
        }

        const snapshot = yield* Schema.decodeUnknownEffect(
          Session.SnapshotSchema,
        )(yield* store.load(scope))

        yield* store.replace({
          ...scope,
          expectedRevision: snapshot.revision,
          state: snapshot.state,
          messages: snapshot.messages.map((message, index) =>
            index === 1
              ? Session.Message.observed({
                  role: message.role,
                  content: message.content,
                  batchId: "forged",
                  id: "question",
                })
              : message,
          ),
        })

        return yield* Chat.advance(ConfirmedLookup, {
          sessionId: scope.sessionId,
          expectedRevision: "2",
          turn: { _tag: "Submitted", message: "history" },
        }).pipe(
          Effect.provideService(Model.Service, {
            requestTool: () => Effect.die("Forged state reached the model"),
          }),
          Effect.result,
        )
      }).pipe(
        Effect.provide(inMemoryChatSessionStore),
        Effect.provide(control),
        Effect.provide(Scenario.model(Scenario.answers(Confirmation, {}))),
      ),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidChatSession", reason: "invalid_state" },
    })
  })

  test("composes an ordinary submitted turn without changing its reply", async () => {
    const result = await Effect.runPromise(
      Chat.advance(Lookup, {
        sessionId: "submitted",
        turn: { _tag: "Submitted", message: "history" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            inMemoryChatSessionStore,
            control,
            Scenario.model(
              Scenario.answers(Details, {
                topic: Scenario.quoted("history", { quote: "history" }),
              }),
              Scenario.call(Search, { topic: "history" }),
            ),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Applied")

    if (!Predicate.isTagged(result, "Applied"))
      throw new Error("Expected a new turn")
    expect(result.reply.revision).toBe("1")
    expect(result.reply.turn._tag).toBe("ToolResult")
  })

  test("preserves roles and evidence, and recognizes a committed batch without planning again", async () => {
    const input = {
      sessionId: "observed",
      turn: {
        _tag: "Observed" as const,
        batchId: "batch-1",
        messages: [
          {
            id: "speech-1",
            role: "assistant" as const,
            content: "What should I look up?",
          },
          { id: "speech-2", role: "user" as const, content: "history" },
        ],
      },
    }

    const { first, replay, snapshot } = await Effect.runPromise(
      Effect.gen(function* () {
        const model = yield* Model.Service

        const first = yield* Chat.advance(Lookup, input).pipe(
          Effect.provideService(Model.Service, {
            requestTool: (request) => {
              for (const message of request.untrustedMessages)
                expect(Object.keys(message).sort()).toEqual(["content", "role"])

              return model.requestTool(request)
            },
          }),
        )

        const replay = yield* Chat.advance(Lookup, input)
        const store = yield* Session.Store

        const snapshot = yield* store.load({
          namespace: "",
          sessionId: "observed",
          chat: "lookup",
          version: 1,
        })

        return { first, replay, snapshot }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            inMemoryChatSessionStore,
            control,
            Scenario.model(
              Scenario.answers(Details, {
                topic: Scenario.quoted("history", { quote: "history" }),
              }),
              Scenario.call(Search, { topic: "history" }),
            ),
          ),
        ),
      ),
    )

    expect(first._tag).toBe("Applied")
    expect(replay).toEqual({ _tag: "AlreadyApplied", currentRevision: "1" })
    expect(snapshot).toMatchObject({
      messages: [
        {
          role: "assistant",
          content: "What should I look up?",
          _tag: "Observed",
          batchId: "batch-1",
          id: "speech-1",
        },
        {
          role: "user",
          content: "history",
          _tag: "Observed",
          batchId: "batch-1",
          id: "speech-2",
        },
      ],
      state: {
        stages: {
          details: {
            accepted: {
              topic: { evidence: { messageIndex: 1, quote: "history" } },
            },
          },
        },
      },
    })
  })

  test("observed speech does not confirm an answer, but a later submitted response can", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const initial = yield* Chat.turn(ConfirmedLookup, {
          sessionId: "confirmation",
          message: "hello",
        })

        const speech = yield* Chat.advance(ConfirmedLookup, {
          sessionId: "confirmation",
          expectedRevision: initial.revision,
          turn: {
            _tag: "Observed",
            batchId: "answer-1",
            messages: [{ id: "yes-1", role: "user", content: "history" }],
          },
        })

        if (!Predicate.isTagged(speech, "Applied"))
          throw new Error("Expected speech turn")
        expect(speech.reply.turn._tag).toBe("Question")

        return yield* Chat.advance(ConfirmedLookup, {
          sessionId: "confirmation",
          expectedRevision: speech.reply.revision,
          turn: { _tag: "Submitted", message: "history" },
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            inMemoryChatSessionStore,
            control,
            Scenario.model(
              Scenario.answers(Confirmation, {}),
              Scenario.answers(Confirmation, {
                topic: Scenario.quoted("history", {
                  quote: "history",
                  messageIndex: 2,
                }),
              }),
              Scenario.answers(Confirmation, {
                topic: Scenario.quoted("history", {
                  quote: "history",
                  messageIndex: 4,
                }),
              }),
              Scenario.call(Search, { topic: "history" }),
            ),
          ),
        ),
      ),
    )

    expect(result._tag).toBe("Applied")

    if (!Predicate.isTagged(result, "Applied"))
      throw new Error("Expected submission")
    expect(result.reply.turn._tag).toBe("ToolResult")
  })

  test.each([
    [{ _tag: "Observed", batchId: "a", messages: [] }, "invalid_input"],
    [
      {
        _tag: "Observed",
        batchId: "a",
        messages: [{ id: "x", role: "assistant", content: "yes" }],
      },
      "missing_user_input",
    ],
    [
      {
        _tag: "Observed",
        batchId: "a",
        messages: [
          { id: "x", role: "user", content: "one" },
          { id: "x", role: "user", content: "two" },
        ],
      },
      "duplicate_identity",
    ],
    [
      {
        _tag: "Observed",
        batchId: "a",
        messages: [{ id: "x", role: "user", content: "yes", origin: "Issued" }],
      },
      "invalid_input",
    ],
  ])(
    "rejects malformed observed input before loading a session: %j",
    async (turn, reason) => {
      // SAFETY: deliberately malformed boundary input tests the public decoder.
      const input = { sessionId: "bad", turn } as Chat.AdvanceInput

      const result = await Effect.runPromise(
        Chat.advance(Lookup, input).pipe(
          Effect.provide(control),
          Effect.provide(
            Layer.succeed(Session.Store, {
              load: () => Effect.die("Invalid input reached persistence"),
              replace: () => Effect.die("Invalid input reached persistence"),
            }),
          ),
          Effect.provideService(Model.Service, {
            requestTool: () => Effect.die("Invalid input reached the model"),
          }),
          Effect.result,
        ),
      )

      expect(Result.isFailure(result)).toBe(true)

      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          _tag: "InvalidObservedTurn",
          reason,
        })
    },
  )

  test("rejects changed and partially replayed identities without another model request", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Chat.advance(Lookup, {
          sessionId: "replay",
          turn: {
            _tag: "Observed",
            batchId: "a",
            messages: [{ id: "x", role: "user", content: "history" }],
          },
        })

        const changed = yield* Chat.advance(Lookup, {
          sessionId: "replay",
          turn: {
            _tag: "Observed",
            batchId: "a",
            messages: [{ id: "x", role: "user", content: "geography" }],
          },
        }).pipe(Effect.result)

        const partial = yield* Chat.advance(Lookup, {
          sessionId: "replay",
          turn: {
            _tag: "Observed",
            batchId: "b",
            messages: [
              { id: "x", role: "user", content: "history" },
              { id: "y", role: "user", content: "now geography" },
            ],
          },
        }).pipe(Effect.result)

        return { changed, partial }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            control,
            inMemoryChatSessionStore,
            Scenario.model(
              Scenario.answers(Details, {
                topic: Scenario.quoted("history", { quote: "history" }),
              }),
              Scenario.call(Search, { topic: "history" }),
            ),
          ),
        ),
      ),
    )

    expect(result.changed).toMatchObject({
      _tag: "Failure",
      failure: { reason: "identity_content_mismatch" },
    })
    expect(result.partial).toMatchObject({
      _tag: "Failure",
      failure: { reason: "partial_replay" },
    })
  })

  test.each(["command", "interaction"] as const)(
    "checks %s admission after planning, before mutation",
    async (kind) => {
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const superseded = yield* Ref.make(false)
          const mutations = yield* Ref.make(0)

          const Commit = Tool.command({
            name: "commit",
            description: "Commit",
            input: Schema.Struct({}),
            execute: () => Ref.update(mutations, (count) => count + 1),
          })

          const chat = Chat.define({
            name: "command_test",
            version: 1,
            stages: [
              kind === "command"
                ? Stage.command({
                    name: "commit",
                    instructions: ["Commit"],
                    command: Commit,
                  })
                : Stage.interact({
                    name: "commit",
                    instructions: ["Commit"],
                    tools: [Commit],
                  }),
            ],
          })

          const check = () =>
            Ref.get(superseded).pipe(
              Effect.flatMap((stale) =>
                stale
                  ? Effect.fail(
                      new Chat.TurnSuperseded({ reason: "newer_intent" }),
                    )
                  : Effect.void,
              ),
            )

          const result = yield* Chat.advance(chat, {
            sessionId: kind,
            turn: { _tag: "Submitted", message: "commit" },
          }).pipe(
            Effect.provideService(Chat.TurnControl, {
              check,
              admitCommand: check,
              beforeCommit: check,
            }),
            Effect.provideService(Model.Service, {
              requestTool: () =>
                Ref.set(superseded, true).pipe(
                  Effect.as({ name: "commit", arguments: {} }),
                ),
            }),
            Effect.result,
          )

          const count = yield* Ref.get(mutations)

          return { result, count }
        }).pipe(Effect.provide(inMemoryChatSessionStore)),
      )

      expect(observed.count).toBe(0)
      expect(observed.result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "TurnSuperseded" },
      })
    },
  )

  test("preserves observed batches and replay identity in a composed chat", async () => {
    const chat = Chat.define({
      name: "composed_lookup",
      version: 1,
      input: Schema.Null,
      stages: [
        Details,
        Stage.tools({
          name: "searching",
          instructions: ["Search"],
          tools: [Search],
        }),
      ],
    })

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Chat.start(chat, {
          sessionId: "composed",
          input: null,
        })

        const input: Chat.AdvanceInput = {
          sessionId: "composed",
          expectedRevision: started.revision,
          turn: {
            _tag: "Observed",
            batchId: "a",
            messages: [
              { id: "1", role: "assistant", content: "What topic?" },
              { id: "2", role: "user", content: "history" },
            ],
          },
        }

        const result = yield* Chat.advance(chat, input)
        const replay = yield* Chat.advance(chat, input)

        return { result, replay }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            control,
            inMemoryChatSessionStore,
            Scenario.model(
              Scenario.answers(Details, {
                topic: Scenario.quoted("history", { quote: "history" }),
              }),
              Scenario.call(Search, { topic: "history" }),
            ),
          ),
        ),
      ),
    )

    expect(output.result).toMatchObject({
      _tag: "Applied",
      reply: {
        revision: "2",
        invocation: { id: 0 },
        turn: { state: { invocations: [{ messages: [0, 1] }] } },
      },
    })
    expect(output.replay).toEqual({
      _tag: "AlreadyApplied",
      currentRevision: "2",
    })
  })
})

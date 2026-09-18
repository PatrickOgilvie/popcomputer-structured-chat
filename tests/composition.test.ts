import * as Debug from "../src/debug.js"
import { expect, test } from "bun:test"
import { Predicate, Effect, Layer, Result, Schema } from "effect"
import {
  Answer,
  Chat,
  Message,
  Model,
  Question,
  Session,
  Stage,
  Tool,
} from "../src/index.js"
import {
  Chat as ChatTest,
  inMemoryChatSessionStore,
  Scenario,
} from "../src/testing.js"

test("a standalone chat parses input and returns its declared output", async () => {
  const Input = Schema.Struct({ date: Schema.DateFromString })

  const Finish = Tool.define({
    name: "finish",
    description: "Finish the conversation",
    input: Schema.Struct({}),
    execute: () =>
      Chat.input(Input).pipe(Effect.map(({ date }) => date.toISOString())),
  })

  const chat = Chat.define({
    name: "typed_chat",
    version: 1,
    input: Input,
    output: {
      schema: Schema.String,
      project: ({ result }) => result.serverResult,
    },
    stages: [
      Stage.tools({
        name: "finish",
        instructions: ["Finish"],
        tools: [Finish],
        afterExecution: "complete",
      }),
    ],
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(chat, {
        sessionId: "typed",
        input: { date: new Date("2026-09-01T00:00:00Z") },
      })

      return yield* Chat.turn(chat, {
        sessionId: "typed",
        expectedRevision: started.revision,
        message: "Finish",
      })
    }).pipe(
      Effect.provide(inMemoryChatSessionStore),
      Effect.provide(Scenario.model(Scenario.call(Finish, {}))),
    ),
  )

  expect(result.turn._tag).toBe("Complete")
  expect(result.outcome).toEqual({
    _tag: "Completed",
    output: "2026-09-01T00:00:00.000Z",
  })
})

test("a child returns typed output and the parent resumes its own state", async () => {
  const Finish = Tool.define({
    name: "finish_dispute",
    description: "Finish",
    input: Schema.Struct({}),
    execute: () => Chat.input(Schema.String),
  })

  const Child = Chat.define({
    name: "dispute",
    version: 1,
    input: Schema.String,
    output: {
      schema: Schema.String,
      project: ({ result }) => result.serverResult,
    },
    stages: [
      Stage.tools({
        name: "finish",
        instructions: ["Finish"],
        tools: [Finish],
        afterExecution: "complete",
      }),
    ],
  })

  const Dispute = Chat.branch({
    name: "enter_dispute",
    description: "Handle a dispute",
    chat: Child,
    arguments: Schema.Struct({}),
    input: () => Chat.input(Schema.String),
  })

  const Answer = Tool.define({
    name: "answer",
    description: "Answer",
    input: Schema.Struct({}),
    execute: () => Chat.returned(Dispute),
  })

  const Parent = Chat.define({
    name: "support",
    version: 1,
    input: Schema.String,
    branches: [Dispute],
    stages: [
      Stage.tools({ name: "support", instructions: ["Help"], tools: [Answer] }),
    ],
  })

  const calls = [
    { name: "enter_dispute", arguments: {} },
    { name: "finish_dispute", arguments: {} },
    { name: "continue_chat", arguments: {} },
    { name: "answer", arguments: {} },
  ]

  const model = Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.sync(() => {
        const next = calls.shift()

        if (next === undefined) throw new Error("Unexpected model call")

        return next
      }),
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(Parent, {
        sessionId: "support",
        input: "termination-1",
      })

      const child = yield* Chat.turn(Parent, {
        sessionId: "support",
        expectedRevision: started.revision,
        message: "I dispute this",
      })

      expect(child.turn._tag).toBe("ToolResult")
      expect(child.invocation.chat).toBe("dispute")
      expect(child.turn.state.active).toBe(0)
      expect(child.turn.state.status).toBe("active")

      return yield* Chat.turn(Parent, {
        sessionId: "support",
        expectedRevision: child.revision,
        message: "What happened?",
      })
    }).pipe(Effect.provide(inMemoryChatSessionStore), Effect.provide(model)),
  )

  expect(result.invocation.chat).toBe("support")

  if (Predicate.isTagged(result.turn, "Question"))
    throw new Error("Expected tool result")
  expect(result.turn.result.serverResult).toEqual({
    _tag: "Completed",
    output: "termination-1",
  })
  expect(calls).toHaveLength(0)
})

const call = (name: string) => ({ name, arguments: {} })

const scripted = (
  ...calls: Array<{ readonly name: string; readonly arguments: {} }>
) =>
  Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.sync(() => {
        const next = calls.shift()

        if (next === undefined) throw new Error("Unexpected model call")

        return next
      }),
  })

const DisputeInput = Schema.Struct({ noticeId: Schema.String })

const Resolve = Tool.define({
  name: "resolve_dispute",
  description: "Resolve",
  input: Schema.Struct({}),
  execute: () => Chat.input(DisputeInput),
})

const DisputeChat = Chat.define({
  name: "dispute_flow",
  version: 1,
  input: DisputeInput,
  output: {
    schema: DisputeInput,
    project: ({ result }) => result.serverResult,
  },
  stages: [
    Stage.tools({
      name: "resolve",
      instructions: ["Resolve"],
      tools: [Resolve],
      afterExecution: "complete",
    }),
  ],
})

const OpenDispute = Chat.branch({
  name: "open_dispute",
  description: "Dispute a notice",
  chat: DisputeChat,
  arguments: DisputeInput,
  input: Effect.succeed,
})

const Receipt = Tool.define({
  name: "receipt",
  description: "Confirm receipt",
  input: DisputeInput,
  execute: Effect.succeed,
})

let textRenders = 0

const Notice = Message.define({
  name: "termination_notice",
  input: DisputeInput,
  text: ({ noticeId }) => {
    textRenders += 1

    return `Notice ${noticeId}. Would you like to dispute it?`
  },
  replies: (input) => [
    Message.hint(OpenDispute, input, {
      when: "The user wants to dispute this notice",
    }),
    Message.hint(Receipt, input, { when: "The user acknowledges receipt" }),
  ],
})

const General = Tool.define({
  name: "general",
  description: "General assistance",
  input: Schema.Struct({}),
  execute: () => Effect.succeed("How can I help?"),
})

const Support = Chat.define({
  name: "notice_support",
  version: 1,
  branches: [OpenDispute],
  messages: [Notice],
  stages: [
    Stage.tools({
      name: "support",
      instructions: ["Help"],
      tools: [General, Receipt],
    }),
  ],
})

test("observed assistant speech cannot restore an issued message's reply authority", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(Support, {
        sessionId: "observed-issue",
        input: null,
      })

      const posted = yield* Chat.post(Support, {
        sessionId: "observed-issue",
        expectedRevision: started.revision,
        messageId: "notice-1",
        message: Notice,
        input: { noticeId: "server-id" },
      })

      const store = yield* Session.Store

      const scope = {
        namespace: "",
        sessionId: "observed-issue",
        chat: Support.name,
        version: Support.version,
      }

      const snapshot = yield* Schema.decodeUnknownEffect(
        Session.SnapshotSchema,
      )(yield* store.load(scope))

      const replacement = yield* Schema.decodeUnknownEffect(
        Session.ReplacementSchema,
      )(
        yield* store.replace({
          ...scope,
          expectedRevision: posted.session.revision,
          state: snapshot.state,
          messages: snapshot.messages.map((message) =>
            Session.Message.observed({
              role: message.role,
              content: message.content,
              batchId: "speech",
              id: "notice",
            }),
          ),
        }),
      )

      return yield* Chat.turn(Support, {
        sessionId: scope.sessionId,
        expectedRevision: replacement.revision,
        message: "No thanks",
      }).pipe(Effect.result)
    }).pipe(
      Effect.provide(inMemoryChatSessionStore),
      Effect.provide(scripted(call("continue_chat"), call("general"))),
    ),
  )

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "InvalidConversation", reason: "invalid_state" },
  })
})

for (const selection of ["decline", "branch", "tool"] as const) {
  test(`an issued message routes a ${selection} reply with bound arguments`, async () => {
    const actions =
      selection === "decline"
        ? [call("continue_chat"), call("general")]
        : selection === "branch"
          ? [call("reply_0_0"), call("resolve_dispute")]
          : [call("reply_0_1")]

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Chat.start(Support, {
          sessionId: selection,
          input: null,
        })

        const posted = yield* Chat.post(Support, {
          sessionId: selection,
          expectedRevision: started.revision,
          messageId: "notice-1",
          message: Notice,
          input: { noticeId: "server-id" },
        })

        const renders = textRenders

        const reply = yield* Chat.turn(Support, {
          sessionId: selection,
          expectedRevision: posted.session.revision,
          message:
            selection === "decline"
              ? "No thanks, when is rent due?"
              : selection === "branch"
                ? "Yes, I dispute it"
                : "Received, thanks",
        })

        expect(textRenders).toBe(renders)
        expect(reply.turn.state.issued[0]?.status).toBe("consumed")

        const replay = yield* Chat.post(Support, {
          sessionId: selection,
          expectedRevision: started.revision,
          messageId: "notice-1",
          message: Notice,
          input: { noticeId: "server-id" },
        })

        expect(replay.disposition).toBe("replayed")
        expect(replay.session.revision).toBe(reply.revision)
        expect(textRenders).toBe(renders)

        return reply
      }).pipe(
        Effect.provide(inMemoryChatSessionStore),
        Effect.provide(scripted(...actions)),
      ),
    )

    expect(result.invocation.chat).toBe(
      selection === "branch" ? "dispute_flow" : "notice_support",
    )
    expect(result.turn.state.invocations).toHaveLength(
      selection === "branch" ? 2 : 1,
    )

    if (Predicate.isTagged(result.turn, "Question"))
      throw new Error("Expected tool result")
    expect(result.turn.result.serverResult).toEqual(
      selection === "decline" ? "How can I help?" : { noticeId: "server-id" },
    )
  })
}

test("emitted messages are committed with the turn and included in presentation", async () => {
  const Send = Tool.define({
    name: "send_notice",
    description: "Send notice",
    input: Schema.Struct({}),
    execute: () =>
      Message.emit(Notice, { noticeId: "emitted" }).pipe(Effect.as("sent")),
  })

  const chat = Chat.define({
    name: "emitter",
    version: 1,
    branches: [OpenDispute],
    messages: [Notice],
    stages: [
      Stage.tools({
        name: "send",
        instructions: ["Send"],
        tools: [Send, Receipt],
      }),
    ],
  })

  const response = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(chat, {
        sessionId: "emitted",
        input: null,
      })

      const reply = yield* Chat.turn(chat, {
        sessionId: "emitted",
        expectedRevision: started.revision,
        message: "Send",
      })

      expect(reply.turn.state.issued).toHaveLength(1)
      expect(reply.turn.state.issued[0]?.status).toBe("pending")

      return yield* Effect.succeed(reply).pipe(Chat.present(chat))
    }).pipe(
      Effect.provide(inMemoryChatSessionStore),
      Effect.provide(scripted(call("continue_chat"), call("send_notice"))),
    ),
  )

  expect(response.invocation).toEqual({ id: 0, chat: "emitter", version: 1 })
  expect(response.message.content).toContainEqual({
    type: "text",
    text: "Notice emitted. Would you like to dispute it?",
  })
  expect(JSON.stringify(response)).not.toContain("reply_")
})

for (const operation of ["suspend", "cancel"] as const) {
  test(`a child can ${operation} and return the same request to its parent`, async () => {
    const Work = Tool.define({
      name: "work",
      description: "Work",
      input: Schema.Struct({}),
      execute: () => Effect.succeed("working"),
    })

    const child = Chat.define({
      name: "unfinished",
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
      name: "caller",
      version: 1,
      branches: [Enter],
      stages: [
        Stage.tools({
          name: "parent",
          instructions: ["Help"],
          tools: [General],
        }),
      ],
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Chat.start(parent, {
          sessionId: operation,
          input: null,
        })

        const entered = yield* Chat.turn(parent, {
          sessionId: operation,
          expectedRevision: started.revision,
          message: "Enter",
        })

        expect(entered.turn.state.active).toBe(1)

        const returned = yield* Chat.turn(parent, {
          sessionId: operation,
          expectedRevision: entered.revision,
          message: "Help me with something else",
        })

        expect(returned.invocation.id).toBe(0)
        expect(returned.turn.state.invocations[1]?.status._tag).toBe(
          operation === "suspend" ? "Suspended" : "Cancelled",
        )

        if (operation === "suspend") {
          const resumed = yield* Chat.turn(parent, {
            sessionId: operation,
            expectedRevision: returned.revision,
            message: "Continue the unfinished conversation",
          })

          expect(resumed.invocation.id).toBe(1)
          expect(resumed.turn.state.invocations).toHaveLength(2)
        }
      }).pipe(
        Effect.provide(inMemoryChatSessionStore),
        Effect.provide(
          scripted(
            call("enter"),
            call("work"),
            call(operation === "suspend" ? "return_to_parent" : "cancel_chat"),
            call("continue_chat"),
            call("general"),
            ...(operation === "suspend"
              ? [call("resume_1"), call("work")]
              : []),
          ),
        ),
      ),
    )
  })
}

test("a failed commit leaves emitted messages and hints unissued", async () => {
  const Emit = Tool.define({
    name: "emit",
    description: "Emit",
    input: Schema.Struct({}),
    execute: () => Message.emit(Notice, { noticeId: "rollback" }),
  })

  const chat = Chat.define({
    name: "rollback",
    version: 1,
    branches: [OpenDispute],
    messages: [Notice],
    stages: [
      Stage.tools({
        name: "emit",
        instructions: ["Emit"],
        tools: [Emit, Receipt],
      }),
    ],
  })

  let snapshot: Session.Snapshot | null = null
  let attempts = 0

  const store = Layer.succeed(Session.Store, {
    load: () => Effect.succeed(snapshot),
    replace: (replacement) =>
      Effect.gen(function* () {
        attempts += 1

        if (attempts === 2)
          return yield* new Session.StoreUnavailable({ reason: "write_failed" })
        snapshot = {
          revision: String(attempts),
          state: replacement.state,
          messages: replacement.messages,
        }

        return { revision: snapshot.revision }
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(chat, {
        sessionId: "rollback",
        input: null,
      })

      const failed = yield* Chat.turn(chat, {
        sessionId: "rollback",
        expectedRevision: started.revision,
        message: "Emit",
      }).pipe(Effect.result)

      expect(Result.isFailure(failed)).toBe(true)

      const current = yield* (yield* Session.Store).load({
        namespace: "",
        sessionId: "rollback",
        chat: "rollback",
        version: 1,
      })

      expect(current).toMatchObject({
        revision: "1",
        messages: [],
        state: { issued: [] },
      })

      const retry = yield* Chat.turn(chat, {
        sessionId: "rollback",
        expectedRevision: started.revision,
        message: "Emit",
      })

      expect(retry.turn.state.issued).toHaveLength(1)
    }).pipe(
      Effect.provide(store),
      Effect.provide(
        scripted(
          call("continue_chat"),
          call("emit"),
          call("continue_chat"),
          call("emit"),
        ),
      ),
    ),
  )
})

test("a child command retains its id when the outer session write is retried", async () => {
  const ids: Array<string> = []

  const Command = Tool.command({
    name: "send",
    description: "Send",
    input: Schema.Struct({}),
    execute: (_, { commandId }) =>
      Effect.sync(() => {
        ids.push(commandId)

        return "sent"
      }),
  })

  const child = Chat.define({
    name: "sender",
    version: 1,
    stages: [
      Stage.command({ name: "send", instructions: ["Send"], command: Command }),
    ],
  })

  const Enter = Chat.branch({
    name: "send_chat",
    description: "Send",
    chat: child,
    arguments: Schema.Struct({}),
    input: () => Effect.succeed(null),
  })

  const parent = Chat.define({
    name: "send_parent",
    version: 1,
    branches: [Enter],
    stages: [
      Stage.tools({
        name: "general",
        instructions: ["Help"],
        tools: [General],
      }),
    ],
  })

  let snapshot: Session.Snapshot | null = null

  const store = Layer.succeed(Session.Store, {
    load: () => Effect.succeed(snapshot),
    replace: (replacement) => {
      if (snapshot !== null)
        return Effect.fail(
          new Session.StoreUnavailable({ reason: "write_failed" }),
        )
      snapshot = {
        revision: "1",
        state: replacement.state,
        messages: replacement.messages,
      }

      return Effect.succeed({ revision: "1" })
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(parent, {
        sessionId: "command",
        input: null,
      })

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* Chat.turn(parent, {
          sessionId: "command",
          expectedRevision: started.revision,
          message: "Send",
        }).pipe(Effect.result)

        expect(Result.isFailure(result)).toBe(true)
      }
    }).pipe(
      Effect.provide(store),
      Effect.provide(
        scripted(
          call("send_chat"),
          call("send"),
          call("send_chat"),
          call("send"),
        ),
      ),
    ),
  )
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
})

test("invalid output does not complete or persist a child", async () => {
  const output = {
    schema: Schema.String.check(Schema.isNonEmpty()),
    project: () => "",
  }

  const child = Chat.define({
    name: "bad_output",
    version: 1,
    output,
    stages: [
      Stage.tools({
        name: "finish",
        instructions: ["Finish"],
        tools: [General],
        afterExecution: "complete",
      }),
    ],
  })

  const Enter = Chat.branch({
    name: "enter",
    description: "Enter",
    chat: child,
    arguments: Schema.Struct({}),
    input: () => Effect.succeed(null),
  })

  const parent = Chat.define({
    name: "output_parent",
    version: 1,
    branches: [Enter],
    stages: [
      Stage.tools({
        name: "general",
        instructions: ["Help"],
        tools: [General],
      }),
    ],
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(parent, {
        sessionId: "invalid-output",
        input: null,
      })

      const result = yield* Chat.turn(parent, {
        sessionId: "invalid-output",
        expectedRevision: started.revision,
        message: "Enter",
      }).pipe(Effect.result)

      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: "InvalidConversation",
        reason: "invalid_output",
      })

      const replay = yield* Chat.start(parent, {
        sessionId: "invalid-output",
        input: null,
      })

      expect(replay.revision).toBe(started.revision)
      expect(replay.state.invocations).toHaveLength(1)
    }).pipe(
      Effect.provide(inMemoryChatSessionStore),
      Effect.provide(scripted(call("enter"), call("general"))),
    ),
  )
})

test("nested calls preserve every caller and enforce configured depth", async () => {
  const Middle = Chat.define({
    name: "middle",
    version: 1,
    branches: [OpenDispute],
    stages: [
      Stage.tools({
        name: "general",
        instructions: ["Help"],
        tools: [General],
      }),
    ],
  })

  const Enter = Chat.branch({
    name: "middle",
    description: "Enter middle",
    chat: Middle,
    arguments: Schema.Struct({}),
    input: () => Effect.succeed(null),
  })

  for (const maximumDepth of [2, 3]) {
    const Root = Chat.define({
      name: "nested",
      version: 1,
      limits: { maximumDepth },
      branches: [Enter],
      stages: [
        Stage.tools({
          name: "general",
          instructions: ["Help"],
          tools: [General],
        }),
      ],
    })

    const model = Layer.succeed(Model.Service, {
      requestTool: ({ tools }) =>
        Effect.succeed(
          tools.some((tool) => tool.name === "middle")
            ? call("middle")
            : tools.some((tool) => tool.name === "open_dispute")
              ? { name: "open_dispute", arguments: { noticeId: "nested" } }
              : call("resolve_dispute"),
        ),
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Chat.start(Root, {
          sessionId: `depth-${maximumDepth}`,
          input: null,
        })

        const result = yield* Chat.turn(Root, {
          sessionId: `depth-${maximumDepth}`,
          expectedRevision: started.revision,
          message: "Dispute",
        }).pipe(Effect.result)

        if (maximumDepth === 2)
          expect(Result.isFailure(result) && result.failure).toMatchObject({
            reason: "depth_limit",
          })
        else {
          if (Result.isFailure(result))
            throw new Error("Expected nested completion")
          expect(result.success.turn.state.invocations).toHaveLength(3)
          expect(result.success.turn.state.active).toBe(1)
          expect(result.success.turn.state.invocations[0]?.status).toEqual({
            _tag: "Waiting",
            child: 1,
          })
        }
      }).pipe(Effect.provide(inMemoryChatSessionStore), Effect.provide(model)),
    )
  }
})

test("root explorations read root input while a child is active", async () => {
  const Read = Tool.define({
    name: "read_root",
    description: "Read input",
    input: Schema.Struct({}),
    execute: () => Chat.input(Schema.String),
  })

  const Work = Chat.define({
    name: "work_child",
    version: 1,
    stages: [
      Stage.tools({ name: "work", instructions: ["Help"], tools: [General] }),
    ],
  })

  const Enter = Chat.branch({
    name: "enter",
    description: "Enter",
    chat: Work,
    arguments: Schema.Struct({}),
    input: () => Effect.succeed(null),
  })

  const Root = Chat.define({
    name: "exploring",
    version: 1,
    input: Schema.String,
    branches: [Enter],
    explorations: [Read],
    stages: [
      Stage.tools({ name: "work", instructions: ["Help"], tools: [General] }),
    ],
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(Root, {
        sessionId: "explore",
        input: "root-input",
      })

      yield* Chat.turn(Root, {
        sessionId: "explore",
        expectedRevision: started.revision,
        message: "Enter",
      })

      const explored = yield* Chat.explore(Root, {
        sessionId: "explore",
        call: Tool.makeCall(Read, {}),
      })

      expect(explored.execution.serverResult).toBe("root-input")
    }).pipe(
      Effect.provide(inMemoryChatSessionStore),
      Effect.provide(scripted(call("enter"), call("general"))),
    ),
  )
})

test("parent and child answers with the same field names stay invocation-local", async () => {
  const Brief = Stage.collect({
    name: "brief",
    fields: {
      amount: Answer.explicit(Schema.Number, {
        description: "Amount",
        ask: Question.fixed("Amount?"),
      }),
    },
  })

  const Read = Tool.define({
    name: "read_amount",
    description: "Read amount",
    input: Schema.Struct({}),
    execute: () =>
      Tool.acceptedAnswer({
        stage: "brief",
        field: "amount",
        schema: Schema.Number,
      }),
  })

  const Child = Chat.define({
    name: "amount_child",
    version: 1,
    stages: [
      Brief,
      Stage.tools({
        name: "read",
        instructions: ["Read"],
        tools: [Read],
        afterExecution: "complete",
      }),
    ],
  })

  const Enter = Chat.branch({
    name: "child",
    description: "Start child",
    chat: Child,
    arguments: Schema.Struct({}),
    input: () => Effect.succeed(null),
  })

  const Parent = Chat.define({
    name: "amount_parent",
    version: 1,
    branches: [Enter],
    stages: [
      Brief,
      Stage.tools({ name: "read", instructions: ["Read"], tools: [Read] }),
    ],
  })

  const actions = [
    call("continue_chat"),
    {
      name: "submit_answers",
      arguments: {
        answers: { amount: 100 },
        evidence: [{ field: "amount", quote: "100" }],
        nextQuestion: null,
      },
    },
    call("read_amount"),
    call("child"),
    {
      name: "submit_answers",
      arguments: {
        answers: { amount: 200 },
        evidence: [{ field: "amount", quote: "200" }],
        nextQuestion: null,
      },
    },
    call("read_amount"),
    call("continue_chat"),
    call("read_amount"),
  ]

  let step = 0

  const model = Layer.succeed(Model.Service, {
    requestTool: (request) =>
      Effect.sync(() => {
        if (step === 4) {
          const plan = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
            accepted: Schema.Record(Schema.String, Schema.Unknown),
            conversation: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
          })))(request.untrustedMessages[0]?.content)
          expect(plan.accepted).toEqual({})
          expect(plan.conversation).toEqual([{ role: "user", content: "Start the child with 200" }])
        }
        const next = actions[step++]

        if (next === undefined) throw new Error("Unexpected model call")

        return next
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(Parent, {
        sessionId: "answers",
        input: null,
      })

      const first = yield* Chat.turn(Parent, {
        sessionId: "answers",
        expectedRevision: started.revision,
        message: "My amount is 100",
      })

      const child = yield* Chat.turn(Parent, {
        sessionId: "answers",
        expectedRevision: first.revision,
        message: "Start the child with 200",
      })

      const parent = yield* Chat.turn(Parent, {
        sessionId: "answers",
        expectedRevision: child.revision,
        message: "Read my original amount",
      })

      if (
        Predicate.isTagged(child.turn, "Question") ||
        Predicate.isTagged(parent.turn, "Question")
      )
        throw new Error("Expected results")
      expect(child.turn.result.serverResult).toBe(200)
      expect(parent.turn.result.serverResult).toBe(100)
    }).pipe(Effect.provide(inMemoryChatSessionStore), Effect.provide(model)),
  )
})

test("debug capture and presentation inspect the child that produced a reply", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(Support, {
        sessionId: "debug-child",
        input: null,
      })

      const posted = yield* Chat.post(Support, {
        sessionId: "debug-child",
        expectedRevision: started.revision,
        messageId: "notice",
        message: Notice,
        input: { noticeId: "debug" },
      })

      const outcome = yield* Debug.turn(
        Support,
        {
          sessionId: "debug-child",
          expectedRevision: posted.session.revision,
          message: "Dispute",
        },
        { modelPayloads: "literal" },
      )

      return yield* Debug.present(Support, outcome, {
        presentation: { result: () => [Chat.Text.make("Dispute complete")] },
      })
    }).pipe(
      Effect.provide(inMemoryChatSessionStore),
      Effect.provide(scripted(call("reply_0_0"), call("resolve_dispute"))),
    ),
  )

  expect(result.outcome).toBe("success")

  if (result.outcome === "failure") throw new Error("Expected success")
  expect(result.invocation?.chat).toBe("dispute_flow")
  expect(result.debug.chat.name).toBe("dispute_flow")
})

test("persisted invocation graphs and issued identities are strictly checked", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(Support, {
        sessionId: "state",
        input: null,
      })

      const store = yield* Session.Store

      const raw = yield* store.load({
        namespace: "",
        sessionId: "state",
        chat: "notice_support",
        version: 1,
      })

      const snapshot = yield* Schema.decodeUnknownEffect(
        Session.SnapshotSchema,
      )(raw)

      const parsed = yield* ChatTest.parseConversationState(
        Support,
        snapshot.state,
        snapshot.messages,
      )

      expect(parsed).toEqual(started.state)

      for (const invalid of [
        { ...parsed, active: 7 },
        {
          ...parsed,
          invocations: [
            {
              ...parsed.invocations[0],
              parent: { invocation: 0, branch: "open_dispute" },
            },
          ],
        },
        {
          ...parsed,
          invocations: [{ ...parsed.invocations[0], messages: [999] }],
        },
        {
          ...parsed,
          issued: [
            {
              id: "unissued",
              invocation: 0,
              definition: "termination_notice",
              input: { noticeId: "bad" },
              messageIndex: 0,
              status: "pending",
            },
          ],
        },
      ]) {
        const result = yield* ChatTest.parseConversationState(
          Support,
          invalid,
          snapshot.messages,
        ).pipe(Effect.result)

        expect(Result.isFailure(result) && result.failure).toMatchObject({
          _tag: "InvalidConversation",
          reason: "invalid_state",
        })
      }
    }).pipe(Effect.provide(inMemoryChatSessionStore)),
  )
})

test("a message emitted after collection can hint a tool in the newly active stage", async () => {
  const Brief = Stage.collect({
    name: "brief",
    fields: {
      amount: Answer.explicit(Schema.Number, {
        description: "Amount",
        ask: Question.fixed("Amount?"),
      }),
    },
  })

  const Follow = Tool.define({
    name: "follow",
    description: "Follow up",
    input: Schema.Struct({ amount: Schema.Number }),
    execute: Effect.succeed,
  })

  const Offer = Message.define({
    name: "offer",
    input: Schema.Number,
    text: (amount) => `Continue with ${amount}?`,
    replies: (amount) => [
      Message.hint(Follow, { amount }, { when: "The user agrees to continue" }),
    ],
  })

  const Emit = Tool.define({
    name: "offer",
    description: "Offer a follow-up",
    input: Schema.Struct({}),
    execute: () =>
      Tool.acceptedAnswer({
        stage: "brief",
        field: "amount",
        schema: Schema.Number,
      }).pipe(Effect.flatMap((amount) => Message.emit(Offer, amount))),
  })

  const chat = Chat.define({
    name: "collect_then_emit",
    version: 1,
    messages: [Offer],
    stages: [
      Brief,
      Stage.tools({
        name: "follow",
        instructions: ["Offer"],
        tools: [Emit, Follow],
      }),
    ],
  })

  const actions = [
    {
      name: "submit_answers",
      arguments: {
        answers: { amount: 100 },
        evidence: [{ field: "amount", quote: "100" }],
        nextQuestion: null,
      },
    },
    call("offer"),
    call("reply_1_0"),
  ]

  const model = Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.sync(() => {
        const next = actions.shift()

        if (next === undefined) throw new Error("Unexpected model call")

        return next
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Chat.start(chat, {
        sessionId: "collected-emission",
        input: null,
      })

      const offered = yield* Chat.turn(chat, {
        sessionId: "collected-emission",
        expectedRevision: started.revision,
        message: "100",
      })

      const followed = yield* Chat.turn(chat, {
        sessionId: "collected-emission",
        expectedRevision: offered.revision,
        message: "Yes",
      })

      if (Predicate.isTagged(followed.turn, "Question"))
        throw new Error("Expected tool result")
      expect(followed.turn.result.serverResult).toEqual({ amount: 100 })
    }).pipe(Effect.provide(inMemoryChatSessionStore), Effect.provide(model)),
  )
})

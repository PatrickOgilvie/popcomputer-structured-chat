import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Result, Schema } from "effect"
import {
  Answer,
  Chat,
  Model,
  Message,
  Question,
  Repair,
  Stage,
  Tool,
} from "../src/index.js"
import { inMemoryChatSessionStore } from "../src/testing.js"
import * as OpenAI from "../src/model/openai-compatible.js"
import type { JsonValue } from "../src/core/json-value.js"
import { presentChatReply } from "../src/core/protocol.js"
import { captureDebugEvents } from "../src/core/debug-trace.js"
import { present as presentLive } from "../src/live/action.js"

const search = Tool.define({
  name: "search",
  description: "Search agencies.",
  input: Schema.Struct({ query: Schema.String }),
  execute: (input) => Effect.succeed(input),
})
const tools = [search] as const
const noModel = Layer.succeed(
  Model.Service,
  Model.Service.of({
    requestTool: () => Effect.die(new Error("Unexpected model request")),
  }),
)

const recordingModel = (...responses: ReadonlyArray<JsonValue>) => {
  const requests: Array<Model.ToolRequest> = []
  return {
    requests,
    layer: Layer.succeed(
      Model.Service,
      Model.Service.of({
        requestTool: (request) =>
          Effect.suspend(() => {
            const response = responses[requests.length]
            requests.push(request)
            return response === undefined
              ? Effect.die(new Error("Unexpected model request"))
              : Effect.succeed(response)
          }),
      }),
    ),
  }
}
const selected = Stage.toolSelector(tools, () =>
  Effect.succeed({
    _tag: "Selected",
    target: { _tag: "Tool", name: "search" },
  }),
)
const base = {
  name: "search",
  tools,
  instructions: ["Find agencies."] as const,
}

describe("tool selection", () => {
  test("explicit reply hints retain their application-bound call and guards", async () => {
    const offer = Message.define({
      name: "offer",
      input: Schema.String,
      text: (query) => `Search for ${query}?`,
      replies: (query) => [
        Message.hint(
          search,
          { query },
          { when: "The user accepts the search" },
        ),
      ],
    })
    const emit = Tool.define({
      name: "offer_search",
      description: "Offer a search",
      input: Schema.Struct({}),
      execute: () => Message.emit(offer, "specific offer"),
    })
    const registry = [emit, search] as const
    const guarded: Array<string> = []
    const stage = Stage.tools({
      ...base,
      tools: registry,
      selection: Stage.toolSelector(registry, () =>
        Effect.succeed({
          _tag: "Selected",
          target: { _tag: "Tool", name: "offer_search" },
        }),
      ),
      inputs: Stage.toolInputs(registry, {
        offer_search: () => Effect.succeed({}),
        search: () =>
          Effect.die(new Error("Reply hints already own their arguments")),
      }),
      guards: [
        Model.guard({
          name: "record",
          check: () => Effect.void,
          checkCall: (context) =>
            Effect.sync(() => {
              guarded.push(context.call.name)
            }),
        }),
      ],
    })
    const chat = Chat.define({
      name: "hint_selection",
      version: 1,
      stages: [stage],
      messages: [offer],
    })
    const model = recordingModel({ name: "reply_1_0", arguments: {} })
    await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* Chat.start(chat, {
          sessionId: "hint-selection",
          input: null,
        })
        const first = yield* Chat.turn(chat, {
          sessionId: "hint-selection",
          expectedRevision: start.revision,
          message: "Offer a search",
        })
        const second = yield* Chat.turn(chat, {
          sessionId: "hint-selection",
          expectedRevision: first.revision,
          message: "Yes",
        })
        expect(second.turn).toMatchObject({
          _tag: "ToolResult",
          result: { serverResult: { query: "specific offer" } },
        })
      }).pipe(
        Effect.provide(Layer.merge(model.layer, inMemoryChatSessionStore)),
      ),
    )
    expect(guarded).toContain("search")
    expect(model.requests).toHaveLength(1)
  })
  test("executes application-bound input without a model request", async () => {
    const stage = Stage.tools({
      name: "search",
      instructions: ["Find agencies."],
      tools,
      selection: Stage.toolSelector(tools, () =>
        Effect.succeed({
          _tag: "Selected",
          target: { _tag: "Tool", name: "search" },
        }),
      ),
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: "branding" }),
      }),
    })
    const result = await Effect.runPromise(
      stage.run([]).pipe(Effect.provide(noModel)),
    )
    expect(result).toMatchObject({
      _tag: "Executed",
      execution: { serverResult: { query: "branding" } },
    })
  })

  test("clarifies a no-match without execution or a model call", async () => {
    const stage = Stage.tools({
      name: "search",
      instructions: ["Find agencies."],
      tools,
      selection: Stage.toolSelector(tools, () =>
        Effect.succeed({ _tag: "NoMatch" }),
      ),
      clarification: Question.fixed("What would you like to find?"),
    })
    expect(
      await Effect.runPromise(stage.run([]).pipe(Effect.provide(noModel))),
    ).toEqual({
      _tag: "Clarification",
      text: "What would you like to find?",
    })
  })

  test("rejects a selector's forged action before any model request", async () => {
    // SAFETY: test deliberately forges a foreign target at the public capability boundary.
    const foreign = "foreign" as never
    const stage = Stage.tools({
      ...base,
      selection: Stage.toolSelector(tools, () =>
        Effect.succeed({
          // SAFETY: deliberate boundary violation, checked by the selection parser.
          _tag: "Selected",
          target: { _tag: "Tool", name: foreign },
        }),
      ),
    })
    const result = await Effect.runPromise(
      Effect.result(stage.run([])).pipe(Effect.provide(noModel)),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidToolSelection", reason: "target_not_offered" },
    })
  })

  test("a selected tool receives only its schema and the clarification control", async () => {
    const other = Tool.define({
      name: "other",
      description: "Other work",
      input: Schema.Struct({}),
      execute: () => Effect.succeed("other"),
    })
    const registry = [search, other] as const
    const model = recordingModel({
      name: "search",
      arguments: { query: "branding" },
    })
    const stage = Stage.tools({
      ...base,
      tools: registry,
      selection: Stage.toolSelector(registry, () =>
        Effect.succeed({
          _tag: "Selected",
          target: { _tag: "Tool", name: "search" },
        }),
      ),
    })
    const result = await Effect.runPromise(
      stage
        .run([{ role: "user", content: "Find branding help" }])
        .pipe(Effect.provide(model.layer)),
    )
    expect(result).toMatchObject({
      _tag: "Executed",
      execution: { serverResult: { query: "branding" } },
    })
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "request_tool_clarification",
      "search",
    ])
    expect(model.requests[0]?.untrustedMessages[0]?.content).toBe(
      "Find branding help",
    )
    expect(model.requests[0]?.untrustedMessages.at(-1)?.content).toContain(
      '"selection":{"_tag":"Selected"',
    )
  })

  test("fallback offers every action and binds the selected tool once", async () => {
    let bindings = 0
    const other = Tool.define({
      name: "other",
      description: "Other work",
      input: Schema.Struct({}),
      execute: () => Effect.succeed("other"),
    })
    const registry = [search, other] as const
    const model = recordingModel({ name: "search", arguments: {} })
    const stage = Stage.tools({
      ...base,
      tools: registry,
      selection: Stage.toolSelector(registry, () =>
        Effect.succeed({ _tag: "Uncertain" }),
      ),
      inputs: Stage.toolInputs(registry, {
        search: () =>
          Effect.sync(() => {
            bindings++
            return { query: "accepted brief" }
          }),
        other: () => Effect.die(new Error("Wrong resolver")),
      }),
    })
    const result = await Effect.runPromise(
      stage.run([]).pipe(Effect.provide(model.layer)),
    )
    expect(result).toMatchObject({
      _tag: "Executed",
      execution: { serverResult: { query: "accepted brief" } },
    })
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "request_tool_clarification",
      "search",
      "other",
    ])
    expect(bindings).toBe(1)
  })

  test("the model cannot replace application-bound arguments", async () => {
    let bindings = 0
    const model = recordingModel(
      { name: "search", arguments: { query: "injected" } },
      { name: "search", arguments: {} },
    )
    const stage = Stage.tools({
      ...base,
      selection: Stage.toolSelector(tools, () =>
        Effect.succeed({ _tag: "Uncertain" }),
      ),
      inputs: Stage.toolInputs(tools, {
        search: () =>
          Effect.sync(() => {
            bindings++
            return { query: "server" }
          }),
      }),
    })
    expect(
      await Effect.runPromise(stage.run([]).pipe(Effect.provide(model.layer))),
    ).toMatchObject({ execution: { serverResult: { query: "server" } } })
    expect(bindings).toBe(1)
    expect(model.requests).toHaveLength(2)
  })

  test("two invalid proposals clarify without executing", async () => {
    const model = recordingModel(
      { name: "foreign", arguments: {} },
      { name: "search", arguments: { query: 42 } },
    )
    const stage = Stage.tools({
      ...base,
      selection: selected,
      clarification: Question.fixed("What should I search for?"),
    })
    expect(
      await Effect.runPromise(stage.run([]).pipe(Effect.provide(model.layer))),
    ).toEqual({ _tag: "Clarification", text: "What should I search for?" })
    expect(model.requests).toHaveLength(2)
  })

  test("a model can ask for missing arguments in the existing request", async () => {
    const model = recordingModel({
      name: "request_tool_clarification",
      arguments: { text: "Which agency should I compare?" },
    })
    expect(
      await Effect.runPromise(
        Stage.tools({ ...base, selection: selected })
          .run([])
          .pipe(Effect.provide(model.layer)),
      ),
    ).toEqual({ _tag: "Clarification", text: "Which agency should I compare?" })
    expect(model.requests).toHaveLength(1)
  })

  test.each([
    { path: "selected", selection: selected },
    {
      path: "uncertain",
      selection: Stage.toolSelector(tools, () =>
        Effect.succeed({ _tag: "Uncertain" }),
      ),
    },
    {
      path: "provider unavailable",
      selection: Stage.toolSelector(tools, () =>
        Effect.succeed({
          _tag: "NotApplicable",
          reason: "provider_unavailable",
        }),
      ),
    },
  ])("strict OpenAI planning supports clarification: $path", async ({ selection }) => {
    const requests: Array<OpenAI.ProviderRequest> = []
    const layer = OpenAI.layer({
      timeoutMilliseconds: 1_000,
      provider: OpenAI.Provider.openAI({
        model: "gpt-5.6-luna",
        complete: (request) => {
          requests.push(request)
          return Promise.resolve({
            choices: [{
              message: {
                tool_calls: [{
                  function: {
                    name: "request_tool_clarification",
                    arguments: JSON.stringify({ text: "Which agency?" }),
                  },
                }],
              },
            }],
          })
        },
      }),
    })
    expect(
      await Effect.runPromise(
        Stage.tools({ ...base, selection }).run([]).pipe(Effect.provide(layer)),
      ),
    ).toEqual({ _tag: "Clarification", text: "Which agency?" })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        function: expect.objectContaining({
          name: "request_tool_clarification",
          strict: true,
          parameters: expect.objectContaining({
            type: "object",
            required: ["text"],
            additionalProperties: false,
          }),
        }),
      }),
    ]))
    expect(JSON.stringify(requests[0]?.input.tools)).not.toContain('"allOf"')
  })

  test.each([
    { label: "empty", text: "" },
    { label: "whitespace only", text: " " },
    { label: "leading whitespace", text: " leading" },
    { label: "trailing whitespace", text: "trailing " },
    { label: "over 500 characters", text: "x".repeat(501) },
  ])(
    "invalid clarification wording still exhausts the bounded retry: $label",
    async ({ text }) => {
      const proposal = { name: "request_tool_clarification", arguments: { text } }
      const model = recordingModel(proposal, proposal)
      const stage = Stage.tools({
        ...base,
        selection: selected,
        clarification: Question.adaptive("Ask for an agency.", {
          fallback: "Which agency?",
        }),
      })
      expect(
        await Effect.runPromise(stage.run([]).pipe(Effect.provide(model.layer))),
      ).toEqual({ _tag: "Clarification", text: "Which agency?" })
      expect(model.requests).toHaveLength(2)
    },
  )

  test.each([
    { label: "one character", text: "x" },
    { label: "500 characters", text: "x".repeat(500) },
    { label: "multiple lines", text: "Which agency?\nPlease name one." },
  ])(
    "valid clarification wording is retained: $label",
    async ({ text }) => {
      const model = recordingModel({
        name: "request_tool_clarification",
        arguments: { text },
      })
      expect(
        await Effect.runPromise(
          Stage.tools({ ...base, selection: selected })
            .run([])
            .pipe(Effect.provide(model.layer)),
        ),
      ).toEqual({ _tag: "Clarification", text })
      expect(model.requests).toHaveLength(1)
    },
  )

  test("pre-planning guards prevent classification", async () => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
    const stage = Stage.tools({
      ...base,
      selection: Stage.toolSelector(tools, () =>
        Effect.die(new Error("Selector must not run")),
      ),
      guards: [
        Model.guard({ name: "deny", check: () => Effect.fail(new Denied()) }),
      ],
    })
    expect(
      await Effect.runPromise(
        Effect.result(stage.run([])).pipe(Effect.provide(noModel)),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "Denied" } })
  })

  test("call guards inspect bound decoded arguments exactly once", async () => {
    const seen: Array<unknown> = []
    const stage = Stage.tools({
      ...base,
      selection: selected,
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: "server" }),
      }),
      guards: [
        Model.guard({
          name: "observe",
          check: () => Effect.void,
          checkCall: (context) =>
            Effect.sync(() => {
              seen.push(context.call)
            }),
        }),
      ],
    })
    await Effect.runPromise(stage.run([]).pipe(Effect.provide(noModel)))
    expect(seen).toEqual([{ name: "search", arguments: { query: "server" } }])
  })

  test("invalid bound input fails instead of letting the model replace it", async () => {
    // SAFETY: deliberate malformed resolver output tests its codec boundary.
    const invalid = 12 as never
    const stage = Stage.tools({
      ...base,
      selection: selected,
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: invalid }),
      }),
    })
    expect(
      await Effect.runPromise(
        Effect.result(stage.run([])).pipe(Effect.provide(noModel)),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "InvalidToolInput" } })
  })

  test("binding codecs retain decoded Date inputs", async () => {
    const since = new Date("2026-09-19T12:00:00Z")
    const dated = Tool.define({
      name: "dated",
      description: "Search since a date",
      input: Schema.Struct({ since: Schema.DateFromString }),
      execute: (input) => Effect.succeed(input.since.getTime()),
    })
    const registry = [dated] as const
    const stage = Stage.tools({
      ...base,
      tools: registry,
      selection: Stage.toolSelector(registry, () =>
        Effect.succeed({
          _tag: "Selected",
          target: { _tag: "Tool", name: "dated" },
        }),
      ),
      inputs: Stage.toolInputs(registry, {
        dated: () => Effect.succeed({ since }),
      }),
    })
    expect(
      await Effect.runPromise(stage.run([]).pipe(Effect.provide(noModel))),
    ).toMatchObject({ execution: { serverResult: since.getTime() } })
  })

  test("persisted clarification renders without completing the stage", async () => {
    const stage = Stage.tools({
      ...base,
      afterExecution: "complete",
      selection: Stage.toolSelector(tools, (context) =>
        Effect.succeed(
          context.messages.at(-1)?.content === "branding"
            ? { _tag: "Selected", target: { _tag: "Tool", name: "search" } }
            : { _tag: "NoMatch" },
        ),
      ),
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: "branding" }),
      }),
      clarification: Question.fixed("What should I search for?"),
    })
    const chat = Chat.define({
      name: "clarifying_tools",
      version: 1,
      stages: [stage],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Chat.turn(chat, {
          sessionId: "clarify-tools",
          message: "Hello",
        })
        expect(first.turn._tag).toBe("Clarification")
        expect(first.turn.state.status).toBe("active")
        const presented = yield* presentChatReply(first)
        expect(JSON.stringify(presented)).toContain("What should I search for?")
        expect((yield* presentLive(first)).speech).toBe(
          "What should I search for?",
        )
        const second = yield* Chat.turn(chat, {
          sessionId: "clarify-tools",
          expectedRevision: first.revision,
          message: "branding",
        })
        expect(second.turn._tag).toBe("Complete")
        const stale = yield* Effect.result(
          Chat.turn(chat, {
            sessionId: "clarify-tools",
            expectedRevision: first.revision,
            message: "branding",
          }),
        )
        expect(Result.isFailure(stale)).toBe(true)
      }).pipe(Effect.provide(Layer.merge(noModel, inMemoryChatSessionStore))),
    )
  })

  test("stage entry and repair expose accepted context without losing the repair route", async () => {
    const contexts: Array<Stage.ToolSelectionContext> = []
    const brief = Stage.collect({
      name: "brief",
      fields: {
        need: Answer.explicit(Schema.String, {
          description: "Work needed",
          ask: Question.fixed("What work?"),
        }),
      },
    })
    const stage = Stage.tools({
      ...base,
      selection: Stage.toolSelector(tools, (context) => {
        contexts.push(context)
        return Effect.succeed(
          context.trigger === "user_reply"
            ? { _tag: "Selected", target: { _tag: "Repair" } }
            : { _tag: "Selected", target: { _tag: "Tool", name: "search" } },
        )
      }),
      inputs: Stage.toolInputs(tools, {
        search: () =>
          Tool.acceptedAnswer({
            stage: "brief",
            field: "need",
            schema: Schema.String,
          }).pipe(Effect.map((query) => ({ query }))),
      }),
    })
    const chat = Chat.define({
      name: "selected_repair",
      version: 1,
      stages: [brief, stage],
      repair: Repair.standard(),
    })
    const model = recordingModel(
      {
        name: "submit_answers",
        arguments: {
          answers: { need: "branding" },
          evidence: [{ field: "need", quote: "branding" }],
        },
      },
      {
        name: "apply_conversation_repairs",
        arguments: {
          corrections: [
            {
              _tag: "ReplaceAcceptedAnswer",
              stage: "brief",
              field: "need",
              value: "websites",
              evidence: { quote: "websites" },
            },
          ],
        },
      },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Chat.turn(chat, {
          sessionId: "selected-repair",
          message: "branding",
        })
        expect(first.turn).toMatchObject({
          _tag: "ToolResult",
          result: { serverResult: { query: "branding" } },
        })
        const second = yield* Chat.turn(chat, {
          sessionId: "selected-repair",
          expectedRevision: first.revision,
          message: "Actually websites",
        })
        expect(second.turn).toMatchObject({
          _tag: "ToolResult",
          result: { serverResult: { query: "websites" } },
        })
      }).pipe(
        Effect.provide(Layer.merge(model.layer, inMemoryChatSessionStore)),
      ),
    )
    expect(contexts.map((context) => context.trigger)).toEqual([
      "stage_entered",
      "user_reply",
      "after_repair",
    ])
    expect(contexts[0]?.accepted[0]?.value).toBe("branding")
    expect(
      contexts[1]?.candidates.some(
        (candidate) => candidate.target._tag === "Repair",
      ),
    ).toBe(true)
    expect(
      contexts[2]?.candidates.some(
        (candidate) => candidate.target._tag === "Repair",
      ),
    ).toBe(false)
    expect(model.requests).toHaveLength(2)
  })

  test("debug capture records selection and argument ownership", async () => {
    const stage = Stage.tools({
      ...base,
      selection: selected,
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: "brand" }),
      }),
    })
    const captured = await Effect.runPromise(
      captureDebugEvents(stage.run([])).pipe(Effect.provide(noModel)),
    )
    expect(captured.events.map((event) => event._tag)).toContain(
      "ToolSelectionAssessed",
    )
    expect(captured.events).toContainEqual(
      expect.objectContaining({
        _tag: "ToolArgumentsResolved",
        source: "application",
      }),
    )
    expect(Result.isSuccess(captured.result)).toBe(true)
  })

  test.each(["selector", "binding"] as const)(
    "interrupting the %s stops the turn without fallback",
    async (phase) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const wait = Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          )
          const stage = Stage.tools({
            ...base,
            selection:
              phase === "selector"
                ? Stage.toolSelector(tools, () => wait)
                : selected,
            inputs: Stage.toolInputs(tools, {
              search: () =>
                phase === "binding" ? wait : Effect.succeed({ query: "brand" }),
            }),
          })
          const fiber = yield* stage.run([]).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
        }).pipe(Effect.provide(noModel)),
      )
    },
  )

  test("call guard denial is a failure, never a clarification or execution", async () => {
    class Denied extends Schema.TaggedError<Denied>()("ToolDenied", {}) {}
    const stage = Stage.tools({
      ...base,
      selection: selected,
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: "brand" }),
      }),
      guards: [
        Model.guard({
          name: "deny_call",
          check: () => Effect.void,
          checkCall: () => Effect.fail(new Denied()),
        }),
      ],
    })
    expect(
      await Effect.runPromise(
        Effect.result(stage.run([])).pipe(Effect.provide(noModel)),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolDenied" } })
  })

  test("ordinary child routing preserves selection and clarification", async () => {
    const stage = Stage.tools({
      ...base,
      afterExecution: "complete",
      selection: Stage.toolSelector(tools, (context) =>
        Effect.succeed(
          context.messages.at(-1)?.content === "branding"
            ? { _tag: "Selected", target: { _tag: "Tool", name: "search" } }
            : { _tag: "NoMatch" },
        ),
      ),
      inputs: Stage.toolInputs(tools, {
        search: () => Effect.succeed({ query: "application" }),
      }),
    })
    const child = Chat.define({ name: "child", version: 1, stages: [stage] })
    const enter = Chat.branch({
      name: "enter",
      description: "Enter search",
      chat: child,
      arguments: Schema.Struct({}),
      input: () => Effect.succeed(null),
    })
    const parent = Chat.define({
      name: "parent",
      version: 1,
      branches: [enter],
      stages: [Stage.tools(base)],
    })
    const model = recordingModel(
      { name: "enter", arguments: {} },
      { name: "continue_chat", arguments: {} },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Chat.start(parent, {
          sessionId: "nested-selection",
          input: null,
        })
        const first = yield* Chat.turn(parent, {
          sessionId: "nested-selection",
          expectedRevision: started.revision,
          message: "Enter",
        })
        expect(first.turn._tag).toBe("Clarification")
        expect(first.turn.state.active).toBe(1)
        expect(first.outcome).toBeUndefined()
        const second = yield* Chat.turn(parent, {
          sessionId: "nested-selection",
          expectedRevision: first.revision,
          message: "branding",
        })
        expect(second.turn).toMatchObject({
          _tag: "ToolResult",
          result: { serverResult: { query: "application" } },
        })
        expect(second.turn.state.active).toBe(0)
      }).pipe(
        Effect.provide(Layer.merge(model.layer, inMemoryChatSessionStore)),
      ),
    )
    expect(
      model.requests[1]?.tools.some((tool) => tool.name === "search"),
    ).toBe(false)
  })
})

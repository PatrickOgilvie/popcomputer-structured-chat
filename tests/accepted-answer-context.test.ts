import {
  Answer,
  Chat,
  Model,
  Question,
  Repair,
  Stage,
  Tool,
} from "../src/index.js"
import { inMemoryChatSessionStore, Scenario } from "../src/testing.js"
import { expect, test } from "bun:test"
import { Predicate, Effect, Layer, Result, Schema } from "effect"

test("queries receive the accepted value from collection in the same turn", async () => {
  const Budget = Stage.collect({
    name: "requirements",
    fields: {
      budget: Answer.explicit(Schema.Number, {
        description: "Budget",
        ask: Question.fixed("Budget?"),
      }),
    },
  })

  const Search = Tool.define({
    name: "search",
    description: "Use the accepted budget",
    input: Schema.Struct({}),
    execute: () =>
      Tool.acceptedAnswer({
        stage: "requirements",
        field: "budget",
        schema: Schema.Number,
      }).pipe(Effect.map((budget) => ({ budget }))),
  })

  const chat = Chat.define({
    name: "bound_search",
    version: 1,
    stages: [
      Budget,
      Stage.tools({
        name: "results",
        instructions: ["Search"],
        tools: [Search],
      }),
    ],
    explorations: [Search],
  })

  let call = 0

  const model = Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.sync(() =>
        ++call === 1
          ? {
              name: "submit_answers",
              arguments: {
                answers: { budget: 500 },
                evidence: [{ field: "budget", quote: "500" }],
                nextQuestion: null,
              },
            }
          : { name: "search", arguments: {} },
      ),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const reply = yield* Chat.turn(chat, {
        sessionId: "budget",
        message: "My budget is 500",
      })

      if (Predicate.isTagged(reply.turn, "Question"))
        throw new Error("Expected query result")
      expect(reply.turn.result.serverResult).toEqual({ budget: 500 })

      const explored = yield* Chat.explore(chat, {
        sessionId: "budget",
        call: { name: "search", arguments: {} },
      })

      expect(explored.execution.serverResult).toEqual({ budget: 500 })
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )
})

test("transformed answer schemas can be reused before and after persistence", async () => {
  const Brief = Stage.collect({
    name: "brief",
    fields: {
      launch: Answer.semantic(Schema.DateFromString, {
        description: "Launch date",
        ask: Question.fixed("When is launch?"),
      }),
    },
  })

  const Search = Tool.define({
    name: "search",
    description: "Use the accepted launch date",
    input: Schema.Struct({}),
    execute: () =>
      Tool.acceptedAnswer({
        stage: Brief.name,
        field: "launch",
        schema: Brief.fields.launch.schema,
      }).pipe(Effect.map((launch) => ({ launch: launch.toISOString() }))),
  })

  const chat = Chat.define({
    name: "launch_search",
    version: 1,
    stages: [
      Brief,
      Stage.tools({
        name: "results",
        instructions: ["Search"],
        tools: [Search],
      }),
    ],
    explorations: [Search],
  })

  const launch = "2026-09-30T00:00:00.000Z"

  const model = Scenario.model(
    Scenario.answers(Brief, {
      launch: Scenario.quoted(new Date(launch), { quote: "September 30" }),
    }),
    Scenario.call(Search, {}),
    Scenario.call(Search, {}),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Chat.turn(chat, {
        sessionId: "launch",
        message: "Launch September 30",
      })

      if (Predicate.isTagged(first.turn, "Question"))
        throw new Error("Expected results")
      expect(first.turn.result.serverResult).toEqual({ launch })

      const explored = yield* Chat.explore(chat, {
        sessionId: "launch",
        call: Tool.makeCall(Search, {}),
      })

      expect(explored.execution.serverResult).toEqual({ launch })

      const next = yield* Chat.turn(chat, {
        sessionId: "launch",
        expectedRevision: first.revision,
        message: "Search again",
      })

      if (Predicate.isTagged(next.turn, "Question"))
        throw new Error("Expected results")
      expect(next.turn.result.serverResult).toEqual({ launch })
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )
})

test("repair guards and tools read the latest accepted answers on every turn", async () => {
  const Budget = Stage.collect({
    name: "requirements",
    fields: {
      budget: Answer.explicit(Schema.Number, {
        description: "Budget",
        ask: Question.fixed("Budget?"),
      }),
    },
  })

  const acceptedBudget = Tool.acceptedAnswer({
    stage: Budget.name,
    field: "budget",
    schema: Budget.fields.budget.schema,
  })

  const beforeModel: Array<number> = []
  const beforeTool: Array<number> = []

  const guard = Model.guard({
    name: "budget_policy",
    check: () =>
      acceptedBudget.pipe(
        Effect.map((budget) => {
          beforeModel.push(budget)
        }),
      ),
    checkCall: () =>
      acceptedBudget.pipe(
        Effect.map((budget) => {
          beforeTool.push(budget)
        }),
      ),
  })

  const Search = Tool.define({
    name: "search",
    description: "Use the accepted budget",
    input: Schema.Struct({}),
    execute: () => acceptedBudget.pipe(Effect.map((budget) => ({ budget }))),
  })

  const chat = Chat.define({
    name: "guarded_budget_search",
    version: 1,
    stages: [
      Budget,
      Stage.tools({
        name: "results",
        instructions: ["Search"],
        tools: [Search],
        guards: [guard],
      }),
    ],
    repair: Repair.standard(),
  })

  const model = Scenario.model(
    Scenario.answers(Budget, {
      budget: Scenario.quoted(500, { quote: "500" }),
    }),
    Scenario.call(Search, {}),
    Scenario.call(Search, {}),
    Scenario.repairs(
      Scenario.replace(Budget, "budget", 1000, { quote: "1000" }),
    ),
    Scenario.call(Search, {}),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Chat.turn(chat, {
        sessionId: "budget",
        message: "Budget 500",
      })

      const next = yield* Chat.turn(chat, {
        sessionId: "budget",
        expectedRevision: first.revision,
        message: "Search again",
      })

      const repaired = yield* Chat.turn(chat, {
        sessionId: "budget",
        expectedRevision: next.revision,
        message: "Actually, my budget is 1000",
      })

      for (const [reply, budget] of [
        [first, 500],
        [next, 500],
        [repaired, 1000],
      ] as const) {
        if (Predicate.isTagged(reply.turn, "Question"))
          throw new Error("Expected results")
        expect(reply.turn.result.serverResult).toEqual({ budget })
      }
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )
  expect(beforeModel).toEqual([500, 500, 500, 1000])
  expect(beforeTool).toEqual([500, 500, 500, 1000])
})

test("repair preserves transformed values through query execution and persistence", async () => {
  const Launch = Stage.collect({
    name: "launch",
    fields: {
      date: Answer.explicit(Schema.DateFromString, {
        description: "The launch date",
        ask: Question.fixed("When is launch?"),
      }),
    },
  })

  const ReadLaunch = Tool.define({
    name: "read_launch",
    description: "Read the accepted launch date.",
    input: Schema.Struct({}),
    execute: () =>
      Tool.acceptedAnswer({
        stage: Launch.name,
        field: "date",
        schema: Launch.fields.date.schema,
      }).pipe(Effect.map((date) => date.toISOString())),
  })

  const chat = Chat.define({
    name: "repair_launch",
    version: 1,
    stages: [
      Launch,
      Stage.tools({
        name: "results",
        instructions: ["Read the launch date."],
        tools: [ReadLaunch],
      }),
    ],
    repair: Repair.standard(),
  })

  const initialDate = new Date("2026-09-01T00:00:00.000Z")
  const correctedDate = new Date("2026-10-01T00:00:00.000Z")

  const model = Scenario.model(
    Scenario.answers(Launch, {
      date: Scenario.quoted(initialDate, { quote: "September 1" }),
    }),
    Scenario.call(ReadLaunch, {}),
    Scenario.repairs(
      Scenario.replace(Launch, "date", correctedDate, { quote: "October 1" }),
    ),
    Scenario.call(ReadLaunch, {}),
    Scenario.call(ReadLaunch, {}),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Chat.turn(chat, {
        sessionId: "launch",
        message: "September 1",
      })

      const repaired = yield* Chat.turn(chat, {
        sessionId: "launch",
        expectedRevision: first.revision,
        message: "Actually, October 1",
      })

      const reloaded = yield* Chat.turn(chat, {
        sessionId: "launch",
        expectedRevision: repaired.revision,
        message: "Read it again",
      })

      for (const reply of [repaired, reloaded]) {
        if (Predicate.isTagged(reply.turn, "Question"))
          throw new Error("Expected launch result")
        expect(reply.turn.result.serverResult).toBe(correctedDate.toISOString())
      }
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )
})

test("later collection validators can read previously accepted answers", async () => {
  const Budget = Stage.collect({
    name: "requirements",
    fields: {
      budget: Answer.explicit(Schema.Number, {
        description: "Budget",
        ask: Question.fixed("Budget?"),
      }),
    },
  })

  const observed: Array<number> = []

  const Project = Stage.collect({
    name: "project",
    fields: {
      title: Answer.semantic(Schema.String, {
        description: "Project title",
        ask: Question.fixed("What should we build?"),
        validate: () =>
          Tool.acceptedAnswer({
            stage: Budget.name,
            field: "budget",
            schema: Budget.fields.budget.schema,
          }).pipe(
            Effect.map((budget) => {
              observed.push(budget)
            }),
          ),
        reject: { ask: Question.fixed("What other project should we build?") },
      }),
    },
  })

  const Search = Tool.define({
    name: "search",
    description: "Search projects",
    input: Schema.Struct({}),
    execute: () => Effect.succeed({ found: true }),
  })

  const chat = Chat.define({
    name: "validated_project",
    version: 1,
    stages: [
      Budget,
      Project,
      Stage.tools({
        name: "results",
        instructions: ["Search"],
        tools: [Search],
      }),
    ],
  })

  const model = Scenario.model(
    Scenario.answers(Budget, {
      budget: Scenario.quoted(500, { quote: "500" }),
    }),
    Scenario.answers(Project, {
      title: Scenario.quoted("website", { quote: "website" }),
    }),
    Scenario.call(Search, {}),
  )

  const reply = await Effect.runPromise(
    Chat.turn(chat, {
      sessionId: "project",
      message: "Build a website for 500",
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )

  expect(reply.turn._tag).toBe("ToolResult")
  expect(observed).toEqual([500])
})

test("missing and incompatible answer bindings fail before application work", async () => {
  let executions = 0

  const query = Tool.acceptedAnswer({
    stage: "requirements",
    field: "budget",
    schema: Schema.Number,
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        executions++
      }),
    ),
  )

  const missing = await Effect.runPromise(
    query.pipe(
      Effect.provideService(Tool.Context, { stages: {} }),
      Effect.result,
    ),
  )

  const incompatible = await Effect.runPromise(
    query.pipe(
      Effect.provideService(Tool.Context, {
        stages: {
          requirements: {
            accepted: { budget: { value: "untrusted text" } },
          },
        },
      }),
      Effect.result,
    ),
  )

  expect(Result.isFailure(missing) && missing.failure.reason).toBe("missing")
  expect(Result.isFailure(incompatible) && incompatible.failure.reason).toBe(
    "incompatible",
  )
  expect(executions).toBe(0)
})

test("inherited property names cannot masquerade as accepted answers", async () => {
  for (const reference of [
    { stage: "constructor", field: "budget" },
    { stage: "requirements", field: "constructor" },
  ]) {
    const result = await Effect.runPromise(
      Tool.acceptedAnswer({ ...reference, schema: Schema.Number }).pipe(
        Effect.provideService(Tool.Context, {
          stages: { requirements: { accepted: {} } },
        }),
        Effect.result,
      ),
    )

    expect(Result.isFailure(result) && result.failure.reason).toBe("missing")
  }
})

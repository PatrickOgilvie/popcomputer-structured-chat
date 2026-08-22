import { Answer, Chat, Model, Question, Repair, Stage, Tool } from "../src/index.js"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Schema } from "effect"
import {
  inMemoryChatSessionStore,
  Scenario,
} from "../src/testing.js"

const Launch = Stage.collect({
  name: "launch",
  fields: {
    date: Answer.explicit(Schema.DateFromString, {
      description: "The planned launch date",
      ask: Question.fixed("When should it launch?"),
    }),
  },
})

const ProjectBrief = Stage.collect({
  name: "project_brief",
  fields: {
    priority: Answer.semantic(Schema.String, {
      description: "The project's priority",
      ask: Question.fixed("What matters most?"),
    }),
    location: Answer.explicit(Schema.String, {
      description: "Where the client is based",
      ask: Question.fixed("Where are you based?"),
    }),
  },
})

const Search = Tool.define({
  name: "date_search",
  description: "Search by launch date.",
  input: Schema.Struct({ date: Schema.DateFromString }),
  execute: ({ date }) => Effect.succeed({ date }),
}).pipe(
  Tool.modelResult(
    Schema.Struct({ year: Schema.Number }),
    ({ date }) => ({ year: date.getUTCFullYear() }),
  ),
)

const Matching = Stage.tools({
  name: "matching",
  instructions: ["Search using the collected launch date."],
  tools: [Search],
})

const LaunchChat = Chat.define({
  name: "launch_scenario",
  version: 1,
  stages: [Launch, Matching],
})

const FindOffice = Tool.define({
  name: "find_office",
  description: "Find an office in one location.",
  input: Schema.Struct({ location: Schema.String }),
  execute: ({ location }) => Effect.succeed({ location }),
})

const OfficeMatching = Stage.tools({
  name: "office_matching",
  instructions: ["Find an office using the completed brief."],
  tools: [FindOffice],
})

const RepairableProjectChat = Chat.define({
  name: "repairable_project_scenario",
  version: 1,
  stages: [ProjectBrief, OfficeMatching],
  repair: Repair.standard({ maximumCorrections: 2 }),
})

const LocalPreference = Stage.collect({
  name: "local_preference",
  fields: {
    localOnly: Answer.confirmed(Schema.Boolean, {
      description: "Whether results must be local",
      ask: Question.fixed("Should I limit results to local firms?"),
    }),
  },
})

const SearchByLocalPreference = Tool.define({
  name: "search_by_local_preference",
  description: "Search using the confirmed location preference.",
  input: Schema.Struct({ localOnly: Schema.Boolean }),
  execute: ({ localOnly }) => Effect.succeed({ localOnly }),
})

const PreferenceSearch = Stage.tools({
  name: "preference_search",
  instructions: ["Search using the confirmed preference."],
  tools: [SearchByLocalPreference],
})

const RepairablePreferenceChat = Chat.define({
  name: "repairable_preference_scenario",
  version: 1,
  stages: [LocalPreference, PreferenceSearch],
  repair: Repair.standard({ maximumCorrections: 1 }),
})

describe("Scenario", () => {
  test("writes null for omitted fields in a partial answer step", async () => {
    const model = Scenario.model(
      Scenario.answers(ProjectBrief, {
        location: Scenario.quoted("Leeds", {
          quote: "based in Leeds",
        }),
      }),
    )

    const turn = await Effect.runPromise(
      ProjectBrief.run({
        state: ProjectBrief.initialState,
        messages: [Model.Message.user("We are based in Leeds.")],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.complete).toBe(false)
    expect(turn.question?.field).toBe("priority")
    expect(turn.state.accepted.priority).toBeUndefined()
    expect(turn.state.accepted.location).toEqual({
      value: "Leeds",
      evidence: { messageIndex: 0, quote: "based in Leeds" },
    })
  })

  test("scripts a typed public chat flow and encodes transformed values", async () => {
    const date = new Date("2027-02-03T00:00:00.000Z")
    const model = Scenario.model(
      Scenario.answers(Launch, {
        date: Scenario.quoted(date, { quote: "3 February 2027" }),
      }),
      Scenario.call(Search, { date }),
    )

    const reply = await Effect.runPromise(
      Chat.turn(LaunchChat, {
        sessionId: "typed-scenario",
        message: "Launch on 3 February 2027.",
      }).pipe(
        Effect.provide(Layer.merge(model, inMemoryChatSessionStore)),
      ),
    )

    expect(reply.turn._tag).toBe("ToolResult")
    if (reply.turn._tag === "ToolResult") {
      expect(reply.turn.result.serverResult.date).toBeInstanceOf(Date)
      expect(reply.turn.result.modelResult).toEqual({ year: 2027 })
    }
    expect(
      Chat.acceptedAnswer(LaunchChat, reply.turn.state, Launch, "date"),
    ).toEqual({
      value: date,
      evidence: { messageIndex: 0, quote: "3 February 2027" },
    })
  })

  test("scripts an accepted-answer replacement through a persisted chat", async () => {
    const model = Scenario.model(
      Scenario.answers(ProjectBrief, {
        priority: Scenario.quoted("Growth", { quote: "Growth" }),
        location: Scenario.quoted("Leeds", { quote: "based in Leeds" }),
      }),
      Scenario.call(FindOffice, { location: "Leeds" }),
      Scenario.repairs(
        Scenario.replace(ProjectBrief, "location", "Manchester", {
          quote: "Actually, Manchester",
        }),
      ),
      Scenario.call(FindOffice, { location: "Manchester" }),
    )

    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Chat.turn(RepairableProjectChat, {
          sessionId: "replacement-scenario",
          message: "Growth matters most; we are based in Leeds.",
        })
        const second = yield* Chat.turn(RepairableProjectChat, {
          sessionId: "replacement-scenario",
          expectedRevision: first.revision,
          message: "Actually, Manchester.",
        })
        return { first, second }
      }).pipe(
        Effect.provide(Layer.merge(model, inMemoryChatSessionStore)),
      ),
    )

    expect(replies.first.turn._tag).toBe("ToolResult")
    expect(replies.second.turn._tag).toBe("ToolResult")
    expect(
      Chat.acceptedAnswer(
        RepairableProjectChat,
        replies.second.turn.state,
        ProjectBrief,
        "location",
      ),
    ).toEqual({
      value: "Manchester",
      evidence: { messageIndex: 1, quote: "Actually, Manchester" },
    })
    if (replies.second.turn._tag === "ToolResult") {
      expect(replies.second.turn.result.serverResult).toEqual({
        location: "Manchester",
      })
    }
  })

  test("scripts reconfirmation only after the replacement question is issued", async () => {
    const model = Scenario.model(
      Scenario.answers(LocalPreference, {}),
      Scenario.answers(LocalPreference, {
        localOnly: Scenario.quoted(true, {
          quote: "local firms only",
        }),
      }),
      Scenario.call(SearchByLocalPreference, { localOnly: true }),
      Scenario.repairs(
        Scenario.reconfirm(LocalPreference, "localOnly", {
          quote: "national is fine",
        }),
      ),
      Scenario.answers(LocalPreference, {}),
      Scenario.answers(LocalPreference, {
        localOnly: Scenario.quoted(false, {
          quote: "broaden it nationwide",
        }),
      }),
      Scenario.call(SearchByLocalPreference, { localOnly: false }),
    )

    const replies = await Effect.runPromise(
      Effect.gen(function* () {
        const asked = yield* Chat.turn(RepairablePreferenceChat, {
          sessionId: "reconfirmation-scenario",
          message: "Help me choose firms.",
        })
        const initial = yield* Chat.turn(RepairablePreferenceChat, {
          sessionId: "reconfirmation-scenario",
          expectedRevision: asked.revision,
          message: "Yes, local firms only.",
        })
        const correction = yield* Chat.turn(RepairablePreferenceChat, {
          sessionId: "reconfirmation-scenario",
          expectedRevision: initial.revision,
          message: "Actually, national is fine.",
        })
        const confirmed = yield* Chat.turn(RepairablePreferenceChat, {
          sessionId: "reconfirmation-scenario",
          expectedRevision: correction.revision,
          message: "Yes, broaden it nationwide.",
        })
        return { asked, initial, correction, confirmed }
      }).pipe(
        Effect.provide(Layer.merge(model, inMemoryChatSessionStore)),
      ),
    )

    expect(replies.asked.turn._tag).toBe("Question")
    expect(replies.initial.turn._tag).toBe("ToolResult")
    expect(replies.correction.turn._tag).toBe("Question")
    expect(
      Chat.acceptedAnswer(
        RepairablePreferenceChat,
        replies.correction.turn.state,
        LocalPreference,
        "localOnly",
      ),
    ).toBeUndefined()
    expect(replies.confirmed.turn._tag).toBe("ToolResult")
    expect(
      Chat.acceptedAnswer(
        RepairablePreferenceChat,
        replies.confirmed.turn.state,
        LocalPreference,
        "localOnly",
      )?.value,
    ).toBe(false)
  })

  test("requires quote inference to match exactly one user message", async () => {
    const model = Scenario.model(
      Scenario.answers(Launch, {
        date: Scenario.quoted(new Date("2027-02-03T00:00:00.000Z"), {
          quote: "February",
        }),
      }),
    )

    const exit = await Effect.runPromiseExit(
      Launch.run({
        state: Launch.initialState,
        messages: [
          Model.Message.user("Maybe February."),
          Model.Message.assistant("February could work."),
          Model.Message.user("Yes, February."),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("allows an explicit index when the supporting quote repeats", async () => {
    const date = new Date("2027-02-03T00:00:00.000Z")
    const model = Scenario.model(
      Scenario.answers(Launch, {
        date: Scenario.quoted(date, {
          quote: "February",
          messageIndex: 2,
        }),
      }),
    )

    const turn = await Effect.runPromise(
      Launch.run({
        state: Launch.initialState,
        messages: [
          Model.Message.user("Maybe February."),
          Model.Message.assistant("Which date?"),
          Model.Message.user("3 February 2027."),
        ],
      }).pipe(Effect.provide(model)),
    )

    expect(turn.state.accepted.date?.evidence).toEqual({
      messageIndex: 2,
      quote: "February",
    })
  })
})

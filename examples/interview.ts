import { Effect, Schema } from "effect"
import { Answer, Chat, Question, Stage, Tool } from "@popcomputer/structured-chat"
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"

const Budget = Schema.Union([Schema.Finite.check(Schema.isGreaterThan(0)), Schema.Literal("undecided")])

const FindExamples = Tool.define({
  name: "find_examples", description: "Show example agency projects when the user asks for inspiration.",
  input: Schema.Struct({}),
  execute: () => Effect.succeed(["Museum brand identity", "Charity digital service"]),
})
const tools = [FindExamples] as const
const inputs = Stage.toolInputs(tools, { find_examples: () => Effect.succeed({}) })

export const questions = {
  tools,
  required: {
    goal: Answer.explicit(Schema.String, {
      description: "The outcome the user wants",
      ask: Question.fixed("What do you want to achieve?"),
    }),
    budget: Answer.explicit(Budget, {
      description: "The available project budget in pounds, or undecided if the user explicitly has not decided yet. An unmentioned budget is still unanswered.",
      escape: { value: "undecided" },
      ask: Question.choice(Question.adaptive(
        "Ask about a comfortable budget for the work discussed. It is fine if the user has not decided yet.",
        { fallback: "What budget have you set aside?" },
      ), [{ label: "£10k", value: 10000 }, { label: "£20k", value: 20000 }]),
    }),
  },
  optional: {
    timeline: Answer.explicit(Schema.String, {
      description: "A deadline or preferred start date",
      ask: Question.fixed("When would you like to get started?"),
    }),
  },
} as const

const instructions = [
  "Build a useful agency brief. Follow the user's priorities when choosing the next question.",
  "Ask about timing when the conversation mentions a deadline; finish once further questions would add little.",
] as const

// Omit selection to let the model choose from the runtime's eligible actions.
export const Brief = Stage.interview({
  name: "brief", ...questions, instructions, inputs,
  questions: { escape: "Not sure yet" },
})

export const JevBrief = Stage.interview({
  name: "brief", ...questions, instructions, inputs,
  questions: { escape: "Not sure yet" },
  selection: TypeSafe.questionSelection(questions, {
    policy: TypeSafe.selectionPolicy({ minimumProbability: 0.9, minimumMargin: 0.15 }),
    onUnavailable: "fallback",
  }),
})

// A small application policy can handle one decision and delegate the rest.
export const applicationSelection = Stage.questionSelector(questions, context => {
  const finish = context.candidates.find(candidate => candidate.target._tag === "Finish")
  const latest = context.conversation.at(-1)?.message
  if (finish !== undefined && latest?.role === "user" && latest.content.toLowerCase().includes("search now")) {
    return Effect.succeed({ _tag: "Selected", target: finish.target } as const)
  }
  return Effect.succeed({ _tag: "Uncertain" } as const)
})

const Search = Tool.define({
  name: "search", description: "Search for agencies matching the brief",
  input: Schema.Struct({
    goal: Schema.String,
    budget: Budget,
    timeline: Schema.optionalKey(Schema.String),
  }),
  execute: input => Effect.succeed({ brief: input }),
})

export const AgencySearch = Chat.define({
  name: "agency_search", version: 1,
  stages: [Brief, Stage.tools({ name: "search", instructions: ["Search using the accepted brief."], tools: [Search] })],
})

import { Effect, Schema } from "effect"
import {
  Answer,
  defineChat,
  defineTool,
  Question,
  Stage,
} from "@popcomputer/structured-chat"

const SearchCatalog = defineTool({
  name: "search_catalog",
  description: "Search the catalog for relevant agency matches.",
  input: Schema.Struct({ query: Schema.NonEmptyTrimmedString }),
  execute: ({ query }) => Effect.succeed({ query }),
})

const Search = Stage.tools({
  name: "search",
  instructions: ["Search the catalog using the completed project brief."],
  tools: [SearchCatalog],
})

const ProjectBrief = Stage.collect({
  name: "project_brief",
  questions: {
    guidance: "Ask one concise, conversational question at a time.",
    escape: "Not sure yet",
  },
  fields: {
    priority: Answer.confirmed(Schema.NonEmptyTrimmedString, {
      description: "Where the client most needs outside help.",
      ask: Question.adaptiveChoice(
        "Where could an agency make the biggest difference?",
        {
          minimumOptions: 2,
          maximumOptions: 3,
          fallbackOptions: [
            "Launch or grow a product",
            "Build the brand long term",
            "Fix a performance problem",
          ],
        },
      ),
    }),
    location: Answer.confirmed(Schema.NonEmptyTrimmedString, {
      description: "Where the client is based.",
      ask: Question.adaptive(
        "Ask where the client is based and whether location matters.",
        {
          fallback: "Where are you based, and does location matter?",
        },
      ),
    }),
  },
})

/** A required ask-then-answer workflow before catalog search. */
export const Matchmaker = defineChat({
  name: "matchmaker",
  version: 1,
  stages: [ProjectBrief, Search],
})

const ProjectUnderstanding = Stage.collect({
  name: "project_understanding",
  fields: {
    intent: Answer.semantic(Schema.NonEmptyTrimmedString, {
      description:
        "The client's searchable need, desired outcome, sector, or relevant experience.",
      ask: Question.adaptive(
        "Ask one useful follow-up only when the request is not searchable yet.",
        {
          fallback: "What outcome or experience should I search for?",
        },
      ),
    }),
  },
})

/** A chat that can infer a searchable intent from the opening request. */
export const FreeformMatchmaker = defineChat({
  name: "freeform_matchmaker",
  version: 1,
  stages: [ProjectUnderstanding, Search],
})

/** A chat whose catalog search tool is available on the opening turn. */
export const OpenSearchChat = defineChat({
  name: "open_search_chat",
  version: 1,
  stages: [Search],
})

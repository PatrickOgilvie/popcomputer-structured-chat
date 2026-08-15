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
  description: "Search the catalog for relevant resources.",
  input: Schema.Struct({
    query: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
  execute: ({ query }) => Effect.succeed({ query }),
})

const Search = Stage.tools({
  name: "search",
  instructions: ["Search the catalog using the completed request details."],
  tools: [SearchCatalog],
})

const RequestDetails = Stage.collect({
  name: "request_details",
  questions: {
    guidance: "Ask one concise, conversational question at a time.",
    escape: "Not sure yet",
  },
  fields: {
    goal: Answer.confirmed(
      Schema.Trimmed.check(Schema.isNonEmpty()),
      {
        description: "The outcome the user wants to achieve.",
        ask: Question.adaptiveChoice(
          "What would you like help accomplishing?",
          {
            minimumOptions: 2,
            maximumOptions: 3,
            fallbackOptions: [
              "Understand a topic",
              "Compare available options",
              "Plan the next steps",
            ],
          },
        ),
      },
    ),
    audience: Answer.confirmed(
      Schema.Trimmed.check(Schema.isNonEmpty()),
      {
        description: "Who the requested result is for.",
        ask: Question.adaptive(
          "Ask who will use the result and what they already know.",
          {
            fallback: "Who is this for, and what do they already know?",
          },
        ),
      },
    ),
  },
})

/** A required ask-then-answer workflow before catalog search. */
export const GuidedResourceFinder = defineChat({
  name: "guided_resource_finder",
  version: 1,
  stages: [RequestDetails, Search],
})

const RequestUnderstanding = Stage.collect({
  name: "request_understanding",
  fields: {
    intent: Answer.semantic(
      Schema.Trimmed.check(Schema.isNonEmpty()),
      {
        description:
          "The user's searchable goal, subject, constraints, or desired outcome.",
        ask: Question.adaptive(
          "Ask one useful follow-up only when the request is not searchable yet.",
          {
            fallback: "What subject or outcome should I search for?",
          },
        ),
      },
    ),
  },
})

/** A chat that can infer a searchable intent from the opening request. */
export const FreeformResourceFinder = defineChat({
  name: "freeform_resource_finder",
  version: 1,
  stages: [RequestUnderstanding, Search],
})

/** A chat whose catalog search tool is available on the opening turn. */
export const OpenResourceSearch = defineChat({
  name: "open_resource_search",
  version: 1,
  stages: [Search],
})

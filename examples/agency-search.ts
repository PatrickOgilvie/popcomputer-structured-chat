import {
  Context,
  Effect,
  Layer,
  Schema,
} from "effect"
import {
  defineTool,
  defineView,
  Message,
  Stage,
  Tool,
} from "@popcomputer/structured-chat"

interface AgencyMatch {
  readonly id: string
  readonly name: string
  readonly reason: string
  readonly internalScore: number
  readonly retrievedText: string
}

class AgencyCatalog extends Context.Tag("AgencyCatalog")<
  AgencyCatalog,
  {
    readonly search: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<AgencyMatch>>
  }
>() {}

const AgencyCards = defineView({
  name: "agency_cards",
  version: 1,
  schema: Schema.Struct({
    agencies: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        reason: Schema.String,
      }),
    ),
  }),
})

const AgencyEvidence = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      reason: Schema.String,
    }),
  ),
})

export const SearchAgencies = defineTool({
  name: "search_agencies",
  description: "Find agencies relevant to the project.",
  input: Schema.Struct({ query: Schema.NonEmptyTrimmedString }),
  execute: ({ query }) =>
    AgencyCatalog.pipe(
      Effect.flatMap((catalog) => catalog.search(query)),
    ),
}).pipe(
  Tool.modelResult(AgencyEvidence, (matches) => ({
    matches: matches.map(({ id, reason }) => ({ id, reason })),
  })),
  Tool.present(AgencyCards, (matches) => ({
    agencies: matches.map(({ id, name, reason }) => ({
      id,
      name,
      reason,
    })),
  })),
)

export const Matching = Stage.tools({
  name: "matching",
  instructions: ["Route the project brief to one agency search."],
  tools: [SearchAgencies],
})

const AgencyCatalogLive = Layer.succeed(AgencyCatalog, {
  search: () =>
    Effect.succeed([
      {
        id: "agency:1",
        name: "Northbank",
        reason: "Relevant public-sector transformation work.",
        internalScore: 0.93,
        retrievedText: "Untrusted source text remains server-side.",
      },
    ]),
})

export const example = SearchAgencies.execute({
  query: "A public-sector digital service",
}).pipe(Effect.provide(AgencyCatalogLive))

export const stageExample = Matching.run([
  Message.user("We need a public-sector digital service."),
])

import { Chat, Stage, Tool, View } from "@popcomputer/structured-chat"
import { Context, Effect, Schema } from "effect"

class Catalog extends Context.Service<
  Catalog,
  {
    readonly related: (
      seedId: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>>
  }
>()("Catalog") {}

const RelatedCards = View.define({
  name: "related_cards",
  version: 1,
  schema: Schema.Struct({
    results: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
})

const FindRelated = Tool.define({
  name: "find_related",
  description: "Find records related to one visible result.",
  input: Schema.Struct({ seedId: Schema.String }),
  execute: ({ seedId }) =>
    Catalog.pipe(Effect.flatMap((catalog) => catalog.related(seedId))),
}).pipe(
  Tool.present(RelatedCards, (results) => ({ results })),
)

const SearchCards = View.define({
  name: "search_cards",
  version: 1,
  schema: Schema.Struct({
    seedId: Schema.String,
    exploration: Schema.Struct({
      label: Schema.String,
      call: Chat.ExplorationCallSchema,
    }),
  }),
})

const Search = Tool.define({
  name: "search",
  description: "Return the primary conversation result.",
  input: Schema.Struct({ seedId: Schema.String }),
  execute: ({ seedId }) => Effect.succeed({ seedId }),
}).pipe(
  Tool.present(SearchCards, ({ seedId }) => ({
    seedId,
    exploration: {
      label: "Find related",
      call: Tool.makeCall(FindRelated, { seedId }),
    },
  })),
)

const SearchStage = Stage.tools({
  name: "search",
  instructions: ["Run the requested search."],
  tools: [Search],
})

export const Explorer = Chat.define({
  name: "explorer",
  version: 1,
  stages: [SearchStage],
  explorations: [FindRelated],
})

export const runExploration = (
  sessionId: string,
  call: Chat.ExplorationRequest["call"],
) =>
  Chat.explore(Explorer, { sessionId, call }).pipe(
    Chat.presentExploration(Explorer),
  )

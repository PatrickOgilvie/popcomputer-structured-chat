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

interface ResourceMatch {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly internalScore: number
  readonly retrievedText: string
}

class ResourceCatalog extends Context.Service<
  ResourceCatalog,
  {
    readonly search: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<ResourceMatch>>
  }
>()("ResourceCatalog") {}

const ResultCards = defineView({
  name: "result_cards",
  version: 1,
  schema: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        summary: Schema.String,
      }),
    ),
  }),
})

const ResourceEvidence = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      summary: Schema.String,
    }),
  ),
})

export const FindResources = defineTool({
  name: "find_resources",
  description: "Find resources relevant to the request.",
  input: Schema.Struct({
    query: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
  execute: ({ query }) =>
    Effect.gen(function* () {
      const catalog = yield* ResourceCatalog
      return yield* catalog.search(query)
    }),
}).pipe(
  Tool.modelResult(ResourceEvidence, (matches) => ({
    matches: matches.map(({ id, summary }) => ({ id, summary })),
  })),
  Tool.present(ResultCards, (matches) => ({
    results: matches.map(({ id, title, summary }) => ({
      id,
      title,
      summary,
    })),
  })),
)

export const Lookup = Stage.tools({
  name: "lookup",
  instructions: ["Route the completed request to one resource lookup."],
  tools: [FindResources],
})

const ResourceCatalogLive = Layer.succeed(ResourceCatalog, {
  search: () =>
    Effect.succeed([
      {
        id: "resource:1",
        title: "Onboarding checklist",
        summary: "A concise sequence of practical onboarding steps.",
        internalScore: 0.93,
        retrievedText: "Untrusted source text remains server-side.",
      },
    ]),
})

export const example = FindResources.execute({
  query: "A practical onboarding guide",
}).pipe(Effect.provide(ResourceCatalogLive))

export const stageExample = Lookup.run([
  Message.user("We need a practical onboarding guide."),
])

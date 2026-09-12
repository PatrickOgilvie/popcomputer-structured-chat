import { Predicate, Context, Effect, Schema } from "effect"
import { Chat, Stage, Tool } from "@popcomputer/structured-chat"
import * as Live from "@popcomputer/structured-chat/live"

export class CatalogueFailure extends Schema.TaggedError<CatalogueFailure>()(
  "CatalogueFailure",
  {},
) {}

/** The application's catalogue, supplied once through its normal Effect layer. */
export class Catalogue extends Context.Service<
  Catalogue,
  {
    readonly lookup: (
      query: string,
    ) => Effect.Effect<{ readonly title: string }, CatalogueFailure>
  }
>()("example/live/Catalogue") {}

/** Readiness is a product policy, not a timer or a property of a transcript delta. */
export class ConversationPolicy extends Context.Service<
  ConversationPolicy,
  {
    readonly decide: (
      context: Live.DecisionContext,
    ) => Effect.Effect<Live.Decision>
  }
>()("example/live/ConversationPolicy") {}

const Search = Tool.define({
  name: "search",
  description: "Look up a catalogue entry",
  input: Schema.Struct({ query: Schema.String }),
  execute: ({ query }) =>
    Effect.gen(function* () {
      const catalogue = yield* Catalogue

      return yield* catalogue.lookup(query)
    }),
})

export const Lookup = Chat.define({
  name: "live_catalogue",
  version: 1,
  stages: [
    Stage.tools({
      name: "lookup",
      instructions: ["Search the catalogue for the user's request."],
      tools: [Search],
    }),
  ],
})

/** No action registry or dependency bag: this is an ordinary, precisely typed Effect. */
export const action = Effect.gen(function* () {
  const reply = yield* Live.turn(Lookup)

  if (Predicate.isTagged(reply.turn, "Question"))
    return yield* Live.present(reply)
  const speech = `Found ${reply.turn.result.serverResult.title}.`

  return yield* Live.present(reply, { speech })
})

const resolve = Effect.gen(function* () {
  const context = yield* Live.context
  const policy = yield* ConversationPolicy

  return yield* policy.decide(context)
})

/**
 * Provide Catalogue, ConversationPolicy, Model.Service, Session.Store,
 * Live.Journal, Live.Connection and Live.Publisher at the application boundary.
 * `stop` should be an application shutdown signal; completion waits for final usage.
 */
export const run = (binding: Live.Binding, stop: Effect.Effect<void>) =>
  Live.run(binding, { action, resolve, stop })

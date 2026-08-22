import { Model, Stage, Tool } from "@popcomputer/structured-chat"
import {
  Context,
  Effect,
  Schema,
} from "effect"

/** Application policy rejection retained in the Effect error channel. */
export class UnsafeConversation extends Schema.TaggedError<UnsafeConversation>()(
  "UnsafeConversation",
  { reason: Schema.Literal("prompt_injection") },
) {}

/**
 * Application-owned classifier; production may use any local or remote
 * policy.
 */
export class ConversationSafety extends Context.Service<
  ConversationSafety,
  {
    readonly checkConversation: (
      context: Model.GuardContext,
    ) => Effect.Effect<void, UnsafeConversation>
    readonly checkCall: (
      context: Model.GuardCallContext,
    ) => Effect.Effect<void, UnsafeConversation>
  }
>()("ConversationSafety") {}

/** Effect-native guard composed into any model-backed stage. */
export const PromptInjectionPolicy = Model.guard({
  name: "prompt_injection_policy",
  check: (context) =>
    Effect.gen(function* () {
      const safety = yield* ConversationSafety
      return yield* safety.checkConversation(context)
    }),
  checkCall: (context) =>
    Effect.gen(function* () {
      const safety = yield* ConversationSafety
      return yield* safety.checkCall(context)
    }),
})

const FindResources = Tool.define({
  name: "find_resources",
  description: "Find resources relevant to the request.",
  input: Schema.Struct({
    query: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
  execute: ({ query }) => Effect.succeed({ query }),
})

/** Closed search stage protected by the application policy. */
export const Lookup = Stage.tools({
  name: "lookup",
  instructions: ["Route the completed request to one resource lookup."],
  tools: [FindResources],
  guards: [PromptInjectionPolicy],
})

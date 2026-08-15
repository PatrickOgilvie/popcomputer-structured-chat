import {
  Context,
  Effect,
  Schema,
} from "effect"
import {
  defineModelGuard,
  defineTool,
  Stage,
  type ModelGuardCallContext,
  type ModelGuardContext,
} from "@popcomputer/structured-chat"

/** Application policy rejection retained in the Effect error channel. */
export class UnsafeConversation extends Schema.TaggedError<UnsafeConversation>()(
  "UnsafeConversation",
  { reason: Schema.Literal("prompt_injection") },
) {}

/**
 * Application-owned classifier; production may use any local or remote
 * policy.
 */
export class ConversationSafety extends Context.Tag(
  "ConversationSafety",
)<
  ConversationSafety,
  {
    readonly checkConversation: (
      context: ModelGuardContext,
    ) => Effect.Effect<void, UnsafeConversation>
    readonly checkCall: (
      context: ModelGuardCallContext,
    ) => Effect.Effect<void, UnsafeConversation>
  }
>() {}

/** Effect-native guard composed into any model-backed stage. */
export const PromptInjectionPolicy = defineModelGuard({
  name: "prompt_injection_policy",
  check: (context) =>
    ConversationSafety.pipe(
      Effect.flatMap((safety) =>
        safety.checkConversation(context),
      ),
    ),
  checkCall: (context) =>
    ConversationSafety.pipe(
      Effect.flatMap((safety) => safety.checkCall(context)),
    ),
})

const SearchAgencies = defineTool({
  name: "search_agencies",
  description: "Find agencies relevant to the project brief.",
  input: Schema.Struct({ query: Schema.NonEmptyTrimmedString }),
  execute: ({ query }) => Effect.succeed({ query }),
})

/** Closed search stage protected by the application policy. */
export const Matching = Stage.tools({
  name: "matching",
  instructions: ["Route the completed brief to one search."],
  tools: [SearchAgencies],
  guards: [PromptInjectionPolicy],
})

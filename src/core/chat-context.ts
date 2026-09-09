import { Context, Effect, Schema } from "effect"

/** A called conversation either produces its declared output or is cancelled. */
export type ChatOutcome<Output> =
  | { readonly _tag: "Completed"; readonly output: Output }
  | { readonly _tag: "Cancelled" }

/** @internal Parsed invocation values supplied by the conversation runtime. */
export interface ChatContextService {
  readonly input: unknown
  readonly returns: ReadonlyArray<{
    readonly branch: object
    readonly outcome: ChatOutcome<unknown>
  }>
}

/** Server-owned input and returns for the active chat invocation. */
export class ChatContext extends Context.Service<
  ChatContext,
  ChatContextService
>()("@popcomputer/structured-chat/ChatContext") {}

/** A chat input or returned value is absent or incompatible with its binding. */
export class ChatContextUnavailable extends Schema.TaggedError<ChatContextUnavailable>()(
  "ChatContextUnavailable",
  {
    reason: Schema.Literals([
      "invalid_input",
      "missing_return",
      "invalid_return",
    ]),
  },
) {}

/** Read the active invocation input through its decoded schema contract. */
export const chatInput = <A>(
  schema: Schema.Decoder<A>,
): Effect.Effect<A, ChatContextUnavailable, ChatContext> =>
  Effect.gen(function* () {
    const context = yield* ChatContext
    return yield* Schema.decodeUnknownEffect(Schema.toType(schema))(
      context.input,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new ChatContextUnavailable({ reason: "invalid_input" }),
      ),
    )
  })

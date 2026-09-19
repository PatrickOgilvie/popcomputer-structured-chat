import { Predicate, Context, Effect, Schema } from "effect"
import * as Chat from "../Chat.js"
import type { ChatSessionStore } from "../core/session.js"
import { presentChatReply, Text } from "../core/protocol.js"
import type { Binding } from "./contracts.js"
import {
  InvalidAction,
  InvalidPresentation,
  Presentation,
  RecoveryRequired,
} from "./contracts.js"
import type { JournalFailure } from "./journal.js"

/** @internal Runtime-owned capability scoped to one claimed delegation action. */
export class ActionScope extends Context.Service<
  ActionScope,
  {
    readonly binding: Binding
    readonly input: Chat.AdvanceInput
    readonly control: Chat.TurnControlService
    readonly begin: () => Effect.Effect<void, InvalidAction>
    readonly committed: (
      revision: string,
    ) => Effect.Effect<void, JournalFailure | InvalidAction>
  }
>()("@popcomputer/structured-chat/live/ActionScope") {}

/**
 * Execute one workflow turn for this delegation. The runtime supplies its exact
 * observed input, revision, provenance, and command admission authority.
 * @template C The definition retaining its precise result, failure, and service types.
 */
export const turn = <C extends Chat.AnyDefinition>(
  chat: C,
): Effect.Effect<
  Chat.Reply<C>,
  Chat.AdvanceError<C> | InvalidAction | JournalFailure | RecoveryRequired,
  ActionScope | ChatSessionStore | Chat.Requirements<C>
> =>
  Effect.gen(function* () {
    const action = yield* ActionScope

    if (
      chat.name !== action.binding.chat ||
      chat.version !== action.binding.version
    )
      return yield* new InvalidAction({ reason: "wrong_chat" })
    yield* action.begin()

    const result = yield* Chat.advance(chat, action.input).pipe(
      Effect.provideService(Chat.TurnControl, action.control),
    )

    if (Predicate.isTagged(result, "AlreadyApplied"))
      return yield* new RecoveryRequired({
        reason: "committed_presentation_missing",
      })
    yield* action.committed(result.reply.revision)

    return result.reply
  }).pipe(
    Effect.withSpan("popcomputer.structured_chat.live.turn", {
      attributes: { chat: chat.name },
    }),
  )

/**
 * Project a committed reply to browser views and explicit speech. Questions
 * default to their authored text; tool results require a caller-owned summary.
 */
export const present = (
  reply: Parameters<typeof presentChatReply>[0],
  options: { readonly speech?: string | null } = {},
): Effect.Effect<Presentation, InvalidPresentation> =>
  Effect.gen(function* () {
    const speech =
      options.speech === undefined
        ? Predicate.isTagged(reply.turn, "Question")
          ? reply.turn.question.text
          : Predicate.isTagged(reply.turn, "Clarification")
            ? reply.turn.clarification.text
          : undefined
        : options.speech

    if (speech === undefined)
      return yield* new InvalidPresentation({
        reason: "missing_speech_projection",
      })

    const browser = yield* presentChatReply(reply, {
      result: ({ result }) =>
        speech === null ? result.views : [Text.make(speech), ...result.views],
    }).pipe(
      Effect.mapError(
        () => new InvalidPresentation({ reason: "invalid_output" }),
      ),
    )

    return yield* Schema.decodeEffect(Presentation)(
      { speech, browser },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new InvalidPresentation({ reason: "invalid_output" }),
      ),
    )
  })

/** Construct a voice-only response without serializing application results. */
export const say = (
  speech: string,
): Effect.Effect<Presentation, InvalidPresentation> =>
  Schema.decodeEffect(Presentation)({ speech, browser: null }).pipe(
    Effect.mapError(
      () => new InvalidPresentation({ reason: "invalid_output" }),
    ),
  )

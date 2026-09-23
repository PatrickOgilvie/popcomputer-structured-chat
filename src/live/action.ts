import { Context, Effect, Predicate, Schema } from "effect"

import * as Chat from "../Chat.js"
import {
  presentChatReply,
  Text,
  type PresentableChatReply,
  type PresentableTurn,
} from "../core/protocol.js"
import type { ChatSessionStore } from "../core/session.js"
import {
  type Binding,
  InvalidLiveAction,
  InvalidLivePresentation,
  Presentation,
  LiveRecoveryRequired,
} from "./contracts.js"
import type { LiveJournalFailure } from "./journal.js"

/** @internal Runtime-owned capability scoped to one claimed delegation action. */
export class ActionScope extends Context.Service<
  ActionScope,
  {
    readonly binding: Binding
    readonly input: Chat.AdvanceInput
    readonly control: Chat.TurnControlService
    readonly begin: () => Effect.Effect<void, InvalidLiveAction>
    readonly committed: (
      revision: string,
    ) => Effect.Effect<void, LiveJournalFailure | InvalidLiveAction>
  }
>()("@popcomputer/structured-chat/live/ActionScope") {}

/**
 * Execute one workflow turn for this delegation. The runtime supplies its exact
 * observed input, revision, provenance, and command admission authority.
 * @template C The definition retaining its precise result, failure, and service types.
 */
export const turn = Effect.fn("popcomputer.structured_chat.live.turn")(
  function* <C extends Chat.AnyDefinition>(
    chat: C,
  ): Effect.fn.Return<
    Chat.Reply<C>,
    | Chat.AdvanceError<C>
    | InvalidLiveAction
    | LiveJournalFailure
    | LiveRecoveryRequired,
    ActionScope | ChatSessionStore | Chat.Requirements<C>
  > {
    yield* Effect.annotateCurrentSpan({ chat: chat.name })
    const action = yield* ActionScope

    if (
      chat.name !== action.binding.chat ||
      chat.version !== action.binding.version
    )
      return yield* new InvalidLiveAction({ reason: "wrong_chat" })
    yield* action.begin()

    const result = yield* Chat.advance(chat, action.input).pipe(
      Effect.provideService(Chat.TurnControl, action.control),
    )

    if (Predicate.isTagged(result, "AlreadyApplied"))
      return yield* new LiveRecoveryRequired({
        reason: "committed_presentation_missing",
      })
    yield* action.committed(result.reply.revision)

    return result.reply
  },
)

/**
 * Project a committed reply to browser views and explicit speech. Questions
 * default to their authored text; tool results require a caller-owned summary.
 */
export const present = (
  reply: PresentableChatReply<PresentableTurn>,
  options: { readonly speech?: string | null } = {},
): Effect.Effect<Presentation, InvalidLivePresentation> =>
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
      return yield* new InvalidLivePresentation({
        reason: "missing_speech_projection",
      })

    const browser = yield* presentChatReply(reply, {
      result: ({ result }) =>
        speech === null ? result.views : [Text.make(speech), ...result.views],
    }).pipe(
      Effect.mapError(
        () => new InvalidLivePresentation({ reason: "invalid_output" }),
      ),
    )

    return yield* Schema.decodeEffect(Presentation)(
      { speech, browser },
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new InvalidLivePresentation({ reason: "invalid_output" }),
      ),
    )
  })

/** Construct a voice-only response without serializing application results. */
export const say = (
  speech: string,
): Effect.Effect<Presentation, InvalidLivePresentation> =>
  Schema.decodeEffect(Presentation)({ speech, browser: null }).pipe(
    Effect.mapError(
      () => new InvalidLivePresentation({ reason: "invalid_output" }),
    ),
  )

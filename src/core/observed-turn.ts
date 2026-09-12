import { Data, Predicate, Effect, Schema } from "effect"
import {
  ObservationIdSchema,
  observed,
  submitted,
  type ConversationMessage,
} from "./conversation-message.js"
import { UntrustedMessageSchema } from "./model.js"
import {
  ChatSessionIdSchema,
  ChatSessionNamespaceSchema,
  ChatSessionRevisionSchema,
} from "./session.js"

const ObservedMessageSchema = Schema.Struct({
  id: ObservationIdSchema,
  ...UntrustedMessageSchema.fields,
})

/** Parsed input for either an explicit submission or an observed transcript batch. */
export const ControlledTurnInputSchema = Schema.Struct({
  namespace: Schema.optional(ChatSessionNamespaceSchema),
  sessionId: ChatSessionIdSchema,
  expectedRevision: Schema.optional(ChatSessionRevisionSchema),
  turn: Schema.TaggedUnion({
    Submitted: {
      message: UntrustedMessageSchema.fields.content,
    },
    Observed: {
      batchId: ObservationIdSchema,
      messages: Schema.Array(ObservedMessageSchema).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(199),
      ),
    },
  }),
})

/** Controlled turn input, with no provider-specific fields or caller-supplied authority. */
export interface ControlledTurnInput extends Schema.Schema.Type<
  typeof ControlledTurnInputSchema
> {}

/** A new committed result, or evidence that this exact observed batch already committed. */
export type AdvanceResult<Reply> = Data.TaggedEnum<{
  Applied: { readonly reply: Reply }
  AlreadyApplied: { readonly currentRevision: string }
}>

interface AdvanceResultDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: AdvanceResult<this["A"]>
}

/** @internal Construct and discriminate an applied or replayed controlled turn. */
export const AdvanceResult = Data.taggedEnum<AdvanceResultDefinition>()

/** An observed batch cannot safely enter the conversation. */
export class InvalidObservedTurn extends Schema.TaggedError<InvalidObservedTurn>()(
  "InvalidObservedTurn",
  {
    reason: Schema.Literals([
      "invalid_input",
      "duplicate_identity",
      "identity_content_mismatch",
      "partial_replay",
      "missing_user_input",
    ]),
  },
) {}

/** @internal Decode once before any model, command, or persistence mutation. */
export const parseControlledTurn = (input: ControlledTurnInput) =>
  Schema.decodeEffect(ControlledTurnInputSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() => new InvalidObservedTurn({ reason: "invalid_input" })),
    Effect.tap(({ turn }) => {
      if (Predicate.isTagged(turn, "Submitted")) return Effect.void

      if (turn.messages.at(-1)?.role !== "user")
        return Effect.fail(
          new InvalidObservedTurn({ reason: "missing_user_input" }),
        )

      if (
        new Set(turn.messages.map(({ id }) => id)).size !== turn.messages.length
      )
        return Effect.fail(
          new InvalidObservedTurn({ reason: "duplicate_identity" }),
        )

      return Effect.void
    }),
  )

/** @internal Preserve exact decoded role/content and attach only runtime-owned provenance. */
export const turnMessages = (
  turn: ControlledTurnInput["turn"],
): ReadonlyArray<ConversationMessage> =>
  Predicate.isTagged(turn, "Submitted")
    ? [submitted(turn.message)]
    : turn.messages.map((message) =>
        observed({
          role: message.role,
          content: message.content,
          batchId: turn.batchId,
          id: message.id,
        }),
      )

/** @internal Recognize exact persisted observations before checking an old expected revision. */
export const isAppliedTurn = (
  turn: ControlledTurnInput["turn"],
  messages: ReadonlyArray<ConversationMessage>,
): Effect.Effect<boolean, InvalidObservedTurn> => {
  if (Predicate.isTagged(turn, "Submitted")) return Effect.succeed(false)

  const storedBatch = messages.filter(
    (message) =>
      Predicate.isTagged(message, "Observed") &&
      message.batchId === turn.batchId,
  )

  const identities = new Set(turn.messages.map(({ id }) => id))

  const overlapping = messages.filter(
    (message) =>
      Predicate.isTagged(message, "Observed") && identities.has(message.id),
  )

  if (storedBatch.length === 0 && overlapping.length === 0)
    return Effect.succeed(false)

  if (
    storedBatch.length !== turn.messages.length ||
    overlapping.length !== turn.messages.length
  )
    return Effect.fail(new InvalidObservedTurn({ reason: "partial_replay" }))

  const same = storedBatch.every((stored, index) => {
    const incoming = turn.messages[index]

    return (
      incoming !== undefined &&
      Predicate.isTagged(stored, "Observed") &&
      stored.id === incoming.id &&
      stored.role === incoming.role &&
      stored.content === incoming.content
    )
  })

  return same
    ? Effect.succeed(true)
    : Effect.fail(
        new InvalidObservedTurn({ reason: "identity_content_mismatch" }),
      )
}

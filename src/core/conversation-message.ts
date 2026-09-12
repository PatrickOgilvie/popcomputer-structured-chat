import { Predicate, Schema } from "effect"
import type { AnswerMode } from "./answer.js"
import { UntrustedMessageSchema } from "./model.js"

/** Stable identity of one server-observed transcript batch or message. */
export const ObservationIdSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
)

/**
 * Conversation text with explicit source authority. Only authored assistant
 * text can be issued, and only submitted user text can confirm an answer.
 * Being authored does not itself establish an issued question or reply hint.
 */
export const ConversationMessageSchema = Schema.TaggedUnion({
  Submitted: {
    role: Schema.Literal("user"),
    content: UntrustedMessageSchema.fields.content,
  },
  Authored: {
    role: Schema.Literal("assistant"),
    content: UntrustedMessageSchema.fields.content,
  },
  Observed: {
    ...UntrustedMessageSchema.fields,
    batchId: ObservationIdSchema,
    id: ObservationIdSchema,
  },
})

/** Source-bearing text retained throughout execution and persistence. */
export type ConversationMessage = typeof ConversationMessageSchema.Type

/** Construct submitted user text from already parsed application input. */
export const submitted = (content: string) =>
  ConversationMessageSchema.cases.Submitted.make({ role: "user", content })

/** Construct runtime-authored assistant text; issuance remains a separate operation. */
export const authored = (content: string) =>
  ConversationMessageSchema.cases.Authored.make({ role: "assistant", content })

/** Construct an observation from parsed speech and runtime-owned replay identities. */
export const observed = (
  input: Omit<
    Extract<ConversationMessage, { readonly _tag: "Observed" }>,
    "_tag"
  >,
) => ConversationMessageSchema.cases.Observed.make(input)

/** Only application-authored assistant text may carry issued-message authority. */
export const isAuthored = (message: ConversationMessage): boolean =>
  Predicate.isTagged(message, "Authored")

/** Speech may ground semantic/explicit answers, but confirmation requires a submission. */
export const canGroundAnswer = (
  message: ConversationMessage,
  mode: AnswerMode,
): boolean =>
  message.role === "user" &&
  (mode !== "confirmed" || Predicate.isTagged(message, "Submitted"))

/** Find the latest eligible exact quote after the owning question's message index. */
export const findEvidence = (
  messages: ReadonlyArray<ConversationMessage>,
  input: {
    readonly quote: string
    readonly afterIndex: number
    readonly mode: AnswerMode
  },
): number | undefined => {
  for (let index = messages.length - 1; index > input.afterIndex; index -= 1) {
    const message = messages[index]

    if (
      message !== undefined &&
      canGroundAnswer(message, input.mode) &&
      message.content.includes(input.quote)
    )
      return index
  }

  return undefined
}

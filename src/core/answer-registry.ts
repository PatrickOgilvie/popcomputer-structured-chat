import type {
  AnswerFields,
  CollectQuestionPolicy,
} from "./answer-collection.js"
import type { AnswerDefinitionContract } from "./answer.js"
import type { ConversationMessage } from "./conversation-message.js"

/**
 * @internal Definition-time facts shared by every answer-stage operation.
 * Field declaration order drives deterministic questioning.
 */
export interface AnswerRegistry<Fields extends AnswerFields> {
  readonly stage: string
  readonly fields: Fields
  readonly fieldNames: ReadonlyArray<keyof Fields & string>
  readonly questions: CollectQuestionPolicy
  readonly getAnswer: (field: keyof Fields & string) => AnswerDefinitionContract
}

/** @internal Compare text with the stage's uncertainty escape, ignoring case. */
export const matchesEscape = (text: string, escape: string): boolean =>
  text.toLocaleLowerCase("en") === escape.toLocaleLowerCase("en")

/**
 * @internal Whether the latest message is a user reply selecting the escape
 * verbatim. The browser submits the escape label unchanged; paraphrased
 * uncertainty is left to the model.
 */
export const isEscapeReply = (
  message: ConversationMessage | undefined,
  escape: string | undefined,
): boolean =>
  escape !== undefined &&
  message !== undefined &&
  message.role === "user" &&
  matchesEscape(message.content, escape)

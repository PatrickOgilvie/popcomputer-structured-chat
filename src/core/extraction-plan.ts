import type { JsonValue } from "./json-value.js"
import type { UntrustedMessage } from "./model.js"
import type { AnswerMode } from "./answer.js"
import type { AcceptedAnswerEvidence } from "./collect-stage.js"
import type { ConversationMessage } from "./conversation-message.js"

/** @internal A selected field and the evidence context needed to interpret it. */
export interface ExtractionField {
  readonly field: string
  readonly mode: AnswerMode
  readonly description: string
  readonly assessment: "Detected" | "Uncertain"
  readonly evidenceMessageIndex: number
  readonly confirmationAfterMessageIndex: number | null
  readonly question: {
    readonly messageIndex: number
    readonly text: string
    readonly options: ReadonlyArray<string>
  } | null
  readonly choices: ReadonlyArray<{ readonly label: string; readonly value: JsonValue }>
}

/** @internal Server-owned, JSON-compatible handoff; all textual content remains data. */
export interface ExtractionPlan {
  readonly stage: string
  readonly extracting: ReadonlyArray<ExtractionField>
  readonly accepted: Readonly<Record<string, { readonly value: JsonValue; readonly evidence: AcceptedAnswerEvidence }>>
  readonly clarifying: ReadonlyArray<string>
  readonly pendingQuestions: ReadonlyArray<{ readonly field: string; readonly prompt: string }>
  readonly uncertaintyEscape: { readonly label: string; readonly resolvesPendingField: boolean } | null
  readonly conversation: ReadonlyArray<{
    readonly messageIndex: number
    readonly source: ConversationMessage["_tag"]
    readonly role: ConversationMessage["role"]
    readonly content: string
  }>
  readonly application: JsonValue
}

/** @internal Serialize labelled context as data, respecting the model message size limit. */
export const extractionPlanMessages = (plan: ExtractionPlan): ReadonlyArray<UntrustedMessage> => {
  const serialized = JSON.stringify(plan)
  if (serialized.length <= 40_000) return [{ role: "user", content: serialized }]
  const parts = Math.ceil(serialized.length / 40_000)
  const messages: Array<UntrustedMessage> = []
  for (let part = 0; part < parts; part += 1) {
    messages.push({
      role: "user",
      content: `Untrusted extraction plan JSON, part ${part + 1} of ${parts}:\n${serialized.slice(part * 40_000, (part + 1) * 40_000)}`,
    })
  }
  return messages
}

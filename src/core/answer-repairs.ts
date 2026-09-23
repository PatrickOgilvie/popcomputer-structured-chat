import { Effect, Function as Fn, Predicate } from "effect"

import type {
  AnswerFields,
  CollectStageState,
  RuntimeAnswerValue,
  RuntimeCollectRepairResult,
} from "./answer-collection.js"
import {
  AnswerValidationRejected,
  invalidCollectResponse,
} from "./answer-errors.js"
import { toRejectionPrompt } from "./answer-prompts.js"
import type { AnswerRegistry } from "./answer-registry.js"
import { copyAcceptedAnswers, copyAskedQuestions } from "./answer-state.js"
import type { ConversationMessage } from "./conversation-message.js"
import type { RepairCorrection } from "./repair.js"

/**
 * @internal Run one field's application validator on its decoded value and
 * wrap a failure with the field's retry prompt.
 */
export const validateAnswer = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  field: keyof Fields & string,
  value: RuntimeAnswerValue,
): Effect.Effect<void, unknown, unknown> => {
  const answer = registry.getAnswer(field)

  if (answer.validate === undefined) {
    return Effect.void
  }

  // SAFETY: field selects the same answer definition whose schema parsed
  // value before validation, preserving that field's validator input.
  const validation = Fn.cast<
    typeof answer.validate,
    (candidate: RuntimeAnswerValue) => Effect.Effect<void, unknown, unknown>
  >(answer.validate)

  return validation(value).pipe(
    Effect.mapError(
      (error) =>
        new AnswerValidationRejected({
          stage: registry.stage,
          field,
          error,
          question: toRejectionPrompt(registry, field),
        }),
    ),
  )
}

/**
 * @internal Apply bounded corrections in list order, stopping at the first
 * invalid repair or failed validator. Reconfirmation clears the answer and
 * its issued question, then blocks completion until the user answers again.
 */
export const applyAnswerRepairs = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
  messages: ReadonlyArray<ConversationMessage>,
  repairs: ReadonlyArray<RepairCorrection>,
): Effect.Effect<RuntimeCollectRepairResult, unknown, unknown> =>
  Effect.gen(function* () {
    const accepted = copyAcceptedAnswers(registry, state)
    const asked = copyAskedQuestions(registry, state)
    const currentMessageIndex = messages.length - 1
    const currentMessage = messages[currentMessageIndex]
    const seen = new Set<string>()
    const clarifying = new Set(state.clarifying ?? [])
    const invalidRepair = () =>
      invalidCollectResponse(registry.stage, "invalid_repair")
    let requiresConfirmation = false

    for (const repair of repairs) {
      // SAFETY: the field lookup below rejects names outside Fields before
      // any field-indexed operation runs.
      const field = Fn.cast<string, keyof Fields & string>(repair.field)
      const answer = Object.hasOwn(registry.fields, field)
        ? registry.getAnswer(field)
        : undefined

      if (
        answer === undefined ||
        seen.has(field) ||
        !Object.hasOwn(state.accepted, field) ||
        currentMessage?.role !== "user" ||
        !currentMessage.content.includes(repair.evidence.quote)
      ) {
        return yield* invalidRepair()
      }

      seen.add(field)

      if (Predicate.isTagged(repair, "ReconfirmAnswer")) {
        if (answer.mode !== "confirmed") {
          return yield* invalidRepair()
        }

        accepted.delete(field)
        asked.delete(field)
        // Reconfirmation remains unresolved even when the field is optional
        // in the owning stage. Persist it until a later answer or decline.
        clarifying.add(field)
        requiresConfirmation = true
        continue
      }

      if (answer.mode === "confirmed" || !("value" in repair)) {
        return yield* invalidRepair()
      }

      yield* validateAnswer(registry, field, repair.value)
      clarifying.delete(field)
      accepted.set(field, {
        value: repair.value,
        evidence: {
          messageIndex: currentMessageIndex,
          quote: repair.evidence.quote,
        },
      })
    }

    const repairedState = {
      accepted: Object.fromEntries(accepted),
      asked: Object.fromEntries(asked),
    }
    return {
      state:
        clarifying.size === 0
          ? repairedState
          : { ...repairedState, clarifying: [...clarifying] },
      requiresConfirmation,
    }
  })

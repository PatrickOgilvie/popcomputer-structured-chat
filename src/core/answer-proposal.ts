import { Effect, Function as Fn, Predicate, Result, Schema } from "effect"

import type {
  AnswerCollectionResult,
  AnswerFields,
  CollectAnswerValidationError,
  CollectAnswerValidationRequirements,
  CollectStageState,
  RuntimeAnswerValue,
} from "./answer-collection.js"
import {
  invalidCollectResponse,
  type InvalidCollectStageResponse,
} from "./answer-errors.js"
import { nextQuestion } from "./answer-prompts.js"
import {
  isEscapeReply,
  matchesEscape,
  type AnswerRegistry,
} from "./answer-registry.js"
import { validateAnswer } from "./answer-repairs.js"
import { copyAcceptedAnswers } from "./answer-state.js"
import {
  canGroundAnswer,
  findEvidence,
  type ConversationMessage,
} from "./conversation-message.js"
import {
  recordDebugEvent,
  type CollectProposalRejectionReason,
} from "./debug-trace.js"
import type { JsonValue } from "./json-value.js"
import { getOwn } from "./record.js"

/** @internal One complete submit_answers proposal after per-field assessment. */
export interface AnswerProposal<Fields extends AnswerFields> {
  readonly answers: Readonly<Record<string, RuntimeAnswerValue | null>>
  readonly evidence: ReadonlyArray<{
    readonly field: keyof Fields & string
    readonly quote: string
  }>
  readonly nextQuestion: {
    readonly field: keyof Fields & string
    readonly text: string
    readonly options: ReadonlyArray<string>
  } | null
}

/** @internal A proposal declaring no answers; absence never changes state. */
export const emptyAnswerProposal = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
): AnswerProposal<Fields> => ({
  answers: Object.fromEntries(
    registry.fieldNames.map((field) => [field, null]),
  ),
  evidence: [],
  nextQuestion: null,
})

/** @internal Strictly parsed transport envelope before per-field decoding. */
export interface RawAnswerProposal {
  readonly answers: Readonly<Record<string, JsonValue | undefined>>
  readonly evidence: ReadonlyArray<{
    readonly field: string
    readonly quote: JsonValue
  }>
}

/**
 * @internal Turn-local accumulators owned by one collection operation. The
 * assessment mutates them in place so grounded proposals survive a repair
 * request for the fields that were rejected.
 */
export interface ProposalAccumulator<Fields extends AnswerFields> {
  readonly answers: Record<string, RuntimeAnswerValue | null>
  readonly evidence: Array<{
    readonly field: keyof Fields & string
    readonly quote: string
  }>
  readonly clarifying: Set<string>
}

/** @internal Per-field assessment of one proposal attempt. */
export interface ProposalAssessmentInput<Fields extends AnswerFields> {
  readonly state: CollectStageState<Fields>
  readonly messages: ReadonlyArray<ConversationMessage>
  readonly attempt: 1 | 2
  readonly selected: ReadonlyArray<keyof Fields & string>
  readonly escapedField: (keyof Fields & string) | undefined
  readonly raw: RawAnswerProposal
  readonly accumulator: ProposalAccumulator<Fields>
}

/** @internal One rejected field and the safe reason recorded for repair. */
export interface RejectedProposalField<Fields extends AnswerFields> {
  readonly field: keyof Fields & string
  readonly reason: CollectProposalRejectionReason
}

/** @internal Record one field's assessment as a span and a debug event. */
export const annotateAnswerProposal = Effect.fn(
  "popcomputer.structured_chat.answer.proposal",
)(function* (
  stage: string,
  field: string,
  attempt: 1 | 2,
  decision:
    | "absent"
    | "unchanged"
    | "grounded"
    | "rejected"
    | "repair_requested",
  reason: CollectProposalRejectionReason | null = null,
) {
  yield* Effect.annotateCurrentSpan({
    stage,
    field,
    attempt,
    decision,
    reason: reason ?? "none",
  })
  yield* recordDebugEvent({
    _tag: "AnswerProposalAssessed",
    stage,
    field,
    attempt,
    decision,
    reason,
  })
})

const evidenceQuoteSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_000),
)

/**
 * @internal Assess each selected field of one raw proposal: decode its value
 * once, verify exactly one eligible quote, and retain grounded values in the
 * accumulator. Returns the fields eligible for one bounded repair request.
 */
export const assessAnswerProposal = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  input: ProposalAssessmentInput<Fields>,
): Effect.Effect<ReadonlyArray<RejectedProposalField<Fields>>> =>
  Effect.gen(function* () {
    const { state, messages, attempt, raw, accumulator } = input
    const latest = messages.at(-1)
    const escape = registry.questions.escape
    const rejected: Array<RejectedProposalField<Fields>> = []

    for (const field of input.selected) {
      const proposed = getOwn(raw.answers, field)
      if (
        proposed === undefined ||
        proposed === null ||
        field === input.escapedField ||
        (escape !== undefined &&
          Predicate.isString(proposed) &&
          matchesEscape(proposed, escape))
      ) {
        // Absence is not evidence of an attempted answer. Preserve any existing
        // clarification, but do not create one merely because this field was asked.
        yield* annotateAnswerProposal(registry.stage, field, attempt, "absent")
        continue
      }
      const answer = registry.getAnswer(field)
      const issued = getOwn(state.asked, field)
      if (
        answer.mode === "confirmed" &&
        (issued === undefined ||
          latest === undefined ||
          !canGroundAnswer(latest, answer.mode))
      ) {
        yield* annotateAnswerProposal(
          registry.stage,
          field,
          attempt,
          "rejected",
          "confirmation_required",
        )
        continue
      }
      const parsed = yield* Schema.decodeUnknownEffect(answer.schema)(
        proposed,
        { onExcessProperty: "error" },
      ).pipe(Effect.result)
      let reason: CollectProposalRejectionReason | undefined
      if (Result.isFailure(parsed)) {
        reason = "invalid_value"
      } else {
        const previous = getOwn(state.accepted, field)
        const unchanged =
          previous !== undefined &&
          Schema.toEquivalence(Schema.toType(answer.schema))(
            previous.value,
            parsed.success,
          )
        if (unchanged && !accumulator.clarifying.has(field)) {
          yield* annotateAnswerProposal(
            registry.stage,
            field,
            attempt,
            "unchanged",
          )
          continue
        }
        const quotes = raw.evidence.filter((item) => item.field === field)
        const quote =
          quotes[0] === undefined
            ? undefined
            : Schema.decodeUnknownResult(evidenceQuoteSchema)(quotes[0].quote)
        if (quotes.length === 0) reason = "missing_evidence"
        else if (quotes.length > 1) reason = "duplicate_evidence"
        else if (
          quote === undefined ||
          Result.isFailure(quote) ||
          findEvidence(messages, {
            quote: quote.success,
            afterIndex: Math.max(
              previous?.evidence.messageIndex ?? -1,
              answer.mode === "confirmed" ? (issued?.messageIndex ?? -1) : -1,
              state.clarifying?.includes(field) === true
                ? ((issued?.latest ?? issued)?.messageIndex ?? -1)
                : -1,
            ),
            mode: answer.mode,
          }) === undefined
        )
          reason = "invalid_evidence"
        else {
          accumulator.clarifying.delete(field)
          if (unchanged) {
            yield* annotateAnswerProposal(
              registry.stage,
              field,
              attempt,
              "unchanged",
            )
          } else {
            accumulator.answers[field] = parsed.success
            accumulator.evidence.push({ field, quote: quote.success })
            yield* annotateAnswerProposal(
              registry.stage,
              field,
              attempt,
              "grounded",
            )
          }
        }
      }
      if (reason !== undefined) {
        accumulator.clarifying.add(field)
        rejected.push({ field, reason })
        yield* annotateAnswerProposal(
          registry.stage,
          field,
          attempt,
          "rejected",
          reason,
        )
      }
    }

    return rejected
  })

/**
 * @internal Merge an assessed proposal into accepted state. Validators run
 * sequentially in definition order and stop at the first failure, keeping
 * application Effects and the selected retry question deterministic.
 */
export const mergeAnswerProposal = <Fields extends AnswerFields>(
  registry: AnswerRegistry<Fields>,
  state: CollectStageState<Fields>,
  messages: ReadonlyArray<ConversationMessage>,
  proposal: AnswerProposal<Fields>,
  clarifying: ReadonlyArray<keyof Fields & string>,
  focus?: keyof Fields & string,
): Effect.Effect<
  AnswerCollectionResult<CollectStageState<Fields>>,
  InvalidCollectStageResponse | CollectAnswerValidationError<Fields>,
  CollectAnswerValidationRequirements<Fields>
> => {
  const execution = Effect.gen(function* () {
    const accepted = copyAcceptedAnswers(registry, state)
    const proposed = proposal.answers
    const pendingBeforeProposal = nextQuestion(registry, state, focus)
    const latestMessage = messages.at(-1)
    const invalidEvidence = () => invalidCollectResponse(registry.stage)

    // Escape detection is an exact, case-insensitive match on the whole
    // latest user message: the browser submits the escape label
    // verbatim. Paraphrased uncertainty is interpreted by the model
    // according to the answer's schema and description.
    const escapedField =
      pendingBeforeProposal !== undefined &&
      isEscapeReply(latestMessage, registry.questions.escape)
        ? pendingBeforeProposal.field
        : undefined

    // While the stage is incomplete, a later proposal may replace an
    // already accepted answer with fresh evidence. A confirmed field's
    // replacement evidence must still postdate its issued question, so
    // the ask-then-answer contract keeps holding; once the stage
    // completes, corrections go through the repair transition instead.
    for (const field of registry.fieldNames) {
      const answer = registry.getAnswer(field)

      if (field === escapedField) {
        const escapeResolution = answer.escape

        // The value is application-authored and schema-validated at
        // definition time, so field validators do not run here. The
        // escape message itself is the grounding evidence; a confirmed
        // field still requires its question to have been issued.
        if (
          escapeResolution !== undefined &&
          latestMessage !== undefined &&
          canGroundAnswer(latestMessage, answer.mode) &&
          (answer.mode !== "confirmed" ||
            getOwn(state.asked, field) !== undefined)
        ) {
          accepted.set(field, {
            value: escapeResolution.value,
            evidence: {
              messageIndex: messages.length - 1,
              quote: latestMessage.content,
            },
          })
        }

        continue
      }

      const proposedValue = proposed[field]

      const proposedEscape =
        registry.questions.escape !== undefined &&
        Schema.is(Schema.String)(proposedValue) &&
        matchesEscape(proposedValue, registry.questions.escape)

      if (proposedValue === null || proposedEscape) {
        continue
      }

      const issued = getOwn(state.asked, field)

      if (
        answer.mode === "confirmed" &&
        (issued === undefined ||
          latestMessage === undefined ||
          !canGroundAnswer(latestMessage, answer.mode))
      ) {
        continue
      }

      const evidence = proposal.evidence.find(
        (candidate) => candidate.field === field,
      )

      const messageIndex =
        evidence === undefined
          ? undefined
          : findEvidence(messages, {
              quote: evidence.quote,
              afterIndex:
                answer.mode === "confirmed" && issued !== undefined
                  ? issued.messageIndex
                  : -1,
              mode: answer.mode,
            })

      if (evidence === undefined || messageIndex === undefined) {
        return yield* invalidEvidence()
      }

      yield* validateAnswer(registry, field, proposedValue)

      accepted.set(field, {
        value: proposedValue,
        evidence: {
          messageIndex,
          quote: evidence.quote,
        },
      })
    }

    const retained = {
      accepted: Object.fromEntries(accepted),
      asked: state.asked,
    }
    const runtimeMerged =
      clarifying.length === 0 ? retained : { ...retained, clarifying }

    // SAFETY: accepted keys come only from fieldNames and every value was
    // decoded by that field's schema before insertion.
    const merged = Fn.cast<typeof runtimeMerged, CollectStageState<Fields>>(
      runtimeMerged,
    )

    return {
      state: merged,
      declines: [],
      wording:
        proposal.nextQuestion === null
          ? null
          : {
              field: proposal.nextQuestion.field,
              text: proposal.nextQuestion.text,
              options: proposal.nextQuestion.options.map((label) => ({
                label,
              })),
            },
    }
  })

  // SAFETY: each validator came from the same concrete Fields mapping used by
  // the public conditional unions; the loop recovers nothing.
  return Fn.cast<
    typeof execution,
    Effect.Effect<
      AnswerCollectionResult<CollectStageState<Fields>>,
      InvalidCollectStageResponse | CollectAnswerValidationError<Fields>,
      CollectAnswerValidationRequirements<Fields>
    >
  >(execution)
}

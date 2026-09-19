# Recovering individual collection proposals

## Problem and outcome

A reply of “the UK” produced a valid `market: "UK"` with evidence and a redundant `location: "local"` without evidence. The collection runtime rejected the entire proposal and repeated the country question. The desired result is to retain the existing location and its provenance, accept UK, and ask about timing without another model request.

## Decisions

Collection is a patch to accepted state. Accepted values are labelled context; the model should submit only additions and corrections (null means no change). The existing `submit_answers` transport remains an answers object plus evidence entries. The collection boundary immediately associates each proposed value with its evidence and independently decodes it using the owning answer schema. This keeps the public stage API and provider schema precise without allowing one invalid value to discard other decoded values.

Both detector-backed and direct extraction receive labelled plans. Direct extraction retains the full history; detector/context-backed extraction retains its existing six-message window. Accepted facts and their provenance remain separately available in either case.

Each field has one assessment:

- **Absent:** null or omitted; retain existing state.
- **Unchanged:** the decoded value is equivalent under the answer schema to the accepted value; retain its original evidence and skip application validation.
- **Grounded:** a new or changed decoded value with exactly one valid eligible quote; hold it for application validation.
- **Rejected:** invalid value, missing/duplicate/invalid evidence, or an unmet confirmation requirement; retain existing state. Repairable output errors are eligible for the remaining model attempt.

New answers keep their existing grounding rules. Corrections must cite evidence later than the accepted answer's evidence; confirmed answers additionally require a submitted user message after the issued question. An unchanged answer cannot refresh evidence or manufacture confirmation. Schema decoding happens once per proposed value; application validators receive the decoded value.

## Execution

1. Run pre-model guards and detection as today. Prepare selected fields and context once.
2. Request a proposal using the precise selected-field JSON Schema. Parse the call envelope strictly, then decode values and assess evidence independently. Ignore invalid optional next-question wording; the runtime owns question selection.
3. Preserve grounded proposals in turn-local memory. If necessary, make one repair request restricted to rejected fields with safe field/reason diagnostics. Previously grounded fields are absent from the repair schema and cannot be overwritten. Unchanged or confirmation-ineligible fields do not cause a repair.
4. The collection operation has at most **two model requests total**, including malformed-envelope recovery. A failed repair due to invalid model output leaves good proposals available; transport, guard, context, and other infrastructure failures still fail the turn. Provider-level network retry policy is separate.
5. Run post-parse call guards on the combined decoded, grounded proposal before application execution. Run application validators once, in definition order. A validator failure retains its existing typed rejection and aborts the turn; no accepted values are persisted. Do not retry application validators. Current validators are field-level; this change introduces no implicit cross-field validation or partial commit API.
6. Merge validated additions/corrections and application-owned escape resolutions. Select the next question from this state. Persist through the existing single session revision/CAS operation; never write intermediate repair state.

## Clarification off-ramp

An unresolved rejected proposal leads to clarification. A null or omitted value means no proposal for that field; it does not establish that the user attempted to answer its question. In particular, correcting an earlier country answer while timing is pending must update the country and resume the normal timing question. Absence neither creates nor clears a persistent clarification marker.

For an ambiguous attempted answer, the model can suggest focused wording for an adaptive question; null alone does not persist an ambiguity judgment. Adaptive questions can use model-proposed wording for the runtime-selected field. Fixed questions retain their application-owned wording, adding a short clarification lead-in only for an actual pending clarification. No extra model request is needed to generate the fallback.

Persist optional `clarifying` field names alongside accepted answers and issued questions. This is necessary for corrections: an existing answer stays visible, but an unresolved correction must prevent stage completion and search. Clarifications take precedence over other missing fields. A fresh grounded answer clears the marker; reaffirming an unchanged value requires fresh evidence after the clarification question, preserves the original accepted evidence, and skips the validator. An application-defined uncertainty resolution can also resolve it; an unconfigured uncertainty response cannot silently restore the old value.

While a clarification is pending, an eligible reply reaches extraction even if the detector says undetected. The plan labels the pending clarification explicitly. Existing confirmation/source authority still applies. Debug snapshots expose `clarificationPending` while retaining the accepted value.

Model-output rejection is distinct from application rejection. Partial model recovery does not weaken business rules or session atomicity. Validators may perform Effects, so “atomic” describes session persistence, not rollback of external validator side effects.

## Observability

Record bounded per-field debug events and spans with field, attempt, decision, and safe reason. Record repair requests explicitly. Do not add raw values or quotes to decision annotations; provider payload capture continues through the existing debug facility. `QuestionAnswered` denotes the final accepted transition; a grounded proposal is not yet a committed answer.

## Verification

- Replay the exact UK proposal with a redundant location and no location evidence: one model call, original location evidence retained, UK accepted, timing next.
- With timing already issued, correct France to UK while leaving timing null: preserve other facts, update UK and its evidence, resume the original timing question, and accept timing on the next turn. Cover both direct and detector-backed extraction and the persisted state round trip.
- Null for an issued pending field must preserve, rather than create or clear, its existing clarification state.
- Exercise the same behavior with and without detection, and with schema-decoded object values.
- Submit mixed valid and invalid values/evidence: retain valid proposals, narrow repair to failed fields, accept repaired values, and cap total calls at two.
- Exhaust repair or return malformed output: retain independent good proposals and ask only for missing answers.
- Attempt to overwrite a retained good proposal during repair: strict field selection rejects the output.
- Reject unsupported/stale corrections, duplicate quotes, and confirmation evidence from before issuance or observations; preserve previous values.
- Verify validators run once after repair; application or transport failures leave persisted state/revision unchanged.
- Persist an unresolved correction with all fields populated, verify search remains blocked, then reaffirm or correct it using fresh evidence and verify progression.
- Check debug decisions, final question selection, and tool-stage execution from accepted state through public runtime/session seams.
- Run existing collection, extraction, model, guard, debug and session tests, repository type/lint checks, and the full unit suite. Re-run the authorized sample through the local playground's live Jev/Cloudflare integration as a smoke check, not a substitute for deterministic regressions.

## Verification recorded on 2026-09-18

`bun test tests/collect-proposal-recovery.test.ts` runs 19 deterministic regressions through the real collection/session boundaries, with controlled model responses. The full unit suite passed 511 tests; the Cloudflare worker suite passed 8, and the local playground passed 20. Repository architecture, type, lint, package type, ESM smoke, and package dry-run checks passed.

Live Jev + Cloudflare DeepSeek V4 Flash accepted the opening brief, accepted “the UK” and asked about timing in 2.4 seconds, then accepted “ASAP” and completed collection/search in 2.8 seconds. The diagnostic session was removed afterward. The exact malformed UK proposal is covered deterministically with detection both enabled and disabled; the live check does not depend on a model reproducing that mistake.

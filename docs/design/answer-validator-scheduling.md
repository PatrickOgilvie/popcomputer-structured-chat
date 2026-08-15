# Answer validator scheduling

Status: **sequential fail-fast contract documented and verified (2026-08-11)**

## 1. Summary

Do not run answer validators concurrently. Validators are arbitrary Effects with typed service requirements; the package has no purity, independence, idempotency, or error-accumulation contract. Parallel execution could start later side effects after an earlier field should have rejected the proposal and would make the selected retry question race-dependent.

The positive improvement is to make declaration-order, sequential, fail-fast behavior a public contract and test it.

## 2. Goals and non-goals

Goals:

- specify validator order and short-circuit behavior;
- keep rejection prompts deterministic;
- prevent a later optimization from accidentally introducing concurrency.

Non-goals:

- maximize validation throughput;
- accumulate multiple field errors in one turn;
- declare application Effects pure;
- change repair validation order.

## 3. Evidence and constraints

`mergeProposal` visits `fieldNames` in schema declaration order and yields each validator before accepting the field. `applyRepairs` similarly follows the bounded repair list. The first failure is wrapped as `AnswerValidationRejected` with one field-specific question.

Effect's `forEach` documentation states that iteration is sequential by default and short-circuits on failure; concurrency is an explicit option. OpenAI Agents JS also treats SDK-side function-tool concurrency as explicit configuration rather than an invisible optimization. These reinforce that scheduling is semantic when Effects may do work:

- <https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Effect.ts>
- <https://github.com/openai/openai-agents-js/releases>

## 4. Options considered

### A. Bounded concurrent validators

Rejected. `concurrency: 2` limits resource use but does not restore fail-fast side-effect behavior or deterministic first error.

### B. Concurrent pure validators only

Potential future design, but it requires a separate pure validator constructor and an explicit error accumulation policy. The expected field count is already capped, so the API cost is not justified by evidence.

### C. Sequential fail-fast contract

Recommended. Keep the implementation and add public docs plus a regression test.

## 5. Typed contracts

No type changes are required. The behavioral contract is:

```text
for each proposed field in definition order:
  validate evidence
  run that field's validator
  on failure: stop and return that field's rejection
  on success: accept the field and continue
```

For repairs, list order is preserved and processing stops at the first invalid repair or failed validator.

## 6. Call and data flow

```text
parsed proposal
  -> field A evidence -> validator A
  -> field B evidence -> validator B
  -> first failure -> one typed rejection question
```

No later validator starts after a prior validator fails.

## 7. Files and implementation plan

- `README.md`: document declaration-order sequential fail-fast validators near collect-stage validation.
- `src/core/collect-stage.ts`: strengthen the public/runtime comment; no scheduling change.
- `tests/collect-stage.test.ts`: add a test with two proposed fields proving order and that the second validator is not invoked after the first fails.

## 8. Red-green-refactor plan

1. Red: add a two-field validator test that records execution order and fails the first validator.
2. Green: current code should satisfy it; update documentation and comments.
3. Refactor: if useful, name the sequential loop invariant without converting it to a concurrent combinator.
4. Verify repair tests still demonstrate ordered repair handling.

## 9. Risks and mitigations

- **Slower independent I/O validators:** callers can combine related checks inside one field validator under their own explicit concurrency and error policy.
- **Contract ossification:** a future pure-validator API can be additive.
- **Undocumented order changes:** regression test locks declaration-order fail-fast behavior.

## 10. Decision

Implement documentation and a test only. Preserve sequential scheduling.

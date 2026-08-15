# Trusted chat transition loop

Status: **implemented and verified (2026-08-11)**

## 1. Summary

Split the chat runtime into one checked entry point and one private trusted transition loop. Public `Chat.run` still validates state shape and transcript grounding. Persisted `Chat.reply` still parses the snapshot and grounds it. Once either boundary succeeds, collect completion and repair transitions call the trusted loop without rescanning every accepted answer and evidence quote.

This removes duplicate whole-state/provenance work while preserving all boundary and stage-local validation.

## 2. Goals and non-goals

Goals:

- perform state and grounding checks once per public boundary;
- preserve every current error and successful turn;
- make the trusted-state invariant visible in names and comments.

Non-goals:

- skip snapshot parsing;
- weaken proposal, repair, field, guard, or tool validation;
- expose a trusted-state constructor publicly;
- alter model call counts or persistence.

## 3. Current call stack and problem

```text
Chat.reply
  -> stateSchema decode (includes semantic state validation)
  -> isGroundedInMessages
  -> runRuntime
     -> isValidRuntimeState
     -> isGroundedInMessages
     -> stage
     -> internal transition
     -> runRuntime
        -> repeat both scans
```

The state has at most the package's bounded fields/messages, so this is not an asymptotic failure. It is still repeated security work on an already validated internal value and obscures which calls are true trust boundaries.

## 4. Options considered

### A. Keep validation in every recursive call

Safe but redundant, and it makes internal transitions look untrusted.

### B. Brand a `TrustedRuntimeChatState`

Potentially useful, but a compile-time brand does not encode the relationship between one state and one exact transcript. It adds ceremony without eliminating the need for a clearly scoped private function.

### C. Checked wrapper plus private trusted loop

Recommended. The wrapper owns structural/semantic and grounding checks. Only closures inside `defineChat` can invoke the trusted loop.

## 5. Typed contracts

```ts
const runTrustedRuntime = (
  state: RuntimeChatState,
  messages: ReadonlyArray<UntrustedMessage>,
  commandContext?: CommandExecutionContext,
  allowRepair?: boolean,
): Effect.Effect<unknown, unknown, unknown>

const runCheckedRuntime = (
  state: RuntimeChatState,
  messages: ReadonlyArray<UntrustedMessage>,
  commandContext?: CommandExecutionContext,
  allowRepair?: boolean,
): Effect.Effect<unknown, unknown, unknown>
```

`runCheckedRuntime` is used by public `run`. `reply` uses `runTrustedRuntime` only after `stateSchema` decoding and its explicit grounding check. Internal collect and repair transitions use only `runTrustedRuntime`.

## 6. Call and data flow

```text
Chat.run(untrusted typed value)
  -> runCheckedRuntime -> validate + ground -> runTrustedRuntime

Chat.reply(raw persisted value)
  -> schema decode -> ground -> runTrustedRuntime

runTrustedRuntime
  -> stage parser/guards/validators
  -> package-constructed next state
  -> runTrustedRuntime
```

The trusted loop is safe because every next state is constructed from a previously checked state plus a stage result that has already passed the stage's schemas and validators.

## 7. Files and implementation plan

- `src/core/chat.ts`
  - rename the existing dispatch body to `runTrustedRuntime`;
  - add `runCheckedRuntime` containing the current entry checks;
  - route public `run` through checked;
  - route parsed/grounded `reply` and internal transitions through trusted.
- `tests/chat.test.ts`
  - retain/extend forged-state and ungrounded-evidence boundary tests;
  - rely on existing continuation tests for behavior equivalence.
- `tests/repair.test.ts`
  - retain repair validation and bounded second-step coverage.

## 8. Red-green-refactor plan

1. Red: add a focused regression proving `Chat.run` rejects a forged state before the model runs, if existing coverage is not sufficiently direct.
2. Green: introduce the checked wrapper and trusted loop with no behavior change.
3. Green: call the trusted loop from the already parsed/grounded reply path.
4. Refactor: centralize the invariant comment at the two trusted call sites.
5. Verify: run chat, repair, command, type, and full package suites.

## 9. Risks and mitigations

- **A future caller invokes trusted dispatch too early:** keep it closure-private and document each call site.
- **A stage returns malformed state:** stage runtime schemas and validators remain unchanged; construction stays package-owned.
- **Public `run` accepts structurally typed forged values:** it continues through the checked wrapper.
- **Reply accidentally omits grounding:** keep the explicit grounding check adjacent to trusted invocation and cover corrupted snapshots.

## 10. Decision

Implement. This is an internal refactor with a clear trust-boundary improvement and no public API or semantic change.

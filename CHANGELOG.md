# Changelog

All notable changes to `@popcomputer/structured-chat` are documented in this
file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Provider-neutral answer detection and `TypeSafe.detection`: one batched Noul per stage question marks none, one, or many fields answered, gates generative extraction to detected fields, and skips the model when nothing is detected.

## [0.7.0] - 2026-09-18

Optional TypeSafe evaluation brings calibrated, typed decisions from the
System One model family into structured chats without changing stages that do
not opt in.

### Added

- Optional TypeSafe SDK adapter with typed Noul, Choice, Score, and batch evaluation, explicit Effect configuration, bounded retries, cancellation, and sanitized failures.
- Provider-neutral answer resolvers and `TypeSafe.collection` for registered enum and boolean answers, preserving evidence, guards, validators, corrections, and session revision checks.
- Node and workerd adapter checks, real D1 replay/conflict coverage, and a compiled TypeSafe usage example.

## [0.6.0] - 2026-09-12

Durable Live client delegation connects voice conversations to the existing
structured-chat workflow through ordinary, composable Effect actions.

### Breaking changes

- Persisted conversation messages now carry explicit `Submitted`, `Authored`,
  or `Observed` provenance. Older untagged snapshots are rejected; there is no
  automatic stored-data migration. Custom session adapters and low-level
  callers must use source-bearing messages, available through
  `Session.Message.submitted`, `Session.Message.authored`, and
  `Session.Message.observed`.
- Observed user speech can ground semantic and explicit answers, but cannot
  confirm an answer. Observed assistant speech cannot acquire the authority
  of an application-issued question or reply hint.

### Added

- Added the optional, React-free `/live` entry point with `Live.run`,
  `Live.turn`, `Live.present`, and `Live.say`. Actions retain their precise
  application service requirements and typed failures.
- Added `Chat.advance` and `Chat.TurnControl` for controlled submitted or
  observed turns, exact observation-batch replay detection, and cooperative
  command admission in sequential and composed chats.
- Added a durable Live journal backed by `Session.Store`, exclusive workflow
  ownership, revisable transcript candidates, explicit readiness and
  supersession policy, and separate speech/browser presentation.
- Added `/live/openai` with WebRTC session bootstrap through Effect
  `HttpClient`, scoped authenticated Socket integration, strict event parsing,
  and application-supplied token-count preflight. The OpenAI SDK is not
  required, and importing either Live entry point opens no connection.
- Added the [Live integration guide](https://github.com/PatrickOgilvie/popcomputer-structured-chat/blob/v0.6.0/docs/live.md)
  and a [compiled action example](https://github.com/PatrickOgilvie/popcomputer-structured-chat/blob/v0.6.0/examples/live-lookup.ts).

### Fixed

- Kept receiving provider events while publication and close writes are
  pending, and retained provider finalization and final usage independently
  of later application failures.
- Retained durable recovery claims after uncertain workflow writes,
  post-commit failures, and ambiguous commentary delivery, without blindly
  replaying application commands or resending unknown deliveries.
- Tightened provider response validation, command planning guards, persisted
  evidence checks, D1 retention configuration, and browser failure and
  cancellation boundaries.
- Preserved existing command-identity digests while using portable Web Crypto.

### Maintenance and verification

- Refined Effect state construction and module contracts, consolidated
  repeated provider/model-selection test setup, and replaced encoder-call-count
  coupling with deterministic projection-failure coverage.
- Verified 432 Bun tests, 2 Cloudflare workerd tests, lint, TypeScript and
  architecture checks, package entry points, and Node/React-free ESM smoke
  tests. The revised tests also caught six deliberate regressions in isolated
  mutation checks.
- Live transport and workflow tests use local seams. Real microphone/playback,
  provider event timing, and application readiness quality still require an
  authenticated end-to-end acceptance test before production use.

## [0.5.0] - 2026-09-09

### Breaking changes

- D1 expiry now retains terminal session identity tombstones and returns
  `Session.Expired` on load. Expired scopes cannot restart; use a new session ID.
  The bundled session table schema includes constrained active/expired rows.

- Command IDs now identify one persisted turn across all command choices.
  `Tool.deriveCommandId` no longer accepts a `command` field. Application
  receipts must share a namespace across commands and reject retries that
  change the command name or arguments.

### Added

- Added composable chats with typed input/output, `Chat.branch`, invocation-local
  answers, nested call/return, suspension, resumption, and cancellation.
- Added `Message.define`, conditional tool/branch reply hints, atomic
  `Message.emit`, and retry-stable `Chat.post` for application-authored messages.
- Added `Chat.start`, composed browser/debug presentation with invocation
  identity, and definition-owned validation of complete conversation snapshots.

- Added React-free `/client` factories for ordinary turns, debug turns, and
  explorations, with strict protocol boundaries and typed failure/cancellation
  results. Assistant-ui adapters now compose those clients.
- Added `StructuredChatAssistantProvider` at `/assistant-ui/react`, including
  chat identity resets and an optional lazily loaded debug window.

- Added `Stage.interact` for repeatable closed sets of queries and commands,
  with stable turn identities and explicitly named completion tools.
- Added `Tool.acceptedAnswer` and `Tool.Context` for trusted collection-to-tool
  bindings, including side explorations, without model-authored arguments.

- Added optional stage-scoped `Model.profile(...)` service keys and named
  OpenAI-compatible model layers. Existing stages and the one-argument model
  layer continue to use `Model.Service`; explicitly selected profiles are
  exact Effect requirements and never silently fall back.

### Fixed

- Unified tool-set, command, interaction, and repair dispatch behind a compiled
  registry, preserving transformed inputs and precise application Effect types.
- D1 expiry guards both revision and timestamp, preventing a concurrent refresh
  in the same millisecond from being erased. Cleanup counts each expiry once.

- Accepted-answer bindings validate decoded values, allowing transformed answer
  schemas to be reused after collection and persistence.
- Stage guards and validators receive accepted-answer context, including during
  repair planning and after recursive collection or repair transitions.

## [0.4.0] - 2026-08-25

### Breaking changes

- Bumped the normal and debug turn response envelopes to schema version 2.
  Persisted responses now require the complete `answers` sidecar, and
  `Chat.Reply` now requires its correlated `userAnswers` snapshot. Notices and
  validation rejections remain non-progressing responses without that sidecar.

### Added

- Added opt-in `Answer.visibleToUser()` disclosure, a strictly validated
  user-answer snapshot, an isolated assistant-ui observer, and a complete-
  replacement React store and hook for driving onboarding summaries and forms
  from safe accepted answers. Unannotated answers remain private by default.
- Added opt-in `Debug.turn` capture for literal OpenAI-compatible provider
  inputs and outputs, ordered semantic annotations, and an accumulated **LLM
  Trace** tab in the assistant-ui debug inspector. Explicit debug outcomes
  retain terminal failure traces without object-identity coupling, the browser
  store bounds sensitive in-memory history, and raw model payloads remain
  outside persisted chat sessions and the normal browser response contract.

### Fixed

- Preserved exact `AbortError` cancellations while reading assistant response
  bodies, rejected unsafe or malformed projected field names fail-closed, and
  bounded both server traces and browser history without dropping terminal
  failure context.
- Added wrapping arrow-key, Home, and End navigation to the debug inspector's
  tabs, and retained validated session correlation when a traced turn fails.

### Migration

- Mark only answers that are safe for the browser with
  `Answer.visibleToUser(...)`, then read the complete revision-correlated
  snapshot from `Chat.Reply.userAnswers` or the browser response's `answers`
  field.
- Update normal and debug response decoders from schema version 1 to version 2.
  Applications using assistant-ui can connect `onAnswerSnapshot` to
  `createStructuredChatUserAnswerStore()` and read it with
  `useStructuredChatUserAnswers()`.

## [0.3.1] - 2026-08-22

### Added

- Added side chats, exposed as read-only explorations, so applications can run
  contextual query tools beside the main conversation without invoking the
  model, changing the transcript, or advancing the session revision. The new
  API includes encoded `Tool.makeCall` payloads, strict request and response
  protocols, an assistant-ui client with typed outcomes, and fail-closed view
  extraction.

### Fixed

- Preserved conflict-first handling for stale normal turns while sharing
  persisted-session validation with explorations, and added an overlapping
  turn-plus-explorations regression test proving that only the main lane
  replaces the session.

## [0.3.0] - 2026-08-22

### Breaking changes

- Replaced the flat root export surface with the `Answer`, `Chat`, `Model`,
  `Question`, `Repair`, `Session`, `Stage`, `Tool`, and `View` domain
  namespaces.
- Replaced operational methods on chat definitions with the deep `Chat`
  module. Define chats with `Chat.define(...)` and run persisted turns with
  `Chat.turn(chat, input)`.
- Made chat definitions opaque. Low-level `initialState`, `parseState`, and
  `run` operations are now available only through the `Chat` namespace from
  `@popcomputer/structured-chat/testing`.
- Moved debug projections out of the root package into
  `@popcomputer/structured-chat/debug`.
- Moved the OpenAI-compatible model adapter into
  `@popcomputer/structured-chat/model/openai-compatible`, with concise names
  such as `make`, `Provider`, and `layer`.

### Added

- Added `Chat.present(chat, options)`, a definition-bound Effect transformer
  for composing a complete server action from `Chat.turn` through browser
  presentation.
- Added `Chat.acceptedAnswer` for retrieving accepted values together with
  their transcript evidence.
- Added a Cloudflare D1 session-store adapter at
  `@popcomputer/structured-chat/d1`, including optimistic revision checks,
  optional namespace retention, and a bundled SQL migration.
- Added bounded retry policies and per-tool guidance-schema overrides to the
  OpenAI-compatible model adapter. Guidance overrides affect provider input
  without weakening Effect Schema validation of model output.
- Added safe Cloudflare Workers AI error classification and documented-code
  extraction at `@popcomputer/structured-chat/model/cloudflare-workers-ai`.
- Added `Chat.turnRequestSchema(...)` for application-owned message limits and
  `Chat.findTurnParts(...)` for fail-closed decoding of typed view data.
- Added an architecture check that detects runtime import cycles, internal API
  leaks, testing imports in production code, and accidental expansion of the
  root package surface.

### Changed

- Extracted chat execution into a private, finite transition process with
  tagged states while preserving typed Effect requirements and expected
  failures at the `Chat.turn` boundary.
- Updated examples, browser adapters, tests, and documentation to compose
  through the new domain modules and package subpaths.
- Expanded package verification with Cloudflare workerd integration tests,
  package-consumer type tests, Node ESM smoke tests, and tarball inspection.

### Migration

```ts
import { Chat } from "@popcomputer/structured-chat"

const SupportChat = Chat.define(definition)
const PresentSupportChat = Chat.present(SupportChat)

const response = Chat.turn(SupportChat, input).pipe(
  PresentSupportChat,
)
```

The central call-site migration is:

```ts
// Before
const chat = defineChat(definition)
const reply = chat.reply(input)

// Next release
const chat = Chat.define(definition)
const reply = Chat.turn(chat, input)
```

## [0.2.0] - 2026-08-20

### Added

- Added opt-in, schema-safe chat-state inspection and assistant-ui debug
  presentation.

### Changed

- Upgraded the package and its public Effect contracts to Effect v4.
- Generalized the README examples around package-owned structured-chat
  concepts.

## [0.1.0] - 2026-08-15

### Added

- Initial release of schema-defined structured chats with typed stages,
  questions, tools, commands, session persistence, browser presentation,
  assistant-ui integration, and transcript scenarios.

[Unreleased]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/releases/tag/v0.1.0

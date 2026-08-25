# Changelog

All notable changes to `@popcomputer/structured-chat` are documented in this
file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/PatrickOgilvie/popcomputer-structured-chat/releases/tag/v0.1.0

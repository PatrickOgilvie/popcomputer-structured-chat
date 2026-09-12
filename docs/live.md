# GPT-Live client delegation

The optional `@popcomputer/structured-chat/live` entry point runs application-owned workflows during a voice conversation. GPT-Live handles speech; the existing structured-chat model still plans within the application's stages, answer rules, guards, and tool registry. Import `@popcomputer/structured-chat/live/openai` for OpenAI transport support. Neither entry point opens a connection on import or requires the OpenAI SDK.

## An action is an Effect

Actions use the same service composition as the rest of the application. `Live.turn` supplies the claimed input and execution authority; `Live.present` projects the committed reply for its consumers. Application service requirements and typed failures remain inferred through `Live.run`.

```ts
import { Effect } from "effect"
import * as Live from "@popcomputer/structured-chat/live"

const action = Effect.gen(function* () {
  const reply = yield* Live.turn(Lookup)
  return yield* Live.present(reply, { speech: "Here is the result." })
})

const resolve = Effect.gen(function* () {
  const context = yield* Live.context
  const policy = yield* ConversationPolicy
  return yield* policy.decide(context)
})

const session = Live.run(binding, { action, resolve, stop })
```

`Lookup`, `ConversationPolicy`, `binding`, and `stop` above are application-owned. The [compiled example](../examples/live-lookup.ts) defines the workflow and its exact business-service requirements.

Use `Live.turn` at most once per action. Question replies default to their authored text; other replies require an explicit speech projection, or `speech: null` with nonempty browser views. `Live.say(text)` constructs a voice-only presentation. No arbitrary `serverResult` is automatically serialized. Business mutations belong in `Tool.command`, where admission applies; unrelated effects in an action are not automatically gated or rolled back.

## Configure capabilities once

`Live.run` requires these services in addition to the action's and policy's own requirements:

| Service | Responsibility |
| --- | --- |
| `Model.Service` or the chat's named model profiles | Existing structured workflow planning |
| `Session.Store` | Atomic workflow snapshots and revisions |
| `Live.Journal` | Durable delegation claims, observations, and delivery state |
| `Live.Connection` | Decoded provider events and commentary commands |
| `Live.Publisher` | Idempotent application/browser notifications |

`Live.journal({ namespace: "voice-journals" })` builds a journal from `Session.Store`. It captures its store when its layer is built, so journal and workflow storage may use different databases. Use a dedicated namespace and retain ownership rows during recovery. The D1 adapter supports both stores; use durable storage in production, not the testing in-memory layer.

`Publisher.publish` receives either a `Presentation` or a `Notice`. Upsert by publication `id`. The browser response retains the existing session, accepted-answer, view, and invocation protocol. `superseded: true` means an admitted command's actual result remains relevant even though its conversational intent changed. `Live.withoutPublisher` explicitly discards this channel for a voice-only application.

For composed chats or definitions with startup input, call `Chat.start` with that input before starting the Live runner. The binding selects an existing workflow scope; it does not invent the chat's initial input.

## Connect OpenAI

The server can bootstrap a browser's WebRTC offer with:

```ts
const answer = yield* OpenAILive.createSession({
  apiKey, // Redacted<string>, server-only
  sdp: authorizedOffer.sdp,
  instructions: trustedApplicationInstructions,
})
```

Provide an Effect `HttpClient` layer. This helper creates `gpt-live-1` with client delegation and returns only `session.id` and the WebRTC SDP answer. It never retries creation automatically. Authenticate and authorize your endpoint before calling it; a workflow or provider session ID is not authorization. For advanced provider configuration, create the session with your own SDK integration and use the returned opaque identity.

For server-side events, supply a factory that constructs an authenticated Effect `Socket.Socket` layer for the URL it receives:

```ts
const connection = OpenAILive.connection({
  sessionId: answer.session.id,
  socket: (url) => makeAuthenticatedSocketLayer(url),
})
```

`makeAuthenticatedSocketLayer` is application-owned. The connection validates the identity before invoking this factory, derives the sideband URL, and scopes socket acquisition and cleanup together. The factory's service requirements and typed acquisition failures remain inferred; acquisition is not automatically retried. Server WebSocket authentication stays in the host's Socket constructor. `sidebandUrl` remains available for advanced integrations implementing their own transport adapter. The browser continues to own microphone capture and audio playback; the library does not request microphone access or create UI.

The connection layer also requires `OpenAILive.TextTokens`. Supply a provider-compatible token counter; the adapter rejects commentary above 500 tokens before writing. It does not guess token count from character length. Counter failures must return `InvalidPresentation`; a nonpositive or noninteger result is rejected. Provider errors remain authoritative even after this local preflight.

Attach the sideband early and run exactly one execution owner. WebRTC creation already starts the session: do not send `session.start`. A sideband is not a confidentiality boundary from the primary client, and reconnect does not promise historical-event replay. See the official [WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live) and [server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).

## Readiness is application policy

`Live.context` exposes original role-labelled fragments, their session-relative intervals, a revisable candidate, and the active delegation's admission/commit/supersession state. The resolver is an ordinary Effect and may use application services or a separately evaluated model. Its decisions are:

- `Live.awaitContext`: retain the delegation and wait for more provider evidence.
- `Live.ready(candidate)`: freeze the candidate that was actually inspected.
- `Live.supersede(activeId)`: invalidate a prior intent cooperatively.
- `Live.Decision.cases.Clarify.make({ speech })`: finish this delegation with a clarification request.

The resolver is reassessed on new transcript/delegation evidence and backend progress. Results from an outdated context are discarded. `Await` is not a polling loop; if your policy needs another application signal, wait for it within the policy Effect. The policy remains interruptible with the session scope.

Candidates preserve receipt order, join consecutive same-speaker deltas without inserting whitespace, and end at the latest nonblank user fragment. Only the grouped message boundaries are trimmed to satisfy the existing conversation-message contract; the original fragments are retained unchanged. Timestamp overlap is preserved, not interpreted as a complete chronology. The policy may select an earlier user-fragment boundary explicitly through a `Ready` decision.

Neither a transcript fragment, a pause, nor delegation metadata establishes a complete request. Speech grouping and interruption policy must be evaluated against real conversations for the product. See [delegation](https://developers.openai.com/api/docs/guides/live-delegation) and [transcript semantics](https://developers.openai.com/api/docs/guides/live-conversations).

## Evidence and confirmation

`Chat.advance` accepts submitted text or a bounded observed batch under `Chat.TurnControl`. Observed user speech can ground semantic/explicit answers with exact quotes. Observed assistant speech cannot become an issued workflow question; observed user speech cannot satisfy `Answer.confirmed` or bypass that restriction through an escape answer. The model receives only role/content, not observation metadata.

Persisted conversation messages carry an explicit source: `Submitted`, `Authored`, or `Observed`. Session adapters and low-level stage callers use `Session.Message.submitted(text)`, `Session.Message.authored(text)`, or `Session.Message.observed({ role, content, batchId, id })`. `Model.Message` remains a role/content DTO for model requests; it is not a persisted conversation message. Authorship alone does not issue a question or reply offer: the workflow must also record issuance and ownership.

This changes the low-level message and persistence contract. Existing untagged snapshots are rejected, not silently assigned authority. Migrate any existing history using its known origin before upgrading; do not classify transcript text as submitted or authored merely from its role. Ordinary `Chat.turn` and `Chat.advance` caller inputs remain unchanged.

Pure voice confirmation is intentionally unsupported. Use an explicit application submission for confirmed fields. The supplied session runner owns only Live events: finish it before calling `Chat.turn` on the same workflow, submit against the latest revision, then create a new Live session if needed. A custom single-owner application runtime can use `Chat.advance` to coordinate both channels; never concurrently call `Chat.turn`, `Chat.post`, or another writer outside that owner. The journal protects competing Live owners, not arbitrary external workflow writers.

An exact observed replay returns `AlreadyApplied` before checking an old revision and does not plan or execute again. Changed content or partial identity overlap fails. Both leaf and composed chats preserve observation provenance and batch ownership. Existing `Chat.turn` behavior is unchanged.

## Execution, delivery, and recovery

One action/delivery worker runs at a time, while incoming events and policy decisions continue. The journal marks command admission after planning and immediately before application execution. A correction before admission prevents the command; a correction after admission permits its real outcome to commit, publishes the outcome as superseded, and suppresses commentary that has not yet been attempted. Queries are checked again before commit. Every workflow storage attempt first records a pending commit in the journal; if this checkpoint fails, storage is not touched and `TurnControlUnavailable` reports `commit_checkpoint_failed`. Admission does not make an external mutation transactional: persist command receipts keyed by the existing `CommandId`, with tool and argument checks.

Presentation is journaled before either channel is used. Browser publication and voice delivery have independent states. Voice progresses from `Prepared` to `Attempted`, then `Accepted`, `Rejected`, or `Unknown`; unsent obsolete output becomes `Suppressed`. An append acknowledgement is not proof of speech or playback. A send failure may be ambiguous and is never automatically retried. A matching provider acknowledgement can resolve a previously unknown delivery. Once acceptance or rejection is recorded, a later local send failure neither overwrites it nor emits a contradictory notice.

A delegation's prepared presentation separately records whether a workflow revision committed. Clarification and `Live.say` do not advance the workflow; `Live.context.active.committed` becomes true only after a successful workflow commit checkpoint. Catching an error after command admission or a workflow storage attempt and returning fallback speech cannot erase an uncertain backend outcome: the session requires recovery instead, including for query and collector turns. Fallback speech remains possible when failure happened before either boundary.

The workflow snapshot, Live journal, and provider append do not share one transaction. If the process stops after a workflow commit but before presentation is saved, the runtime cannot reconstruct an ephemeral application result and must not replay the command. Failures retain the exclusive ownership claim and mark the journal interrupted when possible. Reusing an existing Live session or taking over an owned workflow produces `RecoveryRequired`.

Recovery is an application/operator procedure: establish that the prior executor has stopped, reconcile command receipts and the workflow revision, inspect prepared/unknown delivery, then deliberately resolve ownership with the persistence administrator or an application-specific journal implementation. There is no automatic lease expiry, reconnect replay, claim-reset helper, or exactly-once delivery claim. Never erase ownership just because a timeout elapsed.

The optional `stop` Effect is the application's shutdown signal. It stops admitting work, waits for active work/delivery, sends `session.close` in a scoped worker, and waits for `session.closed`. Provider events continue to be processed while the close write is pending; finalization cancels any remaining close worker when the run completes. The final summary contains cumulative usage, workflow revision, and delivery outcomes, not speech-heard status. A transport close without that event fails; after finalization is recorded, a socket error does not invalidate it. Applications should impose their own finalization deadline; timeout/interruption retains the recovery claim. Media cleanup belongs to the host.

The journal retains provider progress (`Open`, `CloseRequested`, `Finalized`) independently of execution lifecycle. If application publication fails after final usage arrives, execution is `Interrupted` but provider finalization and usage remain recorded.

## Bounds and verification

The journal retains at most 2,000 original fragments, 200,000 transcript characters, and 200 delegations/deliveries. Provider queues and the runtime mailbox are bounded at 256. Overflow fails instead of silently dropping evidence. Canonical workflow history remains bounded at 200 messages, reserving the entire input batch and output before model/tool execution. No automatic summarization or truncation is performed.

Tests cover exact replay, confirmation provenance, command admission, supersession during execution, post-commit failure, ambiguous append, receive/delivery concurrency, finalization, wire contracts, token preflight, bootstrap, inferred types, SQL round trips, and D1 ownership in workerd. These local tests do not establish real microphone/playback behavior, provider event timing, or the quality of an application's readiness policy. Run an authenticated end-to-end voice acceptance test before production use.

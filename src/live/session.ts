import {
  Data,
  Predicate,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import { ChatSessionSnapshotSchema, ChatSessionStore } from "../core/session.js"
import {
  TurnControlUnavailable,
  TurnSuperseded,
  type TurnControlService,
} from "../core/turn-control.js"
import { ActionScope } from "./action.js"
import {
  Binding,
  Connection,
  ConnectionFailure,
  Event,
  InvalidAction,
  InvalidPresentation,
  Presentation,
  Publisher,
  RecoveryRequired,
  Publication,
  type PublicationFailure,
} from "./contracts.js"
import type { JournalFailure } from "./journal.js"
import { Journal, identity } from "./journal.js"
import * as SessionState from "./state.js"
import type { State, Delegation, Delivery } from "./state.js"
import { Decision, DecisionScope } from "./transcript.js"

/** Final session outcome, independent of whether any commentary was heard. */
export interface Summary {
  readonly lifecycle: "Closed"
  readonly revision: string | null
  readonly usageSeconds: number
  readonly delegations: ReadonlyArray<{
    readonly id: string
    readonly phase: Delegation["phase"]["_tag"]
    readonly superseded: boolean
  }>
  readonly deliveries: ReadonlyArray<{
    readonly id: string
    readonly voice: Delivery["voice"]
    readonly browser: Delivery["browser"]
  }>
}

/** Expected runtime, journal, provider, or application-channel failure. */
export type Failure =
  | ConnectionFailure
  | InvalidAction
  | InvalidPresentation
  | JournalFailure
  | RecoveryRequired
  | PublicationFailure

type Mail<E, D> = Data.TaggedEnum<{
  Provider: { readonly event: Event }
  TransportEnded: {
    readonly exit: Exit.Exit<void, ConnectionFailure>
  }
  Resolved: {
    readonly id: string
    readonly generation: number
    readonly exit: Exit.Exit<Decision, D>
  }
  Acted: {
    readonly id: string
    readonly exit: Exit.Exit<Presentation, E>
  }
  Delivered: { readonly exit: Exit.Exit<void, Failure> }
  CloseSent: {
    readonly exit: Exit.Exit<void, ConnectionFailure>
  }
  Notified: {
    readonly exit: Exit.Exit<void, PublicationFailure>
  }
  Stop: {}
}>

const summary = (state: State): Summary => ({
  lifecycle: "Closed",
  revision: state.chatRevision,
  usageSeconds: state.usageSeconds,
  delegations: state.delegations.map(({ id, phase, intent }) => ({
    id,
    phase: phase._tag,
    superseded: intent === "Superseded",
  })),
  deliveries: state.deliveries.map(({ id, voice, browser }) => ({
    id,
    voice,
    browser,
  })),
})

/** Explicitly discard application notifications for a voice-only integration. */
export const withoutPublisher: Layer.Layer<Publisher> = Layer.succeed(
  Publisher,
  { publish: () => Effect.void },
)

/**
 * Own a complete client-delegation session. Actions and readiness policies are
 * ordinary Effects; only their runtime-owned context services are discharged.
 * A successful stop waits for session.closed. Failure retains durable ownership
 * for reconciliation, rather than assuming in-flight commands were cancelled.
 * @template E The action's expected failures.
 * @template R The action's required services.
 * @template D The readiness policy's expected failures.
 * @template DR The readiness policy's required services.
 */
export const run = <E, R, D, DR>(
  bindingInput: Binding,
  program: {
    readonly resolve: Effect.Effect<Decision, D, DR>
    readonly action: Effect.Effect<Presentation, E, R>
    readonly stop?: Effect.Effect<void>
  },
) =>
  Effect.gen(function* () {
    const binding = yield* Schema.decodeEffect(Binding)(bindingInput, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => new InvalidAction({ reason: "invalid_binding" })),
    )

    const connection = yield* Connection

    if (connection.sessionId !== binding.liveSessionId)
      return yield* new ConnectionFailure({ reason: "session_mismatch" })
    const journal = yield* Journal
    const publisher = yield* Publisher
    const store = yield* ChatSessionStore

    // Reject a known prior run before claiming ownership. The second check under
    // ownership protects against a concurrent owner completing between checks.
    if (Option.isSome(yield* journal.load(binding)))
      return yield* new RecoveryRequired({ reason: "session_interrupted" })

    const owned = yield* journal.own(
      binding,
      Effect.scoped(
        Effect.gen(function* () {
          const existing = yield* journal.load(binding)

          // A concurrent run may have completed after the initial precheck.
          // Return successfully from own so this unused claim is released.
          if (Option.isSome(existing)) return Option.none<Summary>()
          const raw = yield* store.load(binding)

          const snapshot =
            raw === null
              ? null
              : yield* Schema.decodeUnknownEffect(ChatSessionSnapshotSchema)(
                  raw,
                  { onExcessProperty: "error" },
                ).pipe(
                  Effect.mapError(
                    () => new InvalidAction({ reason: "invalid_state" }),
                  ),
                )

          const initial = SessionState.initial(
            binding,
            snapshot?.revision ?? null,
          )

          const revision = yield* journal.replace(
            binding,
            Option.none(),
            initial,
          )

          const current = yield* SynchronizedRef.make({
            revision,
            state: initial,
          })

          const key = yield* identity(binding)
          const Mail = Data.taggedEnum<Mail<E, D>>()
          const mailbox = yield* Queue.make<Mail<E, D>>({ capacity: 256 })

          // Workers own I/O, while only the mailbox consumer makes scheduling
          // decisions. Every worker reports its full Exit and belongs to this run.
          const forkWorker = <A, WE, WR>(
            work: Effect.Effect<A, WE, WR>,
            completed: (exit: Exit.Exit<A, WE>) => Mail<E, D>,
          ) =>
            work.pipe(
              Effect.exit,
              Effect.flatMap((exit) => Queue.offer(mailbox, completed(exit))),
              Effect.forkScoped,
            )

          const transact = <A, TE>(
            change: (
              state: State,
            ) => Effect.Effect<SessionState.Transition<A>, TE>,
          ) =>
            SynchronizedRef.modifyEffect(current, (previous) =>
              Effect.gen(function* () {
                const { value, state: next } = yield* change(previous.state)

                if (next === previous.state) return [value, previous] as const

                const nextRevision = yield* journal.replace(
                  binding,
                  Option.some(previous.revision),
                  next,
                )

                return [value, { revision: nextRevision, state: next }] as const
              }),
            )

          const read = SynchronizedRef.get(current).pipe(
            Effect.map(({ state }) => state),
          )

          // This is best-effort failure annotation, not the ownership release. If
          // storage is unavailable, the existing durable claim still prevents replay.
          yield* Effect.addFinalizer(() =>
            transact(SessionState.interrupt).pipe(
              Effect.catchTag("LiveJournalFailure", (error) =>
                Effect.logError("Live journal finalization unavailable", {
                  reason: error.reason,
                }),
              ),
            ),
          )

          yield* forkWorker(
            connection.events.pipe(
              Stream.runForEach((event) =>
                Queue.offer(mailbox, Mail.Provider({ event })),
              ),
            ),
            (exit) => Mail.TransportEnded({ exit }),
          )
          yield* (program.stop ?? Effect.never).pipe(
            Effect.andThen(Queue.offer(mailbox, Mail.Stop())),
            Effect.forkScoped,
          )

          let activeId: string | undefined
          let generation = 0
          let assessedGeneration = -1
          let resolving = false
          let pendingNotices = 0

          const notify = (
            notice: Extract<Publication, { readonly _tag: "Notice" }>,
          ) =>
            Effect.gen(function* () {
              pendingNotices += 1
              yield* forkWorker(publisher.publish(notice), (exit) =>
                Mail.Notified({
                  exit,
                }),
              )
            })

          const makeControl = (id: string): TurnControlService => ({
            check: () =>
              read.pipe(
                Effect.flatMap((state) => SessionState.check(state, id)),
              ),
            admitCommand: (commandId) =>
              transact((state) =>
                SessionState.admit(state, id, commandId),
              ).pipe(
                // Failed durable admission is operational failure, never normal supersession.
                Effect.catchTag("LiveJournalFailure", () =>
                  Effect.fail(
                    new TurnControlUnavailable({ reason: "admission_failed" }),
                  ),
                ),
              ),
            beforeCommit: () =>
              transact((state) => SessionState.beforeCommit(state, id)).pipe(
                Effect.catchTag("LiveJournalFailure", () =>
                  Effect.fail(
                    new TurnControlUnavailable({
                      reason: "commit_checkpoint_failed",
                    }),
                  ),
                ),
              ),
          })

          const deliver = (
            id: string,
            presentation: Presentation,
          ): Effect.Effect<void, Failure> =>
            Effect.gen(function* () {
              const delivery = yield* transact((state) =>
                SessionState.prepare(state, id, presentation, key),
              )

              const publication = yield* SessionState.publication(
                yield* read,
                delivery,
              )

              yield* publisher.publish(publication)
              yield* transact((state) =>
                SessionState.published(state, delivery.id),
              )

              const commentary = yield* transact((state) =>
                SessionState.attempt(state, delivery.id),
              )

              if (Option.isNone(commentary)) return

              const sent = yield* connection
                .commentary(commentary.value)
                .pipe(Effect.result)

              if (Predicate.isTagged(sent, "Failure")) {
                const outcome = Schema.is(InvalidPresentation)(sent.failure)
                  ? "Rejected"
                  : "Unknown"

                const notice = yield* transact((state) =>
                  SessionState.deliveryFailed(state, delivery.id, outcome),
                )

                if (Option.isSome(notice))
                  yield* publisher.publish(notice.value)
              }
            })

          while (true) {
            const state = yield* read

            if (
              state.provider === "Finalized" &&
              activeId === undefined &&
              pendingNotices === 0
            ) {
              yield* transact(SessionState.finish)

              return Option.some(summary(yield* read))
            }

            if (
              state.lifecycle === "Closing" &&
              activeId === undefined &&
              pendingNotices === 0 &&
              state.provider === "Open"
            ) {
              yield* transact(SessionState.requestClose)
              yield* forkWorker(connection.close(), (exit) =>
                Mail.CloseSent({
                  exit,
                }),
              )
            }

            if (
              state.lifecycle === "Running" &&
              !resolving &&
              generation !== assessedGeneration
            ) {
              const selected = SessionState.context(state, activeId)

              if (Option.isSome(selected)) {
                const decisionContext = selected.value
                resolving = true
                const observedGeneration = generation
                yield* forkWorker(
                  program.resolve.pipe(
                    Effect.provideService(DecisionScope, decisionContext),
                  ),
                  (exit) =>
                    Mail.Resolved({
                      id: decisionContext.delegation.id,
                      generation: observedGeneration,
                      exit,
                    }),
                )
              }
            }

            const message = yield* Queue.take(mailbox)

            switch (message._tag) {
              case "Stop":
                yield* transact(SessionState.stop)
                generation += 1
                break
              case "TransportEnded":
                // A transport close after final usage does not invalidate finalization.
                if (state.provider === "Finalized") break

                if (Exit.isFailure(message.exit))
                  return yield* Effect.failCause(message.exit.cause)

                return yield* new ConnectionFailure({
                  reason: "unexpected_end",
                })
              case "CloseSent":
                if (
                  state.provider !== "Finalized" &&
                  Exit.isFailure(message.exit)
                )
                  return yield* Effect.failCause(message.exit.cause)
                break
              case "Resolved": {
                resolving = false

                if (message.generation !== generation) break

                if (Exit.isFailure(message.exit))
                  return yield* Effect.failCause(message.exit.cause)
                assessedGeneration = generation

                const decision = yield* Schema.decodeEffect(Decision)(
                  message.exit.value,
                  { onExcessProperty: "error" },
                ).pipe(
                  Effect.mapError(
                    () => new InvalidAction({ reason: "invalid_decision" }),
                  ),
                )

                const latest = yield* read

                if (latest.lifecycle !== "Running") break

                if (Decision.guards.Await(decision)) break

                if (Decision.guards.Supersede(decision)) {
                  if (decision.delegationId !== activeId)
                    return yield* new InvalidAction({
                      reason: "invalid_decision",
                    })

                  const changed = yield* transact((state) =>
                    SessionState.supersede(state, decision.delegationId),
                  )

                  if (changed) generation += 1
                  break
                }

                if (activeId !== undefined) break

                if (Decision.guards.Clarify(decision)) {
                  activeId = message.id
                  yield* forkWorker(
                    deliver(message.id, {
                      speech: decision.speech,
                      browser: null,
                    }),
                    (exit) => Mail.Delivered({ exit }),
                  )
                  break
                }

                const turnInput = yield* transact((state) =>
                  SessionState.claim(
                    state,
                    message.id,
                    decision.throughEventId,
                    key,
                  ),
                )

                activeId = message.id
                const began = yield* Ref.make(false)

                const actionScope = ActionScope.of({
                  binding,
                  input: turnInput,
                  control: makeControl(message.id),
                  begin: () =>
                    Ref.getAndSet(began, true).pipe(
                      Effect.flatMap((used) =>
                        used
                          ? Effect.fail(
                              new InvalidAction({ reason: "multiple_turns" }),
                            )
                          : Effect.void,
                      ),
                    ),
                  committed: (revision) =>
                    transact((state) =>
                      SessionState.commit(state, message.id, revision),
                    ),
                })

                yield* forkWorker(
                  program.action.pipe(
                    Effect.provideService(ActionScope, actionScope),
                  ),
                  (exit) => Mail.Acted({ id: message.id, exit }),
                )
                break
              }

              case "Acted": {
                generation += 1

                if (Exit.isFailure(message.exit)) {
                  const error = Exit.findErrorOption(message.exit)

                  if (
                    Option.isSome(error) &&
                    Schema.is(TurnSuperseded)(error.value)
                  ) {
                    yield* transact((state) =>
                      SessionState.abandon(state, message.id),
                    )
                    yield* notify(
                      Publication.Notice({
                        id: `${key}.${message.id}.superseded`,
                        reason: "superseded",
                      }),
                    )
                    activeId = undefined
                    break
                  }

                  return yield* Effect.failCause(message.exit.cause)
                }

                const presentation = yield* Schema.decodeEffect(Presentation)(
                  message.exit.value,
                  { onExcessProperty: "error" },
                ).pipe(
                  Effect.mapError(
                    () => new InvalidPresentation({ reason: "invalid_output" }),
                  ),
                )

                yield* forkWorker(deliver(message.id, presentation), (exit) =>
                  Mail.Delivered({ exit }),
                )
                break
              }

              case "Delivered":
                if (Exit.isFailure(message.exit))
                  return yield* Effect.failCause(message.exit.cause)
                activeId = undefined
                generation += 1
                break
              case "Notified":
                pendingNotices -= 1

                if (Exit.isFailure(message.exit))
                  return yield* Effect.failCause(message.exit.cause)
                break
              case "Provider": {
                const event = yield* Schema.decodeEffect(Event)(message.event, {
                  onExcessProperty: "error",
                }).pipe(
                  Effect.mapError(
                    () => new ConnectionFailure({ reason: "invalid_event" }),
                  ),
                )

                const ingestion = yield* transact((state) =>
                  SessionState.observe(state, event),
                )

                if (ingestion.reassess) generation += 1

                if (Option.isSome(ingestion.notice))
                  yield* notify(ingestion.notice.value)
                break
              }
            }
          }
        }),
      ),
    )

    if (Option.isNone(owned))
      return yield* new RecoveryRequired({ reason: "session_interrupted" })

    return owned.value
  }).pipe(Effect.withSpan("popcomputer.structured_chat.live.session"))

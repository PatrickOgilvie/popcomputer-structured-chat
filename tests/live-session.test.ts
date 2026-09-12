import { describe, expect, test } from "bun:test"
import {
  Predicate,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect"
import { Chat, Model, Session, Stage, Tool } from "../src/index.js"
import * as Live from "../src/integrations/live.js"
import { inMemoryChatSessionStore, Scenario } from "../src/testing.js"

const Search = Tool.define({
  name: "search",
  description: "Search",
  input: Schema.Struct({ query: Schema.String }),
  execute: ({ query }) => Effect.succeed({ query }),
})

const Lookup = Chat.define({
  name: "live_lookup",
  version: 1,
  stages: [
    Stage.tools({ name: "lookup", instructions: ["Search"], tools: [Search] }),
  ],
})

const binding: Live.Binding = {
  liveSessionId: "opaque-provider-session",
  namespace: "account-1",
  sessionId: "workflow-1",
  chat: Lookup.name,
  version: Lookup.version,
}

const persistence = Live.journal({ namespace: "voice-journals" }).pipe(
  Layer.provideMerge(inMemoryChatSessionStore),
)

const resolve = Live.context.pipe(
  Effect.map((context) =>
    Option.isSome(context.active) || Option.isNone(context.candidate)
      ? Live.awaitContext
      : Live.ready(context.candidate.value),
  ),
)

const action = Effect.gen(function* () {
  const reply = yield* Live.turn(Lookup)

  return yield* Live.present(reply, { speech: "Found the result." })
})

const delegated: Live.Event = {
  _tag: "Delegated",
  eventId: "delegation-event",
  delegationId: "opaque-delegation",
  offsetMs: 1_000,
}

const transcript = (
  eventId: string,
  delta: string,
  role: "user" | "assistant" = "user",
): Live.Event => ({
  _tag: "Transcript",
  fragment: { eventId, role, delta, startMs: 0, endMs: 1_000 },
})

describe("Live action runtime", () => {
  test.each(["clarify", "say", "turn"] as const)(
    "reports workflow commitment independently of prepared %s output",
    async (kind) => {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()
          const publishing = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const inspected = yield* Deferred.make<Live.DecisionContext>()
          const stop = yield* Deferred.make<void>()
          yield* Queue.offerAll(events, [
            transcript("u", "Find history"),
            delegated,
          ])

          const policy = Effect.gen(function* () {
            const context = yield* Live.context

            if (Option.isSome(context.active)) {
              if (context.transcript.some(({ eventId }) => eventId === "later"))
                yield* Deferred.succeed(inspected, context)

              return Live.awaitContext
            }

            if (kind === "clarify")
              return Live.Decision.cases.Clarify.make({
                speech: "Which period?",
              })

            return Option.isSome(context.candidate)
              ? Live.ready(context.candidate.value)
              : Live.awaitContext
          })

          const fiber = yield* Live.run(binding, {
            resolve: policy,
            action: kind === "turn" ? action : Live.say("Which period?"),
            stop: Deferred.await(stop),
          }).pipe(
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: () =>
                Deferred.succeed(stop, undefined).pipe(Effect.asVoid),
              close: () =>
                Queue.offer(events, { _tag: "Closed", seconds: 1 }).pipe(
                  Effect.asVoid,
                ),
            }),
            Effect.provideService(Live.Publisher, {
              publish: () =>
                Deferred.succeed(publishing, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                ),
            }),
            Effect.forkScoped,
          )

          yield* Deferred.await(publishing)
          yield* Queue.offer(events, transcript("later", "More context"))
          const context = yield* Deferred.await(inspected)
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(fiber)

          return { context, result }
        }).pipe(
          Effect.scoped,
          Effect.provide(persistence),
          Effect.provide(
            Scenario.model(Scenario.call(Search, { query: "history" })),
          ),
        ),
      )

      expect(output.context.active).toMatchObject({
        _tag: "Some",
        value: { committed: kind === "turn", commandAdmitted: false },
      })
      expect(output.result.revision).toBe(kind === "turn" ? "1" : null)
    },
  )

  test.each(["supersede", "fallback"] as const)(
    "never erases an admitted command when application code reports %s",
    async (kind) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()

          const Commit = Tool.command({
            name: "commit",
            description: "Commit",
            input: Schema.Struct({}),
            execute: () =>
              Effect.fail(new Chat.TurnSuperseded({ reason: "newer_intent" })),
          })

          const Workflow = Chat.define({
            name: "late_supersession",
            version: 1,
            stages: [
              Stage.command({
                name: "commit",
                instructions: ["Commit"],
                command: Commit,
              }),
            ],
          })

          const scope = { ...binding, chat: Workflow.name }
          yield* Queue.offerAll(events, [transcript("u", "Commit"), delegated])

          const result = yield* Live.run(scope, {
            resolve,
            action: Live.turn(Workflow).pipe(
              Effect.catchTag("TurnSuperseded", (error) =>
                kind === "fallback" ? Effect.void : Effect.fail(error),
              ),
              Effect.flatMap(() => Live.say("Done")),
            ),
          }).pipe(
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: () => Effect.die("No safe result"),
              close: () => Effect.void,
            }),
            Effect.provide(Live.withoutPublisher),
            Effect.provide(Scenario.model(Scenario.call(Commit, {}))),
            Effect.result,
          )

          const journal = yield* Live.Journal

          return {
            result,
            snapshot: yield* journal.load(scope),
            takeover: yield* journal
              .own(scope, Effect.void)
              .pipe(Effect.result),
          }
        }).pipe(Effect.provide(persistence)),
      )

      expect(result.result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "backend_outcome_unknown" },
      })
      expect(result.snapshot).toMatchObject({
        _tag: "Some",
        value: {
          state: {
            lifecycle: "Interrupted",
            delegations: [
              {
                phase: {
                  _tag: "Running",
                  commandId: expect.stringMatching(/^cmd_/),
                },
              },
            ],
          },
        },
      })
      expect(result.takeover).toMatchObject({
        _tag: "Failure",
        failure: { reason: "session_already_owned" },
      })
    },
  )

  test("keeps receiving during rejection notifications, ignores unrelated rejections, and drains notices on close", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const notified = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const closed = yield* Deferred.make<void>()
        const notices = yield* Ref.make(0)
        const journal = yield* Live.Journal
        yield* Queue.offerAll(events, [
          transcript("u", "Find history"),
          delegated,
        ])

        const fiber = yield* Live.run(binding, { resolve, action }).pipe(
          Effect.provideService(Live.Journal, {
            ...journal,
            replace: (scope, revision, state) =>
              journal
                .replace(scope, revision, state)
                .pipe(
                  Effect.tap(() =>
                    state.lifecycle === "Closing"
                      ? Deferred.succeed(closed, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: (append) =>
              Queue.offerAll(events, [
                {
                  _tag: "Rejected",
                  eventId: "other",
                  clientEventId: "unrelated-browser-command",
                },
                {
                  _tag: "Rejected",
                  eventId: "reject",
                  clientEventId: append.eventId,
                },
              ]).pipe(Effect.asVoid),
            close: () => Effect.die("Provider closed independently"),
          }),
          Effect.provideService(Live.Publisher, {
            publish: (publication) =>
              Predicate.isTagged(publication, "Presentation")
                ? Effect.void
                : Ref.update(notices, (value) => value + 1).pipe(
                    Effect.andThen(Deferred.succeed(notified, undefined)),
                    Effect.andThen(Deferred.await(release)),
                  ),
          }),
          Effect.forkScoped,
        )

        yield* Deferred.await(notified)
        yield* Queue.offer(events, { _tag: "Closed", seconds: 6 })
        yield* Deferred.await(closed)
        yield* Deferred.succeed(release, undefined)

        return {
          result: yield* Fiber.join(fiber),
          notices: yield* Ref.get(notices),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(persistence),
        Effect.provide(
          Scenario.model(Scenario.call(Search, { query: "history" })),
        ),
      ),
    )

    expect(result.notices).toBe(1)
    expect(result.result.deliveries).toMatchObject([
      { voice: "Rejected", browser: "Published" },
    ])
    expect(result.result.usageSeconds).toBe(6)
  })

  test("runs one ordinary Effect action, journals its reply, and delivers voice and views separately", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const sent = yield* Ref.make<ReadonlyArray<Live.Commentary>>([])
        const published = yield* Ref.make<ReadonlyArray<Live.Publication>>([])
        const stop = yield* Deferred.make<void>()
        yield* Queue.offerAll(events, [
          transcript("user-1", "Find history"),
          delegated,
          delegated,
        ])

        const result = yield* Live.run(binding, {
          resolve,
          action,
          stop: Deferred.await(stop),
        }).pipe(
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: (append) =>
              Ref.update(sent, (values) => [...values, append]).pipe(
                Effect.andThen(
                  Queue.offer(events, {
                    _tag: "Accepted",
                    eventId: "accepted",
                    clientEventId: append.eventId,
                  }),
                ),
                Effect.andThen(Deferred.succeed(stop, undefined)),
                Effect.asVoid,
              ),
            close: () =>
              Queue.offer(events, { _tag: "Closed", seconds: 12 }).pipe(
                Effect.asVoid,
              ),
          }),
          Effect.provideService(Live.Publisher, {
            publish: (publication) =>
              Ref.update(published, (values) => [...values, publication]),
          }),
        )

        return {
          result,
          sent: yield* Ref.get(sent),
          published: yield* Ref.get(published),
        }
      }).pipe(
        Effect.provide(persistence),
        Effect.provide(
          Scenario.model(Scenario.call(Search, { query: "history" })),
        ),
      ),
    )

    expect(output.result.lifecycle).toBe("Closed")
    expect(output.result.revision).toBe("1")
    expect(output.result.usageSeconds).toBe(12)
    expect(output.result.deliveries).toMatchObject([
      { voice: "Accepted", browser: "Published" },
    ])
    expect(output.sent).toHaveLength(1)
    expect(output.sent[0]).toMatchObject({
      delegationId: "opaque-delegation",
      content: "Found the result.",
    })
    expect(output.published).toMatchObject([
      {
        _tag: "Presentation",
        superseded: false,
        presentation: {
          browser: { session: { id: binding.sessionId, revision: "1" } },
        },
      },
    ])
  })

  test("waits for late transcript and preserves exact fragments without fabricating word separators", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const awaiting = yield* Deferred.make<void>()
        const stop = yield* Deferred.make<void>()
        const seen = yield* Ref.make<ReadonlyArray<Model.UntrustedMessage>>([])

        const delayedResolver = Effect.gen(function* () {
          const context = yield* Live.context

          if (Option.isNone(context.candidate)) {
            yield* Deferred.succeed(awaiting, undefined)

            return Live.awaitContext
          }

          return Option.isSome(context.active)
            ? Live.awaitContext
            : Live.ready(context.candidate.value)
        })

        const fiber = yield* Live.run(binding, {
          resolve: delayedResolver,
          action,
          stop: Deferred.await(stop),
        }).pipe(
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: () =>
              Deferred.succeed(stop, undefined).pipe(Effect.asVoid),
            close: () =>
              Queue.offer(events, { _tag: "Closed", seconds: 3 }).pipe(
                Effect.asVoid,
              ),
          }),
          Effect.provide(Live.withoutPublisher),
          Effect.provideService(Model.Service, {
            requestTool: (request) =>
              Ref.set(seen, request.untrustedMessages).pipe(
                Effect.as({ name: "search", arguments: { query: "history" } }),
              ),
          }),
          Effect.forkScoped,
        )

        yield* Queue.offer(events, delegated)
        yield* Deferred.await(awaiting)
        yield* Queue.offerAll(events, [
          transcript("fragment-1", "Find his"),
          transcript("fragment-2", "tory"),
        ])
        yield* Fiber.join(fiber)

        return yield* Ref.get(seen)
      }).pipe(Effect.scoped, Effect.provide(persistence)),
    )

    expect(observed).toEqual([{ role: "user", content: "Find history" }])
  })

  test.each([false, true])(
    "supersession respects the durable command-admission boundary (admitted: %s)",
    async (admitted) => {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()
          const started = yield* Deferred.make<void>()
          const superseded = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const stop = yield* Deferred.make<void>()
          const commands = yield* Ref.make(0)
          const sent = yield* Ref.make(0)

          const publications = yield* Ref.make<ReadonlyArray<Live.Publication>>(
            [],
          )

          const pause = Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )

          const Commit = Tool.command({
            name: "commit",
            description: "Commit",
            input: Schema.Struct({}),
            execute: () =>
              Ref.update(commands, (value) => value + 1).pipe(
                Effect.andThen(admitted ? pause : Effect.void),
              ),
          })

          const Workflow = Chat.define({
            name: "commit_workflow",
            version: 1,
            stages: [
              Stage.command({
                name: "commit",
                instructions: ["Commit"],
                command: Commit,
              }),
            ],
          })

          const policy = Effect.gen(function* () {
            const context = yield* Live.context

            if (Option.isSome(context.active)) {
              if (context.active.value.superseded) {
                yield* Deferred.succeed(superseded, undefined)

                return Live.awaitContext
              }

              return context.transcript.some(
                ({ delta }) => delta === "Actually, stop.",
              )
                ? Live.supersede(context.active.value.delegationId)
                : Live.awaitContext
            }

            return Option.isSome(context.candidate)
              ? Live.ready(context.candidate.value)
              : Live.awaitContext
          })

          yield* Queue.offerAll(events, [transcript("u", "Commit."), delegated])

          const fiber = yield* Live.run(
            { ...binding, chat: Workflow.name },
            {
              resolve: policy,
              action: Live.turn(Workflow).pipe(
                Effect.flatMap((reply) =>
                  Live.present(reply, { speech: "Committed." }),
                ),
              ),
              stop: Deferred.await(stop),
            },
          ).pipe(
            Effect.provideService(Model.Service, {
              requestTool: () =>
                (admitted ? Effect.void : pause).pipe(
                  Effect.as({ name: "commit", arguments: {} }),
                ),
            }),
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: () => Ref.update(sent, (value) => value + 1),
              close: () =>
                Queue.offer(events, { _tag: "Closed", seconds: 4 }).pipe(
                  Effect.asVoid,
                ),
            }),
            Effect.provideService(Live.Publisher, {
              publish: (publication) =>
                Ref.update(publications, (values) => [
                  ...values,
                  publication,
                ]).pipe(
                  Effect.andThen(Deferred.succeed(stop, undefined)),
                  Effect.asVoid,
                ),
            }),
            Effect.forkScoped,
          )

          yield* Deferred.await(started)
          yield* Queue.offerAll(events, [
            delegated,
            transcript("correction", "Actually, stop."),
          ])
          yield* Deferred.await(superseded)
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(fiber)

          return {
            result,
            commands: yield* Ref.get(commands),
            sent: yield* Ref.get(sent),
            publications: yield* Ref.get(publications),
          }
        }).pipe(Effect.scoped, Effect.provide(persistence)),
      )

      expect(output.commands).toBe(admitted ? 1 : 0)
      expect(output.sent).toBe(0)
      expect(output.result.revision).toBe(admitted ? "1" : null)
      expect(output.result.delegations).toMatchObject([
        { phase: admitted ? "Prepared" : "Superseded", superseded: true },
      ])
      expect(output.publications).toMatchObject(
        admitted
          ? [{ _tag: "Presentation", superseded: true }]
          : [{ _tag: "Notice", reason: "superseded" }],
      )
    },
  )

  test("an ambiguous append is journaled Unknown and never blindly resent", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const stop = yield* Deferred.make<void>()
        const sends = yield* Ref.make(0)
        yield* Queue.offerAll(events, [
          transcript("u", "Find history"),
          delegated,
        ])

        const result = yield* Live.run(binding, {
          resolve,
          action,
          stop: Deferred.await(stop),
        }).pipe(
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: () =>
              Ref.update(sends, (value) => value + 1).pipe(
                Effect.andThen(Queue.offer(events, delegated)),
                Effect.andThen(
                  Effect.fail(
                    new Live.ConnectionFailure({ reason: "write_failed" }),
                  ),
                ),
              ),
            close: () =>
              Queue.offerAll(events, [
                { _tag: "Usage", seconds: 8 },
                { _tag: "Usage", seconds: 5 },
                { _tag: "Closed", seconds: 10 },
              ]).pipe(Effect.asVoid),
          }),
          Effect.provideService(Live.Publisher, {
            publish: (publication) =>
              Predicate.isTagged(publication, "Notice")
                ? Deferred.succeed(stop, undefined).pipe(Effect.asVoid)
                : Effect.void,
          }),
        )

        return { result, sends: yield* Ref.get(sends) }
      }).pipe(
        Effect.provide(persistence),
        Effect.provide(
          Scenario.model(Scenario.call(Search, { query: "history" })),
        ),
      ),
    )

    expect(output.sends).toBe(1)
    expect(output.result.usageSeconds).toBe(10)
    expect(output.result.deliveries).toMatchObject([
      { voice: "Unknown", browser: "Published" },
    ])
  })

  test("keeps receiving while publication is blocked and honors finalization before socket failure", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event, Live.ConnectionFailure>()
        const publishing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sawClose = yield* Deferred.make<void>()
        yield* Queue.offerAll(events, [
          transcript("u", "Find history"),
          delegated,
        ])
        const journal = yield* Live.Journal

        const fiber = yield* Live.run(binding, { resolve, action }).pipe(
          Effect.provideService(Live.Journal, {
            ...journal,
            replace: (scope, revision, state) =>
              journal
                .replace(scope, revision, state)
                .pipe(
                  Effect.tap(() =>
                    state.lifecycle === "Closing"
                      ? Deferred.succeed(sawClose, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: () => Effect.die("Must not send after session.closed"),
            close: () => Effect.die("Provider already closed"),
          }),
          Effect.provideService(Live.Publisher, {
            publish: () =>
              Deferred.succeed(publishing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
          }),
          Effect.forkScoped,
        )

        yield* Deferred.await(publishing)
        yield* Queue.offer(events, { _tag: "Closed", seconds: 9 })
        yield* Queue.fail(
          events,
          new Live.ConnectionFailure({ reason: "read_failed" }),
        )
        yield* Deferred.await(sawClose)
        yield* Deferred.succeed(release, undefined)

        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.scoped,
        Effect.provide(persistence),
        Effect.provide(
          Scenario.model(Scenario.call(Search, { query: "history" })),
        ),
      ),
    )

    expect(result.lifecycle).toBe("Closed")
    expect(result.usageSeconds).toBe(9)
    expect(result.deliveries).toMatchObject([{ voice: "Suppressed" }])
  })

  test("fails a lost durable admission without executing or relinquishing ownership", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const commands = yield* Ref.make(0)
        const journal = yield* Live.Journal

        const Commit = Tool.command({
          name: "commit",
          description: "Commit",
          input: Schema.Struct({}),
          execute: () => Ref.update(commands, (value) => value + 1),
        })

        const Workflow = Chat.define({
          name: "commit_workflow",
          version: 1,
          stages: [
            Stage.command({
              name: "commit",
              instructions: ["Commit"],
              command: Commit,
            }),
          ],
        })

        const scope = { ...binding, chat: Workflow.name }
        yield* Queue.offerAll(events, [transcript("u", "Commit"), delegated])

        const result = yield* Live.run(scope, {
          resolve,
          action: Live.turn(Workflow).pipe(
            Effect.flatMap((reply) =>
              Live.present(reply, { speech: "Committed." }),
            ),
          ),
        }).pipe(
          Effect.provideService(Live.Journal, {
            ...journal,
            replace: (scope, revision, state) =>
              state.delegations.some(
                ({ phase }) =>
                  Predicate.isTagged(phase, "Running") &&
                  phase.commandId !== null,
              )
                ? Effect.fail(
                    new Live.JournalFailure({ reason: "write_failed" }),
                  )
                : journal.replace(scope, revision, state),
          }),
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: () => Effect.die("No admission, no delivery"),
            close: () => Effect.void,
          }),
          Effect.provide(Live.withoutPublisher),
          Effect.provide(Scenario.model(Scenario.call(Commit, {}))),
          Effect.result,
        )

        return {
          result,
          commands: yield* Ref.get(commands),
          owner: yield* journal.own(scope, Effect.void).pipe(Effect.result),
        }
      }).pipe(Effect.provide(persistence)),
    )

    expect(output.commands).toBe(0)
    expect(output.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TurnControlUnavailable", reason: "admission_failed" },
    })
    expect(output.owner).toMatchObject({
      _tag: "Failure",
      failure: { reason: "session_already_owned" },
    })
  })

  test("a post-commit application failure preserves its typed error and requires reconciliation", async () => {
    class ProjectionFailed extends Schema.TaggedError<ProjectionFailed>()(
      "ProjectionFailed",
      {},
    ) {}

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const journal = yield* Live.Journal
        const store = yield* Session.Store
        yield* Queue.offerAll(events, [
          transcript("u", "Find history"),
          delegated,
        ])

        const result = yield* Live.run(binding, {
          resolve,
          action: Live.turn(Lookup).pipe(
            Effect.andThen(Effect.fail(new ProjectionFailed({}))),
          ),
        }).pipe(
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: () => Effect.die("No projection, no delivery"),
            close: () => Effect.void,
          }),
          Effect.provide(Live.withoutPublisher),
          Effect.result,
        )

        return {
          result,
          journal: yield* journal.load(binding),
          snapshot: yield* store.load(binding),
          takeover: yield* journal
            .own({ ...binding, liveSessionId: "replacement" }, Effect.void)
            .pipe(Effect.result),
        }
      }).pipe(
        Effect.provide(persistence),
        Effect.provide(
          Scenario.model(Scenario.call(Search, { query: "history" })),
        ),
      ),
    )

    expect(output.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProjectionFailed" },
    })
    expect(output.snapshot).toMatchObject({ revision: "1" })
    expect(output.journal).toMatchObject({
      _tag: "Some",
      value: {
        state: {
          lifecycle: "Interrupted",
          delegations: [{ phase: { _tag: "Committed", revision: "1" } }],
        },
      },
    })
    expect(output.takeover).toMatchObject({
      _tag: "Failure",
      failure: { reason: "session_already_owned" },
    })
  })

  test.each(["journal", "workflow"] as const)(
    "a caught %s failure after query commitment cannot erase workflow progress",
    async (boundary) => {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()
          const journal = yield* Live.Journal
          const store = yield* Session.Store
          yield* Queue.offerAll(events, [
            transcript("u", "Find history"),
            delegated,
          ])

          const result = yield* Live.run(binding, {
            resolve,
            action: action.pipe(
              Effect.catchTag(
                ["LiveJournalFailure", "ChatSessionStoreUnavailable"],
                () => Live.say("Please try again."),
              ),
            ),
          }).pipe(
            Effect.provideService(Live.Journal, {
              ...journal,
              replace: (scope, revision, state) =>
                boundary === "journal" &&
                state.delegations.some(({ phase }) =>
                  Predicate.isTagged(phase, "Committed"),
                )
                  ? Effect.fail(
                      new Live.JournalFailure({ reason: "write_failed" }),
                    )
                  : journal.replace(scope, revision, state),
            }),
            Effect.provideService(Session.Store, {
              ...store,
              replace: (input) =>
                store.replace(input).pipe(
                  Effect.tap(() =>
                    boundary === "workflow" &&
                    input.namespace === binding.namespace
                      ? Effect.fail(
                          new Session.StoreUnavailable({
                            reason: "write_failed",
                          }),
                        )
                      : Effect.void,
                  ),
                ),
            }),
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: () =>
                Effect.die("Uncertain commitment must not be delivered"),
              close: () =>
                Effect.die("Uncertain commitment must not close normally"),
            }),
            Effect.provide(Live.withoutPublisher),
            Effect.result,
          )

          return {
            result,
            snapshot: yield* store.load(binding),
            journal: yield* journal.load(binding),
            takeover: yield* journal
              .own(binding, Effect.void)
              .pipe(Effect.result),
          }
        }).pipe(
          Effect.provide(persistence),
          Effect.provide(
            Scenario.model(Scenario.call(Search, { query: "history" })),
          ),
        ),
      )

      expect(output.result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "LiveRecoveryRequired",
          reason: "backend_outcome_unknown",
        },
      })
      expect(output.snapshot).toMatchObject({ revision: "1" })
      expect(output.journal).toMatchObject({
        _tag: "Some",
        value: {
          state: {
            lifecycle: "Interrupted",
            delegations: [
              {
                phase: { _tag: "Running", commandId: null, commit: "Pending" },
              },
            ],
            deliveries: [],
          },
        },
      })
      expect(output.takeover).toMatchObject({
        _tag: "Failure",
        failure: { reason: "session_already_owned" },
      })
    },
  )

  test.each(["propagated", "caught"] as const)(
    "a %s pre-commit checkpoint failure never touches workflow storage",
    async (handling) => {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()
          const stop = yield* Deferred.make<void>()
          const journal = yield* Live.Journal
          const store = yield* Session.Store
          yield* Queue.offerAll(events, [
            transcript("u", "Find history"),
            delegated,
          ])

          const result = yield* Live.run(binding, {
            resolve,
            action:
              handling === "caught"
                ? action.pipe(
                    Effect.catchTag("TurnControlUnavailable", () =>
                      Live.say("Please try again."),
                    ),
                  )
                : action,
            stop: Deferred.await(stop),
          }).pipe(
            Effect.provideService(Live.Journal, {
              ...journal,
              replace: (scope, revision, state) =>
                state.delegations.some(
                  ({ phase }) =>
                    Predicate.isTagged(phase, "Running") &&
                    phase.commit === "Pending",
                )
                  ? Effect.fail(
                      new Live.JournalFailure({ reason: "write_failed" }),
                    )
                  : journal.replace(scope, revision, state),
            }),
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: () =>
                Deferred.succeed(stop, undefined).pipe(Effect.asVoid),
              close: () =>
                Queue.offer(events, { _tag: "Closed", seconds: 1 }).pipe(
                  Effect.asVoid,
                ),
            }),
            Effect.provide(Live.withoutPublisher),
            Effect.result,
          )

          return {
            result,
            snapshot: yield* store.load(binding),
            takeover: yield* journal
              .own(binding, Effect.void)
              .pipe(Effect.result),
          }
        }).pipe(
          Effect.provide(persistence),
          Effect.provide(
            Scenario.model(Scenario.call(Search, { query: "history" })),
          ),
        ),
      )

      expect(output.result).toMatchObject(
        handling === "caught"
          ? {
              _tag: "Success",
              success: { lifecycle: "Closed", revision: null },
            }
          : {
              _tag: "Failure",
              failure: {
                _tag: "TurnControlUnavailable",
                reason: "commit_checkpoint_failed",
              },
            },
      )
      expect(output.takeover._tag).toBe(
        handling === "caught" ? "Success" : "Failure",
      )
      expect(output.snapshot).toBeNull()
    },
  )

  test.each(["Accepted", "Rejected"] as const)(
    "publishes no contradictory notice when %s precedes a write failure",
    async (acknowledgement) => {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()
          const acknowledged = yield* Deferred.make<void>()
          const stop = yield* Deferred.make<void>()

          const publications = yield* Ref.make<ReadonlyArray<Live.Publication>>(
            [],
          )

          const journal = yield* Live.Journal
          yield* Queue.offerAll(events, [
            transcript("u", "Find history"),
            delegated,
          ])

          const result = yield* Live.run(binding, {
            resolve,
            action: Live.say("Which period?"),
            stop: Deferred.await(stop),
          }).pipe(
            Effect.provideService(Live.Journal, {
              ...journal,
              replace: (scope, revision, state) =>
                journal
                  .replace(scope, revision, state)
                  .pipe(
                    Effect.tap(() =>
                      state.deliveries.some(
                        ({ voice }) => voice === acknowledgement,
                      )
                        ? Deferred.succeed(acknowledged, undefined)
                        : Effect.void,
                    ),
                  ),
            }),
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: (append) =>
                Queue.offer(events, {
                  _tag: acknowledgement,
                  eventId: "ack",
                  clientEventId: append.eventId,
                }).pipe(
                  Effect.andThen(Deferred.await(acknowledged)),
                  Effect.andThen(Deferred.succeed(stop, undefined)),
                  Effect.andThen(
                    Effect.fail(
                      new Live.ConnectionFailure({ reason: "write_failed" }),
                    ),
                  ),
                ),
              close: () =>
                Queue.offer(events, { _tag: "Closed", seconds: 1 }).pipe(
                  Effect.asVoid,
                ),
            }),
            Effect.provideService(Live.Publisher, {
              publish: (publication) =>
                Ref.update(publications, (values) => [...values, publication]),
            }),
          )

          return {
            result,
            publications: yield* Ref.get(publications),
            snapshot: yield* journal.load(binding),
          }
        }).pipe(Effect.provide(persistence)),
      )

      expect(output.result.deliveries).toMatchObject([
        { voice: acknowledgement },
      ])
      expect(output.snapshot).toMatchObject({
        _tag: "Some",
        value: { state: { deliveries: [{ voice: acknowledgement }] } },
      })
      expect(
        output.publications.filter(({ _tag }) => _tag === "Notice"),
      ).toMatchObject(
        acknowledgement === "Rejected" ? [{ reason: "delivery_rejected" }] : [],
      )
    },
  )

  test("retains provider finalization when application publication subsequently fails", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* Queue.make<Live.Event>()
        const publishing = yield* Deferred.make<void>()
        const providerClosed = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const journal = yield* Live.Journal
        yield* Queue.offerAll(events, [
          transcript("u", "Find history"),
          delegated,
        ])

        const fiber = yield* Live.run(binding, { resolve, action }).pipe(
          Effect.provideService(Live.Journal, {
            ...journal,
            replace: (scope, revision, state) =>
              journal
                .replace(scope, revision, state)
                .pipe(
                  Effect.tap(() =>
                    state.lifecycle === "Closing"
                      ? Deferred.succeed(providerClosed, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.fromQueue(events),
            commentary: () =>
              Effect.die("Finalized provider must not receive commentary"),
            close: () => Effect.die("Provider already finalized"),
          }),
          Effect.provideService(Live.Publisher, {
            publish: () =>
              Deferred.succeed(publishing, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  Effect.fail(
                    new Live.PublicationFailure({ reason: "publish_failed" }),
                  ),
                ),
              ),
          }),
          Effect.result,
          Effect.forkScoped,
        )

        yield* Deferred.await(publishing)
        yield* Queue.offer(events, { _tag: "Closed", seconds: 8 })
        yield* Deferred.await(providerClosed)
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(fiber)

        return { result, snapshot: yield* journal.load(binding) }
      }).pipe(
        Effect.scoped,
        Effect.provide(persistence),
        Effect.provide(
          Scenario.model(Scenario.call(Search, { query: "history" })),
        ),
      ),
    )

    expect(output.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LivePublicationFailure" },
    })
    expect(output.snapshot).toMatchObject({
      _tag: "Some",
      value: {
        state: {
          lifecycle: "Interrupted",
          provider: "Finalized",
          usageSeconds: 8,
        },
      },
    })
  })
})

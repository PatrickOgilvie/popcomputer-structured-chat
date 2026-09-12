import { describe, expect, test } from "bun:test"
import { Predicate, Effect, Option, Result, Schema } from "effect"
import { FastCheck } from "effect/testing"
import { deriveCommandId } from "../src/core/command.js"
import * as State from "../src/live/state.js"
import type { Binding, Event } from "../src/live/contracts.js"

const binding: Binding = {
  namespace: "tenant",
  sessionId: "workflow",
  liveSessionId: "provider",
  chat: "lookup",
  version: 1,
}

const delegation: Event = {
  _tag: "Delegated",
  eventId: "event",
  delegationId: "delegation",
  offsetMs: 1,
}

const transcript: Event = {
  _tag: "Transcript",
  fragment: {
    eventId: "speech",
    role: "user",
    delta: "Find history",
    startMs: 0,
    endMs: 1,
  },
}

// Exercise the same canonical reconstruction used by the journal after every transition.
const persisted = (state: State.State) =>
  Schema.decodeUnknownSync(State.State)(JSON.parse(JSON.stringify(state)), {
    onExcessProperty: "error",
  })

const waiting = Effect.gen(function* () {
  const observed = yield* State.observe(
    persisted(State.initial(binding, null)),
    transcript,
  )

  return persisted(
    (yield* State.observe(persisted(observed.state), delegation)).state,
  )
})

const claimed = waiting.pipe(
  Effect.flatMap((state) =>
    State.claim(state, "delegation", "speech", "identity"),
  ),
  Effect.map(({ state }) => persisted(state)),
)

describe("Live domain transitions", () => {
  test("retains receipt order and ignores exact duplicates through generated persistence round trips", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.array(FastCheck.string({ maxLength: 32 }), {
          minLength: 1,
          maxLength: 20,
        }),
        async (deltas) => {
          const state = await Effect.runPromise(
            Effect.gen(function* () {
              let current = persisted(State.initial(binding, null))

              for (const [index, delta] of deltas.entries()) {
                const event: Event = {
                  _tag: "Transcript",
                  fragment: {
                    eventId: `event-${index}`,
                    role: index % 2 === 0 ? "user" : "assistant",
                    delta,
                    startMs: index,
                    endMs: index + 1,
                  },
                }

                const next = yield* State.observe(current, event)
                expect(next.value.reassess).toBe(true)
                current = persisted(next.state)
                const duplicate = yield* State.observe(current, event)
                expect(duplicate.state).toBe(current)
                expect(duplicate.value.reassess).toBe(false)
              }

              return current
            }),
          )

          expect(state.fragments.map(({ delta }) => delta)).toEqual(deltas)
        },
      ),
      { numRuns: 50 },
    )
  })

  test("distinguishes duplicate evidence from conflicting identities", async () => {
    const state = await Effect.runPromise(waiting)
    const duplicate = await Effect.runPromise(State.observe(state, delegation))
    expect(duplicate.state).toBe(state)
    expect(duplicate.value.reassess).toBe(false)

    const conflict = await Effect.runPromise(
      State.observe(state, {
        _tag: "Transcript",
        fragment: {
          eventId: "speech",
          role: "user",
          delta: "Changed",
          startMs: 0,
          endMs: 1,
        },
      }).pipe(Effect.result),
    )

    expect(conflict).toMatchObject({
      _tag: "Failure",
      failure: { reason: "identity_conflict" },
    })
  })

  test.each([false, true])(
    "preserves admission across supersession (command: %s)",
    async (command) => {
      const final = await Effect.runPromise(
        Effect.gen(function* () {
          let state = yield* claimed

          if (command) {
            const commandId = yield* deriveCommandId({
              ...binding,
              expectedRevision: null,
            })

            state = persisted(
              (yield* State.admit(state, "delegation", commandId)).state,
            )
          }

          state = persisted((yield* State.supersede(state, "delegation")).state)
          expect((yield* State.supersede(state, "delegation")).value).toBe(
            false,
          )

          const permission = yield* State.beforeCommit(
            state,
            "delegation",
          ).pipe(Effect.result)

          expect(permission._tag).toBe(command ? "Success" : "Failure")

          if (!command)
            return persisted((yield* State.abandon(state, "delegation")).state)

          if (Predicate.isTagged(permission, "Success"))
            state = persisted(permission.success.state)
          state = persisted(
            (yield* State.commit(state, "delegation", "1")).state,
          )

          const prepared = yield* State.prepare(
            state,
            "delegation",
            { speech: "Done", browser: null },
            "identity",
          )

          state = persisted(prepared.state)
          expect(yield* State.publication(state, prepared.value)).toMatchObject(
            { superseded: true },
          )
          state = persisted(
            (yield* State.published(state, prepared.value.id)).state,
          )
          const attempt = yield* State.attempt(state, prepared.value.id)
          expect(Option.isNone(attempt.value)).toBe(true)

          return persisted(attempt.state)
        }),
      )

      expect(final.chatRevision).toBe(command ? "1" : null)
      expect(final.consumed).toBe(command ? 1 : 0)
      expect(final.delegations[0]?.phase._tag).toBe(
        command ? "Prepared" : "Superseded",
      )

      if (command) expect(final.deliveries[0]?.voice).toBe("Suppressed")
    },
  )

  test("a pending query commit cannot be presented as unadvanced or abandoned", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pending = persisted(
          (yield* State.beforeCommit(yield* claimed, "delegation")).state,
        )

        for (const operation of [
          State.prepare(
            pending,
            "delegation",
            { speech: "Fallback", browser: null },
            "identity",
          ).pipe(Effect.asVoid),
          State.abandon(pending, "delegation").pipe(Effect.asVoid),
        ]) {
          expect(yield* operation.pipe(Effect.result)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "backend_outcome_unknown" },
          })
        }

        const committed = persisted(
          (yield* State.commit(pending, "delegation", "1")).state,
        )

        const prepared = persisted(
          (yield* State.prepare(
            committed,
            "delegation",
            { speech: "Done", browser: null },
            "identity",
          )).state,
        )

        expect(prepared.delegations[0]?.phase).toMatchObject({
          _tag: "Prepared",
          workflow: { _tag: "Committed", revision: "1", commandId: null },
        })
      }),
    )
  })

  test.each(["Accepted", "Rejected"] as const)(
    "preserves %s acknowledgement when a local send failure arrives later",
    async (acknowledgement) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const prepared = yield* State.prepare(
            yield* waiting,
            "delegation",
            { speech: "Which period?", browser: null },
            "identity",
          )

          const published = yield* State.published(
            persisted(prepared.state),
            prepared.value.id,
          )

          const attempted = yield* State.attempt(
            persisted(published.state),
            prepared.value.id,
          )

          const acknowledged = yield* State.observe(
            persisted(attempted.state),
            {
              _tag: acknowledgement,
              eventId: "ack",
              clientEventId: prepared.value.id,
            },
          )

          const state = persisted(acknowledged.state)

          for (const outcome of ["Unknown", "Rejected"] as const) {
            const late = yield* State.deliveryFailed(
              state,
              prepared.value.id,
              outcome,
            )

            expect(late.state).toBe(state)
            expect(Option.isNone(late.value)).toBe(true)
          }

          expect(state.deliveries[0]?.voice).toBe(acknowledgement)
        }),
      )
    },
  )

  test("attempts output once and resolves an unknown delivery with a late acknowledgement", async () => {
    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const prepared = yield* State.prepare(
          yield* waiting,
          "delegation",
          { speech: "Which period?", browser: null },
          "identity",
        )

        let current = persisted(prepared.state)
        expect(current.delegations[0]?.phase).toMatchObject({
          _tag: "Prepared",
          workflow: { _tag: "NotAdvanced" },
        })
        expect(
          (yield* State.attempt(current, prepared.value.id).pipe(Effect.result))
            ._tag,
        ).toBe("Failure")
        current = persisted(
          (yield* State.published(current, prepared.value.id)).state,
        )
        const attempt = yield* State.attempt(current, prepared.value.id)
        expect(attempt.value).toEqual(
          Option.some({
            eventId: prepared.value.id,
            delegationId: "delegation",
            content: "Which period?",
          }),
        )
        current = persisted(attempt.state)
        current = persisted(
          (yield* State.deliveryFailed(current, prepared.value.id, "Unknown"))
            .state,
        )
        expect(
          (yield* State.attempt(current, prepared.value.id).pipe(Effect.result))
            ._tag,
        ).toBe("Failure")
        current = persisted(
          (yield* State.observe(current, {
            _tag: "Accepted",
            eventId: "ack",
            clientEventId: prepared.value.id,
          })).state,
        )

        return current
      }),
    )

    expect(state.chatRevision).toBeNull()
    expect(state.deliveries[0]?.voice).toBe("Accepted")
  })

  test("requires provider finalization to finish and retains it when execution is interrupted", async () => {
    const interrupted = await Effect.runPromise(
      Effect.gen(function* () {
        let state = persisted((yield* State.stop(yield* waiting)).state)
        state = persisted((yield* State.requestClose(state)).state)
        expect(state.provider).toBe("CloseRequested")
        expect((yield* State.finish(state).pipe(Effect.result))._tag).toBe(
          "Failure",
        )
        expect(
          Result.isFailure(
            Schema.decodeResult(State.State)({
              ...state,
              lifecycle: "Closed",
            }),
          ),
        ).toBe(true)
        state = persisted(
          (yield* State.observe(state, { _tag: "Closed", seconds: 12 })).state,
        )
        const closed = persisted((yield* State.finish(state)).state)
        expect(closed.lifecycle).toBe("Closed")
        expect(closed.delegations[0]?.phase._tag).toBe("Superseded")

        return persisted((yield* State.interrupt(state)).state)
      }),
    )

    expect(interrupted.lifecycle).toBe("Interrupted")
    expect(interrupted.provider).toBe("Finalized")
    expect(interrupted.usageSeconds).toBe(12)
  })
})

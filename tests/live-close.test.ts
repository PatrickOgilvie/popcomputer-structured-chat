import { describe, expect, test } from "bun:test"
import { Predicate, Deferred, Effect, Layer, Queue, Ref, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import * as Live from "../src/integrations/live.js"
import * as OpenAI from "../src/integrations/openai-live.js"
import { inMemoryChatSessionStore } from "../src/testing.js"

const binding: Live.Binding = {
  namespace: "tenant",
  sessionId: "workflow",
  liveSessionId: "provider",
  chat: "lookup",
  version: 1,
}

const persistence = Live.journal({ namespace: "voice-journals" }).pipe(
  Layer.provideMerge(inMemoryChatSessionStore),
)

const program = {
  resolve: Effect.succeed(Live.awaitContext),
  action: Live.say("Unused"),
  stop: Effect.void,
}

// Only the WebSocket boundary is substituted; Effect owns the real reader,
// writer latch, event dispatch, and scope finalization in the regression below.
class InMemoryWebSocket extends EventTarget implements WebSocket {
  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSING = 2 as const
  readonly CLOSED = 3 as const
  readonly bufferedAmount = 0
  readonly extensions = ""
  readonly protocol = ""
  readonly url = "wss://test.invalid"
  binaryType: BinaryType = "arraybuffer"
  readyState: number = this.OPEN
  onclose: WebSocket["onclose"] = null
  onerror: WebSocket["onerror"] = null
  onmessage: WebSocket["onmessage"] = null
  onopen: WebSocket["onopen"] = null
  readonly sent: Array<Parameters<WebSocket["send"]>[0]> = []

  send(data: Parameters<WebSocket["send"]>[0]) {
    this.sent.push(data)
  }

  close(code = 1000, reason = "") {
    this.readyState = this.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code, reason }))
  }
}

describe("Live shutdown", () => {
  test.each(["pending", "failed"] as const)(
    "retains final usage and releases the owner when the close write is %s",
    async (outcome) => {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* Queue.make<Live.Event>()
          const finalized = yield* Deferred.make<void>()
          const released = yield* Ref.make(false)
          const journal = yield* Live.Journal

          const result = yield* Live.run(binding, program).pipe(
            Effect.provideService(Live.Journal, {
              ...journal,
              replace: (scope, revision, state) =>
                journal
                  .replace(scope, revision, state)
                  .pipe(
                    Effect.tap(() =>
                      state.provider === "Finalized"
                        ? Deferred.succeed(finalized, undefined)
                        : Effect.void,
                    ),
                  ),
            }),
            Effect.provideService(Live.Connection, {
              sessionId: binding.liveSessionId,
              events: Stream.fromQueue(events),
              commentary: () => Effect.die("No delegation"),
              close: () =>
                Queue.offer(events, { _tag: "Closed", seconds: 7 }).pipe(
                  Effect.andThen(Deferred.await(finalized)),
                  Effect.andThen(
                    outcome === "pending"
                      ? Effect.never
                      : Effect.fail(
                          new Live.ConnectionFailure({
                            reason: "write_failed",
                          }),
                        ),
                  ),
                  Effect.ensuring(Ref.set(released, true)),
                ),
            }),
            Effect.provide(Live.withoutPublisher),
          )

          return {
            result,
            released: yield* Ref.get(released),
            snapshot: yield* journal.load(binding),
            takeover: yield* journal
              .own(binding, Effect.void)
              .pipe(Effect.result),
          }
        }).pipe(Effect.provide(persistence)),
      )

      expect(output.result).toMatchObject({
        lifecycle: "Closed",
        usageSeconds: 7,
      })
      expect(output.released).toBe(true)
      expect(output.snapshot).toMatchObject({
        _tag: "Some",
        value: {
          state: {
            lifecycle: "Closed",
            provider: "Finalized",
            usageSeconds: 7,
          },
        },
      })
      expect(output.takeover._tag).toBe("Success")
    },
  )

  test("preserves a close write failure when the provider has not finalized", async () => {
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* Live.Journal

        const result = yield* Live.run(binding, program).pipe(
          Effect.provideService(Live.Connection, {
            sessionId: binding.liveSessionId,
            events: Stream.never,
            commentary: () => Effect.die("No delegation"),
            close: () =>
              Effect.fail(
                new Live.ConnectionFailure({ reason: "write_failed" }),
              ),
          }),
          Effect.provide(Live.withoutPublisher),
          Effect.result,
        )

        return {
          result,
          takeover: yield* journal
            .own(binding, Effect.void)
            .pipe(Effect.result),
        }
      }).pipe(Effect.provide(persistence)),
    )

    expect(output.result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "write_failed" },
    })
    expect(output.takeover).toMatchObject({
      _tag: "Failure",
      failure: { reason: "session_already_owned" },
    })
  })

  test("processes queued finalization after the real Effect WebSocket writer latch closes", async () => {
    const websocket = new InMemoryWebSocket()

    const output = await Effect.runPromise(
      Effect.gen(function* () {
        const received = yield* Deferred.make<void>()
        const ended = yield* Deferred.make<void>()
        const connection = yield* Live.Connection
        const journal = yield* Live.Journal

        const result = yield* Live.run(binding, program).pipe(
          Effect.provideService(Live.Connection, {
            ...connection,
            events: connection.events.pipe(
              Stream.tap((event) =>
                Predicate.isTagged(event, "Closed")
                  ? Deferred.succeed(received, undefined)
                  : Effect.void,
              ),
              Stream.ensuring(Deferred.succeed(ended, undefined)),
            ),
          }),
          Effect.provideService(Live.Journal, {
            ...journal,
            replace: (scope, revision, state) =>
              journal.replace(scope, revision, state).pipe(
                Effect.tap(() =>
                  state.lifecycle === "Closing" && state.provider === "Open"
                    ? Effect.sync(() =>
                        websocket.dispatchEvent(
                          new MessageEvent("message", {
                            data: JSON.stringify({
                              type: "session.closed",
                              usage: { seconds: 7 },
                            }),
                          }),
                        ),
                      ).pipe(
                        Effect.andThen(Deferred.await(received)),
                        Effect.andThen(Effect.sync(() => websocket.close())),
                        Effect.andThen(Deferred.await(ended)),
                      )
                    : Effect.void,
                ),
              ),
          }),
          Effect.provide(Live.withoutPublisher),
        )

        return {
          result,
          takeover: yield* journal
            .own(binding, Effect.void)
            .pipe(Effect.result),
        }
      }).pipe(
        Effect.provide(
          OpenAI.connection({
            sessionId: binding.liveSessionId,
            socket: () =>
              Layer.effect(
                Socket.Socket,
                Socket.fromWebSocket(Effect.succeed(websocket)),
              ),
          }).pipe(
            Layer.provide(
              Layer.succeed(OpenAI.TextTokens, {
                count: () => Effect.succeed(1),
              }),
            ),
          ),
        ),
        Effect.provide(persistence),
      ),
    )

    expect(output.result).toMatchObject({
      lifecycle: "Closed",
      usageSeconds: 7,
    })
    expect(output.takeover._tag).toBe("Success")
    expect(websocket.sent).toEqual([])
  })
})

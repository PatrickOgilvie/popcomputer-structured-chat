import { describe, expect, test } from "bun:test"
import {
  Predicate,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import * as Live from "../src/integrations/live.js"
import * as OpenAI from "../src/integrations/openai-live.js"

describe("OpenAI Live adapter", () => {
  test.each([
    [
      {
        type: "session.input_transcript.delta",
        event_id: "u",
        delta: " hi ",
        start_ms: 10,
        end_ms: 20,
      },
      {
        _tag: "Transcript",
        fragment: {
          eventId: "u",
          role: "user",
          delta: " hi ",
          startMs: 10,
          endMs: 20,
        },
      },
    ],
    [
      {
        type: "session.output_transcript.delta",
        event_id: "a",
        delta: "Hello",
        start_ms: 8,
        end_ms: 30,
      },
      {
        _tag: "Transcript",
        fragment: {
          eventId: "a",
          role: "assistant",
          delta: "Hello",
          startMs: 8,
          endMs: 30,
        },
      },
    ],
    [
      {
        type: "session.delegation.created",
        event_id: "d",
        offset_ms: 25,
        delegation: { id: "opaque:id", type: "delegation", target: "client" },
      },
      {
        _tag: "Delegated",
        eventId: "d",
        delegationId: "opaque:id",
        offsetMs: 25,
      },
    ],
    [
      {
        type: "session.commentary.appended",
        event_id: "ack",
        client_event_id: "sent",
        start_ms: 10,
        end_ms: 20,
      },
      { _tag: "Accepted", eventId: "ack", clientEventId: "sent" },
    ],
    [
      {
        type: "error",
        event_id: "e",
        error: { code: null, message: "private provider detail" },
      },
      { _tag: "Rejected", eventId: "e", clientEventId: null },
    ],
    [
      { type: "error", event_id: "e", error: { client_event_id: "sent" } },
      { _tag: "Rejected", eventId: "e", clientEventId: "sent" },
    ],
    [
      {
        type: "session.usage.updated",
        event_id: "usage",
        usage: { seconds: 4 },
        context_window: { usage_ratio: 0.5 },
      },
      { _tag: "Usage", seconds: 4 },
    ],
    [
      {
        type: "session.closed",
        event_id: "closed",
        usage: { seconds: 7 },
        reason: "close_requested",
        session: { id: "session" },
      },
      { _tag: "Closed", seconds: 7 },
    ],
  ] as const)(
    "normalizes the documented wire event %j",
    async (wire, expected) => {
      expect(await Effect.runPromise(OpenAI.decodeEvent(wire))).toEqual(
        Option.some(expected),
      )
    },
  )

  test.each([
    {
      type: "session.input_transcript.delta",
      event_id: "x",
      delta: "private",
      start_ms: 20,
      end_ms: 10,
    },
    {
      type: "session.delegation.created",
      event_id: "x",
      offset_ms: 0,
      delegation: { type: "delegation", target: "client" },
    },
    { type: "session.commentary.appended", event_id: "x" },
    { type: "session.closed", usage: { seconds: -1 } },
    null,
  ])(
    "fails malformed recognized events without exposing the payload: %j",
    async (wire) => {
      const result = await Effect.runPromise(
        OpenAI.decodeEvent(wire).pipe(Effect.result),
      )

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "LiveConnectionFailure", reason: "invalid_event" },
      })
      expect(JSON.stringify(result)).not.toContain("private")
    },
  )

  test("ignores unrelated events and non-client delegations", async () => {
    for (const wire of [
      { type: "session.output_audio.delta", delta: "audio" },
      { type: "future.event" },
      {
        type: "session.delegation.created",
        event_id: "d",
        offset_ms: 0,
        delegation: { id: "r", type: "delegation", target: "responses" },
      },
    ])
      expect(await Effect.runPromise(OpenAI.decodeEvent(wire))).toEqual(
        Option.none(),
      )
  })

  test("uses the Socket seam for receive, append, token preflight and close", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const frames = yield* Queue.make<string>()
        const writes = yield* Ref.make<ReadonlyArray<unknown>>([])

        const socket = Socket.make({
          runRaw: (handler, options) =>
            Effect.andThen(
              options?.onOpen ?? Effect.void,
              Stream.runForEach(
                Stream.fromQueue(frames),
                (frame) => handler(frame) ?? Effect.void,
              ),
            ),
          writer: Effect.succeed((frame) => {
            const parsed: unknown = JSON.parse(
              Schema.decodeUnknownSync(Schema.String)(frame),
            )

            return Ref.update(writes, (values) => [...values, parsed])
          }),
        })

        yield* Queue.offer(
          frames,
          JSON.stringify({
            type: "session.usage.updated",
            usage: { seconds: 5 },
          }),
        )

        const received = yield* Effect.gen(function* () {
          const connection = yield* Live.Connection
          yield* connection.commentary({
            eventId: "out",
            delegationId: "opaque:delegation",
            content: "Ready.",
          })

          const rejected = yield* connection
            .commentary({
              eventId: "large",
              delegationId: "opaque:delegation",
              content: "Too large",
            })
            .pipe(Effect.result)

          expect(rejected).toMatchObject({
            _tag: "Failure",
            failure: { reason: "speech_budget" },
          })
          yield* connection.close()

          return yield* Stream.runCollect(
            connection.events.pipe(Stream.take(1)),
          )
        }).pipe(
          Effect.provide(
            OpenAI.connection({
              sessionId: "opaque-session",
              socket: () => Layer.succeed(Socket.Socket, socket),
            }).pipe(
              Layer.provide(
                Layer.succeed(OpenAI.TextTokens, {
                  count: (text) =>
                    Effect.succeed(text === "Ready." ? 500 : 501),
                }),
              ),
            ),
          ),
        )

        return { received, writes: yield* Ref.get(writes) }
      }).pipe(Effect.scoped),
    )

    expect(result.received).toEqual([{ _tag: "Usage", seconds: 5 }])
    expect(result.writes).toEqual([
      {
        type: "session.commentary.append",
        event_id: "out",
        delegation_id: "opaque:delegation",
        content: "Ready.",
      },
      { type: "session.close" },
    ])
  })

  test("binds socket acquisition to the connection identity and releases it with the layer", async () => {
    const acquired: Array<string> = []
    const released: Array<string> = []

    const socket = Socket.make({
      runRaw: () => Effect.never,
      writer: Effect.succeed(() => Effect.void),
    })

    const identity = await Effect.runPromise(
      Live.Connection.pipe(
        Effect.map((connection) => connection.sessionId),
        Effect.provide(
          OpenAI.connection({
            sessionId: "opaque/session:id",
            socket: (url: string) =>
              Layer.effect(
                Socket.Socket,
                Effect.acquireRelease(
                  Effect.sync(() => {
                    acquired.push(url)

                    return socket
                  }),
                  () =>
                    Effect.sync(() => {
                      released.push(url)
                    }),
                ),
              ),
          }).pipe(
            Layer.provide(
              Layer.succeed(OpenAI.TextTokens, {
                count: () => Effect.succeed(1),
              }),
            ),
          ),
        ),
      ),
    )

    expect(identity).toBe("opaque/session:id")
    expect(acquired).toEqual([
      "wss://api.openai.com/v1/live/sessions/opaque%2Fsession%3Aid/attach",
    ])
    expect(released).toEqual(acquired)
  })

  test.each(["", "x".repeat(513)])(
    "rejects an invalid identity before invoking the socket factory: %s",
    async (sessionId) => {
      let invoked = false

      const result = await Effect.runPromise(
        Live.Connection.pipe(
          Effect.provide(
            OpenAI.connection({
              sessionId,
              socket: () => {
                invoked = true

                return Layer.effect(
                  Socket.Socket,
                  Effect.die("Invalid identity reached the host"),
                )
              },
            }).pipe(
              Layer.provide(
                Layer.succeed(OpenAI.TextTokens, {
                  count: () => Effect.succeed(1),
                }),
              ),
            ),
          ),
          Effect.result,
        ),
      )

      expect(invoked).toBe(false)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid_input" },
      })
    },
  )

  test("preserves host acquisition errors without retrying", async () => {
    class HostFailure extends Schema.TaggedError<HostFailure>()(
      "HostFailure",
      {},
    ) {}

    const failure = new HostFailure({})
    let attempts = 0

    const result = await Effect.runPromise(
      Live.Connection.pipe(
        Effect.provide(
          OpenAI.connection({
            sessionId: "provider-session",
            socket: () =>
              Layer.effect(
                Socket.Socket,
                Effect.sync(() => {
                  attempts += 1
                }).pipe(Effect.andThen(Effect.fail(failure))),
              ),
          }).pipe(
            Layer.provide(
              Layer.succeed(OpenAI.TextTokens, {
                count: () => Effect.succeed(1),
              }),
            ),
          ),
        ),
        Effect.result,
      ),
    )

    expect(result).toMatchObject({ _tag: "Failure", failure })

    if (Predicate.isTagged(result, "Failure"))
      expect(result.failure).toBe(failure)
    expect(attempts).toBe(1)
  })

  test("releases the host socket when the connection consumer is interrupted", async () => {
    let releases = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()

        const socket = Socket.make({
          runRaw: () => Effect.never,
          writer: Effect.succeed(() => Effect.void),
        })

        const consumer = yield* Live.Connection.pipe(
          Effect.andThen(Deferred.succeed(ready, undefined)),
          Effect.andThen(Effect.never),
          Effect.provide(
            OpenAI.connection({
              sessionId: "provider-session",
              socket: () =>
                Layer.effect(
                  Socket.Socket,
                  Effect.acquireRelease(Effect.succeed(socket), () =>
                    Effect.sync(() => {
                      releases += 1
                    }),
                  ),
                ),
            }).pipe(
              Layer.provide(
                Layer.succeed(OpenAI.TextTokens, {
                  count: () => Effect.succeed(1),
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        )

        yield* Deferred.await(ready)
        yield* Fiber.interrupt(consumer)
      }).pipe(Effect.scoped),
    )
    expect(releases).toBe(1)
  })

  test("creates client-mode WebRTC sessions with server-only credentials through HttpClient", async () => {
    const requests: Array<{
      readonly url: string
      readonly method: string
      readonly body: unknown
    }> = []

    const client = HttpClient.make((request) => {
      const body: unknown = Predicate.isTagged(request.body, "Uint8Array")
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : null

      requests.push({ url: request.url, method: request.method, body })
      expect(request.headers.authorization).toBe("Bearer server-key")

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              session: { id: "opaque/provider-id", ignored: true },
              transport: { type: "webrtc", sdp: "answer" },
              private: "not returned",
            },
            { status: 201 },
          ),
        ),
      )
    })

    const answer = await Effect.runPromise(
      OpenAI.createSession({
        apiKey: Redacted.make("server-key"),
        sdp: "offer",
        instructions: "Help with this workflow.",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    )

    expect(answer).toEqual({
      session: { id: "opaque/provider-id" },
      transport: { type: "webrtc", sdp: "answer" },
    })
    expect(requests).toEqual([
      {
        url: "https://api.openai.com/v1/live/sessions",
        method: "POST",
        body: {
          session: {
            model: "gpt-live-1",
            instructions: "Help with this workflow.",
            delegation: { type: "client" },
          },
          transport: { type: "webrtc", sdp: "offer" },
        },
      },
    ])
    expect(await Effect.runPromise(OpenAI.sidebandUrl(answer.session.id))).toBe(
      "wss://api.openai.com/v1/live/sessions/opaque%2Fprovider-id/attach",
    )
  })
})

import {
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  type Redacted,
  Schema,
  Stream,
} from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"

import {
  Connection,
  LiveConnectionFailure,
  Event,
  Fragment,
  Id,
  InvalidLivePresentation,
  type Commentary,
} from "../live/contracts.js"

/** Provider-compatible token counting, supplied once at application composition. */
export class TextTokens extends Context.Service<
  TextTokens,
  {
    readonly count: (
      text: string,
    ) => Effect.Effect<number, InvalidLivePresentation>
  }
>()("@popcomputer/structured-chat/live/openai/TextTokens") {}

const Envelope = Schema.Struct({ type: Schema.String })

const Transcript = Schema.Struct({
  event_id: Id,
  delta: Fragment.fields.delta,
  start_ms: Fragment.fields.startMs,
  end_ms: Fragment.fields.endMs,
})

const Delegation = Schema.Struct({
  event_id: Id,
  offset_ms: Fragment.fields.startMs,
  delegation: Schema.Struct({
    id: Id,
    type: Schema.Literal("delegation"),
    target: Schema.String,
  }),
})

const Accepted = Schema.Struct({ event_id: Id, client_event_id: Id })

const Rejected = Schema.Struct({
  event_id: Id,
  error: Schema.Struct({ client_event_id: Schema.optional(Schema.NullOr(Id)) }),
})

const Usage = Schema.Struct({
  usage: Schema.Struct({
    seconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})

/** Decode only this adapter's events; unrelated media and future event kinds are ignored. */
export const decodeEvent = Effect.fn(
  "popcomputer.structured_chat.live.openai.decode_event",
)(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the provider I/O decoder; every recognized payload is parsed here.
  function* (input: unknown) {
    const envelope = yield* Schema.decodeUnknownEffect(Envelope)(input)

    switch (envelope.type) {
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        const event = yield* Schema.decodeUnknownEffect(Transcript)(input)

        const fragment = yield* Schema.decodeEffect(Fragment)({
          eventId: event.event_id,
          role:
            envelope.type === "session.input_transcript.delta"
              ? "user"
              : "assistant",
          delta: event.delta,
          startMs: event.start_ms,
          endMs: event.end_ms,
        })

        return Option.some<Event>(Event.cases.Transcript.make({ fragment }))
      }

      case "session.delegation.created": {
        const event = yield* Schema.decodeUnknownEffect(Delegation)(input)

        return event.delegation.target === "client"
          ? Option.some<Event>(
              Event.cases.Delegated.make({
                eventId: event.event_id,
                delegationId: event.delegation.id,
                offsetMs: event.offset_ms,
              }),
            )
          : Option.none<Event>()
      }

      case "session.commentary.appended": {
        const event = yield* Schema.decodeUnknownEffect(Accepted)(input)

        return Option.some<Event>(
          Event.cases.Accepted.make({
            eventId: event.event_id,
            clientEventId: event.client_event_id,
          }),
        )
      }

      case "error": {
        const event = yield* Schema.decodeUnknownEffect(Rejected)(input)

        return Option.some<Event>(
          Event.cases.Rejected.make({
            eventId: event.event_id,
            clientEventId: event.error.client_event_id ?? null,
          }),
        )
      }

      case "session.usage.updated":
      case "session.closed": {
        const event = yield* Schema.decodeUnknownEffect(Usage)(input)

        return Option.some<Event>(
          envelope.type === "session.closed"
            ? Event.cases.Closed.make({ seconds: event.usage.seconds })
            : Event.cases.Usage.make({ seconds: event.usage.seconds }),
        )
      }

      default:
        return Option.none<Event>()
    }
  },
  Effect.mapError(() => new LiveConnectionFailure({ reason: "invalid_event" })),
)

const Append = Schema.Struct({
  eventId: Id,
  delegationId: Id,
  content: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(50_000),
  ),
})

const connectionLayer = (
  sessionId: string,
): Layer.Layer<Connection, LiveConnectionFailure, Socket.Socket | TextTokens> =>
  Layer.effect(
    Connection,
    Effect.gen(function* () {
      const socket = yield* Socket.Socket
      const tokens = yield* TextTokens
      const write = yield* socket.writer

      const events = yield* Queue.make<Event, LiveConnectionFailure>({
        capacity: 256,
        strategy: "dropping",
      })

      yield* socket
        .runString((frame) =>
          Effect.gen(function* () {
            if (frame.length > 1_000_000)
              return yield* new LiveConnectionFailure({
                reason: "invalid_event",
              })

            const json: unknown = yield* Effect.try({
              try: () => JSON.parse(frame),
              catch: () =>
                new LiveConnectionFailure({ reason: "invalid_event" }),
            })

            const event = yield* decodeEvent(json)

            if (
              Option.isSome(event) &&
              !(yield* Queue.offer(events, event.value))
            )
              return yield* new LiveConnectionFailure({ reason: "read_failed" })
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            Schema.is(LiveConnectionFailure)(error)
              ? error
              : new LiveConnectionFailure({ reason: "read_failed" }),
          ),
          Effect.matchCauseEffect({
            onFailure: (cause) => Queue.failCause(events, cause),
            onSuccess: () =>
              Queue.fail(
                events,
                new LiveConnectionFailure({ reason: "unexpected_end" }),
              ),
          }),
          Effect.forkScoped,
        )

      return Connection.of({
        sessionId,
        events: Stream.fromQueue(events),
        commentary: Effect.fn(
          "popcomputer.structured_chat.live.openai.commentary",
        )(function* (input: Commentary) {
          const append = yield* Schema.decodeEffect(Append)(input, {
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(
              () => new InvalidLivePresentation({ reason: "invalid_output" }),
            ),
          )

          const count = yield* tokens.count(append.content)

          if (!Number.isSafeInteger(count) || count < 1)
            return yield* new InvalidLivePresentation({
              reason: "token_count_unavailable",
            })

          if (count > 500)
            return yield* new InvalidLivePresentation({
              reason: "speech_budget",
            })
          yield* write(
            JSON.stringify({
              type: "session.commentary.append",
              event_id: append.eventId,
              delegation_id: append.delegationId,
              content: append.content,
            }),
          ).pipe(
            Effect.mapError(
              () => new LiveConnectionFailure({ reason: "write_failed" }),
            ),
          )
        }),
        close: Effect.fn("popcomputer.structured_chat.live.openai.close")(() =>
          write(JSON.stringify({ type: "session.close" })).pipe(
            Effect.mapError(
              () => new LiveConnectionFailure({ reason: "write_failed" }),
            ),
          ),
        ),
      })
    }),
  )

const parseSessionId = (sessionId: string) =>
  Schema.decodeEffect(Id)(sessionId).pipe(
    Effect.mapError(
      () => new LiveConnectionFailure({ reason: "invalid_input" }),
    ),
  )

const urlForSession = (sessionId: string) =>
  `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`

/**
 * Acquire an authenticated socket for this exact session in the connection's scope.
 * The host supplies authentication and runtime-specific construction; this layer
 * binds the URL and connection identity once and owns their combined lifetime.
 * Overflow fails visibly rather than dropping execution evidence.
 * @template E The socket layer's acquisition failures.
 * @template R The socket layer's required services.
 */
export const connection = <E, R>(options: {
  readonly sessionId: string
  readonly socket: (url: string) => Layer.Layer<Socket.Socket, E, R>
}): Layer.Layer<Connection, LiveConnectionFailure | E, TextTokens | R> =>
  Layer.unwrap(
    parseSessionId(options.sessionId).pipe(
      Effect.map((sessionId) =>
        connectionLayer(sessionId).pipe(
          Layer.provide(options.socket(urlForSession(sessionId))),
        ),
      ),
    ),
  )

/** Validated sideband URL for advanced integrations constructing their own transport adapter. */
export const sidebandUrl = (
  sessionId: string,
): Effect.Effect<string, LiveConnectionFailure> =>
  parseSessionId(sessionId).pipe(Effect.map(urlForSession))

const SessionOffer = Schema.Struct({
  sdp: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
  instructions: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(65_536),
  ),
})

const SessionAnswer = Schema.Struct({
  session: Schema.Struct({ id: Id }),
  transport: Schema.Struct({
    type: Schema.Literal("webrtc"),
    sdp: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(100_000)),
  }),
})

/** The browser receives only its opaque provider session identity and SDP answer. */
export interface SessionAnswer extends Schema.Schema.Type<
  typeof SessionAnswer
> {}

/**
 * Server-only WebRTC bootstrap. Authenticate and authorize the caller first;
 * instructions and the API key must be supplied by trusted application code.
 * No automatic retry: an uncertain create can have created a billable session.
 */
export const createSession = Effect.fn(
  "popcomputer.structured_chat.live.openai.create_session",
)(function* (options: {
  readonly apiKey: Redacted.Redacted<string>
  readonly sdp: string
  readonly instructions: string
}) {
  const offer = yield* Schema.decodeEffect(SessionOffer)({
    sdp: options.sdp,
    instructions: options.instructions,
  }).pipe(
    Effect.mapError(
      () => new LiveConnectionFailure({ reason: "invalid_input" }),
    ),
  )

  const request = yield* HttpClientRequest.post(
    "https://api.openai.com/v1/live/sessions",
  ).pipe(
    HttpClientRequest.bearerToken(options.apiKey),
    HttpClientRequest.bodyJson({
      session: {
        model: "gpt-live-1",
        instructions: offer.instructions,
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: offer.sdp },
    }),
    Effect.mapError(
      () => new LiveConnectionFailure({ reason: "invalid_input" }),
    ),
  )

  return yield* HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionAnswer)),
    Effect.mapError(() => new LiveConnectionFailure({ reason: "read_failed" })),
  )
})

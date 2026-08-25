import { Context, Effect, Result, Schema } from "effect"
import { JsonValueSchema } from "./json-value.js"

const DebugSequenceSchema = Schema.Natural

const DebugNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
)

const DebugModelCallBaseFields = {
  sequence: DebugSequenceSchema,
  call: DebugSequenceSchema,
}

/** One ordered model-I/O or semantic annotation in a captured debug turn. */
export const StructuredChatDebugEventSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ModelInput"),
    ...DebugModelCallBaseFields,
    provider: DebugNameSchema,
    model: DebugNameSchema,
    providerAttempt: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 100 }),
    ),
    request: JsonValueSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ModelOutput"),
    ...DebugModelCallBaseFields,
    response: JsonValueSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ModelCallFailed"),
    ...DebugModelCallBaseFields,
    reason: Schema.Literals([
      "request_failed",
      "timed_out",
      "response_blocked",
      "invalid_response",
    ]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ModelOutputRejected"),
    ...DebugModelCallBaseFields,
    reason: Schema.Literals([
      "invalid_provider_response",
      "invalid_tool_call",
    ]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ToolCalled"),
    sequence: DebugSequenceSchema,
    tool: DebugNameSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("QuestionAnswered"),
    sequence: DebugSequenceSchema,
    stage: DebugNameSchema,
    field: DebugNameSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("QuestionAsked"),
    sequence: DebugSequenceSchema,
    stage: DebugNameSchema,
    field: DebugNameSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("StageAdvanced"),
    sequence: DebugSequenceSchema,
    from: DebugNameSchema,
    to: DebugNameSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ChatCompleted"),
    sequence: DebugSequenceSchema,
    stage: DebugNameSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("TurnFailed"),
    sequence: DebugSequenceSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("TraceTruncated"),
    sequence: DebugSequenceSchema,
  }),
])

/** One ordered model-I/O or semantic annotation in a captured debug turn. */
export type StructuredChatDebugEvent = Schema.Schema.Type<
  typeof StructuredChatDebugEventSchema
>

const maximumDebugTraceEvents = 200
const maximumCapturedDebugEvents = maximumDebugTraceEvents - 1

const StructuredChatDebugEventsSchema = Schema.Array(
  StructuredChatDebugEventSchema,
).check(
  Schema.isMaxLength(maximumDebugTraceEvents),
).check(
  Schema.makeFilter<ReadonlyArray<StructuredChatDebugEvent>>(
    (events) =>
      events.every((event, index) => event.sequence === index),
    { description: "contiguous structured-chat debug event sequence" },
  ),
)

/** One server turn's bounded, non-persisted debug event stream. */
export const StructuredChatDebugTraceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  events: StructuredChatDebugEventsSchema,
})

/** One server turn's non-persisted debug event stream. */
export type StructuredChatDebugTrace = Schema.Schema.Type<
  typeof StructuredChatDebugTraceSchema
>

type RecordableDebugEvent = Exclude<
  StructuredChatDebugEvent,
  { readonly _tag: "TraceTruncated" | "TurnFailed" }
>

type DebugEventDraft = RecordableDebugEvent extends infer Event
  ? Event extends RecordableDebugEvent
    ? Omit<Event, "sequence">
    : never
  : never

interface DebugEventRecorderService {
  readonly nextModelCall: () => number
  readonly latestModelCall: () => number | undefined
  readonly record: (event: DebugEventDraft) => void
}

const noopRecorder: DebugEventRecorderService = {
  nextModelCall: () => 0,
  latestModelCall: () => undefined,
  record: () => undefined,
}

/** @internal Optional fiber-local recorder used only by explicit debug runs. */
export const DebugEventRecorder = Context.Reference<DebugEventRecorderService>(
  "@popcomputer/structured-chat/DebugEventRecorder",
  { defaultValue: () => noopRecorder },
)

/** @internal Allocate an identifier for one literal provider invocation. */
export const nextDebugModelCall: Effect.Effect<number> =
  DebugEventRecorder.pipe(
    Effect.map((recorder) => recorder.nextModelCall()),
  )

/** @internal Append one event when the current turn opted into capture. */
export const recordDebugEvent = (
  event: DebugEventDraft,
): Effect.Effect<void> =>
  DebugEventRecorder.pipe(
    Effect.tap((recorder) => Effect.sync(() => recorder.record(event))),
    Effect.asVoid,
  )

/** @internal Annotate rejection at the latest sequential model-call boundary. */
export const recordLatestDebugModelOutputRejected = (
  reason: Extract<
    DebugEventDraft,
    { readonly _tag: "ModelOutputRejected" }
  >["reason"],
): Effect.Effect<void> =>
  DebugEventRecorder.pipe(
    Effect.tap((recorder) => {
      const call = recorder.latestModelCall()
      return call === undefined
        ? Effect.void
        : Effect.sync(() =>
            recorder.record({
              _tag: "ModelOutputRejected",
              call,
              reason,
            }),
          )
    }),
    Effect.asVoid,
  )

/** Result of running one Effect with isolated debug-event capture. */
export interface CapturedDebugEvents<Value, Error> {
  readonly result: Result.Result<Value, Error>
  readonly events: ReadonlyArray<StructuredChatDebugEvent>
}

/**
 * @internal Run an Effect with isolated capture while retaining typed failures.
 * Defects and interruption remain in the Effect channel.
 */
export const captureDebugEvents = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<CapturedDebugEvents<Value, Error>, never, Requirements> =>
  Effect.suspend(() => {
    const events: Array<StructuredChatDebugEvent> = []
    let nextSequence = 0
    let nextModelCall = 0
    let latestModelCall: number | undefined
    let traceTruncated = false
    const recorder: DebugEventRecorderService = {
      nextModelCall: () => {
        const call = nextModelCall
        nextModelCall += 1
        latestModelCall = call
        return call
      },
      latestModelCall: () => latestModelCall,
      record: (event) => {
        if (traceTruncated) {
          return
        }
        if (events.length >= maximumCapturedDebugEvents) {
          const truncatedSequence = maximumCapturedDebugEvents - 1
          events[truncatedSequence] = {
            _tag: "TraceTruncated",
            sequence: truncatedSequence,
          }
          nextSequence = maximumCapturedDebugEvents
          traceTruncated = true
          return
        }
        events.push({ ...event, sequence: nextSequence })
        nextSequence += 1
      },
    }

    return effect.pipe(
      Effect.provideService(DebugEventRecorder, recorder),
      Effect.result,
      Effect.map((result) => ({ result, events: [...events] })),
    )
  })

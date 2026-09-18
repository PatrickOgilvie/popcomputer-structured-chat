import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  TypeSafeClient,
  type EntryType,
  type Fetch,
  type Questions,
} from "@typesafe-ai/sdk"
import {
  Effect,
  Function as Fn,
  Layer,
  Predicate,
  Redacted,
  Schedule,
  Schema,
} from "effect"
import {
  batch,
  DescriptionSchema,
  EvaluationNameSchema,
  EvaluationInputRejected,
  ProbabilitySchema,
  TypeSafeConfigurationInvalid,
  TypeSafeInvalidResponse,
  TypeSafeRequestRejected,
  TypeSafeService,
  TypeSafeUnavailable,
  type AnswerFor,
  type Batch,
  type Description,
  type Evaluation,
  type EvaluationError,
  type EvaluationLimits,
  type Question,
  type QuestionMap,
} from "../core/evaluation.js"
import { JsonValueSchema, type JsonValue } from "../core/json-value.js"

/** Explicit server-only configuration and an optional fetch transport seam. */
export interface TypeSafeConfig {
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string
  readonly totalTimeoutMilliseconds: number
  readonly retry: {
    readonly maximumAttempts: 1 | 2 | 3
    readonly delayMilliseconds: number
  }
  readonly limits: EvaluationLimits
  readonly fetch?: Fetch
}
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const ConfigSchema = Schema.Struct({
  model: EvaluationNameSchema,
  totalTimeoutMilliseconds: PositiveInteger,
  retry: Schema.Struct({
    maximumAttempts: Schema.Literals([1, 2, 3]),
    delayMilliseconds: Schema.Natural,
  }),
  limits: Schema.Struct({
    maximumQuestions: PositiveInteger,
    maximumStateCharacters: PositiveInteger,
  }),
})
const ResponseSchema = Schema.Struct({
  model: EvaluationNameSchema,
  answers: Schema.Record(
    Schema.String,
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("noul"), noul: ProbabilitySchema }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        choice: Schema.String,
        probabilities: Schema.Record(Schema.String, ProbabilitySchema),
        confidence: ProbabilitySchema,
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        score: Schema.Finite,
        probabilities: Schema.Record(Schema.String, ProbabilitySchema),
        legend: Schema.Record(Schema.String, JsonValueSchema),
        confidence: ProbabilitySchema,
      }),
    ]),
  ),
  usage: Schema.Struct({
    input_tokens: Schema.Natural,
    output_tokens: Schema.Natural,
  }),
})

const sameKeys = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean =>
  left.length === right.length && left.every((key) => right.includes(key))
// Live Choice responses round individual probabilities (for example, a 106-option
// response totalled 0.99). Preserve those values rather than renormalizing them.
// Allow half a percentage point per candidate, capped at five percentage points;
// malformed or materially incomplete distributions still fail closed.
const validDistribution = (values: ReadonlyArray<number>): boolean =>
  Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <=
  Math.min(0.05, values.length * 0.005) + 1e-9
const invalid = (reason: TypeSafeInvalidResponse["reason"]) =>
  new TypeSafeInvalidResponse({ reason })

const decodeResponse = <Q extends QuestionMap>(
  questions: Q,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK responses are untrusted transport input.
  raw: unknown,
): Effect.Effect<Evaluation<Q>, TypeSafeInvalidResponse> =>
  Effect.gen(function* () {
    const response = yield* Schema.decodeUnknownEffect(ResponseSchema)(
      raw,
    ).pipe(Effect.mapError(() => invalid("invalid_shape")))
    if (!sameKeys(Object.keys(questions), Object.keys(response.answers)))
      return yield* invalid("question_mismatch")
    const entries: Array<readonly [string, AnswerFor<Question>]> = []
    for (const [id, question] of Object.entries(questions)) {
      const answer = response.answers[id]
      if (answer === undefined) return yield* invalid("question_mismatch")
      switch (question._tag) {
        case "Noul": {
          if (answer.type !== "noul") return yield* invalid("question_mismatch")
          entries.push([id, { _tag: "Noul", probability: answer.noul }])
          break
        }
        case "Choice": {
          if (answer.type !== "choice")
            return yield* invalid("question_mismatch")
          const keys = Object.keys(question.criteria)
          if (
            !keys.includes(answer.choice) ||
            !sameKeys(keys, Object.keys(answer.probabilities))
          )
            return yield* invalid("invalid_choice")
          if (!validDistribution(Object.values(answer.probabilities)))
            return yield* invalid("invalid_distribution")
          entries.push([
            id,
            {
              _tag: "Choice",
              value: answer.choice,
              probabilities: answer.probabilities,
              confidence: answer.confidence,
            },
          ])
          break
        }
        case "Score": {
          if (answer.type !== "score")
            return yield* invalid("question_mismatch")
          const keys = question.levels.map((_, index) => String(index))
          if (
            !sameKeys(keys, Object.keys(answer.probabilities)) ||
            !sameKeys(keys, Object.keys(answer.legend))
          )
            return yield* invalid("invalid_distribution")
          const probabilities = keys.map(
            (key) => answer.probabilities[key] ?? Number.NaN,
          )
          if (
            !validDistribution(probabilities) ||
            answer.score < 0 ||
            answer.score > keys.length - 1
          )
            return yield* invalid("invalid_distribution")
          entries.push([
            id,
            {
              _tag: "Score",
              value: answer.score,
              probabilities,
              confidence: answer.confidence,
            },
          ])
          break
        }
      }
    }
    const answers = Object.fromEntries(entries)
    // SAFETY: every question ID, discriminator, choice and distribution was checked against Q above.
    return {
      answers: Fn.cast<typeof answers, Evaluation<Q>["answers"]>(answers),
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }
  })

// The SDK uses mutable JSON collections; project into owned transport collections.
const sdkJson = (value: JsonValue): import("@typesafe-ai/sdk").JsonValue => {
  if (Array.isArray(value)) return value.map(sdkJson)
  if (Schema.is(Schema.Record(Schema.String, JsonValueSchema))(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sdkJson(Schema.decodeUnknownSync(JsonValueSchema)(child)),
      ]),
    )
  return Schema.decodeUnknownSync(
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
  )(value)
}
const sdkDescription = (value: Description): EntryType => {
  if (Predicate.isString(value)) return value
  if (Array.isArray(value)) return value.map(sdkJson)
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sdkJson(child)]),
  )
}
const encodeQuestions = (questions: QuestionMap): Questions =>
  Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      switch (question._tag) {
        case "Noul": {
          const encoded: Questions[string] = {
            type: "noul",
            instructions: sdkDescription(question.instructions),
          }
          if (question.criteria !== undefined) encoded.criteria = {
            true: sdkDescription(question.criteria.true),
            false: sdkDescription(question.criteria.false),
          }
          return [id, encoded]
        }
        case "Choice":
          return [
            id,
            {
              type: "choice",
              instructions: sdkDescription(question.instructions),
              criteria: Object.fromEntries(
                Object.entries(question.criteria).map(([key, value]) => [
                  key,
                  sdkDescription(value),
                ]),
              ),
            },
          ]
        case "Score":
          return [
            id,
            {
              type: "score",
              instructions: sdkDescription(question.instructions),
              criteria: [
                sdkDescription(question.levels[0]),
                sdkDescription(question.levels[1]),
                ...question.levels.slice(2).map(sdkDescription),
              ],
            },
          ]
      }
    }),
  )

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Translate SDK exceptions without carrying their content into public errors.
const sdkFailure = (cause: unknown): EvaluationError => {
  if (cause instanceof APITimeoutError)
    return new TypeSafeUnavailable({ reason: "timeout" })
  if (cause instanceof APIConnectionError)
    return new TypeSafeUnavailable({ reason: "network" })
  if (cause instanceof SyntaxError) return invalid("invalid_json")
  if (cause instanceof APIError) {
    if (cause.status === 401)
      return new TypeSafeRequestRejected({ reason: "unauthorized" })
    if (cause.status === 403)
      return new TypeSafeRequestRejected({ reason: "forbidden" })
    if (cause.status === 404)
      return new TypeSafeRequestRejected({ reason: "not_found" })
    if (cause.status === 429)
      return new TypeSafeUnavailable({ reason: "rate_limited" })
    if (cause.status === 529)
      return new TypeSafeUnavailable({ reason: "overloaded" })
    if (cause.status === 408)
      return new TypeSafeUnavailable({ reason: "timeout" })
    if (cause.status >= 500)
      return new TypeSafeUnavailable({ reason: "server" })
    return new TypeSafeRequestRejected({ reason: "invalid_request" })
  }
  return new TypeSafeRequestRejected({ reason: "invalid_request" })
}

/** Construct the optional TypeSafe evaluator without reading ambient configuration. */
export const typeSafeLayer = (
  config: TypeSafeConfig,
): Layer.Layer<TypeSafeService, TypeSafeConfigurationInvalid> =>
  Layer.effect(
    TypeSafeService,
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeUnknownEffect(ConfigSchema)(
        config,
      ).pipe(Effect.mapError(() => new TypeSafeConfigurationInvalid()))
      const apiKey = yield* Schema.decodeUnknownEffect(
        Schema.Trimmed.check(Schema.isNonEmpty()),
      )(Redacted.value(config.apiKey)).pipe(
        Effect.mapError(() => new TypeSafeConfigurationInvalid()),
      )
      const clientOptions = {
        apiKey,
        baseURL: "https://api.typesafe.ai",
        defaultModel: parsed.model,
        logLevel: "off",
        retry: { maxRetries: 0 },
        timeout: parsed.totalTimeoutMilliseconds,
      } satisfies import("@typesafe-ai/sdk").TypeSafeClientConfig
      const client = yield* Effect.try({
        try: () =>
          new TypeSafeClient(
            config.fetch === undefined
              ? clientOptions
              : { ...clientOptions, fetch: config.fetch },
          ),
        catch: () => new TypeSafeConfigurationInvalid(),
      })
      return TypeSafeService.of({
        limits: parsed.limits,
        evaluate: <const Q extends QuestionMap>(input: {
          readonly state: Description
          readonly questions: Batch<Q>
        }) =>
          Effect.gen(function* () {
            const state = yield* Schema.decodeUnknownEffect(DescriptionSchema)(
              input.state,
            ).pipe(
              Effect.mapError(
                () => new EvaluationInputRejected({ reason: "invalid_state" }),
              ),
            )
            const snapshot = yield* Effect.try({
              try: () => batch(input.questions.questions),
              catch: () =>
                new EvaluationInputRejected({ reason: "invalid_questions" }),
            })
            if (
              Object.keys(snapshot.questions).length >
                parsed.limits.maximumQuestions ||
              JSON.stringify(state).length >
                parsed.limits.maximumStateCharacters
            )
              return yield* new EvaluationInputRejected({
                reason: "budget_exceeded",
              })
            const questions = encodeQuestions(snapshot.questions)
            yield* Effect.annotateCurrentSpan({
              model: parsed.model,
              questionCount: Object.keys(questions).length,
            })
            const attempt = Effect.tryPromise({
              try: (signal) =>
                client.systemOne(
                  {
                    model: parsed.model,
                    state: sdkDescription(state),
                    questions,
                  },
                  { signal, retry: { maxRetries: 0 } },
                ),
              catch: sdkFailure,
            }).pipe(
              Effect.flatMap((raw) => decodeResponse(snapshot.questions, raw)),
              Effect.withSpan("popcomputer.structured_chat.typesafe.attempt"),
            )
            const result = yield* attempt.pipe(
              Effect.retry({
                times: parsed.retry.maximumAttempts - 1,
                while: (error) => error._tag === "TypeSafeUnavailable",
                schedule: Schedule.spaced(parsed.retry.delayMilliseconds),
              }),
              Effect.timeoutOrElse({
                duration: parsed.totalTimeoutMilliseconds,
                orElse: () =>
                  Effect.fail(new TypeSafeUnavailable({ reason: "timeout" })),
              }),
            )
            yield* Effect.annotateCurrentSpan({
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            })
            return result
          }).pipe(
            Effect.withSpan("popcomputer.structured_chat.typesafe.evaluate"),
          ),
      })
    }),
  )

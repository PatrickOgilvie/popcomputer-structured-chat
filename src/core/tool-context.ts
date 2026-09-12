import { Context, Effect, Schema } from "effect"

/** Trusted accepted values available during chat stages and explorations. */
export interface ToolContextService {
  readonly stages: Readonly<
    Partial<
      Record<
        string,
        {
          readonly accepted: Readonly<
            Partial<Record<string, { readonly value: unknown }>>
          >
        }
      >
    >
  >
}

/** Server-owned collection context; it is never added to model tool arguments. */
export class ToolContext extends Context.Service<
  ToolContext,
  ToolContextService
>()("@popcomputer/structured-chat/ToolContext") {}

/** An answer binding references a missing or incompatible accepted value. */
export class AcceptedAnswerUnavailable extends Schema.TaggedError<AcceptedAnswerUnavailable>()(
  "AcceptedAnswerUnavailable",
  {
    stage: Schema.String,
    field: Schema.String,
    reason: Schema.Literals(["missing", "incompatible"]),
  },
) {}

/** Read a server-accepted answer using the schema's decoded value contract. */
export const acceptedAnswer = <A>(input: {
  readonly stage: string
  readonly field: string
  readonly schema: Schema.Decoder<A>
}): Effect.Effect<A, AcceptedAnswerUnavailable, ToolContext> =>
  Effect.gen(function* () {
    const context = yield* ToolContext

    const stage = Object.hasOwn(context.stages, input.stage)
      ? context.stages[input.stage]
      : undefined

    const answer =
      stage !== undefined && Object.hasOwn(stage.accepted, input.field)
        ? stage.accepted[input.field]
        : undefined

    if (answer === undefined)
      return yield* new AcceptedAnswerUnavailable({
        stage: input.stage,
        field: input.field,
        reason: "missing",
      })

    return yield* Schema.decodeUnknownEffect(Schema.toType(input.schema))(
      answer.value,
    ).pipe(
      Effect.mapError(
        () =>
          new AcceptedAnswerUnavailable({
            stage: input.stage,
            field: input.field,
            reason: "incompatible",
          }),
      ),
    )
  })

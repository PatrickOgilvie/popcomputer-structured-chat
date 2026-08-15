import { Effect, Schema } from "effect"
import {
  ChatSessionIdSchema,
  ChatSessionRevisionSchema,
} from "./session.js"
import { defineView } from "./view.js"

/** Bounded plain text emitted by a structured chat presenter. */
export const AssistantTextPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(20_000)),
})

/** Provider-neutral named data emitted by a structured chat presenter. */
export const AssistantDataPartSchema = Schema.Struct({
  type: Schema.Literal("data"),
  name: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(100),
    Schema.pattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  ),
  data: Schema.Unknown,
})

/** Message parts transported from a structured chat action to a browser. */
export const AssistantMessagePartSchema = Schema.Union(
  AssistantTextPartSchema,
  AssistantDataPartSchema,
)

/** Message parts transported from a structured chat action to a browser. */
export type AssistantMessagePart = Schema.Schema.Type<
  typeof AssistantMessagePartSchema
>

/** Strict assistant message returned by one structured chat action. */
export const StructuredChatAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.NonEmptyArray(AssistantMessagePartSchema).pipe(
    Schema.maxItems(20),
  ),
})

/** Strict assistant message returned by one structured chat action. */
export type StructuredChatAssistantMessage = Schema.Schema.Type<
  typeof StructuredChatAssistantMessageSchema
>

/** Opaque browser-held reference to one server-owned chat session. */
export const StructuredChatSessionReferenceSchema = Schema.Struct({
  id: ChatSessionIdSchema,
  revision: ChatSessionRevisionSchema,
})

/** Opaque browser-held reference to one server-owned chat session. */
export type StructuredChatSessionReference = Schema.Schema.Type<
  typeof StructuredChatSessionReferenceSchema
>

/** Browser request carrying no server-owned chat state. */
export const StructuredChatTurnRequestSchema = Schema.Struct({
  session: Schema.optional(StructuredChatSessionReferenceSchema),
  message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(50_000)),
})

/** Browser request carrying no server-owned chat state. */
export type StructuredChatTurnRequest = Schema.Schema.Type<
  typeof StructuredChatTurnRequestSchema
>

/** Versioned browser response for one persisted structured chat turn. */
export const StructuredChatTurnResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  session: Schema.optional(StructuredChatSessionReferenceSchema),
  message: StructuredChatAssistantMessageSchema,
})

/** Versioned browser response for one persisted structured chat turn. */
export type StructuredChatTurnResponse = Schema.Schema.Type<
  typeof StructuredChatTurnResponseSchema
>

/** Built-in browser contract for one collect-stage question. */
export const CollectQuestionView = defineView({
  name: "collect_question",
  version: 1,
  schema: Schema.Struct({
    stage: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100)),
    field: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100)),
    text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(500)),
    options: Schema.Array(
      Schema.Struct({
        label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(100)),
      }),
    ).pipe(Schema.maxItems(20)),
  }),
})

/** Safe reason that application-owned message presentation was rejected. */
export class InvalidChatPresentation extends Schema.TaggedError<InvalidChatPresentation>()(
  "InvalidChatPresentation",
  { reason: Schema.Literal("invalid_message") },
) {}

interface PresentableQuestionTurn {
  readonly _tag: "Question"
  readonly stage: string
  readonly question: {
    readonly field: string
    readonly text: string
    readonly options: ReadonlyArray<{ readonly label: string }>
    readonly escape?: { readonly label: string }
  }
}

interface PresentableToolTurn {
  readonly _tag: "ToolResult" | "Complete"
  readonly stage: string
  readonly result: {
    readonly views: ReadonlyArray<AssistantMessagePart>
  }
}

type PresentableTurn = PresentableQuestionTurn | PresentableToolTurn

/** Optional application projections for question and tool-result messages. */
export interface PresentChatReplyOptions<Turn extends PresentableTurn> {
  readonly question?: (
    turn: Extract<Turn, PresentableQuestionTurn>,
  ) => ReadonlyArray<AssistantMessagePart>
  readonly result?: (
    turn: Extract<Turn, PresentableToolTurn>,
  ) => ReadonlyArray<AssistantMessagePart>
}

/** Construct and validate one plain assistant text part. */
const makeText = (text: string): AssistantMessagePart =>
  Schema.validateSync(AssistantTextPartSchema)({ type: "text", text })

/** Constructors for deterministic assistant message parts. */
export const Text = {
  make: makeText,
} as const

const invalidPresentation = () =>
  new InvalidChatPresentation({ reason: "invalid_message" })

interface StructuredChatResponseCandidate {
  readonly schemaVersion: number
  readonly session: StructuredChatSessionReference | undefined
  readonly message: {
    readonly role: string
    readonly content: ReadonlyArray<AssistantMessagePart>
  }
}

const parseResponse = (
  input: StructuredChatResponseCandidate,
): Effect.Effect<StructuredChatTurnResponse, InvalidChatPresentation> =>
  Schema.decodeUnknown(StructuredChatTurnResponseSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(invalidPresentation))

const buildPresentation = <Value>(
  evaluate: () => Value,
): Effect.Effect<Value, InvalidChatPresentation> =>
  Effect.try({
    try: evaluate,
    catch: invalidPresentation,
  })

/**
 * Present a safe non-progressing notice after a rejected or unavailable turn.
 *
 * Supplying the prior session reference lets the browser retry from the same
 * server-owned state. An initial rejected turn may omit it entirely.
 */
export const presentChatNotice = (input: {
  readonly text: string
  readonly session?: StructuredChatSessionReference | undefined
}): Effect.Effect<
  StructuredChatTurnResponse,
  InvalidChatPresentation
> =>
  buildPresentation(() => ({
    schemaVersion: 1,
    session: input.session,
    message: {
      role: "assistant",
      content: [makeText(input.text)],
    },
  })).pipe(Effect.flatMap(parseResponse))

/**
 * Present an application-authored retry question after answer validation.
 *
 * The rejection is non-progressing: pass the browser's prior session
 * reference, if any, so its next answer retries from the same revision.
 */
export const presentAnswerValidationRejection = (input: {
  readonly rejection: {
    readonly stage: string
    readonly question: {
      readonly field: string
      readonly text: string
      readonly options: ReadonlyArray<{
        readonly label: string
        readonly value?: unknown
      }>
      readonly escape?: { readonly label: string }
    }
  }
  readonly session?: StructuredChatSessionReference | undefined
}): Effect.Effect<
  StructuredChatTurnResponse,
  InvalidChatPresentation
> =>
  buildPresentation(() => ({
    schemaVersion: 1,
    session: input.session,
    message: {
      role: "assistant" as const,
      content: [
        CollectQuestionView.make({
          stage: input.rejection.stage,
          field: input.rejection.question.field,
          text: input.rejection.question.text,
          options: [
            ...input.rejection.question.options.map(({ label }) => ({
              label,
            })),
            ...(input.rejection.question.escape === undefined
              ? []
              : [input.rejection.question.escape]),
          ],
        }),
      ],
    },
  })).pipe(Effect.flatMap(parseResponse))

/**
 * Project one persisted chat reply into the strict browser protocol.
 *
 * Questions use the built-in CollectQuestionView unless overridden. Tool
 * results use their validated views unless the application adds text or a
 * different ordered composition.
 */
export const presentChatReply = <Turn extends PresentableTurn>(
  reply: {
    readonly sessionId: Schema.Schema.Type<
      typeof ChatSessionIdSchema
    > | string
    readonly revision: Schema.Schema.Type<
      typeof ChatSessionRevisionSchema
    > | string
    readonly turn: Turn
  },
  options: PresentChatReplyOptions<Turn> = {},
): Effect.Effect<StructuredChatTurnResponse, InvalidChatPresentation> => {
  const buildContent = (): ReadonlyArray<AssistantMessagePart> => {
    if (reply.turn._tag === "Question") {
      // SAFETY: The discriminant narrows the generic Turn to its question
      // member even though TypeScript cannot retain that fact through Extract.
      const questionTurn = reply.turn as Extract<
        Turn,
        PresentableQuestionTurn
      >
      return options.question?.(questionTurn) ?? [
        CollectQuestionView.make({
          stage: reply.turn.stage,
          field: reply.turn.question.field,
          text: reply.turn.question.text,
          options: [
            ...reply.turn.question.options.map(({ label }) => ({
              label,
            })),
            ...(reply.turn.question.escape === undefined
              ? []
              : [reply.turn.question.escape]),
          ],
        }),
      ]
    }

    // SAFETY: The non-question branch contains only ToolResult and Complete.
    const toolTurn = reply.turn as Extract<Turn, PresentableToolTurn>
    return options.result?.(toolTurn) ?? reply.turn.result.views
  }

  return buildPresentation(buildContent).pipe(
    Effect.flatMap((content) =>
      parseResponse({
        schemaVersion: 1,
        session: {
          id: reply.sessionId,
          revision: reply.revision,
        },
        message: { role: "assistant", content },
      }),
    ),
    Effect.withSpan("popcomputer.structured_chat.presentation.reply", {
      attributes: { stage: reply.turn.stage },
    }),
  )
}

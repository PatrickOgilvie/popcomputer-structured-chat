import { cast, Effect, Result, Schema } from "effect"
import {
  ChatSessionIdSchema,
  ChatSessionRevisionSchema,
} from "./session.js"
import { defineView, type ViewData, type ViewDefinitionContract } from "./view.js"
import { JsonValueSchema } from "./json-value.js"
import { ToolNameSchema } from "./tool.js"
import {
  StructuredChatUserAnswerSnapshotSchema,
  type StructuredChatUserAnswerSnapshot,
} from "./user-answer-projection.js"

/** Bounded plain text emitted by a structured chat presenter. */
export const AssistantTextPartSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(20_000),
  ),
})

/** Provider-neutral named data emitted by a structured chat presenter. */
export const AssistantDataPartSchema = Schema.Struct({
  type: Schema.Literal("data"),
  name: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(100),
    Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  ),
  data: Schema.Unknown,
})

/** Message parts transported from a structured chat action to a browser. */
export const AssistantMessagePartSchema = Schema.Union([
  AssistantTextPartSchema,
  AssistantDataPartSchema,
])

/** Message parts transported from a structured chat action to a browser. */
export type AssistantMessagePart = Schema.Schema.Type<
  typeof AssistantMessagePartSchema
>

/** Strict assistant message returned by one structured chat action. */
export const StructuredChatAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.NonEmptyArray(AssistantMessagePartSchema).check(
    Schema.isMaxLength(20),
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

/** Upper bound for one application-owned turn-request message bound. */
const MaximumTurnRequestMessageLengthSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
)

/** Message bound applied when a turn-request schema names no bound. */
const defaultTurnRequestMessageLength = 50_000

/**
 * Build one browser turn-request schema with an application-owned message
 * bound.
 *
 * The session reference stays optional and the message remains trimmed,
 * non-empty text bounded by `maximumMessageLength`.
 */
export const structuredChatTurnRequestSchema = (options?: {
  readonly maximumMessageLength?: number
}) => {
  const maximumMessageLength =
    options?.maximumMessageLength === undefined
      ? defaultTurnRequestMessageLength
      : Schema.decodeSync(MaximumTurnRequestMessageLengthSchema)(
          options.maximumMessageLength,
        )

  return Schema.Struct({
    session: Schema.optional(StructuredChatSessionReferenceSchema),
    message: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(maximumMessageLength),
    ),
  })
}

/** Browser request carrying no server-owned chat state. */
export const StructuredChatTurnRequestSchema =
  structuredChatTurnRequestSchema()

/** Browser request carrying no server-owned chat state. */
export type StructuredChatTurnRequest = Schema.Schema.Type<
  typeof StructuredChatTurnRequestSchema
>

/** Versioned browser response for one successfully persisted chat turn. */
export const StructuredChatPersistedTurnResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  session: StructuredChatSessionReferenceSchema,
  message: StructuredChatAssistantMessageSchema,
  answers: StructuredChatUserAnswerSnapshotSchema,
})

/** Versioned browser response for one successfully persisted chat turn. */
export type StructuredChatPersistedTurnResponse = Schema.Schema.Type<
  typeof StructuredChatPersistedTurnResponseSchema
>

/** Versioned browser response for a notice that did not advance state. */
export const StructuredChatNonProgressingResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  session: Schema.optional(StructuredChatSessionReferenceSchema),
  message: StructuredChatAssistantMessageSchema,
})

/** Versioned browser response for a notice that did not advance state. */
export type StructuredChatNonProgressingResponse = Schema.Schema.Type<
  typeof StructuredChatNonProgressingResponseSchema
>

/** Strict persisted-or-non-progressing browser turn response. */
export const StructuredChatTurnResponseSchema = Schema.Union([
  StructuredChatPersistedTurnResponseSchema,
  StructuredChatNonProgressingResponseSchema,
])

/** Strict persisted-or-non-progressing browser turn response. */
export type StructuredChatTurnResponse = Schema.Schema.Type<
  typeof StructuredChatTurnResponseSchema
>

/** Transport envelope for one application-authored exploration call. */
export const StructuredChatExplorationCallSchema = Schema.Struct({
  name: ToolNameSchema,
  arguments: JsonValueSchema,
})

/** Transport envelope for one application-authored exploration call. */
export type StructuredChatExplorationCall = Schema.Schema.Type<
  typeof StructuredChatExplorationCallSchema
>

/** Browser request for one exploration against an existing chat session. */
export const StructuredChatExplorationRequestSchema = Schema.Struct({
  session: Schema.Struct({ id: ChatSessionIdSchema }),
  call: StructuredChatExplorationCallSchema,
})

/** Browser request for one exploration against an existing chat session. */
export type StructuredChatExplorationRequest = Schema.Schema.Type<
  typeof StructuredChatExplorationRequestSchema
>

/** Versioned browser response containing exploration presentation parts. */
export const StructuredChatExplorationResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  content: Schema.NonEmptyArray(AssistantMessagePartSchema).check(
    Schema.isMaxLength(20),
  ),
})

/** Versioned browser response containing exploration presentation parts. */
export type StructuredChatExplorationResponse = Schema.Schema.Type<
  typeof StructuredChatExplorationResponseSchema
>

const findViewParts = <View extends ViewDefinitionContract>(
  parts: ReadonlyArray<AssistantMessagePart>,
  view: View,
): ReadonlyArray<ViewData<View>> => {
  const decodePart = Schema.decodeUnknownResult(view.partSchema)
  const matched: Array<ViewData<View>> = []
  for (const part of parts) {
    if (part.type !== "data" || part.name !== view.name) {
      continue
    }
    const decoded = decodePart(part, { onExcessProperty: "error" })
    if (Result.isSuccess(decoded)) {
      // SAFETY: view.partSchema decodes data to exactly ViewData<View>; the
      // generic constraint only exposes its upper bound.
      matched.push(
        cast<typeof decoded.success.data, ViewData<View>>(
          decoded.success.data,
        ),
      )
    }
  }
  return matched
}

/**
 * Decode every assistant-message part matching the view, skipping mismatches
 * and undecodable parts.
 *
 * Parts are matched by their encoded `name` and strictly decoded with the
 * view's own part schema, whose data carries the literal view
 * `schemaVersion`. Non-matching and undecodable parts are silently dropped,
 * mirroring the fail-closed behaviour of browser renderer fallbacks.
 */
export const findTurnParts = <View extends ViewDefinitionContract>(
  response: StructuredChatTurnResponse,
  view: View,
): ReadonlyArray<ViewData<View>> => {
  return findViewParts(response.message.content, view)
}

/** Decode every exploration part matching one view definition. */
export const findExplorationParts = <
  View extends ViewDefinitionContract,
>(
  response: StructuredChatExplorationResponse,
  view: View,
): ReadonlyArray<ViewData<View>> => findViewParts(response.content, view)

/** Built-in browser contract for one collect-stage question. */
export const CollectQuestionView = defineView({
  name: "collect_question",
  version: 1,
  schema: Schema.Struct({
    stage: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(100),
    ),
    field: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(100),
    ),
    text: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(500),
    ),
    options: Schema.Array(
      Schema.Struct({
        label: Schema.Trimmed.check(
          Schema.isNonEmpty(),
          Schema.isMaxLength(100),
        ),
      }),
    ).check(Schema.isMaxLength(20)),
  }),
})

/** Safe reason that application-owned message presentation was rejected. */
export class InvalidChatPresentation extends Schema.TaggedError<InvalidChatPresentation>()(
  "InvalidChatPresentation",
  { reason: Schema.Literal("invalid_message") },
) {}

/** Minimum question-turn shape accepted by browser presentation. */
export interface PresentableQuestionTurn {
  readonly _tag: "Question"
  readonly stage: string
  readonly question: {
    readonly field: string
    readonly text: string
    readonly options: ReadonlyArray<{ readonly label: string }>
    readonly escape?: { readonly label: string }
  }
}

/** Minimum tool-turn shape accepted by browser presentation. */
export interface PresentableToolTurn {
  readonly _tag: "ToolResult" | "Complete"
  readonly stage: string
  readonly result: {
    readonly views: ReadonlyArray<AssistantMessagePart>
  }
}

/** Domain-turn shapes accepted by browser presentation. */
export type PresentableTurn =
  | PresentableQuestionTurn
  | PresentableToolTurn

/** Optional application projections for question and tool-result messages. */
export interface PresentChatReplyOptions<Turn extends PresentableTurn> {
  readonly question?: (
    turn: Extract<Turn, PresentableQuestionTurn>,
  ) => ReadonlyArray<AssistantMessagePart>
  readonly result?: (
    turn: Extract<Turn, PresentableToolTurn>,
  ) => ReadonlyArray<AssistantMessagePart>
}

/** Minimum correlated exploration result accepted by presentation. */
export interface PresentableExploration {
  readonly name: string
  readonly input: unknown
  readonly execution: {
    readonly views: ReadonlyArray<AssistantMessagePart>
  }
}

/** Optional application projection for one exploration response. */
export interface PresentChatExplorationOptions<
  Run extends PresentableExploration,
> {
  readonly result?: (run: Run) => ReadonlyArray<AssistantMessagePart>
}

/** Construct and validate one plain assistant text part. */
const makeText = (text: string): AssistantMessagePart =>
  Schema.decodeSync(Schema.toType(AssistantTextPartSchema))({
    type: "text",
    text,
  })

/** Constructors for deterministic assistant message parts. */
export const Text = {
  make: makeText,
} as const

const invalidPresentation = () =>
  new InvalidChatPresentation({ reason: "invalid_message" })

interface StructuredChatPersistedResponseCandidate {
  readonly schemaVersion: number
  readonly session: StructuredChatSessionReference
  readonly message: {
    readonly role: string
    readonly content: ReadonlyArray<AssistantMessagePart>
  }
  readonly answers: StructuredChatUserAnswerSnapshot
}

interface StructuredChatNonProgressingResponseCandidate {
  readonly schemaVersion: number
  readonly session: StructuredChatSessionReference | undefined
  readonly message: {
    readonly role: string
    readonly content: ReadonlyArray<AssistantMessagePart>
  }
}

const parsePersistedResponse = (
  input: StructuredChatPersistedResponseCandidate,
): Effect.Effect<
  StructuredChatPersistedTurnResponse,
  InvalidChatPresentation
> =>
  Schema.decodeUnknownEffect(StructuredChatPersistedTurnResponseSchema)(
    input,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(invalidPresentation))

const parseNonProgressingResponse = (
  input: StructuredChatNonProgressingResponseCandidate,
): Effect.Effect<
  StructuredChatNonProgressingResponse,
  InvalidChatPresentation
> =>
  Schema.decodeUnknownEffect(StructuredChatNonProgressingResponseSchema)(
    input,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(invalidPresentation))

const parseExplorationResponse = (
  input: {
    readonly schemaVersion: number
    readonly content: ReadonlyArray<AssistantMessagePart>
  },
): Effect.Effect<
  StructuredChatExplorationResponse,
  InvalidChatPresentation
> =>
  Schema.decodeUnknownEffect(StructuredChatExplorationResponseSchema)(
    input,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(invalidPresentation))

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
  StructuredChatNonProgressingResponse,
  InvalidChatPresentation
> =>
  buildPresentation(() => ({
    schemaVersion: 2,
    session: input.session,
    message: {
      role: "assistant",
      content: [makeText(input.text)],
    },
  })).pipe(Effect.flatMap(parseNonProgressingResponse))

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
  StructuredChatNonProgressingResponse,
  InvalidChatPresentation
> =>
  buildPresentation(() => ({
    schemaVersion: 2,
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
  })).pipe(Effect.flatMap(parseNonProgressingResponse))

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
    readonly userAnswers: StructuredChatUserAnswerSnapshot
  },
  options: PresentChatReplyOptions<Turn> = {},
): Effect.Effect<
  StructuredChatPersistedTurnResponse,
  InvalidChatPresentation
> => {
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
      parsePersistedResponse({
        schemaVersion: 2,
        session: {
          id: reply.sessionId,
          revision: reply.revision,
        },
        message: { role: "assistant", content },
        answers: reply.userAnswers,
      }),
    ),
    Effect.withSpan("popcomputer.structured_chat.presentation.reply", {
      attributes: { stage: reply.turn.stage },
    }),
  )
}

/** Project one exploration result into the strict browser protocol. */
export const presentChatExploration = <
  Run extends PresentableExploration,
>(
  run: Run,
  options: PresentChatExplorationOptions<Run> = {},
): Effect.Effect<
  StructuredChatExplorationResponse,
  InvalidChatPresentation
> =>
  buildPresentation(
    () => options.result?.(run) ?? run.execution.views,
  ).pipe(
    Effect.flatMap((content) =>
      parseExplorationResponse({ schemaVersion: 1, content }),
    ),
    Effect.withSpan(
      "popcomputer.structured_chat.presentation.exploration",
      { attributes: { tool: run.name } },
    ),
  )

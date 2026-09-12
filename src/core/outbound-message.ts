import { Predicate, Context, Effect, Schema } from "effect"
import type { BranchContract } from "./branch.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"
import { TrustedInstructionSchema } from "./model.js"
import { AssistantTextPartSchema } from "./protocol.js"
import {
  ToolNameSchema,
  type ToolDefinitionContract,
  type ToolSchema,
} from "./tool.js"

/** A reply may select a registered tool or a registered chat branch. */
export type ReplyTarget = ToolDefinitionContract | BranchContract

/** Decoded arguments accepted by the exact target of a reply hint. */
export type ReplyArguments<T extends ReplyTarget> = T extends BranchContract
  ? Schema.Schema.Type<T["argumentsSchema"]>
  : T extends ToolDefinitionContract
    ? Schema.Schema.Type<T["inputSchema"]>
    : never

/** A fully bound candidate for the next successfully committed user reply. */
export interface ReplyHint<T extends ReplyTarget = ReplyTarget> {
  readonly target: T
  readonly arguments: ReplyArguments<T>
  readonly when: string
}

/** Bind authoritative arguments to one declared reply handler. */
export const hint = <T extends ReplyTarget>(
  target: T,
  arguments_: ReplyArguments<T>,
  options: { readonly when: string },
): ReplyHint<T> => ({ target, arguments: arguments_, when: options.when })

/** An outbound message or its reply hints failed validation. */
export class InvalidOutboundMessage extends Schema.TaggedError<InvalidOutboundMessage>()(
  "InvalidOutboundMessage",
  {
    reason: Schema.Literals([
      "invalid_input",
      "invalid_text",
      "invalid_hint",
      "not_registered",
      "identity_conflict",
    ]),
  },
) {}

/** @internal Validated text and encoded arguments, ready for one session commit. */
export interface PreparedMessage {
  readonly definition: OutboundMessageContract
  readonly input: JsonValue
  readonly text: string
  readonly hints: ReadonlyArray<{
    readonly target: ReplyTarget
    readonly arguments: JsonValue
    readonly when: string
  }>
}

const messageRuntime = Symbol(
  "@popcomputer/structured-chat/OutboundMessageRuntime",
)

/** Minimum sealed outbound-message definition. */
export interface OutboundMessageContract extends StructuredDefinition<"outbound_message"> {
  readonly name: string
  readonly inputSchema: ToolSchema
  readonly [messageRuntime]: {
    readonly prepare: (
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- sealed message boundary validates the supplied payload
      input: unknown,
    ) => Effect.Effect<PreparedMessage, InvalidOutboundMessage>
    readonly hints: (
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- sealed message boundary validates stored payloads without rendering text
      input: unknown,
    ) => Effect.Effect<PreparedMessage["hints"], InvalidOutboundMessage>
  }
}

/** Application-owned wording and reply expectations derived from typed input. */
export interface OutboundMessage<
  Name extends string,
  Input extends ToolSchema,
> extends OutboundMessageContract {
  readonly name: Name
  readonly inputSchema: Input
}

/** Define a message whose wording and hints are validated before persistence. */
export const defineMessage = <
  const Name extends string,
  Input extends ToolSchema,
>(input: {
  readonly name: Name
  readonly input: Input
  readonly text: (input: Input["Type"]) => string
  readonly replies?: (input: Input["Type"]) => ReadonlyArray<ReplyHint>
}): OutboundMessage<Name, Input> => {
  ToolNameSchema.make(input.name)
  const parseInput = Schema.decodeUnknownEffect(Schema.toType(input.input))

  const invalidInput = () =>
    new InvalidOutboundMessage({ reason: "invalid_input" })

  const invalidText = () =>
    new InvalidOutboundMessage({ reason: "invalid_text" })

  const invalidHint = () =>
    new InvalidOutboundMessage({ reason: "invalid_hint" })

  const prepareHints = Effect.fn("Message.prepareHints")(function* (
    value: Input["Type"],
  ) {
    const candidates = yield* Effect.try({
      try: () => input.replies?.(value) ?? [],
      catch: invalidHint,
    })

    if (candidates.length > 20) return yield* invalidHint()

    return yield* Effect.forEach(candidates, (candidate) =>
      Effect.gen(function* () {
        const when = yield* Schema.decodeEffect(TrustedInstructionSchema)(
          candidate.when,
        )

        const schema = Predicate.isTagged(candidate.target, "ChatBranch")
          ? candidate.target.argumentsSchema
          : candidate.target.inputSchema

        const arguments_ = yield* Schema.decodeUnknownEffect(
          Schema.toType(schema),
        )(candidate.arguments, { onExcessProperty: "error" })

        const encodedArguments = yield* Schema.encodeUnknownEffect(schema)(
          arguments_,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(JsonValueSchema)))

        return { target: candidate.target, arguments: encodedArguments, when }
      }).pipe(Effect.mapError(invalidHint)),
    )
  })

  const definition: OutboundMessage<Name, Input> = structuredDefinition(
    "outbound_message",
  )({
    name: input.name,
    inputSchema: input.input,
    [messageRuntime]: {
      prepare: (value) =>
        Effect.gen(function* () {
          const parsed = yield* parseInput(value, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(invalidInput))

          const encoded = yield* Schema.encodeUnknownEffect(input.input)(
            parsed,
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(JsonValueSchema)),
            Effect.mapError(invalidInput),
          )

          const text = yield* Effect.try({
            try: () => input.text(parsed),
            catch: invalidText,
          }).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(AssistantTextPartSchema.fields.text),
            ),
            Effect.mapError(invalidText),
          )

          const hints = yield* prepareHints(parsed)

          return { definition, input: encoded, text, hints }
        }),
      hints: (value) =>
        parseInput(value, { onExcessProperty: "error" }).pipe(
          Effect.mapError(invalidInput),
          Effect.flatMap(prepareHints),
        ),
    },
  })

  return definition
}

/** @internal Prepare one message through its sealed definition. */
export const prepareMessage = (
  definition: OutboundMessageContract,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validates an erased message payload using its registered codec
  input: unknown,
): Effect.Effect<PreparedMessage, InvalidOutboundMessage> =>
  definition[messageRuntime].prepare(input)

/** @internal Rebuild registered hints without rendering or reissuing message text. */
export const prepareReplyHints = (
  definition: OutboundMessageContract,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persisted input is decoded by the registered definition
  input: unknown,
) => definition[messageRuntime].hints(input)

/** Invocation-owned collector; messages join the current turn's atomic replacement. */
export class MessageCollector extends Context.Service<
  MessageCollector,
  {
    readonly emit: (
      message: PreparedMessage,
    ) => Effect.Effect<void, InvalidOutboundMessage>
  }
>()("@popcomputer/structured-chat/MessageCollector") {}

/** Issue a message inside a running chat without performing a nested session write. */
export const emit = <M extends OutboundMessageContract>(
  definition: M,
  input: Schema.Schema.Type<M["inputSchema"]>,
): Effect.Effect<void, InvalidOutboundMessage, MessageCollector> =>
  Effect.gen(function* () {
    const collector = yield* MessageCollector
    const message = yield* prepareMessage(definition, input)
    yield* collector.emit(message)
  })

import { Schema } from "effect"
import { ChatNameSchema, ChatVersionSchema } from "./chat-identity.js"
import { JsonValueSchema } from "./json-value.js"
import { ChatSessionIdSchema } from "./session.js"
import { ToolNameSchema } from "./tool.js"

const Index = Schema.Natural

const ParentSchema = Schema.Struct({
  invocation: Index,
  branch: ToolNameSchema,
})

/** Stored lifecycle of one independently scoped chat invocation. */
export const InvocationStatusSchema = Schema.TaggedUnion({
  Active: {},
  Waiting: { child: Index },
  Suspended: {},
  Completed: { output: Schema.Unknown },
  Cancelled: {},
})

/** Persistence envelope; input, workflow and output use their definition-owned codecs. */
export const InvocationSchema = Schema.Struct({
  id: Index,
  definition: Schema.String,
  parent: Schema.NullOr(ParentSchema),
  input: Schema.Unknown,
  workflow: Schema.Unknown,
  messages: Schema.Array(Index).check(Schema.isMaxLength(200)),
  status: InvocationStatusSchema,
})

/** Persisted outbound text and next-reply expectations. */
export const IssuedMessageSchema = Schema.Struct({
  id: ChatSessionIdSchema,
  invocation: Index,
  definition: ToolNameSchema,
  input: JsonValueSchema,
  messageIndex: Index,
  status: Schema.Literals(["pending", "consumed"]),
})

/** One session contains all invocations and issued-message identities. */
export const ConversationStateSchema = Schema.TaggedStruct("Conversation", {
  chat: ChatNameSchema,
  schemaVersion: ChatVersionSchema,
  status: Schema.Literals(["active", "complete"]),
  active: Index,
  invocations: Schema.NonEmptyArray(InvocationSchema).check(
    Schema.isMaxLength(100),
  ),
  issued: Schema.Array(IssuedMessageSchema).check(Schema.isMaxLength(200)),
})

/** Serialized chat composition state, revalidated against its registered definitions. */
export type ConversationState = Schema.Schema.Type<
  typeof ConversationStateSchema
>

/** Persisted invocation record. */
export type Invocation = Schema.Schema.Type<typeof InvocationSchema>

/** Stable outbound-message record. */
export type IssuedMessage = Schema.Schema.Type<typeof IssuedMessageSchema>

/** A composition boundary or transition was rejected before persistence. */
export class InvalidConversation extends Schema.TaggedError<InvalidConversation>()(
  "InvalidConversation",
  {
    reason: Schema.Literals([
      "invalid_input",
      "invalid_output",
      "invalid_state",
      "invalid_transition",
      "depth_limit",
      "transition_limit",
      "invocation_limit",
    ]),
  },
) {}

import { Predicate, Context, Effect, Schema } from "effect"
import {
  Answer,
  Chat,
  Message,
  Question,
  Stage,
  Tool,
  View,
} from "@popcomputer/structured-chat"

const SupportText = View.define({
  name: "support_text",
  version: 1,
  schema: Schema.Struct({ text: Schema.String }),
})

const SupportInput = Schema.Struct({ tenantId: Schema.String })

const NoticeArguments = Schema.Struct({ noticeId: Schema.String })

const DisputeInput = Schema.Struct({
  tenantId: Schema.String,
  noticeId: Schema.String,
})

const DisputeReceipt = Schema.Struct({ caseId: Schema.String })

class NoticeUnavailable extends Schema.TaggedError<NoticeUnavailable>()(
  "NoticeUnavailable",
  { reason: Schema.Literals(["not_found", "unavailable"]) },
) {}

/** Application implementation checks tenant ownership and deduplicates command IDs. */
export class Notices extends Context.Service<
  Notices,
  {
    readonly authorize: (
      input: Schema.Schema.Type<typeof DisputeInput>,
    ) => Effect.Effect<void, NoticeUnavailable>
    readonly acknowledge: (
      input: Schema.Schema.Type<typeof DisputeInput>,
      commandId: string,
    ) => Effect.Effect<void, NoticeUnavailable>
    readonly dispute: (
      input: Schema.Schema.Type<typeof DisputeInput> & {
        readonly reason: string
      },
      commandId: string,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof DisputeReceipt>,
      NoticeUnavailable
    >
  }
>()("example/Notices") {}

const Details = Stage.collect({
  name: "details",
  fields: {
    reason: Answer.explicit(Schema.String, {
      description: "The tenant's reason for disputing this notice",
      ask: Question.fixed("Why do you dispute this notice?"),
    }),
  },
})

const FileDispute = Tool.command({
  name: "file_dispute",
  description:
    "File the dispute the tenant has requested with their stated reason.",
  input: Schema.Struct({}),
  execute: (_, { commandId }) =>
    Effect.gen(function* () {
      const notice = yield* Chat.input(DisputeInput)

      const reason = yield* Tool.acceptedAnswer({
        stage: "details",
        field: "reason",
        schema: Schema.String,
      })

      const notices = yield* Notices

      return yield* notices.dispute({ ...notice, reason }, commandId)
    }),
}).pipe(
  Tool.present(SupportText, ({ caseId }) => ({
    text: `Your dispute reference is ${caseId}.`,
  })),
)

/** Self-contained: callable from support, another chat, or its own session. */
export const DisputeChat = Chat.define({
  name: "notice_dispute",
  version: 1,
  input: DisputeInput,
  output: {
    schema: DisputeReceipt,
    project: ({ result }) => result.serverResult,
  },
  stages: [
    Details,
    Stage.command({
      name: "file",
      instructions: ["File the requested dispute using its accepted reason."],
      command: FileDispute,
    }),
  ],
})

const Dispute = Chat.branch({
  name: "dispute_notice",
  description: "The tenant wants to dispute a particular notice.",
  chat: DisputeChat,
  arguments: NoticeArguments,
  input: ({ noticeId }) =>
    Effect.gen(function* () {
      const { tenantId } = yield* Chat.input(SupportInput)
      const notices = yield* Notices
      const input = { tenantId, noticeId }
      yield* notices.authorize(input)

      return input
    }),
})

const Acknowledge = Tool.command({
  name: "acknowledge_notice",
  description: "Record that the tenant acknowledges receiving a notice.",
  input: NoticeArguments,
  execute: ({ noticeId }, { commandId }) =>
    Effect.gen(function* () {
      const { tenantId } = yield* Chat.input(SupportInput)
      const notices = yield* Notices
      const input = { tenantId, noticeId }
      yield* notices.authorize(input)
      yield* notices.acknowledge(input, commandId)

      return "Receipt recorded."
    }),
}).pipe(Tool.present(SupportText, (text) => ({ text })))

export const TerminationNotice = Message.define({
  name: "termination_notice",
  input: NoticeArguments,
  text: ({ noticeId }) =>
    `Your notice reference is ${noticeId}. Would you like to dispute it?`,
  replies: (input) => [
    Message.hint(Dispute, input, {
      when: "The tenant wants to dispute this notice",
    }),
    Message.hint(Acknowledge, input, {
      when: "The tenant acknowledges receipt without requesting a dispute",
    }),
  ],
})

const Help = Tool.define({
  name: "help",
  description:
    "Offer support when the tenant declines the dispute or asks what help is available.",
  input: Schema.Struct({}),
  execute: () =>
    Effect.succeed(
      "I can help with your notices and disputes. What would you like to do?",
    ),
}).pipe(Tool.present(SupportText, (text) => ({ text })))

const ReadDispute = Tool.define({
  name: "read_dispute_result",
  description:
    "Read the latest completed or cancelled dispute in this conversation.",
  input: Schema.Struct({}),
  execute: () => Chat.returned(Dispute),
}).pipe(
  Tool.present(SupportText, (result) => ({
    text: Predicate.isTagged(result, "Completed")
      ? `Your dispute reference is ${result.output.caseId}.`
      : "The dispute was cancelled.",
  })),
)

export const SupportChat = Chat.define({
  name: "tenant_support",
  version: 1,
  input: SupportInput,
  branches: [Dispute],
  messages: [TerminationNotice],
  stages: [
    Stage.interact({
      name: "support",
      instructions: [
        "Help the tenant with notices. Declining a dispute leaves them in support. Receipt acknowledgement does not end support.",
      ],
      tools: [Help, Acknowledge, ReadDispute],
    }),
  ],
})

/** The application can publish the returned message after this atomic write. */
export const startSupport = (input: {
  readonly sessionId: string
  readonly tenantId: string
  readonly noticeId: string
}) =>
  Effect.gen(function* () {
    const notices = yield* Notices
    yield* notices.authorize(input)

    const started = yield* Chat.start(SupportChat, {
      sessionId: input.sessionId,
      input: { tenantId: input.tenantId },
    })

    return yield* Chat.post(SupportChat, {
      sessionId: input.sessionId,
      expectedRevision: started.revision,
      messageId: `notice:${input.noticeId}`,
      message: TerminationNotice,
      input: { noticeId: input.noticeId },
    })
  })

/** The same dispute definition also runs without the support caller. */
export const startStandaloneDispute = (input: {
  readonly sessionId: string
  readonly tenantId: string
  readonly noticeId: string
}) =>
  Effect.gen(function* () {
    const notices = yield* Notices
    yield* notices.authorize(input)

    return yield* Chat.start(DisputeChat, {
      sessionId: input.sessionId,
      input: { tenantId: input.tenantId, noticeId: input.noticeId },
    })
  })

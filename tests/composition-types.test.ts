import { Context, Effect, Schema } from "effect"
import { Chat, Message, Model, Session, Stage, Tool } from "../src/index.js"

class ChildService extends Context.Service<
  ChildService,
  { readonly value: number }
>()("ChildService") {}
class BindingService extends Context.Service<
  BindingService,
  { readonly id: string }
>()("BindingService") {}
class ChildError extends Schema.TaggedError<ChildError>()("ChildError", {}) {}
class BindingError extends Schema.TaggedError<BindingError>()(
  "BindingError",
  {},
) {}

const Input = Schema.Struct({ id: Schema.String })
const Finish = Tool.define({
  name: "finish",
  description: "Finish",
  input: Schema.Struct({ approved: Schema.Boolean }),
  execute: (): Effect.Effect<number, ChildError, ChildService> =>
    ChildService.pipe(Effect.map(({ value }) => value)),
})
const Child = Chat.define({
  name: "typed_child",
  version: 1,
  input: Input,
  output: {
    schema: Schema.Number,
    project: ({ result }) => result.serverResult,
  },
  stages: [
    Stage.tools({
      name: "finish",
      instructions: ["Finish"],
      tools: [Finish],
      afterExecution: "complete",
    }),
  ],
})
const Branch = Chat.branch({
  name: "child",
  description: "Call child",
  chat: Child,
  arguments: Schema.Struct({ accepted: Schema.Boolean }),
  input: (): Effect.Effect<
    Chat.Input<typeof Child>,
    BindingError,
    BindingService
  > => BindingService.pipe(Effect.map(({ id }) => ({ id }))),
})
const Notice = Message.define({
  name: "notice",
  input: Input,
  text: ({ id }) => id,
  replies: () => [
    Message.hint(Branch, { accepted: true }, { when: "The user accepts" }),
  ],
})
const ParentTool = Tool.define({
  name: "parent",
  description: "Continue",
  input: Schema.Struct({}),
  execute: () => Chat.returned(Branch),
})
const Parent = Chat.define({
  name: "typed_parent",
  version: 1,
  branches: [Branch],
  messages: [Notice],
  stages: [
    Stage.tools({
      name: "parent",
      instructions: ["Help"],
      tools: [ParentTool],
    }),
  ],
})
const execution = Chat.turn(Parent, {
  sessionId: "types",
  expectedRevision: "1",
  message: "Yes",
})

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T
export type PreservesTransitiveServices = Assert<
  Equal<
    Effect.Services<typeof execution>,
    Session.Store | Model.Service | ChildService | BindingService
  >
>
export type PreservesChildError = Assert<
  Equal<Extract<Effect.Error<typeof execution>, ChildError>, ChildError>
>
export type PreservesBindingError = Assert<
  Equal<Extract<Effect.Error<typeof execution>, BindingError>, BindingError>
>
export type PreservesInput = Assert<
  Equal<Chat.Input<typeof Child>, { readonly id: string }>
>
export type PreservesOutput = Assert<Equal<Chat.Output<typeof Child>, number>>
export type PreservesResult = Assert<
  Equal<
    Extract<
      Extract<
        Chat.Turn<typeof Parent>,
        { readonly _tag: "ToolResult" }
      >["result"]["serverResult"],
      number
    >,
    number
  >
>

const assertBoundaries = () => {
  Chat.branch({
    name: "bad",
    description: "Bad",
    chat: Child,
    arguments: Schema.Struct({}),
    // @ts-expect-error a branch's input resolver must return the child's declared input
    input: () => Effect.succeed(123),
  })
  // @ts-expect-error branch hints require the branch's exact arguments
  Message.hint(Branch, { accepted: "yes" }, { when: "Accepts" })
  // @ts-expect-error tool hints require the tool's exact arguments
  Message.hint(Finish, { approved: "yes" }, { when: "Continues" })
  // @ts-expect-error standalone input is checked
  Chat.start(Child, { sessionId: "bad", input: { id: 123 } })
  Chat.post(Parent, {
    sessionId: "bad",
    expectedRevision: "1",
    messageId: "one",
    message: Notice,
    // @ts-expect-error message payloads are checked
    input: { id: 123 },
  })
  Chat.post(Child, {
    sessionId: "bad",
    expectedRevision: "1",
    messageId: "one",
    // @ts-expect-error messages must be registered in the declared tree
    message: Notice,
    // @ts-expect-error an unregistered message has no valid payload
    input: { id: "one" },
  })
}
void assertBoundaries

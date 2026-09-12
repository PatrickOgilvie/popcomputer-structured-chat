import type { Effect } from "effect"
import { Function as Fn, Schema } from "effect"
import type { AnyDefinition, Definition } from "../../Chat.js"
import type {
  ChatExplorationTuple,
  ChatStageTuple,
  DefineChatInput,
} from "../../core/chat.js"
import {
  defineBranch,
  type Branch,
  type Branches,
  type InputOf,
} from "../../core/branch.js"
import type {
  ComposedDefinition,
  CompositionOptions,
} from "../../core/composition.js"
import {
  makeConversation,
  type ConversationNode,
} from "../../core/conversation.js"
import type { OutboundMessageContract } from "../../core/outbound-message.js"
import type { ToolSchema } from "../../core/tool.js"
import { compile, read } from "./definition.js"

interface Configuration {
  readonly inputSchema: ToolSchema
  readonly outputSchema: ToolSchema
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- erased projector is checked against its registered output schema
  readonly projectOutput: (turn: never) => unknown
  readonly branches: Branches
  readonly messages: ReadonlyArray<OutboundMessageContract>
  readonly maximumDepth: number
  readonly maximumTransitionsPerTurn: number
}

const configurations = new WeakMap<object, Configuration>()

const conversations = new WeakMap<object, ReturnType<typeof makeConversation>>()

const empty: Configuration = {
  inputSchema: Schema.Null,
  outputSchema: Schema.Null,
  projectOutput: () => null,
  branches: [],
  messages: [],
  maximumDepth: 8,
  maximumTransitionsPerTurn: 16,
}

const limitSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 64 }),
)

/** Define a chat with input/output contracts, branches, or outbound messages. */
export function define<
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple = readonly [],
  Input extends ToolSchema = typeof Schema.Null,
  Output extends ToolSchema = typeof Schema.Null,
  const Calls extends Branches = readonly [],
  const Messages extends ReadonlyArray<OutboundMessageContract> = readonly [],
>(
  input: DefineChatInput<Name, Version, Stages, Explorations> &
    CompositionOptions<Stages, Input, Output, Calls, Messages> &
    (
      | { readonly input: Input }
      | {
          readonly output: NonNullable<
            CompositionOptions<Stages, Input, Output, Calls, Messages>["output"]
          >
        }
      | { readonly branches: Calls }
      | { readonly messages: Messages }
    ),
): ComposedDefinition<
  Name,
  Version,
  Stages,
  Explorations,
  Input,
  Output,
  Calls,
  Messages
>
/** Define an ordinary standalone sequential chat. */
export function define<
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple = readonly [],
>(
  input: DefineChatInput<Name, Version, Stages, Explorations>,
): Definition<Name, Version, Stages, Explorations>
/** @internal Preserve the existing opaque definition while attaching composition metadata. */
export function define(
  input: DefineChatInput<
    string,
    number,
    ChatStageTuple,
    ChatExplorationTuple
  > & {
    readonly input?: ToolSchema
    readonly output?: {
      readonly schema: ToolSchema
      // oxlint-disable-next-line anti-slop/no-unknown-returns -- overloads preserve the exact projector type; runtime checks the schema
      readonly project: (turn: never) => unknown
    }
    readonly branches?: Branches
    readonly messages?: ReadonlyArray<OutboundMessageContract>
    readonly limits?: {
      readonly maximumDepth?: number
      readonly maximumTransitionsPerTurn?: number
    }
  },
): AnyDefinition {
  const definition = compile(input)

  if (
    input.input === undefined &&
    input.output === undefined &&
    input.branches === undefined &&
    input.messages === undefined
  )
    return definition
  const branches = input.branches ?? []
  const messages = input.messages ?? []

  if (new Set(branches.map((branch) => branch.name)).size !== branches.length)
    throw new Error("Chat branch names must be unique")

  if (new Set(messages.map((message) => message.name)).size !== messages.length)
    throw new Error("Outbound message names must be unique")
  const reserved = new Set(["continue_chat", "return_to_parent", "cancel_chat"])

  if (
    branches.some(
      (branch) =>
        reserved.has(branch.name) ||
        branch.name.startsWith("resume_") ||
        branch.name.startsWith("reply_"),
    )
  )
    throw new Error("Chat branch name is reserved for conversation routing")

  const configuration: Configuration = {
    inputSchema: input.input ?? Schema.Null,
    outputSchema: input.output?.schema ?? Schema.Null,
    projectOutput: input.output?.project ?? (() => null),
    branches,
    messages,
    maximumDepth: Schema.decodeSync(limitSchema)(
      input.limits?.maximumDepth ?? 8,
    ),
    maximumTransitionsPerTurn: Schema.decodeSync(limitSchema)(
      input.limits?.maximumTransitionsPerTurn ?? 16,
    ),
  }

  Object.defineProperty(definition, "composition", {
    value: {
      inputSchema: configuration.inputSchema,
      outputSchema: configuration.outputSchema,
      branches,
      messages,
    },
    enumerable: true,
  })
  configurations.set(definition, configuration)
  readConversation(definition)

  return definition
}

/** Declare a callable chat and an Effectful binding from model arguments to trusted input. */
export const branch = <
  const Name extends string,
  Arguments extends ToolSchema,
  Child extends AnyDefinition,
  Error,
  Requirements,
>(input: {
  readonly name: Name
  readonly description: string
  readonly chat: Child
  readonly arguments: Arguments
  readonly input: (
    arguments_: Schema.Schema.Type<Arguments>,
  ) => Effect.Effect<InputOf<Child>, Error, Requirements>
}): Branch<Name, Arguments, Child, Error, Requirements> => {
  read(input.chat)

  return defineBranch(input, configurations.get(input.chat) ?? empty)
}

/** @internal Whether this opaque definition opted into the conversation runtime. */
export const hasComposition = (definition: AnyDefinition): boolean =>
  configurations.has(definition)

/** @internal Compile a finite tree of existing stage runners without child session writes. */
export const readConversation = (
  definition: AnyDefinition,
): ReturnType<typeof makeConversation> => {
  const existing = conversations.get(definition)

  if (existing !== undefined) return existing
  const nodes = new Map<string, ConversationNode>()

  const build = (
    chat: AnyDefinition,
    key: string,
    ancestors: ReadonlySet<AnyDefinition>,
  ): ConversationNode => {
    if (ancestors.has(chat))
      throw new Error(
        "Recursive chat definitions require a finite declared call tree",
      )
    const leaf = read(chat)
    const configuration = configurations.get(chat) ?? empty
    const children = new Map<Branches[number], string>()
    const nextAncestors = new Set([...ancestors, chat])

    for (const branch of configuration.branches) {
      const childKey = `${key}/${branch.name}`
      build(branch.chat, childKey, nextAncestors)
      children.set(branch, childKey)
    }

    const node: ConversationNode = {
      key,
      definition: chat,
      leaf,
      input: configuration.inputSchema,
      output: configuration.outputSchema,
      // SAFETY: the configuration projector was typed against this exact leaf's completion.
      projectOutput: Fn.cast<
        typeof configuration.projectOutput,
        ConversationNode["projectOutput"]
      >(configuration.projectOutput),
      branches: configuration.branches,
      messages: configuration.messages,
      children,
    }

    nodes.set(key, node)

    return node
  }

  const root = build(definition, "root", new Set())
  const configuration = configurations.get(definition) ?? empty

  const runtime = makeConversation({
    root,
    nodes,
    maximumDepth: configuration.maximumDepth,
    maximumTransitionsPerTurn: configuration.maximumTransitionsPerTurn,
  })

  conversations.set(definition, runtime)

  return runtime
}

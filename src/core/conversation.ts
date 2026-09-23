import { isAnswerStage } from "./answer-collection.js"
import { Predicate, Data, Effect, Function as Fn, Schema } from "effect"
import type { AnyDefinition } from "../Chat.js"
import { readBranch, type BranchContract, type Branches } from "./branch.js"
import { ChatContext, type ChatOutcome } from "./chat-context.js"
import type {
  ChatDefinition,
  ChatExplorationTuple,
  ChatExploreInput,
  ChatReplyInput,
  ChatStageTuple,
} from "./chat.js"
import { InvalidChatTransition } from "./chat.js"
import { deriveCommandId } from "./command.js"
import type {
  ConversationReply,
  PostedMessage,
  StartedConversation,
} from "./composition.js"
import {
  ConversationStateSchema,
  InvocationStatusSchema,
  InvalidConversation,
  type ConversationState,
  type Invocation,
} from "./conversation-state.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"
import { Instruction, planToolCall, UntrustedMessageSchema } from "./model.js"
import {
  authored,
  isAuthored,
  type ConversationMessage,
} from "./conversation-message.js"
import {
  isAppliedTurn,
  parseControlledTurn,
  turnMessages,
  AdvanceResult,
  ControlledTurnInputSchema,
  type ControlledTurnInput,
} from "./observed-turn.js"
import {
  uncontrolledTurn,
  type TurnControlService,
  type TurnControlFailure,
} from "./turn-control.js"
import { runModelCallGuards } from "./model-guard.js"
import {
  InvalidOutboundMessage,
  MessageCollector,
  prepareMessage,
  prepareReplyHints,
  type OutboundMessageContract,
  type PreparedMessage,
} from "./outbound-message.js"
import { Text, type AssistantMessagePart } from "./protocol.js"
import {
  ChatSessionConflict,
  ChatSessionNotFound,
  ChatSessionStore,
  ChatSessionIdSchema,
  ChatSessionNamespaceSchema,
  ChatSessionRevisionSchema,
  ChatSessionSnapshotSchema,
  ChatSessionReplacementSchema,
  InvalidChatSession,
  type ChatSessionScope,
  type ChatSessionSnapshot,
} from "./session.js"
import { readInteractionStageRuntime } from "./interaction-stage.js"
import { readCollectStageRuntime } from "./collect-stage.js"
import { readToolStageRuntime } from "./stage.js"
import {
  defineTool,
  readToolExecutionModelContext,
  type ToolDefinitionContract,
  type ToolSchema,
  type RuntimeToolExecutionContext,
} from "./tool.js"
import { ToolContext } from "./tool-context.js"
import {
  compileToolRegistry,
  type CommandContextSource,
} from "./tool-registry.js"
import { defineToolSet, type ToolTuple } from "./tool-set.js"
import type { ModelToolTuple } from "./tool-set.js"
import { projectUserAnswers } from "./user-answer-projection.js"
import type { RuntimeChatState } from "../internal/chat/process.js"

/** @internal One compiled chat and its directly declared child calls. */
export interface ConversationNode {
  readonly key: string
  readonly definition: AnyDefinition
  readonly leaf: ChatDefinition<
    string,
    number,
    ChatStageTuple,
    ChatExplorationTuple
  >
  readonly input: ToolSchema
  readonly output: ToolSchema
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- heterogeneous projector output is immediately decoded with this node's output schema
  readonly projectOutput: (turn: LeafTurn) => unknown
  readonly branches: Branches
  readonly messages: ReadonlyArray<OutboundMessageContract>
  readonly children: ReadonlyMap<BranchContract, string>
}

interface LeafTurn {
  readonly clarification?: { readonly text: string }
  readonly _tag: "Question" | "Clarification" | "ToolResult" | "Complete"
  readonly stage: string
  readonly state: RuntimeChatState
  readonly question?: {
    readonly field: string
    readonly text: string
    readonly options: ReadonlyArray<{ readonly label: string }>
    readonly escape?: { readonly label: string }
  }
  readonly result?: RuntimeToolExecutionContext & {
    readonly serverResult: unknown
    readonly modelResult: unknown
    readonly views: ReadonlyArray<AssistantMessagePart>
  }
}

interface ParsedInvocation extends Omit<Invocation, "workflow"> {
  readonly workflow: RuntimeChatState
}

interface ParsedConversation extends Omit<ConversationState, "invocations"> {
  readonly invocations: readonly [
    ParsedInvocation,
    ...ReadonlyArray<ParsedInvocation>,
  ]
}

interface LoadedConversation {
  readonly scope: ChatSessionScope
  readonly snapshot: ChatSessionSnapshot
  readonly state: ParsedConversation
}

type ReplyAction = Data.TaggedEnum<{
  Continue: {}
  Enter: {
    readonly branch: BranchContract
    readonly arguments: unknown
    readonly sourceMessage: number | undefined
  }
  Tool: { readonly tool: ToolDefinitionContract; readonly arguments: JsonValue }
  Resume: { readonly invocation: number }
  Suspend: {}
  Cancel: {}
}>

const ReplyAction = Data.taggedEnum<ReplyAction>()

const SessionInputSchema = Schema.Struct({
  namespace: Schema.optional(ChatSessionNamespaceSchema),
  sessionId: ChatSessionIdSchema,
})

const TurnInputSchema = Schema.Struct({
  ...SessionInputSchema.fields,
  expectedRevision: Schema.optionalKey(ChatSessionRevisionSchema),
  message: UntrustedMessageSchema.fields.content,
})

const invalidState = () => new InvalidConversation({ reason: "invalid_state" })

const invalidSession = () => new InvalidChatSession({ reason: "invalid_input" })

const conflict = () => new ChatSessionConflict({ reason: "concurrent_update" })

const parseJson = Schema.decodeUnknownEffect(JsonValueSchema)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- schema-owned serialization boundary for heterogeneous inputs and outputs
const encodeValue = (schema: ToolSchema, value: unknown) =>
  Schema.encodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.flatMap(parseJson),
  )

const canonicalJson = (value: JsonValue): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON has already been parsed; canonicalization sorts only object keys
  if (value === null || typeof value !== "object") return JSON.stringify(value)

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`
}

const frameMessages = (
  frame: ParsedInvocation,
  messages: ReadonlyArray<ConversationMessage>,
): ReadonlyArray<ConversationMessage> =>
  frame.messages.flatMap((index) =>
    messages[index] === undefined ? [] : [messages[index]],
  )

const replaceFrame = (
  state: ParsedConversation,
  frame: ParsedInvocation,
): ParsedConversation => {
  // SAFETY: replacing an existing invocation retains the non-empty root tuple.
  const invocations = Fn.cast<
    ReadonlyArray<ParsedInvocation>,
    ParsedConversation["invocations"]
  >(state.invocations.map((entry) => (entry.id === frame.id ? frame : entry)))

  return { ...state, invocations }
}

/** @internal Construct the invocation runtime around existing checked stage runners. */
export const makeConversation = (input: {
  readonly root: ConversationNode
  readonly nodes: ReadonlyMap<string, ConversationNode>
  readonly maximumDepth: number
  readonly maximumTransitionsPerTurn: number
}) => {
  const nodeFor = (frame: Invocation): ConversationNode => {
    const node = input.nodes.get(frame.definition)

    if (node === undefined)
      throw new Error("Parsed invocation lost its compiled chat")

    return node
  }

  const parseState = Effect.fn("Conversation.parseState")(function* (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- persistence boundary decodes the envelope and every registered invocation codec
    value: unknown,
    messages: ReadonlyArray<ConversationMessage>,
  ) {
    const state = yield* Schema.decodeUnknownEffect(ConversationStateSchema)(
      value,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(invalidState))

    if (
      state.chat !== input.root.leaf.name ||
      state.schemaVersion !== input.root.leaf.version ||
      state.invocations[0].definition !== input.root.key
    )
      return yield* invalidState()

    const frames = yield* Effect.forEach(state.invocations, (frame, index) =>
      Effect.gen(function* () {
        const node = input.nodes.get(frame.definition)

        if (node === undefined || frame.id !== index)
          return yield* invalidState()

        if (
          index === 0
            ? frame.parent !== null
            : frame.parent === null || frame.parent.invocation >= index
        )
          return yield* invalidState()
        let depth = 1
        let ancestor = frame.parent

        while (ancestor !== null) {
          depth += 1
          ancestor = state.invocations[ancestor.invocation]?.parent ?? null

          if (depth > input.maximumDepth) return yield* invalidState()
        }

        if (frame.parent !== null) {
          const parent = state.invocations[frame.parent.invocation]

          const parentNode =
            parent === undefined
              ? undefined
              : input.nodes.get(parent.definition)

          const branch = parentNode?.branches.find(
            (entry) => entry.name === frame.parent?.branch,
          )

          if (
            branch === undefined ||
            parentNode?.children.get(branch) !== node.key
          )
            return yield* invalidState()
        }

        if (
          frame.messages.some(
            (entry, position) =>
              entry >= messages.length ||
              (position > 0 && entry <= (frame.messages[position - 1] ?? -1)),
          )
        )
          return yield* invalidState()

        const decodedInput = yield* Schema.decodeUnknownEffect(node.input)(
          frame.input,
          { onExcessProperty: "error" },
        ).pipe(Effect.mapError(invalidState))

        const decodedWorkflow = yield* node.leaf
          .parseState(frame.workflow)
          .pipe(Effect.mapError(invalidState))

        // SAFETY: each workflow was decoded by its exact registered stage tuple.
        const workflow = Fn.cast<typeof decodedWorkflow, RuntimeChatState>(
          decodedWorkflow,
        )

        const localMessages = frame.messages.flatMap((entry) =>
          messages[entry] === undefined ? [] : [messages[entry]],
        )

        for (const stage of node.leaf.stages) {
          if (!isAnswerStage(stage)) continue
          const stageState = workflow.stages[stage.name]

          if (
            stageState === undefined ||
            !readCollectStageRuntime(stage).isGroundedInMessages(
              stageState,
              localMessages,
            )
          )
            return yield* invalidState()
        }

        if (
          Predicate.isTagged(frame.status, "Completed") !==
          (workflow.status === "complete")
        )
          return yield* invalidState()

        const status = Predicate.isTagged(frame.status, "Completed")
          ? {
              _tag: "Completed" as const,
              output: yield* Schema.decodeUnknownEffect(node.output)(
                frame.status.output,
                { onExcessProperty: "error" },
              ).pipe(Effect.mapError(invalidState)),
            }
          : frame.status

        return { ...frame, input: decodedInput, workflow, status }
      }),
    )

    const active = frames[state.active]

    if (
      active === undefined ||
      (state.status === "active"
        ? !Predicate.isTagged(active.status, "Active")
        : state.active !== 0 || !Predicate.isTagged(active.status, "Completed"))
    )
      return yield* invalidState()

    if (
      frames.filter((frame) => Predicate.isTagged(frame.status, "Active"))
        .length !== (state.status === "active" ? 1 : 0)
    )
      return yield* invalidState()

    for (const frame of frames) {
      if (Predicate.isTagged(frame.status, "Waiting")) {
        const child = frames[frame.status.child]

        if (
          child?.parent?.invocation !== frame.id ||
          (!Predicate.isTagged(child.status, "Active") &&
            !Predicate.isTagged(child.status, "Waiting"))
        )
          return yield* invalidState()
      }

      if (
        frame.parent !== null &&
        (Predicate.isTagged(frame.status, "Active") ||
          Predicate.isTagged(frame.status, "Waiting"))
      ) {
        const parent = frames[frame.parent.invocation]

        if (
          parent?.status._tag !== "Waiting" ||
          parent.status.child !== frame.id
        )
          return yield* invalidState()
      }
    }

    if (
      (frames[0]?.status._tag === "Completed") !==
      (state.status === "complete")
    )
      return yield* invalidState()
    const identities = new Set<string>()
    const issuedIndices = new Set<number>()

    for (const issued of state.issued) {
      const message = messages[issued.messageIndex]
      const owner = frames[issued.invocation]

      const definition =
        owner === undefined
          ? undefined
          : nodeFor(owner).messages.find(
              (message) => message.name === issued.definition,
            )

      if (
        definition === undefined ||
        identities.has(issued.id) ||
        issuedIndices.has(issued.messageIndex) ||
        message === undefined ||
        !isAuthored(message) ||
        !owner?.messages.includes(issued.messageIndex)
      )
        return yield* invalidState()
      yield* Schema.decodeEffect(definition.inputSchema)(issued.input, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(invalidState))
      identities.add(issued.id)
      issuedIndices.add(issued.messageIndex)
    }

    // SAFETY: the outer schema requires a root and every frame was decoded above.
    return {
      ...state,
      invocations: Fn.cast<typeof frames, ParsedConversation["invocations"]>(
        frames,
      ),
    }
  })

  const encodeState = (state: ParsedConversation) =>
    Effect.gen(function* () {
      const invocations = yield* Effect.forEach(state.invocations, (frame) =>
        Effect.gen(function* () {
          const node = nodeFor(frame)

          return {
            ...frame,
            input: yield* encodeValue(node.input, frame.input),
            workflow: yield* Schema.encodeUnknownEffect(node.leaf.stateSchema)(
              frame.workflow,
              { onExcessProperty: "error" },
            ),
            status: Predicate.isTagged(frame.status, "Completed")
              ? {
                  _tag: "Completed" as const,
                  output: yield* encodeValue(node.output, frame.status.output),
                }
              : frame.status,
          }
        }),
      )

      return yield* parseJson({ ...state, invocations })
    }).pipe(Effect.mapError(invalidState))

  const scopeFor = (session: {
    readonly namespace?: string | undefined
    readonly sessionId: string
  }): ChatSessionScope => ({
    namespace: session.namespace ?? "",
    sessionId: session.sessionId,
    chat: input.root.leaf.name,
    version: input.root.leaf.version,
  })

  const load = Effect.fn("Conversation.load")(function* (session: {
    readonly namespace?: string | undefined
    readonly sessionId: string
  }): Effect.fn.Return<LoadedConversation, unknown, ChatSessionStore> {
    const parsed = yield* Schema.decodeEffect(SessionInputSchema)(session, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalidSession))

    const scope = scopeFor(parsed)
    const store = yield* ChatSessionStore
    const raw = yield* store.load(scope)

    if (raw === null)
      return yield* new ChatSessionNotFound({ reason: "not_found" })

    const snapshot = yield* Schema.decodeUnknownEffect(
      ChatSessionSnapshotSchema,
    )(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(invalidState))

    const state = yield* parseState(snapshot.state, snapshot.messages)

    return { scope, snapshot, state }
  })

  const commit = Effect.fn("Conversation.commit")(function* (
    scope: ChatSessionScope,
    revision: string | null,
    state: ParsedConversation,
    messages: ReadonlyArray<ConversationMessage>,
  ) {
    if (messages.length > 200)
      return yield* new InvalidChatSession({ reason: "history_limit" })
    const encoded = yield* encodeState(state)
    yield* parseState(encoded, messages)
    const store = yield* ChatSessionStore

    const replacement = yield* store.replace({
      ...scope,
      expectedRevision: revision,
      state: encoded,
      messages,
    })

    return yield* Schema.decodeUnknownEffect(ChatSessionReplacementSchema)(
      replacement,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError(
        () => new InvalidChatSession({ reason: "invalid_replacement" }),
      ),
    )
  })

  const start = Effect.fn("Conversation.start")(function* (request: {
    readonly namespace?: string | undefined
    readonly sessionId: string
    readonly input: unknown
  }): Effect.fn.Return<StartedConversation, unknown, ChatSessionStore> {
    const parsed = yield* Schema.decodeEffect(
      Schema.Struct({ ...SessionInputSchema.fields, input: Schema.Unknown }),
    )(request, { onExcessProperty: "error" }).pipe(
      Effect.mapError(invalidSession),
    )

    const value = yield* Schema.decodeUnknownEffect(
      Schema.toType(input.root.input),
    )(parsed.input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        () => new InvalidConversation({ reason: "invalid_input" }),
      ),
    )

    const encodedInput = yield* encodeValue(input.root.input, value).pipe(
      Effect.mapError(
        () => new InvalidConversation({ reason: "invalid_input" }),
      ),
    )

    const scope = scopeFor(parsed)
    const store = yield* ChatSessionStore
    const existing = yield* store.load(scope)

    if (existing !== null) {
      const snapshot = yield* Schema.decodeUnknownEffect(
        ChatSessionSnapshotSchema,
      )(existing, { onExcessProperty: "error" }).pipe(
        Effect.mapError(invalidState),
      )

      const state = yield* parseState(snapshot.state, snapshot.messages)
      const loaded = { snapshot, state }

      const previousInput = yield* encodeValue(
        input.root.input,
        loaded.state.invocations[0].input,
      )

      if (canonicalJson(previousInput) !== canonicalJson(encodedInput))
        return yield* conflict()

      return {
        sessionId: scope.sessionId,
        revision: loaded.snapshot.revision,
        state: loaded.state,
      }
    }

    const state: ParsedConversation = {
      _tag: "Conversation",
      chat: input.root.leaf.name,
      schemaVersion: input.root.leaf.version,
      status: "active",
      active: 0,
      issued: [],
      invocations: [
        {
          id: 0,
          definition: input.root.key,
          parent: null,
          input: value,
          // SAFETY: the initial workflow belongs to this compiled root definition.
          workflow: Fn.cast<
            typeof input.root.leaf.initialState,
            RuntimeChatState
          >(input.root.leaf.initialState),
          messages: [],
          status: InvocationStatusSchema.cases.Active.make({}),
        },
      ],
    }

    const replacement = yield* commit(scope, null, state, [])

    return { sessionId: scope.sessionId, revision: replacement.revision, state }
  })

  const activeFrame = (state: ParsedConversation): ParsedInvocation => {
    const frame = state.invocations[state.active]

    if (frame === undefined)
      throw new Error("Parsed conversation lost its active invocation")

    return frame
  }

  const toolsFor = (
    frame: ParsedInvocation,
  ): ReadonlyArray<ToolDefinitionContract> => {
    const stage = nodeFor(frame).leaf.stages[frame.workflow.stage]

    switch (stage?._tag) {
      case "ToolStage":
        return stage.toolSet.tools
      case "InteractionStage":
        return stage.tools
      case "CommandStage":
        return [stage.command]
      case "InterviewStage":
        return stage.tools
      case "CollectStage":
      case undefined:
        return []
    }
  }

  const checkMessage = (frame: ParsedInvocation, message: PreparedMessage) => {
    const node = nodeFor(frame)

    if (!node.messages.includes(message.definition))
      return Effect.fail(
        new InvalidOutboundMessage({ reason: "not_registered" }),
      )

    for (const hint of message.hints) {
      const registered = Predicate.isTagged(hint.target, "ChatBranch")
        ? node.branches.includes(hint.target)
        : toolsFor(frame).includes(hint.target)

      if (!registered)
        return Effect.fail(
          new InvalidOutboundMessage({ reason: "invalid_hint" }),
        )
    }

    return Effect.void
  }

  const append = (
    state: ParsedConversation,
    messages: ReadonlyArray<ConversationMessage>,
    owner: number,
    message: ConversationMessage,
  ) => {
    const frame = state.invocations[owner]

    if (frame === undefined)
      throw new Error("Message owner is not an invocation")

    return {
      state: replaceFrame(state, {
        ...frame,
        messages: [...frame.messages, messages.length],
      }),
      messages: [...messages, message],
    }
  }

  const issue = (
    state: ParsedConversation,
    messages: ReadonlyArray<ConversationMessage>,
    owner: number,
    id: string,
    message: PreparedMessage,
  ) => {
    const next = append(state, messages, owner, authored(message.text))

    return {
      ...next,
      state: {
        ...next.state,
        issued: [
          ...next.state.issued,
          {
            id,
            invocation: owner,
            definition: message.definition.name,
            input: message.input,
            messageIndex: messages.length,
            status: "pending" as const,
          },
        ],
      },
    }
  }

  const post = Effect.fn("Conversation.post")(function* (request: {
    readonly namespace?: string | undefined
    readonly sessionId: string
    readonly expectedRevision: string
    readonly messageId: string
    readonly message: OutboundMessageContract
    readonly input: unknown
  }): Effect.fn.Return<PostedMessage, unknown, ChatSessionStore> {
    const parsed = yield* Schema.decodeEffect(
      Schema.Struct({
        ...SessionInputSchema.fields,
        expectedRevision: ChatSessionRevisionSchema,
        messageId: ChatSessionIdSchema,
        message: Schema.Unknown,
        input: Schema.Unknown,
      }),
    )(request, { onExcessProperty: "error" }).pipe(
      Effect.mapError(invalidSession),
    )

    const loaded = yield* load({
      sessionId: parsed.sessionId,
      namespace: parsed.namespace,
    })

    const previous = loaded.state.issued.find(
      (entry) => entry.id === parsed.messageId,
    )

    if (previous !== undefined) {
      const owner = loaded.state.invocations[previous.invocation]

      const registered =
        owner === undefined
          ? undefined
          : nodeFor(owner).messages.find(
              (entry) => entry.name === previous.definition,
            )

      if (registered !== request.message)
        return yield* new InvalidOutboundMessage({
          reason: "identity_conflict",
        })

      const encoded = yield* encodeValue(
        request.message.inputSchema,
        parsed.input,
      ).pipe(
        Effect.mapError(
          () => new InvalidOutboundMessage({ reason: "invalid_input" }),
        ),
      )

      if (canonicalJson(previous.input) !== canonicalJson(encoded))
        return yield* new InvalidOutboundMessage({
          reason: "identity_conflict",
        })
      const text = loaded.snapshot.messages[previous.messageIndex]?.content

      if (text === undefined) return yield* invalidState()

      return {
        disposition: "replayed",
        messageId: previous.id,
        session: {
          id: loaded.scope.sessionId,
          revision: loaded.snapshot.revision,
        },
        message: { role: "assistant", content: [Text.make(text)] },
      }
    }

    if (loaded.snapshot.revision !== parsed.expectedRevision)
      return yield* conflict()

    if (loaded.state.status === "complete")
      return yield* new InvalidChatTransition({
        chat: input.root.leaf.name,
        reason: "already_complete",
      })
    const frame = activeFrame(loaded.state)

    if (!nodeFor(frame).messages.includes(request.message))
      return yield* new InvalidOutboundMessage({ reason: "not_registered" })
    const message = yield* prepareMessage(request.message, parsed.input)
    yield* checkMessage(frame, message)

    const next = issue(
      loaded.state,
      loaded.snapshot.messages,
      frame.id,
      parsed.messageId,
      message,
    )

    const replaced = yield* commit(
      loaded.scope,
      loaded.snapshot.revision,
      next.state,
      next.messages,
    )

    return {
      disposition: "recorded",
      messageId: parsed.messageId,
      session: { id: loaded.scope.sessionId, revision: replaced.revision },
      message: { role: "assistant", content: [Text.make(message.text)] },
    }
  })

  const invocationContext = (
    state: ParsedConversation,
    frame: ParsedInvocation,
  ) => ({
    input: frame.input,
    returns: state.invocations.flatMap((child) => {
      if (
        child.parent?.invocation !== frame.id ||
        (!Predicate.isTagged(child.status, "Completed") &&
          !Predicate.isTagged(child.status, "Cancelled"))
      )
        return []

      const branch = nodeFor(frame).branches.find(
        (entry) => entry.name === child.parent?.branch,
      )

      return branch === undefined ? [] : [{ branch, outcome: child.status }]
    }),
  })

  const plan = Effect.fn("Conversation.plan")(function* (
    state: ParsedConversation,
    frame: ParsedInvocation,
    messages: ReadonlyArray<ConversationMessage>,
    allowParentControl: boolean,
  ): Effect.fn.Return<ReplyAction, unknown, unknown> {
    const node = nodeFor(frame)
    const stage = node.leaf.stages[frame.workflow.stage]

    if (stage === undefined) return yield* invalidState()

    const Continue = defineTool({
      name: "continue_chat",
      description:
        "Handle the user's current request in this conversation. Use when no declared branch or reply hint applies, including when the user declines an offered flow.",
      input: Schema.Struct({}),
      execute: () => Effect.succeed(ReplyAction.Continue()),
    })

    const candidates: Array<ToolDefinitionContract> = [Continue]

    for (const branch of node.branches) {
      candidates.push(
        defineTool({
          name: branch.name,
          description: branch.description,
          input: branch.argumentsSchema,
          execute: (arguments_) =>
            Effect.succeed(
              ReplyAction.Enter({
                branch,
                arguments: arguments_,
                sourceMessage: undefined,
              }),
            ),
        }),
      )
    }

    for (const issued of state.issued) {
      if (issued.invocation !== frame.id || issued.status !== "pending")
        continue

      const definition = node.messages.find(
        (entry) => entry.name === issued.definition,
      )

      if (definition === undefined) return yield* invalidState()

      const value = yield* Schema.decodeEffect(definition.inputSchema)(
        issued.input,
      ).pipe(Effect.mapError(invalidState))

      const hints = yield* prepareReplyHints(definition, value)

      for (const [index, hint] of hints.entries()) {
        const target = hint.target

        if (
          Predicate.isTagged(target, "ChatBranch")
            ? !node.branches.includes(target)
            : !toolsFor(frame).includes(target)
        )
          continue
        const localIndex = frame.messages.indexOf(issued.messageIndex)
        candidates.push(
          defineTool({
            name: `reply_${issued.messageIndex}_${index}`,
            description: `For a reply to assistant message ${localIndex}: ${hint.when} Select only when the user's actual reply matches this condition. Declining the offer or changing topic does not match. The handler's arguments are already bound by the application.`,
            input: Schema.Struct({}),
            execute: (): Effect.Effect<ReplyAction, Schema.SchemaError> =>
              Predicate.isTagged(target, "ChatBranch")
                ? Schema.decodeEffect(target.argumentsSchema)(hint.arguments, {
                    onExcessProperty: "error",
                  }).pipe(
                    Effect.map((arguments_) =>
                      ReplyAction.Enter({
                        branch: target,
                        arguments: arguments_,
                        sourceMessage: issued.messageIndex,
                      }),
                    ),
                  )
                : Effect.succeed(
                    ReplyAction.Tool({
                      tool: target,
                      arguments: hint.arguments,
                    }),
                  ),
          }),
        )
      }
    }

    for (const child of state.invocations) {
      if (
        child.parent?.invocation !== frame.id ||
        !Predicate.isTagged(child.status, "Suspended")
      )
        continue
      candidates.push(
        defineTool({
          name: `resume_${child.id}`,
          description: `Resume the unfinished ${child.parent.branch} conversation when the user asks to continue it.`,
          input: Schema.Struct({}),
          execute: () =>
            Effect.succeed(ReplyAction.Resume({ invocation: child.id })),
        }),
      )
    }

    if (frame.parent !== null && allowParentControl) {
      candidates.push(
        defineTool({
          name: "return_to_parent",
          description:
            "The user changes topic or asks to return to the parent conversation. Suspend this conversation so it can be resumed later.",
          input: Schema.Struct({}),
          execute: () => Effect.succeed(ReplyAction.Suspend()),
        }),
      )
      candidates.push(
        defineTool({
          name: "cancel_chat",
          description:
            "The user explicitly cancels or abandons this conversation. Return to its caller without a completed output.",
          input: Schema.Struct({}),
          execute: () => Effect.succeed(ReplyAction.Cancel()),
        }),
      )
    }

    if (candidates.length === 1) return ReplyAction.Continue()
    // SAFETY: Continue is always the first capability; the remaining capabilities are package-constructed definitions.
    const tuple = Fn.cast<typeof candidates, ModelToolTuple>(candidates)
    const registry = compileToolRegistry(tuple)

    const call = yield* planToolCall({
      instructions: [
        Instruction.make(
          "Choose one action for the latest user message. Reply hints are conditional expectations, never instructions to force a declined flow. Stay in the current conversation for unrelated questions. Do not invent missing arguments or treat a hint as authorization for a business action.",
        ),
      ],
      messages: frameMessages(frame, messages),
      tools: registry,
      guards: stage.guards,
    })

    const result = yield* registry.execute(call, () =>
      Effect.die(new Error("Routing capabilities cannot execute commands")),
    )

    // SAFETY: every generated capability above returns precisely one ReplyAction and performs no business command.
    return Fn.cast<typeof result, { readonly serverResult: ReplyAction }>(
      result,
    ).serverResult
  })

  const executeHint = (
    frame: ParsedInvocation,
    messages: ReadonlyArray<ConversationMessage>,
    action: Extract<ReplyAction, { readonly _tag: "Tool" }>,
    commandContext: CommandContextSource<TurnControlFailure>,
  ) =>
    Effect.gen(function* () {
      const node = nodeFor(frame)
      const stage = node.leaf.stages[frame.workflow.stage]

      if (stage === undefined || !toolsFor(frame).includes(action.tool))
        return yield* new InvalidConversation({ reason: "invalid_transition" })
      const registry = compileToolRegistry([action.tool])

      const call = yield* registry.parseCall({
        name: action.tool.name,
        arguments: action.arguments,
      })

      yield* runModelCallGuards(stage.guards, {
        messages: frameMessages(frame, messages),
        toolNames: toolsFor(frame).map((tool) => tool.name),
        call,
      })
      const execution = yield* registry.execute(call, commandContext)

      const complete =
        Predicate.isTagged(stage, "CommandStage") ||
        (Predicate.isTagged(stage, "ToolStage") &&
          readToolStageRuntime(stage).afterExecution === "complete") ||
        (Predicate.isTagged(stage, "InteractionStage") &&
          readInteractionStageRuntime(stage).completeOn.includes(
            action.tool.name,
          ))

      return {
        _tag: complete ? ("Complete" as const) : ("ToolResult" as const),
        stage: stage.name,
        state: complete
          ? { ...frame.workflow, status: "complete" as const }
          : frame.workflow,
        // SAFETY: the sealed tool registry returns its validated execution and presentation projections.
        result: Fn.cast<typeof execution, NonNullable<LeafTurn["result"]>>(
          execution,
        ),
      }
    })

  const advance = Effect.fn("Conversation.advance")(function* (
    request: ControlledTurnInput,
    control: TurnControlService,
  ): Effect.fn.Return<
    AdvanceResult<ConversationReply<AnyDefinition>>,
    unknown,
    unknown
  > {
    const parsed = yield* parseControlledTurn(request)

    const loaded = yield* load({
      sessionId: parsed.sessionId,
      namespace: parsed.namespace,
    })

    if (yield* isAppliedTurn(parsed.turn, loaded.snapshot.messages))
      return AdvanceResult.AlreadyApplied({
        currentRevision: loaded.snapshot.revision,
      })

    if (loaded.snapshot.revision !== parsed.expectedRevision)
      return yield* conflict()

    if (loaded.state.status === "complete")
      return yield* new InvalidChatTransition({
        chat: input.root.leaf.name,
        reason: "already_complete",
      })
    let state = loaded.state
    let messages = loaded.snapshot.messages
    const incoming = turnMessages(parsed.turn)

    if (messages.length + incoming.length + 1 > 200)
      return yield* new InvalidChatSession({ reason: "history_limit" })
    const initialFrame = activeFrame(state)
    const userIndex = messages.length
    const incomingIndexes = incoming.map((_, index) => userIndex + index)
    yield* control.check()

    for (const message of incoming) {
      const appended = append(state, messages, initialFrame.id, message)
      state = appended.state
      messages = appended.messages
    }

    const emitted: Array<{
      readonly owner: number
      readonly message: PreparedMessage
    }> = []

    const commandContext = () =>
      deriveCommandId({
        ...loaded.scope,
        expectedRevision: loaded.snapshot.revision,
      }).pipe(
        Effect.tap((commandId) => control.admitCommand(commandId)),
        Effect.map((commandId) => ({ commandId })),
      )

    const scoped = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      frame: ParsedInvocation,
    ) =>
      effect.pipe(
        Effect.provideService(ChatContext, invocationContext(state, frame)),
        Effect.provideService(ToolContext, { stages: frame.workflow.stages }),
        Effect.provideService(MessageCollector, {
          emit: (message) =>
            nodeFor(frame).messages.includes(message.definition)
              ? Effect.sync(() => {
                  emitted.push({ owner: frame.id, message })
                })
              : Effect.fail(
                  new InvalidOutboundMessage({ reason: "not_registered" }),
                ),
        }),
      )

    const consumeHints = (owner: number) => {
      state = {
        ...state,
        issued: state.issued.map((entry) =>
          entry.invocation === owner && entry.messageIndex < userIndex
            ? { ...entry, status: "consumed" as const }
            : entry,
        ),
      }
    }

    const attachLatest = (frame: ParsedInvocation): ParsedInvocation => ({
      ...frame,
      messages: [
        ...frame.messages,
        ...incomingIndexes.filter((index) => !frame.messages.includes(index)),
      ],
    })

    const restoreParent = (child: ParsedInvocation) => {
      const parent =
        child.parent === null
          ? undefined
          : state.invocations[child.parent.invocation]

      if (parent === undefined) throw new Error("A called chat lost its caller")
      state = replaceFrame(state, {
        ...parent,
        status: InvocationStatusSchema.cases.Active.make({}),
      })
      state = { ...state, active: parent.id }
    }

    const cancelDescendants = (owner: number) => {
      for (const child of state.invocations) {
        if (
          child.id === owner ||
          Predicate.isTagged(child.status, "Completed") ||
          Predicate.isTagged(child.status, "Cancelled")
        )
          continue
        let parent = child.parent

        while (parent !== null && parent.invocation !== owner)
          parent = state.invocations[parent.invocation]?.parent ?? null

        if (parent?.invocation === owner)
          state = replaceFrame(state, {
            ...child,
            status: InvocationStatusSchema.cases.Cancelled.make({}),
          })
      }
    }

    let allowParentControl = true

    let executed:
      { readonly frame: ParsedInvocation; readonly turn: LeafTurn } | undefined

    for (
      let transition = 0;
      transition < input.maximumTransitionsPerTurn;
      transition += 1
    ) {
      const frame = activeFrame(state)
      const node = nodeFor(frame)

      const action = yield* scoped(
        plan(state, frame, messages, allowParentControl),
        frame,
      )

      consumeHints(frame.id)

      switch (action._tag) {
        case "Enter": {
          let depth = 1
          let parent = frame.parent

          while (parent !== null) {
            depth += 1
            parent = state.invocations[parent.invocation]?.parent ?? null
          }

          if (depth >= input.maximumDepth)
            return yield* new InvalidConversation({ reason: "depth_limit" })

          if (state.invocations.length >= 100)
            return yield* new InvalidConversation({
              reason: "invocation_limit",
            })
          const childKey = node.children.get(action.branch)

          const childNode =
            childKey === undefined ? undefined : input.nodes.get(childKey)

          if (childNode === undefined)
            return yield* new InvalidConversation({
              reason: "invalid_transition",
            })

          const bound = yield* scoped(
            readBranch(action.branch).bind(action.arguments),
            frame,
          )

          const childInput = yield* Schema.decodeUnknownEffect(
            Schema.toType(childNode.input),
          )(bound, { onExcessProperty: "error" }).pipe(
            Effect.mapError(
              () => new InvalidConversation({ reason: "invalid_input" }),
            ),
          )

          yield* encodeValue(childNode.input, childInput).pipe(
            Effect.mapError(
              () => new InvalidConversation({ reason: "invalid_input" }),
            ),
          )

          const child: ParsedInvocation = {
            id: state.invocations.length,
            definition: childNode.key,
            parent: { invocation: frame.id, branch: action.branch.name },
            input: childInput,
            // SAFETY: this initial workflow comes directly from the selected compiled child.
            workflow: Fn.cast<
              typeof childNode.leaf.initialState,
              RuntimeChatState
            >(childNode.leaf.initialState),
            messages:
              action.sourceMessage === undefined
                ? incomingIndexes
                : [action.sourceMessage, ...incomingIndexes],
            status: InvocationStatusSchema.cases.Active.make({}),
          }

          state = replaceFrame(state, {
            ...frame,
            status: InvocationStatusSchema.cases.Waiting.make({
              child: child.id,
            }),
          })
          state = {
            ...state,
            active: child.id,
            invocations: [...state.invocations, child],
          }
          allowParentControl = false
          continue
        }

        case "Resume": {
          const child = state.invocations[action.invocation]

          if (
            child?.parent?.invocation !== frame.id ||
            !Predicate.isTagged(child.status, "Suspended")
          )
            return yield* new InvalidConversation({
              reason: "invalid_transition",
            })
          state = replaceFrame(state, {
            ...frame,
            status: InvocationStatusSchema.cases.Waiting.make({
              child: child.id,
            }),
          })
          state = replaceFrame(state, {
            ...attachLatest(child),
            status: InvocationStatusSchema.cases.Active.make({}),
          })
          state = { ...state, active: child.id }
          allowParentControl = false
          continue
        }

        case "Suspend":
        case "Cancel": {
          if (frame.parent === null)
            return yield* new InvalidConversation({
              reason: "invalid_transition",
            })

          if (Predicate.isTagged(action, "Cancel")) cancelDescendants(frame.id)
          state = replaceFrame(state, {
            ...frame,
            messages: frame.messages.filter(
              (index) => !incomingIndexes.includes(index),
            ),
            status: ReplyAction.$is("Suspend")(action)
              ? InvocationStatusSchema.cases.Suspended.make({})
              : InvocationStatusSchema.cases.Cancelled.make({}),
          })
          restoreParent(frame)
          state = replaceFrame(state, attachLatest(activeFrame(state)))
          allowParentControl = true
          continue
        }

        case "Continue":
        case "Tool": {
          const result = yield* scoped(
            Predicate.isTagged(action, "Tool")
              ? executeHint(frame, messages, action, commandContext)
              : node.leaf.runScoped(
                  frame.workflow,
                  frameMessages(frame, messages),
                  commandContext,
                ),
            frame,
          )

          // SAFETY: both paths use the registered stage's tool/collection parsers and construct its existing turn shape.
          executed = { frame, turn: Fn.cast<typeof result, LeafTurn>(result) }
          break
        }
      }

      break
    }

    if (executed === undefined)
      return yield* new InvalidConversation({ reason: "transition_limit" })
    const { frame, turn } = executed
    const node = nodeFor(frame)
    let nextFrame: ParsedInvocation = { ...frame, workflow: turn.state }
    let outcome: ChatOutcome<null> | undefined

    if (Predicate.isTagged(turn, "Complete")) {
      const output = yield* Effect.try({
        try: () => node.projectOutput(turn),
        catch: () => new InvalidConversation({ reason: "invalid_output" }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.toType(node.output))),
        Effect.mapError(
          () => new InvalidConversation({ reason: "invalid_output" }),
        ),
      )

      yield* encodeValue(node.output, output).pipe(
        Effect.mapError(
          () => new InvalidConversation({ reason: "invalid_output" }),
        ),
      )
      nextFrame = {
        ...nextFrame,
        status: InvocationStatusSchema.cases.Completed.make({ output }),
      }
      cancelDescendants(frame.id)

      if (frame.parent === null) {
        state = { ...state, status: "complete", active: 0 }
        // SAFETY: the public composed definition restores the root output type.
        outcome = {
          _tag: "Completed",
          output: Fn.cast<typeof output, null>(output),
        }
      } else restoreParent(frame)
    }

    state = replaceFrame(state, nextFrame)

    const modelText = Predicate.isTagged(turn, "Question")
      ? turn.question?.text
      : Predicate.isTagged(turn, "Clarification")
        ? turn.clarification?.text
        : turn.result === undefined
          ? undefined
          : readToolExecutionModelContext(turn.result)

    if (modelText !== undefined) {
      const next = append(state, messages, frame.id, authored(modelText))
      state = next.state
      messages = next.messages
    }

    for (const entry of emitted) {
      const owner = state.invocations[entry.owner]

      if (owner === undefined) return yield* invalidState()
      // Collection may have advanced since emission; eligibility uses the committed stage.
      yield* checkMessage(owner, entry.message)
      let messageId = `message:${messages.length}`

      while (state.issued.some((issued) => issued.id === messageId))
        messageId += ":next"
      const next = issue(state, messages, entry.owner, messageId, entry.message)
      state = next.state
      messages = next.messages
    }

    const userAnswers = yield* projectUserAnswers({
      definition: node.leaf,
      state: turn.state,
    })

    yield* control.beforeCommit()

    const replacement = yield* commit(
      loaded.scope,
      loaded.snapshot.revision,
      state,
      messages,
    )

    // SAFETY: leaf results retain their established Question/ToolResult/Complete shape.
    const publicTurn = Fn.cast<
      unknown,
      ConversationReply<AnyDefinition>["turn"]
    >({
      ...turn,
      _tag:
        Predicate.isTagged(turn, "Complete") && frame.parent !== null
          ? "ToolResult"
          : turn._tag,
      state,
    })

    return AdvanceResult.Applied({
      reply: {
        sessionId: loaded.scope.sessionId,
        revision: replacement.revision,
        turn: publicTurn,
        invocation: {
          id: frame.id,
          chat: node.leaf.name,
          version: node.leaf.version,
        },
        userAnswers,
        emittedMessages: emitted.map(({ message }) => ({
          role: "assistant" as const,
          content: [Text.make(message.text)],
        })),
        outcome,
      },
    })
  })

  const reply = Effect.fn("Conversation.reply")(function* (
    request: ChatReplyInput,
  ) {
    const parsed = yield* Schema.decodeUnknownEffect(TurnInputSchema)(request, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalidSession))

    const { message, ...scope } = parsed

    const result = yield* advance(
      {
        ...scope,
        turn: ControlledTurnInputSchema.fields.turn.cases.Submitted.make({
          message,
        }),
      },
      uncontrolledTurn,
    )

    if (!Predicate.isTagged(result, "Applied"))
      return yield* Effect.die(
        new Error("Submitted turns cannot replay observations"),
      )

    return result.reply
  })

  // Explorations explicitly belong to the root definition, including while a child is active.
  const explore = Effect.fn("Conversation.explore")(function* (
    request: ChatExploreInput,
  ) {
    const parsed = yield* Schema.decodeEffect(
      Schema.Struct({ ...SessionInputSchema.fields, call: JsonValueSchema }),
    )(request, { onExcessProperty: "error" }).pipe(
      Effect.mapError(invalidSession),
    )

    const loaded = yield* load({
      sessionId: parsed.sessionId,
      namespace: parsed.namespace,
    })

    const frame = loaded.state.invocations[0]

    if (input.root.leaf.explorations.length === 0)
      return yield* invalidSession()

    // SAFETY: compiled explorations are query-only and this branch checks the non-empty tuple.
    const tuple = Fn.cast<typeof input.root.leaf.explorations, ToolTuple>(
      input.root.leaf.explorations,
    )

    return yield* defineToolSet(...tuple)
      .runCall(parsed.call)
      .pipe(
        Effect.provideService(
          ChatContext,
          invocationContext(loaded.state, frame),
        ),
        Effect.provideService(ToolContext, { stages: frame.workflow.stages }),
      )
  })

  const getInvocation = (state: ConversationState, id: number) =>
    Effect.gen(function* () {
      const envelope = yield* Schema.decodeEffect(
        Schema.toType(ConversationStateSchema),
      )(state, { onExcessProperty: "error" }).pipe(
        Effect.mapError(invalidState),
      )

      if (
        envelope.chat !== input.root.leaf.name ||
        envelope.schemaVersion !== input.root.leaf.version
      )
        return yield* invalidState()
      const frame = envelope.invocations[id]

      const node =
        frame === undefined ? undefined : input.nodes.get(frame.definition)

      if (frame === undefined || node === undefined || frame.id !== id)
        return yield* invalidState()

      const workflow = yield* Schema.decodeUnknownEffect(
        Schema.toType(node.leaf.stateSchema),
      )(frame.workflow, { onExcessProperty: "error" }).pipe(
        Effect.mapError(invalidState),
      )

      return { definition: node.leaf, state: workflow }
    })

  return { start, post, reply, advance, explore, parseState, getInvocation }
}

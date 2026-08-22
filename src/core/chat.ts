import { cast, Effect, Schema } from "effect"
import type {
  AcceptedAnswer,
  CollectAnswers,
  CollectStage,
  CollectStageDefinitionContract,
  CollectStagePrompt,
  CollectStageRuntime,
  CollectStageState,
} from "./collect-stage.js"
import { readCollectStageRuntime } from "./collect-stage.js"
import {
  countUntrustedMessageCharacters,
  UntrustedMessageSchema,
  type UntrustedMessage,
} from "./model.js"
import {
  readCommandStageRuntime,
  readToolStageRuntime,
  type CommandStage,
  type CommandStageDefinitionContract,
  type ToolStage,
  type ToolStageDefinitionContract,
} from "./stage.js"
import type {
  ToolSetError,
  ToolSetExecution,
  ToolSetRequirements,
  ToolSetRun,
  ToolTuple,
} from "./tool-set.js"
import { defineToolSet } from "./tool-set.js"
import { readToolExecutionModelContext } from "./tool.js"
import { deriveCommandId } from "./command.js"
import { defineTool, type QueryToolDefinitionContract } from "./tool.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"
import type { StandardRepair } from "./repair.js"
import {
  ChatSessionConflict,
  ChatSessionIdSchema,
  ChatSessionNamespaceSchema,
  ChatSessionNotFound,
  ChatSessionReplacementSchema,
  ChatSessionRevisionSchema,
  ChatSessionSnapshotSchema,
  ChatSessionStore,
  InvalidChatSession,
  type ChatSessionSnapshot,
  type ChatSessionStoreUnavailable,
} from "./session.js"
import {
  make as makeChatProcess,
  type RuntimeChatState,
  type RuntimeRepairCorrection,
} from "../internal/chat/process.js"

/** Stable machine-facing name for one structured chat definition. */
export const ChatNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Positive persisted-state version for one structured chat definition. */
export const ChatVersionSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
)

/** Safe reason that a server-owned chat transition was rejected. */
export const InvalidChatTransitionReasonSchema = Schema.Literals([
  "already_complete",
  "invalid_state",
])

/** A server-owned chat state cannot perform the requested transition. */
export class InvalidChatTransition extends Schema.TaggedError<InvalidChatTransition>()(
  "InvalidChatTransition",
  {
    chat: ChatNameSchema,
    reason: InvalidChatTransitionReasonSchema,
  },
) {}

/** Minimum runtime identity retained for every structured chat stage. */
export type ChatStageDefinitionContract =
  | CollectStageDefinitionContract
  | ToolStageDefinitionContract
  | CommandStageDefinitionContract

/** Non-empty sequential stage tuple accepted by one chat definition. */
export type ChatStageTuple = readonly [
  ChatStageDefinitionContract,
  ...ReadonlyArray<ChatStageDefinitionContract>,
]

/** Optional closed query-tool tuple exposed as conversation explorations. */
export type ChatExplorationTuple = readonly [] | ToolTuple

type UnionToIntersection<Union> = (
  Union extends unknown ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never

type CollectStateEntry<Stage> = Stage extends CollectStage<
  infer Name,
  infer Fields,
  infer _Guards
>
  ? { readonly [Key in Name]: CollectStageState<Fields> }
  : never

type ChatCollectStage<Stages extends ChatStageTuple> = Extract<
  Stages[number],
  CollectStageDefinitionContract
>

type CollectFields<Stage> = Stage extends CollectStage<
  infer _Name,
  infer Fields,
  infer _Guards
>
  ? Fields
  : never

/** Persisted state entries derived from every collect stage. */
export type ChatStageStates<Stages extends ChatStageTuple> = [
  CollectStateEntry<Stages[number]>,
] extends [never]
  ? Readonly<Record<never, never>>
  : UnionToIntersection<CollectStateEntry<Stages[number]>>

/** Complete server-owned state for one structured chat session. */
export interface ChatState<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> {
  readonly schemaVersion: Version
  readonly chat: Name
  readonly stage: number
  readonly status: "active" | "complete"
  readonly stages: ChatStageStates<Stages>
  readonly repair?: {
    readonly pendingStages: ReadonlyArray<number>
  }
}

type ChatQuestion<Stage> = Stage extends CollectStage<
  infer _Name,
  infer Fields,
  infer _Guards
>
  ? CollectStagePrompt<Fields>
  : never

type ChatToolExecution<Stage> = Stage extends ToolStage<
  infer _Name,
  infer Tools,
  infer _Guards
>
  ? ToolSetExecution<Tools>
  : Stage extends CommandStage<
        infer _Name,
        infer _Command,
        infer _Guards
      >
    ? Extract<Effect.Success<ReturnType<Stage["run"]>>, object>
    : never

type StageEffect<Stage> = Stage extends CollectStage<
  infer _CollectName,
  infer _Fields,
  infer _CollectGuards
>
  ? ReturnType<Stage["run"]>
  : Stage extends ToolStage<
        infer _ToolName,
        infer _Tools,
        infer _ToolGuards
      >
    ? ReturnType<Stage["run"]>
    : Stage extends CommandStage<
          infer _CommandName,
          infer _Command,
          infer _CommandGuards
        >
      ? ReturnType<Stage["run"]>
    : never

/** Failure union produced by any stage in one chat. */
export type ChatError<Stages extends ChatStageTuple> =
  | InvalidChatTransition
  | Effect.Error<StageEffect<Stages[number]>>

/** Effect service union required by any stage in one chat. */
export type ChatRequirements<Stages extends ChatStageTuple> =
  Effect.Services<StageEffect<Stages[number]>>

/** Question, ongoing tool result, or terminal result emitted by one turn. */
export type ChatTurn<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> =
  | {
      readonly _tag: "Question"
      readonly stage: string
      readonly state: ChatState<Name, Version, Stages>
      readonly question: ChatQuestion<Stages[number]>
    }
  | {
      readonly _tag: "ToolResult"
      readonly stage: string
      readonly state: ChatState<Name, Version, Stages>
      readonly result: ChatToolExecution<Stages[number]>
    }
  | {
      readonly _tag: "Complete"
      readonly stage: string
      readonly state: ChatState<Name, Version, Stages>
      readonly result: ChatToolExecution<Stages[number]>
    }

/** Input for one persisted server-owned chat reply. */
export interface ChatReplyInput {
  readonly namespace?: string | undefined
  readonly sessionId: string
  readonly expectedRevision?: string | undefined
  readonly message: string
}

/** Persisted result of one server-owned chat reply. */
export interface ChatReply<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> {
  readonly sessionId: string
  readonly revision: string
  readonly turn: ChatTurn<Name, Version, Stages>
}

/** Failure union produced while loading, running, and replacing a session. */
export type ChatReplyError<Stages extends ChatStageTuple> =
  | ChatError<Stages>
  | ChatSessionStoreUnavailable
  | ChatSessionConflict
  | InvalidChatSession

/** Input for one read-only exploration against the latest session snapshot. */
export interface ChatExploreInput {
  readonly namespace?: string | undefined
  readonly sessionId: string
  readonly call: JsonValue
}

/** Correlated exploration result derived from the configured query tools. */
export type ChatExplorationRun<
  Explorations extends ChatExplorationTuple,
> = Explorations extends ToolTuple ? ToolSetRun<Explorations> : never

/** Failure union produced while loading and running one exploration. */
export type ChatExploreError<
  Explorations extends ChatExplorationTuple,
> =
  | ChatSessionStoreUnavailable
  | ChatSessionNotFound
  | InvalidChatSession
  | (Explorations extends ToolTuple
      ? ToolSetError<Explorations>
      : never)

/** Effect services required by one configured exploration tool. */
export type ChatExploreRequirements<
  Explorations extends ChatExplorationTuple,
> = Explorations extends ToolTuple
  ? ToolSetRequirements<Explorations>
  : never

/** Definition input for one sequential structured chat. */
export interface DefineChatInput<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
  Explorations extends ChatExplorationTuple = readonly [],
> {
  readonly name: Name
  readonly version: Version
  readonly stages: Stages
  readonly explorations?: Explorations
  readonly repair?: StandardRepair
}

/** One schema-defined sequential chat runtime. */
export interface ChatDefinition<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
  Explorations extends ChatExplorationTuple = readonly [],
> {
  readonly name: Name
  readonly version: Version
  readonly stages: Stages
  readonly explorations: Explorations
  readonly repair: StandardRepair | undefined
  readonly stateSchema: Schema.Codec<ChatState<Name, Version, Stages>, unknown>
  readonly initialState: ChatState<Name, Version, Stages>

  /** Read one accepted value together with its supporting transcript data. */
  readonly getAcceptedAnswer: <
    Stage extends ChatCollectStage<Stages>,
    Field extends keyof CollectFields<Stage> & string,
  >(
    state: ChatState<Name, Version, Stages>,
    stage: Stage,
    field: Field,
  ) =>
    | AcceptedAnswer<CollectAnswers<CollectFields<Stage>>[Field]>
    | undefined

  /** Strictly parse persisted server-owned chat state. */
  readonly parseState: (
    input: Schema.Codec.Encoded<
      Schema.Codec<ChatState<Name, Version, Stages>, unknown>
    >,
  ) => Effect.Effect<
    ChatState<Name, Version, Stages>,
    Schema.SchemaError
  >

  /** Run the active stage and any immediately reachable tool stage. */
  readonly run: (input: {
    readonly state: ChatState<Name, Version, Stages>
    readonly messages: ReadonlyArray<UntrustedMessage>
  }) => Effect.Effect<
    ChatTurn<Name, Version, Stages>,
    ChatError<Stages>,
    ChatRequirements<Stages>
  >

  /** Load, run, and atomically replace one server-owned chat session. */
  readonly reply: (
    input: ChatReplyInput,
  ) => Effect.Effect<
    ChatReply<Name, Version, Stages>,
    ChatReplyError<Stages>,
    ChatSessionStore | ChatRequirements<Stages>
  >

  /** Load the latest session and run one configured read-only query tool. */
  readonly explore: (
    input: ChatExploreInput,
  ) => Effect.Effect<
    ChatExplorationRun<Explorations>,
    ChatExploreError<Explorations>,
    ChatSessionStore | ChatExploreRequirements<Explorations>
  >
}

const invalidTransition = (
  chat: string,
  reason: "already_complete" | "invalid_state",
) => new InvalidChatTransition({ chat, reason })

const invalidSession = (
  reason:
    | "invalid_input"
    | "invalid_snapshot"
    | "invalid_state"
    | "invalid_replacement"
    | "history_limit",
) => new InvalidChatSession({ reason })

const ChatReplyBoundaryInputSchema = Schema.Struct({
  namespace: Schema.optional(ChatSessionNamespaceSchema),
  sessionId: ChatSessionIdSchema,
  expectedRevision: Schema.optional(ChatSessionRevisionSchema),
  message: UntrustedMessageSchema.fields.content,
})

const ChatExploreBoundaryInputSchema = Schema.Struct({
  namespace: Schema.optional(ChatSessionNamespaceSchema),
  sessionId: ChatSessionIdSchema,
  call: JsonValueSchema,
})

const maximumPersistedMessages = 200
const maximumMessagesAddedPerTurn = 2

/**
 * Define one sequential chat with collectors and one final executable stage.
 *
 * A final query stage remains active by default so later user messages can
 * refine results. A final command stage is always terminal.
 */
export const defineChat = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple = readonly [],
>(
  definition: DefineChatInput<Name, Version, Stages, Explorations>,
): ChatDefinition<Name, Version, Stages, Explorations> => {
  Schema.decodeSync(ChatNameSchema)(definition.name)
  Schema.decodeSync(ChatVersionSchema)(definition.version)
  const names = definition.stages.map(({ name }) => name)
  if (new Set(names).size !== names.length) {
    throw new Error("Structured chat stage names must be unique")
  }
  const finalStage = definition.stages.at(-1)
  if (
    finalStage?._tag !== "ToolStage" &&
    finalStage?._tag !== "CommandStage"
  ) {
    throw new Error(
      "Structured chats require one final tool or command stage",
    )
  }
  if (
    definition.stages
      .slice(0, -1)
      .some((stage) => stage._tag !== "CollectStage")
  ) {
    throw new Error(
      "Only collect stages may precede the final executable stage",
    )
  }
  const repair = definition.repair
  const explorationDefinitions = definition.explorations ?? []
  const explorationToolSet =
    explorationDefinitions.length === 0
      ? undefined
      : defineToolSet(
          // SAFETY: a non-empty ChatExplorationTuple is exactly ToolTuple;
          // defineToolSet rechecks query-only operation and unique names.
          ...cast<typeof explorationDefinitions, ToolTuple>(
            explorationDefinitions,
          ),
        )
  if (
    repair !== undefined &&
    (finalStage?._tag !== "ToolStage" ||
      readToolStageRuntime(finalStage).afterExecution !== "stay")
  ) {
    throw new Error(
      "Conversation repair requires a repeatable final query stage",
    )
  }

  const stateFields: Record<string, Schema.Codec<unknown, unknown>> = {}
  const initialStages: Record<
    string,
    CollectStageRuntime["initialState"]
  > = {}
  const collectStages: Array<{
    readonly index: number
    readonly stage: CollectStageDefinitionContract
    readonly runtime: ReturnType<typeof readCollectStageRuntime>
  }> = []
  for (const [index, stage] of definition.stages.entries()) {
    if (stage._tag !== "CollectStage") {
      continue
    }
    const runtime = readCollectStageRuntime(stage)
    stateFields[stage.name] = runtime.stateSchema
    initialStages[stage.name] = runtime.initialState
    collectStages.push({ index, stage, runtime })
  }
  const finalStageIndex = definition.stages.length - 1
  if (repair !== undefined && collectStages.length === 0) {
    throw new Error("Conversation repair requires at least one collect stage")
  }
  const repairToolName = "apply_conversation_repairs"
  if (
    repair !== undefined &&
    finalStage?._tag === "ToolStage" &&
    readToolStageRuntime(finalStage).toolNames.includes(repairToolName)
  ) {
    throw new Error(`Tool name is reserved for repair: ${repairToolName}`)
  }
  const repairTool: QueryToolDefinitionContract | undefined = (() => {
    if (repair === undefined) {
      return undefined
    }
    const schemas = collectStages.map(({ runtime }) => runtime.repairSchema)
    const [firstSchema, ...remainingSchemas] = schemas
    if (firstSchema === undefined) {
      throw new Error("Conversation repair requires correction schemas")
    }
    const correctionSchema =
      remainingSchemas.length === 0
        ? firstSchema
        : Schema.Union([firstSchema, ...remainingSchemas])
    const input = Schema.Struct({
      corrections: Schema.NonEmptyArray(correctionSchema).check(
        Schema.isMaxLength(repair.maximumCorrections),
      ),
    })
    return defineTool({
      name: repairToolName,
      description:
        "Use only when the latest user message explicitly corrects previously accepted facts. Quote evidence from that latest user message. Replace semantic or explicit answers; request reconfirmation for confirmed answers.",
      input,
      execute: (proposal) => Effect.succeed(proposal),
    })
  })()
  const isValidRuntimeState = (state: RuntimeChatState): boolean => {
    const pendingStages = state.repair?.pendingStages ?? []
    if (
      (repair === undefined && state.repair !== undefined) ||
      (repair !== undefined && state.repair === undefined)
    ) {
      return false
    }
    if (
      pendingStages.some(
        (index, position) =>
          definition.stages[index]?._tag !== "CollectStage" ||
          (position > 0 && index <= (pendingStages[position - 1] ?? -1)),
      )
    ) {
      return false
    }
    if (pendingStages.length > 0) {
      if (
        state.status !== "active" ||
        state.stage !== pendingStages[0]
      ) {
        return false
      }
      for (const { index, stage, runtime } of collectStages) {
        const stageState = state.stages[stage.name]
        if (stageState === undefined || !runtime.isValid(stageState)) {
          return false
        }
        const pending = pendingStages.includes(index)
        if (pending === runtime.isComplete(stageState)) {
          return false
        }
      }
      return true
    }
    if (state.status === "complete") {
      if (state.stage !== finalStageIndex || finalStage === undefined) {
        return false
      }
      if (
        (finalStage._tag === "ToolStage" &&
          readToolStageRuntime(finalStage).afterExecution !== "complete")
      ) {
        return false
      }
    }

    for (
      let index = 0;
      index < definition.stages.length;
      index += 1
    ) {
      const stage = definition.stages[index]
      if (stage?._tag !== "CollectStage") {
        continue
      }
      const runtime = readCollectStageRuntime(stage)
      const stageState = state.stages[stage.name]
      if (stageState === undefined || !runtime.isValid(stageState)) {
        return false
      }
      if (index < state.stage && !runtime.isComplete(stageState)) {
        return false
      }
      if (
        state.status === "active" &&
        index === state.stage &&
        runtime.isComplete(stageState)
      ) {
        return false
      }
      if (index > state.stage && !runtime.isInitial(stageState)) {
        return false
      }
    }

    return true
  }
  const baseStateFields = {
    schemaVersion: Schema.Literal(definition.version),
    chat: Schema.Literal(definition.name),
    stage: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({
        minimum: 0,
        maximum: definition.stages.length - 1,
      }),
    ),
    status: Schema.Literals(["active", "complete"]),
    stages: Schema.Struct(stateFields),
  }
  const rawStateSchema =
    repair === undefined
      ? Schema.Struct(baseStateFields)
      : Schema.Struct({
          ...baseStateFields,
          repair: Schema.Struct({
            pendingStages: Schema.Array(
              Schema.Number.check(
                Schema.isInt(),
                Schema.isBetween({
                  minimum: 0,
                  maximum: finalStageIndex - 1,
                }),
              ),
            ).check(Schema.isMaxLength(20)),
          }),
        })
  // SAFETY: the conditional repair field is erased only for applying the
  // shared semantic predicate; stateSchema below restores the public type.
  const runtimeStateSchema = cast<
    typeof rawStateSchema,
    Schema.Codec<unknown, unknown>
  >(rawStateSchema)
  const refinedStateSchema = runtimeStateSchema.check(
    Schema.makeFilter<unknown>(
      (state) =>
        isValidRuntimeState(
          cast<typeof state, RuntimeChatState>(state),
        ),
      {
        description: "semantically valid structured-chat state",
      },
    ),
  )
  // SAFETY: stage state fields are taken directly from the concrete collect
  // stages, and the remaining envelope fields are exact literals or bounds.
  const stateSchema = cast<
    typeof refinedStateSchema,
    Schema.Codec<ChatState<Name, Version, Stages>, unknown>
  >(refinedStateSchema)
  const baseInitialState = {
    schemaVersion: definition.version,
    chat: definition.name,
    stage: 0,
    status: "active",
    stages: initialStages,
  } as const
  const initialStateInput =
    repair === undefined
      ? baseInitialState
      : { ...baseInitialState, repair: { pendingStages: [] } }
  const initialState = Schema.decodeUnknownSync(Schema.toType(stateSchema))(
    initialStateInput,
  )

  const isGroundedInMessages = (
    state: RuntimeChatState,
    messages: ReadonlyArray<UntrustedMessage>,
  ): boolean =>
    definition.stages.every((stage) => {
      if (stage._tag !== "CollectStage") {
        return true
      }
      const stageState = state.stages[stage.name]
      return (
        stageState !== undefined &&
        readCollectStageRuntime(stage).isGroundedInMessages(
          stageState,
          messages,
        )
      )
    })

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this owned persistence boundary strictly parses the adapter's intentionally raw load result
  const parseSessionSnapshot = (loaded: unknown) =>
    Schema.decodeUnknownEffect(ChatSessionSnapshotSchema)(loaded, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => invalidSession("invalid_snapshot")),
    )

  const parseStoredSession = (snapshot: ChatSessionSnapshot) =>
    Effect.gen(function* () {
      const state = yield* Schema.decodeUnknownEffect(stateSchema)(
        snapshot.state,
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(() => invalidSession("invalid_state")),
      )
      // SAFETY: stateSchema decoded this definition's exact state envelope.
      const runtimeState = cast<typeof state, RuntimeChatState>(state)
      if (!isGroundedInMessages(runtimeState, snapshot.messages)) {
        return yield* Effect.fail(invalidSession("invalid_state"))
      }

      return {
        snapshot,
        state,
        runtimeState,
        messages: snapshot.messages,
      }
    })

  const applyConversationRepairs = (
    state: RuntimeChatState,
    messages: ReadonlyArray<UntrustedMessage>,
    corrections: ReadonlyArray<RuntimeRepairCorrection>,
  ): Effect.Effect<RuntimeChatState, unknown, unknown> =>
    Effect.gen(function* () {
      const grouped = new Map<string, Array<RuntimeRepairCorrection>>()
      for (const correction of corrections) {
        const current = grouped.get(correction.stage) ?? []
        current.push(correction)
        grouped.set(correction.stage, current)
      }

      let stages = { ...state.stages }
      const pendingStages: Array<number> = []
      for (const { index, stage, runtime } of collectStages) {
        const stageRepairs = grouped.get(stage.name)
        if (stageRepairs === undefined) {
          continue
        }
        grouped.delete(stage.name)
        const stageState = stages[stage.name]
        if (stageState === undefined) {
          return yield* Effect.fail(
            invalidTransition(definition.name, "invalid_state"),
          )
        }
        const result = yield* runtime.applyRepairs(
          stageState,
          messages,
          stageRepairs,
        )
        stages = { ...stages, [stage.name]: result.state }
        if (result.requiresConfirmation) {
          pendingStages.push(index)
        }
      }
      if (grouped.size > 0) {
        return yield* Effect.fail(
          invalidTransition(definition.name, "invalid_state"),
        )
      }

      return {
        ...state,
        stage: pendingStages[0] ?? finalStageIndex,
        stages,
        repair: { pendingStages },
      }
    })

  const process = makeChatProcess({
    chat: definition.name,
    stages: definition.stages,
    finalStageIndex,
    repairTool,
    repairToolName,
    invalidTransition: (reason) =>
      invalidTransition(definition.name, reason),
    isValidState: isValidRuntimeState,
    isGroundedInMessages,
    applyRepairs: applyConversationRepairs,
  })

  const run: ChatDefinition<
    Name,
    Version,
    Stages,
    Explorations
  >["run"] = (input) => {
    // SAFETY: ChatState is generated from the same stage tuple as the sealed
    // runtime state contract; only generic correlations are erased here.
    const runtimeState = cast<
      typeof input.state,
      RuntimeChatState
    >(input.state)
    const runtime = process.runChecked(
      runtimeState,
      input.messages,
    )

    // SAFETY: runtime dispatch follows the exact Stages tuple and each stage
    // retains its own parsing, errors, dependencies, and output constructor.
    return cast<
      typeof runtime,
      Effect.Effect<
        ChatTurn<Name, Version, Stages>,
        ChatError<Stages>,
        ChatRequirements<Stages>
      >
    >(runtime)
  }

  const reply: ChatDefinition<
    Name,
    Version,
    Stages,
    Explorations
  >["reply"] = (input) =>
    Effect.gen(function* () {
      const parsedInput = yield* Schema.decodeUnknownEffect(
        ChatReplyBoundaryInputSchema,
      )(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => invalidSession("invalid_input")),
      )
      const store = yield* ChatSessionStore
      const scope = {
        namespace: parsedInput.namespace ?? "",
        sessionId: parsedInput.sessionId,
        chat: definition.name,
        version: definition.version,
      }
      const loaded = yield* store.load(scope).pipe(
        Effect.withSpan(
          "popcomputer.structured_chat.session.load",
          {
            attributes: {
              chat: definition.name,
              version: definition.version,
            },
          },
        ),
      )
      const snapshot =
        loaded === null
          ? null
          : yield* parseSessionSnapshot(loaded)

      if (
        (snapshot === null &&
          parsedInput.expectedRevision !== undefined) ||
        (snapshot !== null &&
          parsedInput.expectedRevision !== snapshot.revision)
      ) {
        return yield* Effect.fail(
          new ChatSessionConflict({ reason: "concurrent_update" }),
        )
      }

      const storedSession =
        snapshot === null
          ? null
          : yield* parseStoredSession(snapshot)
      const state =
        storedSession?.state ?? initialState
      const previousMessages = storedSession?.messages ?? []
      const runtimeState =
        storedSession?.runtimeState ??
        // SAFETY: initialState was decoded by this definition's stateSchema.
        cast<typeof initialState, RuntimeChatState>(initialState)
      if (
        previousMessages.length + maximumMessagesAddedPerTurn >
        maximumPersistedMessages
      ) {
        return yield* Effect.fail(invalidSession("history_limit"))
      }
      const userMessage = yield* Schema.decodeUnknownEffect(
        UntrustedMessageSchema,
      )(
        { role: "user", content: parsedInput.message },
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(() => invalidSession("invalid_input")),
      )
      const messages = [...previousMessages, userMessage]
      const commandContext =
        finalStage?._tag === "CommandStage"
          ? {
              commandId: yield* deriveCommandId({
                namespace: scope.namespace,
                chat: definition.name,
                version: definition.version,
                sessionId: scope.sessionId,
                expectedRevision: snapshot?.revision ?? null,
                command: readCommandStageRuntime(finalStage).commandName,
              }),
            }
          : undefined
      // SAFETY: stateSchema has parsed the definition-owned state and the
      // explicit check above grounded it against these exact messages.
      // Reply supplies command identity only to the active terminal command.
      const trustedTurn = process.runTrusted(
        runtimeState,
        messages,
        commandContext,
        repair !== undefined &&
          snapshot !== null &&
          state.status === "active" &&
          state.stage === finalStageIndex,
      )
      const turn = yield* cast<
        typeof trustedTurn,
        Effect.Effect<
          ChatTurn<Name, Version, Stages>,
          ChatError<Stages>,
          ChatRequirements<Stages>
        >
      >(trustedTurn)
      const toolModelContext =
        turn._tag === "Question"
          ? undefined
          : readToolExecutionModelContext(turn.result)
      const persistedMessages: ReadonlyArray<UntrustedMessage> =
        turn._tag === "Question"
          ? [
              ...messages,
              {
                role: "assistant",
                content: turn.question.text,
              },
            ]
          : toolModelContext === undefined
            ? messages
            : [
                ...messages,
                {
                  role: "assistant",
                  content: toolModelContext,
                },
              ]
      if (persistedMessages.length > maximumPersistedMessages) {
        return yield* Effect.fail(invalidSession("history_limit"))
      }
      const encodedState = yield* Schema.encodeUnknownEffect(stateSchema)(
        turn.state,
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(() => invalidSession("invalid_state")),
      )
      const replaced = yield* store
        .replace({
          ...scope,
          expectedRevision: snapshot?.revision ?? null,
          state: encodedState,
          messages: persistedMessages,
        })
        .pipe(
          Effect.withSpan(
            "popcomputer.structured_chat.session.replace",
            {
              attributes: {
                chat: definition.name,
                version: definition.version,
                messageCount: persistedMessages.length,
                messageCharacterCount:
                  countUntrustedMessageCharacters(
                    persistedMessages,
                  ),
                stage: turn.state.stage,
                status: turn.state.status,
              },
            },
          ),
        )
      const replacement = yield* Schema.decodeUnknownEffect(
        ChatSessionReplacementSchema,
      )(replaced, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => invalidSession("invalid_replacement")),
      )

      return {
        sessionId: scope.sessionId,
        revision: replacement.revision,
        turn,
      }
    }).pipe(
      Effect.withSpan("popcomputer.structured_chat.session.reply", {
        attributes: { chat: definition.name },
      }),
    )

  const exploreRuntime = (input: ChatExploreInput) =>
    Effect.gen(function* () {
      const parsedInput = yield* Schema.decodeUnknownEffect(
        ChatExploreBoundaryInputSchema,
      )(input, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => invalidSession("invalid_input")),
      )
      if (explorationToolSet === undefined) {
        return yield* Effect.fail(invalidSession("invalid_input"))
      }

      const store = yield* ChatSessionStore
      const loaded = yield* store.load({
        namespace: parsedInput.namespace ?? "",
        sessionId: parsedInput.sessionId,
        chat: definition.name,
        version: definition.version,
      }).pipe(
        Effect.withSpan(
          "popcomputer.structured_chat.exploration.session.load",
          {
            attributes: {
              chat: definition.name,
              version: definition.version,
            },
          },
        ),
      )
      if (loaded === null) {
        return yield* Effect.fail(
          new ChatSessionNotFound({ reason: "not_found" }),
        )
      }
      const snapshot = yield* parseSessionSnapshot(loaded)
      yield* parseStoredSession(snapshot)
      const executed = yield* explorationToolSet.runCall(parsedInput.call)

      // SAFETY: explorationToolSet was compiled from Explorations after the
      // non-empty branch, and runCall preserves each member's correlation.
      return cast<
        typeof executed,
        ChatExplorationRun<Explorations>
      >(executed)
    }).pipe(
      Effect.withSpan("popcomputer.structured_chat.exploration.run", {
        attributes: { chat: definition.name },
      }),
    )
  // SAFETY: explorationToolSet is compiled from definition.explorations;
  // its erased runtime unions are restored by the same concrete tuple here.
  const explore = cast<
    typeof exploreRuntime,
    ChatDefinition<
      Name,
      Version,
      Stages,
      Explorations
    >["explore"]
  >(exploreRuntime)

  return {
    name: definition.name,
    version: definition.version,
    stages: definition.stages,
    // SAFETY: omitted explorations correspond to the default empty tuple;
    // supplied definitions retain their exact inferred tuple.
    explorations: cast<
      typeof explorationDefinitions,
      Explorations
    >(explorationDefinitions),
    repair,
    stateSchema,
    initialState,
    getAcceptedAnswer: (state, stage, field) => {
      if (!definition.stages.includes(stage)) {
        return undefined
      }
      // SAFETY: Stage is restricted to this chat's concrete collect stages,
      // Field is restricted to its field keys, and state uses the same tuple.
      const runtimeState = cast<typeof state, RuntimeChatState>(state)
      const accepted = runtimeState.stages[stage.name]?.accepted[field]
      return cast<
        typeof accepted,
        | AcceptedAnswer<
            CollectAnswers<CollectFields<typeof stage>>[typeof field]
          >
        | undefined
      >(accepted)
    },
    parseState: (input) =>
      Schema.decodeUnknownEffect(stateSchema)(input, {
        onExcessProperty: "error",
      }),
    run,
    reply,
    explore,
  }
}

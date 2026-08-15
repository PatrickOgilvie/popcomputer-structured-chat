import { Effect, Schema, unsafeCoerce } from "effect"
import type * as ParseResult from "effect/ParseResult"
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
  ToolSetExecution,
} from "./tool-set.js"
import { readToolExecutionModelContext } from "./tool.js"
import type { CommandExecutionContext } from "./tool.js"
import { deriveCommandId } from "./command.js"
import { defineTool, type QueryToolDefinitionContract } from "./tool.js"
import type { StandardRepair } from "./repair.js"
import {
  ChatSessionConflict,
  ChatSessionIdSchema,
  ChatSessionNamespaceSchema,
  ChatSessionReplacementSchema,
  ChatSessionRevisionSchema,
  ChatSessionSnapshotSchema,
  ChatSessionStore,
  InvalidChatSession,
  type ChatSessionStoreUnavailable,
} from "./session.js"

/** Stable machine-facing name for one structured chat definition. */
export const ChatNameSchema = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(100),
  Schema.pattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Positive persisted-state version for one structured chat definition. */
export const ChatVersionSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 2_147_483_647),
)

/** Safe reason that a server-owned chat transition was rejected. */
export const InvalidChatTransitionReasonSchema = Schema.Literal(
  "already_complete",
  "invalid_state",
)

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
    ? Extract<Effect.Effect.Success<ReturnType<Stage["run"]>>, object>
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
  | Effect.Effect.Error<StageEffect<Stages[number]>>

/** Effect service union required by any stage in one chat. */
export type ChatRequirements<Stages extends ChatStageTuple> =
  Effect.Effect.Context<StageEffect<Stages[number]>>

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
  readonly revision: string
  readonly turn: ChatTurn<Name, Version, Stages>
}

/** Failure union produced while loading, running, and replacing a session. */
export type ChatReplyError<Stages extends ChatStageTuple> =
  | ChatError<Stages>
  | ChatSessionStoreUnavailable
  | ChatSessionConflict
  | InvalidChatSession

/** Definition input for one sequential structured chat. */
export interface DefineChatInput<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> {
  readonly name: Name
  readonly version: Version
  readonly stages: Stages
  readonly repair?: StandardRepair
}

/** One schema-defined sequential chat runtime. */
export interface ChatDefinition<
  Name extends string,
  Version extends number,
  Stages extends ChatStageTuple,
> {
  readonly name: Name
  readonly version: Version
  readonly stages: Stages
  readonly repair: StandardRepair | undefined
  readonly stateSchema: Schema.Schema<
    ChatState<Name, Version, Stages>,
    unknown,
    never
  >
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
    input: Schema.Schema.Encoded<
      Schema.Schema<ChatState<Name, Version, Stages>, unknown, never>
    >,
  ) => Effect.Effect<
    ChatState<Name, Version, Stages>,
    ParseResult.ParseError
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
}

interface RuntimeChatState {
  readonly schemaVersion: number
  readonly chat: string
  readonly stage: number
  readonly status: "active" | "complete"
  readonly stages: Readonly<
    Partial<
      Record<string, CollectStageRuntime["initialState"]>
    >
  >
  readonly repair?: {
    readonly pendingStages: ReadonlyArray<number>
  }
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
>(
  definition: DefineChatInput<Name, Version, Stages>,
): ChatDefinition<Name, Version, Stages> => {
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
  if (
    repair !== undefined &&
    (finalStage?._tag !== "ToolStage" ||
      readToolStageRuntime(finalStage).afterExecution !== "stay")
  ) {
    throw new Error(
      "Conversation repair requires a repeatable final query stage",
    )
  }

  const stateFields: Record<string, Schema.Schema.AnyNoContext> = {}
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
        : Schema.Union(firstSchema, ...remainingSchemas)
    const input = Schema.Struct({
      corrections: Schema.NonEmptyArray(correctionSchema).pipe(
        Schema.maxItems(repair.maximumCorrections),
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
    stage: Schema.Number.pipe(
      Schema.int(),
      Schema.between(0, definition.stages.length - 1),
    ),
    status: Schema.Literal("active", "complete"),
    stages: Schema.Struct(stateFields),
  }
  const rawStateSchema =
    repair === undefined
      ? Schema.Struct(baseStateFields)
      : Schema.Struct({
          ...baseStateFields,
          repair: Schema.Struct({
            pendingStages: Schema.Array(
              Schema.Number.pipe(
                Schema.int(),
                Schema.between(0, finalStageIndex - 1),
              ),
            ).pipe(Schema.maxItems(20)),
          }),
        })
  // SAFETY: the conditional repair field is erased only for applying the
  // shared semantic predicate; stateSchema below restores the public type.
  const runtimeStateSchema = unsafeCoerce<
    typeof rawStateSchema,
    Schema.Schema.AnyNoContext
  >(rawStateSchema)
  const refinedStateSchema = runtimeStateSchema.pipe(
    Schema.filter(
      (state) =>
        isValidRuntimeState(
          unsafeCoerce<typeof state, RuntimeChatState>(state),
        ),
      {
        description: "semantically valid structured-chat state",
      },
    ),
  )
  // SAFETY: stage state fields are taken directly from the concrete collect
  // stages, and the remaining envelope fields are exact literals or bounds.
  const stateSchema = unsafeCoerce<
    typeof refinedStateSchema,
    Schema.Schema<ChatState<Name, Version, Stages>, unknown, never>
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
  const initialState = Schema.validateSync(stateSchema)(initialStateInput)

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

  interface RuntimeRepairCorrection {
    readonly _tag: "ReplaceAcceptedAnswer" | "ReconfirmAnswer"
    readonly stage: string
    readonly field: string
    readonly value?: unknown
    readonly evidence: {
      readonly quote: string
    }
  }

  interface RuntimeRepairProposal {
    readonly corrections: ReadonlyArray<RuntimeRepairCorrection>
  }

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

  /** Dispatch only values already checked against this exact transcript. */
  const runTrustedRuntime = (
    state: RuntimeChatState,
    messages: ReadonlyArray<UntrustedMessage>,
    commandContext?: CommandExecutionContext,
    allowRepair = false,
  ): Effect.Effect<unknown, unknown, unknown> => {
    if (state.status === "complete") {
      return Effect.fail(
        invalidTransition(definition.name, "already_complete"),
      )
    }
    const stage = definition.stages[state.stage]
    if (stage === undefined) {
      return Effect.fail(
        invalidTransition(definition.name, "invalid_state"),
      )
    }

    if (stage._tag === "CommandStage") {
      if (commandContext === undefined) {
        return Effect.fail(
          invalidTransition(definition.name, "invalid_state"),
        )
      }
      return readCommandStageRuntime(stage)
        .run(messages, commandContext)
        .pipe(
          Effect.map((result) => ({
            _tag: "Complete" as const,
            stage: stage.name,
            state: {
              ...state,
              status: "complete" as const,
            },
            result,
          })),
        )
    }

    if (stage._tag === "ToolStage") {
      const runtime = readToolStageRuntime(stage)
      if (allowRepair && repairTool !== undefined) {
        return runtime.planWith(messages, repairTool).pipe(
          Effect.flatMap((planned) => {
            const call = planned
            if (call.name !== repairToolName) {
              return runtime.execute(call).pipe(
                Effect.map((result) => ({
                  _tag: "ToolResult" as const,
                  stage: stage.name,
                  state,
                  result,
                })),
              )
            }
            // SAFETY: planWith used the generated repair tool schema, and this
            // branch is selected by that tool's unique literal name.
            const proposal = unsafeCoerce<
              typeof call.arguments,
              RuntimeRepairProposal
            >(call.arguments)
            return applyConversationRepairs(
              state,
              messages,
              proposal.corrections,
            ).pipe(
              Effect.flatMap((repairedState) =>
                Effect.suspend(() =>
                  runTrustedRuntime(
                    repairedState,
                    messages,
                    commandContext,
                    false,
                  ),
                ),
              ),
            )
          }),
        )
      }
      return runtime.run(messages).pipe(
        Effect.map((result) =>
          runtime.afterExecution === "complete"
            ? {
                _tag: "Complete" as const,
                stage: stage.name,
                state: {
                  ...state,
                  status: "complete" as const,
                },
                result,
              }
            : {
                _tag: "ToolResult" as const,
                stage: stage.name,
                state,
                result,
              },
        ),
      )
    }

    const runtime = readCollectStageRuntime(stage)
    const collectState = state.stages[stage.name]
    if (collectState === undefined) {
      return Effect.fail(
        invalidTransition(definition.name, "invalid_state"),
      )
    }
    return runtime
      .run({ state: collectState, messages })
      .pipe(
        Effect.flatMap((turn) => {
          const nextState: RuntimeChatState = {
            ...state,
            stages: {
              ...state.stages,
              [stage.name]: turn.state,
            },
          }
          if (turn.complete) {
            const pendingStages = state.repair?.pendingStages ?? []
            const remainingPending =
              pendingStages[0] === state.stage
                ? pendingStages.slice(1)
                : pendingStages
            const nextStage =
              pendingStages.length > 0
                ? (remainingPending[0] ?? finalStageIndex)
                : state.stage + 1
            const advancedState =
              state.repair === undefined
                ? { ...nextState, stage: nextStage }
                : {
                    ...nextState,
                    stage: nextStage,
                    repair: { pendingStages: remainingPending },
                  }
            return Effect.suspend(() =>
              runTrustedRuntime(
                advancedState,
                messages,
                commandContext,
                false,
              ),
            )
          }

          return Effect.succeed({
            _tag: "Question" as const,
            stage: stage.name,
            state: nextState,
            question: turn.question,
          })
        }),
      )
  }

  /** Validate a public runtime entry before entering trusted transitions. */
  const runCheckedRuntime = (
    state: RuntimeChatState,
    messages: ReadonlyArray<UntrustedMessage>,
    commandContext?: CommandExecutionContext,
    allowRepair = false,
  ): Effect.Effect<unknown, unknown, unknown> =>
    !isValidRuntimeState(state) ||
    !isGroundedInMessages(state, messages)
      ? Effect.fail(
          invalidTransition(definition.name, "invalid_state"),
        )
      : runTrustedRuntime(
          state,
          messages,
          commandContext,
          allowRepair,
        )

  const run: ChatDefinition<Name, Version, Stages>["run"] = (input) => {
    // SAFETY: ChatState is generated from the same stage tuple as the sealed
    // runtime state contract; only generic correlations are erased here.
    const runtimeState = unsafeCoerce<
      typeof input.state,
      RuntimeChatState
    >(input.state)
    const runtime = runCheckedRuntime(
      runtimeState,
      input.messages,
    )

    // SAFETY: runtime dispatch follows the exact Stages tuple and each stage
    // retains its own parsing, errors, dependencies, and output constructor.
    return unsafeCoerce<
      typeof runtime,
      Effect.Effect<
        ChatTurn<Name, Version, Stages>,
        ChatError<Stages>,
        ChatRequirements<Stages>
      >
    >(runtime)
  }

  const reply: ChatDefinition<Name, Version, Stages>["reply"] = (input) =>
    Effect.gen(function* () {
      const parsedInput = yield* Schema.decodeUnknown(
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
          : yield* Schema.decodeUnknown(ChatSessionSnapshotSchema)(
              loaded,
              { onExcessProperty: "error" },
            ).pipe(
              Effect.mapError(() =>
                invalidSession("invalid_snapshot"),
              ),
            )

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

      const state =
        snapshot === null
          ? initialState
          : yield* Schema.decodeUnknown(stateSchema)(snapshot.state, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(() =>
                invalidSession("invalid_state"),
              ),
            )
      const previousMessages = snapshot?.messages ?? []
      // SAFETY: stateSchema decoded this definition's exact state envelope.
      const runtimeState = unsafeCoerce<typeof state, RuntimeChatState>(state)
      if (
        !isGroundedInMessages(
          runtimeState,
          previousMessages,
        )
      ) {
        return yield* Effect.fail(invalidSession("invalid_state"))
      }
      if (
        previousMessages.length + maximumMessagesAddedPerTurn >
        maximumPersistedMessages
      ) {
        return yield* Effect.fail(invalidSession("history_limit"))
      }
      const userMessage = yield* Schema.decodeUnknown(
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
      const trustedTurn = runTrustedRuntime(
        runtimeState,
        messages,
        commandContext,
        repair !== undefined &&
          snapshot !== null &&
          state.status === "active" &&
          state.stage === finalStageIndex,
      )
      const turn = yield* unsafeCoerce<
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
      const encodedState = yield* Schema.encodeUnknown(stateSchema)(
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
      const replacement = yield* Schema.decodeUnknown(
        ChatSessionReplacementSchema,
      )(replaced, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => invalidSession("invalid_replacement")),
      )

      return {
        revision: replacement.revision,
        turn,
      }
    }).pipe(
      Effect.withSpan("popcomputer.structured_chat.session.reply", {
        attributes: { chat: definition.name },
      }),
    )

  return {
    name: definition.name,
    version: definition.version,
    stages: definition.stages,
    repair,
    stateSchema,
    initialState,
    getAcceptedAnswer: (state, stage, field) => {
      if (!definition.stages.includes(stage)) {
        return undefined
      }
      // SAFETY: Stage is restricted to this chat's concrete collect stages,
      // Field is restricted to its field keys, and state uses the same tuple.
      const runtimeState = unsafeCoerce<typeof state, RuntimeChatState>(state)
      const accepted = runtimeState.stages[stage.name]?.accepted[field]
      return unsafeCoerce<
        typeof accepted,
        | AcceptedAnswer<
            CollectAnswers<CollectFields<typeof stage>>[typeof field]
          >
        | undefined
      >(accepted)
    },
    parseState: (input) =>
      Schema.decodeUnknown(stateSchema)(input, {
        onExcessProperty: "error",
      }),
    run,
    reply,
  }
}

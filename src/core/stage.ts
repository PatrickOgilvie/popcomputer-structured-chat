import { Effect, Schema, unsafeCoerce } from "effect"
import {
  Instruction,
  planToolCall,
  StructuredChatModel,
  type ChatModelUnavailable,
  type UnsupportedModelToolSchema,
  type UntrustedMessage,
} from "./model.js"
import type {
  ModelGuardError,
  ModelGuardRequirements,
  ModelGuardTuple,
} from "./model-guard.js"
import {
  defineToolSet,
  type ToolSet,
  type ToolSetCall,
  type ToolSetError,
  type ToolSetExecution,
  type ToolSetRequirements,
  type ToolCallPlanner,
  type ToolTuple,
} from "./tool-set.js"
import type {
  CommandDefinitionContract,
  CommandExecutionContext,
  InvalidToolCall,
  InvalidToolProjection,
  StructuredCommand,
  ToolCall,
  ToolExecution,
  QueryToolDefinitionContract,
} from "./tool.js"
import { defineCollectStage } from "./collect-stage.js"
import { StageNameSchema } from "./stage-name.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"

export { StageNameSchema } from "./stage-name.js"

/** State transition applied after one tool-stage execution. */
export const ToolStageAfterExecutionSchema = Schema.Literal(
  "stay",
  "complete",
)

/** State transition applied after one tool-stage execution. */
export type ToolStageAfterExecution = Schema.Schema.Type<
  typeof ToolStageAfterExecutionSchema
>

/** Definition input for one stage-scoped, repeatable tool step. */
export interface DefineToolStageInput<
  Name extends string,
  Tools extends ToolTuple,
  Guards extends ModelGuardTuple,
> {
  readonly name: Name
  readonly instructions: readonly [string, ...ReadonlyArray<string>]
  readonly tools: Tools
  readonly guards?: Guards
  readonly afterExecution?: ToolStageAfterExecution
}

/** @internal Erased tool-stage behavior consumed by the chat runtime. */
export interface ToolStageRuntime {
  readonly afterExecution: ToolStageAfterExecution
  readonly toolNames: ReadonlyArray<string>
  readonly planWith: (
    messages: ReadonlyArray<UntrustedMessage>,
    additionalTool: QueryToolDefinitionContract,
  ) => Effect.Effect<
    ToolCall<string, Schema.Schema.AnyNoContext>,
    unknown,
    unknown
  >
  readonly execute: (
    call: ToolCall<string, Schema.Schema.AnyNoContext>,
  ) => Effect.Effect<unknown, unknown, unknown>
  readonly run: (
    messages: ReadonlyArray<UntrustedMessage>,
  ) => Effect.Effect<unknown, unknown, unknown>
}

const toolStageRuntime = Symbol(
  "@popcomputer/structured-chat/ToolStageRuntime",
)

/** Minimum sealed tool-stage shape accepted by a chat definition. */
export interface ToolStageDefinitionContract
  extends StructuredDefinition<"tool_stage"> {
  readonly _tag: "ToolStage"
  readonly name: string
  readonly [toolStageRuntime]: ToolStageRuntime
}

/** @internal Read the erased runtime from an authentic tool stage. */
export const readToolStageRuntime = (
  stage: ToolStageDefinitionContract,
): ToolStageRuntime => stage[toolStageRuntime]

/** @internal Erased command-stage behavior consumed by the chat runtime. */
export interface CommandStageRuntime {
  readonly commandName: string
  readonly run: (
    messages: ReadonlyArray<UntrustedMessage>,
    context: CommandExecutionContext,
  ) => Effect.Effect<unknown, unknown, unknown>
}

const commandStageRuntime = Symbol(
  "@popcomputer/structured-chat/CommandStageRuntime",
)

/** Minimum sealed terminal command-stage shape accepted by a chat. */
export interface CommandStageDefinitionContract
  extends StructuredDefinition<"command_stage"> {
  readonly _tag: "CommandStage"
  readonly name: string
  readonly command: CommandDefinitionContract
  readonly [commandStageRuntime]: CommandStageRuntime
}

/** @internal Read the erased runtime from an authentic command stage. */
export const readCommandStageRuntime = (
  stage: CommandStageDefinitionContract,
): CommandStageRuntime => stage[commandStageRuntime]

/** One stage exposing a closed set of structured tools for each user turn. */
export interface ToolStage<
  Name extends string,
  Tools extends ToolTuple,
  Guards extends ModelGuardTuple,
> extends ToolStageDefinitionContract {
  readonly _tag: "ToolStage"
  readonly name: Name
  readonly toolSet: ToolSet<Tools>
  readonly guards: Guards
  readonly afterExecution: ToolStageAfterExecution

  /** Ask for and parse one stage-scoped call without executing it. */
  readonly plan: (
    messages: ReadonlyArray<UntrustedMessage>,
  ) => Effect.Effect<
    ToolSetCall<Tools>,
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | InvalidToolCall
    | ModelGuardError<Guards>,
    | StructuredChatModel
    | ModelGuardRequirements<Guards>
  >

  /** Run one required tool call against this stage's capabilities. */
  readonly run: (
    messages: ReadonlyArray<UntrustedMessage>,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | ToolSetError<Tools>
    | ModelGuardError<Guards>,
    | StructuredChatModel
    | ToolSetRequirements<Tools>
    | ModelGuardRequirements<Guards>
  >
}

type CommandCall<Command> = Command extends StructuredCommand<
  infer Name,
  infer InputSchema,
  infer _ServerResult,
  infer _Error,
  infer _Requirements,
  infer _ModelSchema,
  infer _Presenters
>
  ? ToolCall<Name, InputSchema>
  : never

type CommandResult<Command> = Command extends StructuredCommand<
  infer _Name,
  infer _InputSchema,
  infer ServerResult,
  infer _Error,
  infer _Requirements,
  infer ModelSchema,
  infer Presenters
>
  ? ToolExecution<ServerResult, ModelSchema, Presenters>
  : never

type CommandError<Command> = Command extends StructuredCommand<
  infer _Name,
  infer _InputSchema,
  infer _ServerResult,
  infer Error,
  infer _Requirements,
  infer _ModelSchema,
  infer _Presenters
>
  ? Error
  : never

type CommandRequirements<Command> = Command extends StructuredCommand<
  infer _Name,
  infer _InputSchema,
  infer _ServerResult,
  infer _Error,
  infer Requirements,
  infer _ModelSchema,
  infer _Presenters
>
  ? Requirements
  : never

/** Definition input for one exactly-once-intent terminal command stage. */
export interface DefineCommandStageInput<
  Name extends string,
  Command extends CommandDefinitionContract,
  Guards extends ModelGuardTuple,
> {
  readonly name: Name
  readonly instructions: readonly [string, ...ReadonlyArray<string>]
  readonly command: Command
  readonly guards?: Guards
}

/** One terminal stage exposing exactly one side-effecting command. */
export interface CommandStage<
  Name extends string,
  Command extends CommandDefinitionContract,
  Guards extends ModelGuardTuple,
> extends CommandStageDefinitionContract {
  readonly name: Name
  readonly command: Command
  readonly guards: Guards

  readonly plan: (
    messages: ReadonlyArray<UntrustedMessage>,
  ) => Effect.Effect<
    CommandCall<Command>,
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | InvalidToolCall
    | ModelGuardError<Guards>,
    | StructuredChatModel
    | ModelGuardRequirements<Guards>
  >

  readonly run: (
    messages: ReadonlyArray<UntrustedMessage>,
    context: CommandExecutionContext,
  ) => Effect.Effect<
    CommandResult<Command>,
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | InvalidToolCall
    | InvalidToolProjection
    | CommandError<Command>
    | ModelGuardError<Guards>,
    | StructuredChatModel
    | CommandRequirements<Command>
    | ModelGuardRequirements<Guards>
  >
}

const defineToolStage = <
  const Name extends string,
  const Tools extends ToolTuple,
  const Guards extends ModelGuardTuple = readonly [],
>(
  definition: DefineToolStageInput<Name, Tools, Guards>,
): ToolStage<Name, Tools, Guards> => {
  Schema.decodeSync(StageNameSchema)(definition.name)
  const instructions = definition.instructions.map(Instruction.make)
  const toolSet = defineToolSet(...definition.tools)
  // SAFETY: when guards are omitted, Guards uses its readonly [] default; an
  // explicitly supplied tuple is returned unchanged.
  const guards =
    definition.guards ?? unsafeCoerce<readonly [], Guards>([])
  const afterExecution = Schema.decodeSync(
    ToolStageAfterExecutionSchema,
  )(definition.afterExecution ?? "stay")

  const plan = (messages: ReadonlyArray<UntrustedMessage>) =>
    planToolCall({
      instructions,
      messages,
      tools: toolSet,
      guards,
    }).pipe(
      Effect.withSpan("popcomputer.structured_chat.stage.plan", {
        attributes: { stage: definition.name },
      }),
    )

  const run: ToolStage<Name, Tools, Guards>["run"] = (messages) =>
    plan(messages).pipe(Effect.flatMap(toolSet.execute))
  // SAFETY: chat repair supplies only a call parsed by a combined set that
  // contains this exact query tuple; non-repair names therefore belong here.
  const executeRuntime = toolSet.execute as (
    call: ToolCall<string, Schema.Schema.AnyNoContext>,
  ) => Effect.Effect<unknown, unknown, unknown>

  const planWith = (
    messages: ReadonlyArray<UntrustedMessage>,
    additionalTool: QueryToolDefinitionContract,
  ) => {
    // SAFETY: the additional package-owned query and this non-empty exact
    // query tuple form another valid closed tool set for planning only.
    const combined = defineToolSet(
      additionalTool,
      ...definition.tools,
    )
    return planToolCall({
      instructions,
      messages,
      tools: combined,
      guards,
    })
  }

  return structuredDefinition("tool_stage")({
    _tag: "ToolStage",
    name: definition.name,
    toolSet,
    guards,
    afterExecution,
    plan,
    run,
    [toolStageRuntime]: {
      afterExecution,
      toolNames: definition.tools.map(({ name }) => name),
      planWith,
      execute: executeRuntime,
      run,
    },
  })
}

const defineCommandStage = <
  const Name extends string,
  const Command extends CommandDefinitionContract,
  const Guards extends ModelGuardTuple = readonly [],
>(
  definition: DefineCommandStageInput<Name, Command, Guards>,
): CommandStage<Name, Command, Guards> => {
  Schema.decodeSync(StageNameSchema)(definition.name)
  const instructions = definition.instructions.map(Instruction.make)
  // SAFETY: when omitted, Guards is its readonly [] default.
  const guards =
    definition.guards ?? unsafeCoerce<readonly [], Guards>([])
  const planner: ToolCallPlanner<readonly [Command]> = {
    models: [definition.command.model],
    // SAFETY: this command parses its literal name and exact input schema.
    parseCall: definition.command.parseCall as ToolCallPlanner<
      readonly [Command]
    >["parseCall"],
  }
  const plan = (messages: ReadonlyArray<UntrustedMessage>) =>
    planToolCall({ instructions, messages, tools: planner, guards }).pipe(
      Effect.withSpan("popcomputer.structured_chat.command_stage.plan", {
        attributes: { stage: definition.name },
      }),
    )
  interface RuntimeCommand {
    readonly execute: (
      input: Schema.Schema.Type<Schema.Schema.AnyNoContext>,
      context: CommandExecutionContext,
    ) => Effect.Effect<unknown, unknown, unknown>
  }
  // SAFETY: Command has the package-owned identity and command operation;
  // its parsed call and runtime execute input originate from one definition.
  const runtimeCommand = unsafeCoerce<Command, RuntimeCommand>(
    definition.command,
  )
  const runRuntime = (
    messages: ReadonlyArray<UntrustedMessage>,
    context: CommandExecutionContext,
  ) =>
    plan(messages).pipe(
      Effect.flatMap((call) =>
        runtimeCommand.execute(call.arguments, context),
      ),
      Effect.withSpan("popcomputer.structured_chat.command_stage.run", {
        attributes: { stage: definition.name },
      }),
    )
  // SAFETY: failures and requirements are not recovered; the command's
  // projections and result are preserved by its own execute operation.
  const run = runRuntime as CommandStage<Name, Command, Guards>["run"]

  return structuredDefinition("command_stage")({
    _tag: "CommandStage",
    name: definition.name,
    command: definition.command,
    guards,
    plan,
    run,
    [commandStageRuntime]: {
      commandName: definition.command.name,
      run: runRuntime,
    },
  })
}

/** Constructors for sequential structured chat stages. */
export const Stage = {
  collect: defineCollectStage,
  tools: defineToolStage,
  command: defineCommandStage,
} as const

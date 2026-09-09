import { Effect, Function as Fn, Schema } from "effect"
import {
  Instruction,
  planToolCall,
  type AnyModelProfile,
  type ChatModelUnavailable,
  type ModelProfileInput,
  type ModelRequirement,
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
} from "./tool.js"
import { compileToolRegistry, compileRepairToolRegistry, type RepairDecision } from "./tool-registry.js"
import type { RepairTool } from "./repair.js"
import { defineInteractionStage } from "./interaction-stage.js"
import { defineCollectStage } from "./collect-stage.js"
import { StageNameSchema } from "./stage-name.js"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"

export { StageNameSchema } from "./stage-name.js"

/** State transition applied after one tool-stage execution. */
export const ToolStageAfterExecutionSchema = Schema.Literals([
  "stay",
  "complete",
])

/** State transition applied after one tool-stage execution. */
export type ToolStageAfterExecution = Schema.Schema.Type<
  typeof ToolStageAfterExecutionSchema
>

/** Definition input for one stage-scoped, repeatable tool step. */
export type DefineToolStageInput<
  Name extends string,
  Tools extends ToolTuple,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined = undefined,
> = {
  readonly name: Name
  readonly instructions: readonly [string, ...ReadonlyArray<string>]
  readonly tools: Tools
  readonly guards?: Guards
  readonly afterExecution?: ToolStageAfterExecution
} & ModelProfileInput<Profile>

/** @internal Erased tool-stage behavior consumed by the chat runtime. */
export interface ToolStageRuntime {
  readonly afterExecution: ToolStageAfterExecution
  readonly toolNames: ReadonlyArray<string>
  readonly withRepair: (repair: RepairTool) => (
    messages: ReadonlyArray<UntrustedMessage>,
  ) => Effect.Effect<RepairDecision, unknown, unknown>
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
  readonly guards: ModelGuardTuple
  readonly toolSet: { readonly tools: ToolTuple }
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
  readonly guards: ModelGuardTuple
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
  Profile extends AnyModelProfile | undefined = undefined,
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
    | ModelRequirement<Profile>
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
    | ModelRequirement<Profile>
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
export type DefineCommandStageInput<
  Name extends string,
  Command extends CommandDefinitionContract,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined = undefined,
> = {
  readonly name: Name
  readonly instructions: readonly [string, ...ReadonlyArray<string>]
  readonly command: Command
  readonly guards?: Guards
} & ModelProfileInput<Profile>

/** One terminal stage exposing exactly one side-effecting command. */
export interface CommandStage<
  Name extends string,
  Command extends CommandDefinitionContract,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined = undefined,
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
    | ModelRequirement<Profile>
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
    | ModelRequirement<Profile>
    | CommandRequirements<Command>
    | ModelGuardRequirements<Guards>
  >
}

const defineToolStage = <
  const Name extends string,
  const Tools extends ToolTuple,
  const Guards extends ModelGuardTuple = readonly [],
  const Profile extends AnyModelProfile | undefined = undefined,
>(
  definition: DefineToolStageInput<
    Name,
    Tools,
    Guards,
    Profile
  >,
): ToolStage<Name, Tools, Guards, Profile> => {
  Schema.decodeSync(StageNameSchema)(definition.name)
  const instructions = definition.instructions.map(Instruction.make)
  const toolSet = defineToolSet(...definition.tools)
  // SAFETY: when guards are omitted, Guards uses its readonly [] default; an
  // explicitly supplied tuple is returned unchanged.
  const guards =
    definition.guards ?? Fn.cast<readonly [], Guards>([])
  // SAFETY: ModelProfileInput requires a concrete model whenever Profile is
  // defined; when Profile is undefined, undefined is the only legal value.
  const model = Fn.cast<typeof definition.model, Profile>(
    definition.model,
  )
  // SAFETY: the selected value above preserves the conditional input proof;
  // this projection only restores that relationship for object construction.
  const modelInput = Fn.cast<
    { readonly model: Profile },
    ModelProfileInput<Profile>
  >({ model })
  const afterExecution = Schema.decodeSync(
    ToolStageAfterExecutionSchema,
  )(definition.afterExecution ?? "stay")

  const plan = (messages: ReadonlyArray<UntrustedMessage>) =>
    planToolCall<Tools, Guards, Profile>({
      instructions,
      messages,
      tools: toolSet,
      guards,
      ...modelInput,
    }).pipe(
      Effect.withSpan("popcomputer.structured_chat.stage.plan", {
        attributes: { stage: definition.name },
      }),
    )

  const run: ToolStage<Name, Tools, Guards, Profile>["run"] = (messages) =>
    plan(messages).pipe(Effect.flatMap(toolSet.execute))
  const withRepair = (repair: RepairTool) => {
    const combined = compileRepairToolRegistry(definition.tools, repair)
    return (messages: ReadonlyArray<UntrustedMessage>) =>
      planToolCall<readonly [RepairTool, ...Tools], Guards, Profile>({
        instructions,
        messages,
        tools: combined.planner,
        guards,
        ...modelInput,
      }).pipe(Effect.map(combined.decide))
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
      withRepair,
      run,
    },
  })
}

const defineCommandStage = <
  const Name extends string,
  const Command extends CommandDefinitionContract,
  const Guards extends ModelGuardTuple = readonly [],
  const Profile extends AnyModelProfile | undefined = undefined,
>(
  definition: DefineCommandStageInput<
    Name,
    Command,
    Guards,
    Profile
  >,
): CommandStage<Name, Command, Guards, Profile> => {
  Schema.decodeSync(StageNameSchema)(definition.name)
  const instructions = definition.instructions.map(Instruction.make)
  // SAFETY: when omitted, Guards is its readonly [] default.
  const guards =
    definition.guards ?? Fn.cast<readonly [], Guards>([])
  // SAFETY: ModelProfileInput requires a concrete model whenever Profile is
  // defined; when Profile is undefined, undefined is the only legal value.
  const model = Fn.cast<typeof definition.model, Profile>(
    definition.model,
  )
  // SAFETY: the selected value above preserves the conditional input proof;
  // this projection only restores that relationship for object construction.
  const modelInput = Fn.cast<
    { readonly model: Profile },
    ModelProfileInput<Profile>
  >({ model })
  const registry = compileToolRegistry([definition.command] as const)
  const plan = (messages: ReadonlyArray<UntrustedMessage>) =>
    planToolCall<readonly [Command], Guards, Profile>({
      instructions,
      messages,
      tools: registry,
      guards,
      ...modelInput,
    }).pipe(
      Effect.withSpan("popcomputer.structured_chat.command_stage.plan", {
        attributes: { stage: definition.name },
      }),
    )
  const runRuntime = (
    messages: ReadonlyArray<UntrustedMessage>,
    context: CommandExecutionContext,
  ) =>
    plan(messages).pipe(
      Effect.flatMap((call) =>
        registry.execute(call, () => Effect.succeed(context)),
      ),
      Effect.withSpan("popcomputer.structured_chat.command_stage.run", {
        attributes: { stage: definition.name },
      }),
    )
  // SAFETY: failures and requirements are not recovered; the command's
  // projections and result are preserved by its own execute operation.
  const run = Fn.cast<
    typeof runRuntime,
    CommandStage<Name, Command, Guards, Profile>["run"]
  >(runRuntime)

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
  interact: defineInteractionStage,
} as const

import { Effect, Function as Fn, Schema } from "effect"
import {
  structuredDefinition,
  type StructuredDefinition,
} from "./definition.js"
import {
  Instruction,
  planToolCall,
  type AnyModelProfile,
  type ModelProfileInput,
  type ModelRequirement,
  type UntrustedMessage,
  type ChatModelUnavailable,
  type UnsupportedModelToolSchema,
} from "./model.js"
import type {
  ModelGuardTuple,
  ModelGuardError,
  ModelGuardRequirements,
} from "./model-guard.js"
import { StageNameSchema } from "./stage-name.js"
import {
  InvalidToolCall,
} from "./tool.js"
import type {
  ModelToolTuple,
  ToolSetCall,
  ToolSetExecution,
  ToolSetError,
  ToolSetRequirements,
} from "./tool-set.js"
import { compileToolRegistry, type CommandContextSource } from "./tool-registry.js"

/** Resolves the shared turn identity after planning selects a command. */
export type InteractionCommandContext = CommandContextSource

/** Input for a repeatable stage with a closed set of queries and commands. */
export type DefineInteractionStageInput<
  Name extends string,
  Tools extends ModelToolTuple,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined = undefined,
> = {
  readonly name: Name
  readonly instructions: readonly [string, ...ReadonlyArray<string>]
  readonly tools: Tools
  readonly guards?: Guards
  readonly completeOn?: ReadonlyArray<Tools[number]["name"]>
} & ModelProfileInput<Profile>

interface InteractionStageRuntime {
  readonly toolNames: ReadonlyArray<string>
  readonly commandNames: ReadonlyArray<string>
  readonly completeOn: ReadonlyArray<string>
  readonly run: (
    messages: ReadonlyArray<UntrustedMessage>,
    context: InteractionCommandContext,
  ) => Effect.Effect<
    {
      readonly name: string
      readonly complete: boolean
      readonly execution: unknown
    },
    unknown,
    unknown
  >
}
const interactionStageRuntime = Symbol(
  "@popcomputer/structured-chat/InteractionStageRuntime",
)

/** Minimum sealed interaction-stage shape accepted by a chat. */
export interface InteractionStageDefinitionContract
  extends StructuredDefinition<"interaction_stage"> {
  readonly _tag: "InteractionStage"
  readonly name: string
  readonly guards: ModelGuardTuple
  readonly tools: ModelToolTuple
  readonly [interactionStageRuntime]: InteractionStageRuntime
}

/** @internal Read the runtime from an authentic interaction stage. */
export const readInteractionStageRuntime = (
  stage: InteractionStageDefinitionContract,
): InteractionStageRuntime => stage[interactionStageRuntime]

/** Repeatable command/query interaction with explicitly named completion tools. */
export interface InteractionStage<
  Name extends string,
  Tools extends ModelToolTuple,
  Guards extends ModelGuardTuple,
  Profile extends AnyModelProfile | undefined = undefined,
> extends InteractionStageDefinitionContract {
  readonly name: Name
  readonly tools: Tools
  readonly plan: (
    messages: ReadonlyArray<UntrustedMessage>,
  ) => Effect.Effect<
    ToolSetCall<Tools>,
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | InvalidToolCall
    | ModelGuardError<Guards>,
    ModelRequirement<Profile> | ModelGuardRequirements<Guards>
  >
  readonly run: (
    messages: ReadonlyArray<UntrustedMessage>,
    context: InteractionCommandContext,
  ) => Effect.Effect<
    {
      readonly name: Tools[number]["name"]
      readonly complete: boolean
      readonly execution: ToolSetExecution<Tools>
    },
    | ChatModelUnavailable
    | UnsupportedModelToolSchema
    | ToolSetError<Tools>
    | ModelGuardError<Guards>,
    | ModelRequirement<Profile>
    | ToolSetRequirements<Tools>
    | ModelGuardRequirements<Guards>
  >
}

/** Build a closed interaction stage; only declared completion tools can finish it. */
export const defineInteractionStage = <
  const Name extends string,
  const Tools extends ModelToolTuple,
  const Guards extends ModelGuardTuple = readonly [],
  const Profile extends AnyModelProfile | undefined = undefined,
>(
  definition: DefineInteractionStageInput<Name, Tools, Guards, Profile>,
): InteractionStage<Name, Tools, Guards, Profile> => {
  Schema.decodeSync(StageNameSchema)(definition.name)
  const registry = compileToolRegistry(definition.tools)
  const toolNames = registry.models.map(({ name }) => name)
  const completeOn = [...(definition.completeOn ?? [])]
  if (completeOn.some((name) => !toolNames.includes(name))) {
    throw new Error("Interaction completion tools must belong to the stage")
  }
  // SAFETY: omitted guards use the readonly [] generic default.
  const guards = definition.guards ?? Fn.cast<readonly [], Guards>([])
  // SAFETY: ModelProfileInput requires a concrete model whenever Profile is defined.
  const modelInput = Fn.cast<
    { readonly model: typeof definition.model },
    ModelProfileInput<Profile>
  >({ model: definition.model })
  const plan = (messages: ReadonlyArray<UntrustedMessage>) =>
    planToolCall<Tools, Guards, Profile>({
      instructions: definition.instructions.map(Instruction.make),
      messages,
      tools: registry,
      guards,
      ...modelInput,
    })
  const runRuntime = (
    messages: ReadonlyArray<UntrustedMessage>,
    context: InteractionCommandContext,
  ) =>
    plan(messages).pipe(
      Effect.flatMap((call) =>
        registry.run(call, context).pipe(
          Effect.map(({ name, execution }) => ({
            name,
            complete: completeOn.includes(name),
            execution,
          })),
        ),
      ),
      Effect.withSpan("popcomputer.structured_chat.interaction.run", {
        attributes: { stage: definition.name },
      }),
    )
  // SAFETY: dispatch preserves each registered tool's result, failures and requirements.
  const run = Fn.cast<
    typeof runRuntime,
    InteractionStage<Name, Tools, Guards, Profile>["run"]
  >(runRuntime)
  return structuredDefinition("interaction_stage")({
    _tag: "InteractionStage",
    name: definition.name,
    guards,
    tools: definition.tools,
    plan,
    run,
    [interactionStageRuntime]: {
      toolNames,
      commandNames: definition.tools
        .filter((tool) => tool.operation === "command")
        .map((tool) => tool.name),
      completeOn,
      run: runRuntime,
    },
  })
}

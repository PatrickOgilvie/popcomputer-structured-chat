import { Data, Effect, Function as Fn, Schema } from "effect"
import {
  InvalidToolCall,
  ToolNameSchema,
  type CommandExecutionContext,
  type ToolCall,
  type ToolDefinitionContract,
  type ToolSchema,
} from "./tool.js"
import { JsonValueSchema, type JsonValue } from "./json-value.js"
import type {
  ModelToolTuple,
  ToolCallPlanner,
  ToolSetCall,
  ToolSetError,
  ToolSetExecution,
  ToolSetRequirements,
  ToolSetRun,
  ToolTuple,
} from "./tool-set.js"
import type { RepairProposal, RepairTool } from "./repair.js"

/** @internal Resolve the persisted turn identity only for command execution. */
export type CommandContextSource<E = never> = () => Effect.Effect<
  CommandExecutionContext,
  E
>

/** @internal Closed dispatch for a tuple that may contain commands. */
export interface CompiledToolRegistry<
  Tools extends ModelToolTuple,
> extends ToolCallPlanner<Tools> {
  readonly execute: <E>(
    call: ToolSetCall<Tools>,
    commandContext: CommandContextSource<E>,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    ToolSetError<Tools> | E,
    ToolSetRequirements<Tools>
  >
  readonly run: <E>(
    call: ToolSetCall<Tools>,
    commandContext: CommandContextSource<E>,
  ) => Effect.Effect<
    ToolSetRun<Tools>,
    ToolSetError<Tools> | E,
    ToolSetRequirements<Tools>
  >
}

/** @internal Query-only dispatch needs no command identity capability. */
export interface CompiledQueryToolRegistry<
  Tools extends ToolTuple,
> extends ToolCallPlanner<Tools> {
  readonly execute: (
    call: ToolSetCall<Tools>,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >
  readonly run: (
    call: ToolSetCall<Tools>,
  ) => Effect.Effect<
    ToolSetRun<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >
}

interface RuntimeParser {
  readonly parseCall: (
    input: JsonValue,
  ) => Effect.Effect<ToolCall<string, ToolSchema>, InvalidToolCall>
}

type RuntimeCapability = RuntimeParser &
  (
    | {
        readonly operation: "query"
        readonly execute: (
          input: Schema.Schema.Type<ToolSchema>,
        ) => Effect.Effect<unknown, unknown, unknown>
      }
    | {
        readonly operation: "command"
        readonly execute: (
          input: Schema.Schema.Type<ToolSchema>,
          context: CommandExecutionContext,
        ) => Effect.Effect<unknown, unknown, unknown>
      }
  )

const CallEnvelopeSchema = Schema.Struct({
  name: ToolNameSchema,
  arguments: JsonValueSchema,
})

/** @internal Compile a query-only registry without requiring command context. */
export function compileToolRegistry<const Tools extends ToolTuple>(
  tools: Tools,
): CompiledQueryToolRegistry<Tools>
/** @internal Compile closed query/command dispatch with required command context. */
export function compileToolRegistry<const Tools extends ModelToolTuple>(
  tools: Tools,
): CompiledToolRegistry<Tools>
/** @internal Keep name membership and parser/executor correlation in one owner. */
export function compileToolRegistry<const Tools extends ModelToolTuple>(
  tools: Tools,
) {
  const registered = new Map<string, RuntimeCapability>()

  const models = tools.map((tool) => {
    if (registered.has(tool.name)) {
      throw new Error(`Duplicate structured chat tool name: ${tool.name}`)
    }

    // SAFETY: sealed definitions keep their operation, parser and executor
    // correlated. Public tuple projections restore only those same members.
    registered.set(
      tool.name,
      Fn.cast<ToolDefinitionContract, RuntimeCapability>(tool),
    )

    return tool.model
  })

  const select = (
    name: string,
  ): Effect.Effect<RuntimeCapability, InvalidToolCall> => {
    const tool = registered.get(name)

    return tool === undefined
      ? Effect.fail(
          new InvalidToolCall({
            tool: name,
            reason: "unknown_tool",
            path: null,
          }),
        )
      : Effect.succeed(tool)
  }

  const parseRuntime = (input: JsonValue) =>
    Schema.decodeUnknownEffect(CallEnvelopeSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        () =>
          new InvalidToolCall({
            tool: null,
            reason: "invalid_envelope",
            path: null,
          }),
      ),
      Effect.flatMap((call) =>
        select(call.name).pipe(Effect.flatMap((tool) => tool.parseCall(call))),
      ),
    )

  // SAFETY: registered membership selects the definition that parses its own
  // literal name and exact argument schema; arguments are decoded only here.
  const parseCall = Fn.cast<
    typeof parseRuntime,
    ToolCallPlanner<Tools>["parseCall"]
  >(parseRuntime)

  const runRuntime = <E = never>(
    call: ToolSetCall<Tools>,
    commandContext?: CommandContextSource<E>,
  ) =>
    select(call.name).pipe(
      Effect.flatMap((tool) =>
        Effect.suspend(() => {
          if (tool.operation === "query") {
            return tool.execute(call.arguments)
          }

          if (commandContext === undefined) {
            return Effect.die(
              new Error("Command execution requires turn context"),
            )
          }

          return Effect.suspend(commandContext).pipe(
            Effect.flatMap((context) => tool.execute(call.arguments, context)),
          )
        }),
      ),
      Effect.map((execution) => ({
        name: call.name,
        input: call.arguments,
        execution,
      })),
    )

  // SAFETY: dispatch keeps each parsed member's name, input and execution
  // together and preserves its failures/services. Overloads require context
  // whenever a caller's tuple may contain commands; query tuples omit it.
  const run = Fn.cast<
    typeof runRuntime,
    <E = never>(
      call: ToolSetCall<Tools>,
      commandContext?: CommandContextSource<E>,
    ) => Effect.Effect<
      ToolSetRun<Tools>,
      ToolSetError<Tools> | E,
      ToolSetRequirements<Tools>
    >
  >(runRuntime)

  const executeRuntime = <E = never>(
    call: ToolSetCall<Tools>,
    commandContext?: CommandContextSource<E>,
  ) =>
    runRuntime(call, commandContext).pipe(
      Effect.map(({ execution }) => execution),
    )

  // SAFETY: removing name/input from the correlated run preserves exactly
  // the execution union and its unchanged error and service requirements.
  const execute = Fn.cast<
    typeof executeRuntime,
    <E = never>(
      call: ToolSetCall<Tools>,
      commandContext?: CommandContextSource<E>,
    ) => Effect.Effect<
      ToolSetExecution<Tools>,
      ToolSetError<Tools> | E,
      ToolSetRequirements<Tools>
    >
  >(executeRuntime)

  return { models, parseCall, execute, run }
}

/** @internal A parsed repair or deferred application query, with membership retained. */
export type RepairDecision<
  Execution = unknown,
  Error = unknown,
  Requirements = unknown,
> = Data.TaggedEnum<{
  Repair: { readonly proposal: RepairProposal }
  Query: {
    readonly execute: Effect.Effect<Execution, Error, Requirements>
  }
}>

/** @internal Compile the final query tuple together with its generated repair tool. */
export const compileRepairToolRegistry = <const Tools extends ToolTuple>(
  tools: Tools,
  repair: RepairTool,
) => {
  const combined = compileToolRegistry([repair, ...tools] as const)
  const queries = compileToolRegistry(tools)

  type Decision = RepairDecision<
    ToolSetExecution<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >

  const Decision = Data.taggedEnum<Decision>()

  const decide = (
    call: ToolSetCall<readonly [RepairTool, ...Tools]>,
  ): Decision => {
    if (call.name === repair.name) {
      // SAFETY: compilation rejects duplicate names. This literal name can
      // only originate from the generated parser's decoded RepairProposal.
      return Decision.Repair({
        proposal: Fn.cast<typeof call.arguments, RepairProposal>(
          call.arguments,
        ),
      })
    }

    // SAFETY: removing the unique repair member leaves this exact query tuple.
    const query = Fn.cast<typeof call, ToolSetCall<Tools>>(call)

    return Decision.Query({ execute: queries.execute(query) })
  }

  return { planner: combined, decide }
}

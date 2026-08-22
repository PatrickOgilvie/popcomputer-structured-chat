import { Function as Fn } from "effect"
import type {
  ChatDefinition as RuntimeDefinition,
  ChatExplorationTuple,
  ChatStageTuple,
  DefineChatInput,
} from "../../core/chat.js"
import { defineChat } from "../../core/chat.js"
import { structuredDefinition } from "../../core/definition.js"
import type { Definition } from "../../Chat.js"

type AnyRuntimeDefinition = RuntimeDefinition<
  string,
  number,
  ChatStageTuple,
  ChatExplorationTuple
>

const compiledDefinitions = new WeakMap<object, AnyRuntimeDefinition>()

/** Compile and privately retain one structured chat runtime. */
export const compile = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple = readonly [],
>(
  input: DefineChatInput<Name, Version, Stages, Explorations>,
): Definition<Name, Version, Stages, Explorations> => {
  const runtime = defineChat(input)
  const definition = structuredDefinition("chat")<
    Definition<Name, Version, Stages, Explorations>
  >({
    name: runtime.name,
    version: runtime.version,
    stages: runtime.stages,
    explorations: runtime.explorations,
    repair: runtime.repair,
  })

  // SAFETY: the WeakMap erases only correlations retained by Definition's
  // exact name, version, and stage tuple. read recovers those same generics.
  compiledDefinitions.set(
    definition,
    Fn.cast<typeof runtime, AnyRuntimeDefinition>(runtime),
  )
  return definition
}

/** Read the package-owned runtime behind an opaque chat definition. */
export const read = <
  const Name extends string,
  const Version extends number,
  const Stages extends ChatStageTuple,
  const Explorations extends ChatExplorationTuple,
>(
  definition: Definition<Name, Version, Stages, Explorations>,
): RuntimeDefinition<Name, Version, Stages, Explorations> => {
  const runtime = compiledDefinitions.get(definition)
  if (runtime === undefined) {
    throw new Error(
      "Structured chat definitions must be created with Chat.define",
    )
  }

  // SAFETY: compile stored the runtime under this exact opaque definition.
  return Fn.cast<
    typeof runtime,
    RuntimeDefinition<Name, Version, Stages, Explorations>
  >(runtime)
}

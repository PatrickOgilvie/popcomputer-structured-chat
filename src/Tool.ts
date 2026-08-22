import { Tool } from "./core/tool.js"

/** Define one read-only structured tool. */
export { defineTool as define } from "./core/tool.js"

/** Define one idempotency-aware command. */
export { defineCommand as command } from "./core/tool.js"

/** Define one closed query-tool set. */
export { defineToolSet as set } from "./core/tool-set.js"

/** Add a model-visible projection to a tool result. */
export const modelResult = Tool.modelResult

/** Add one validated browser-view projection to a tool result. */
export const present = Tool.present

export {
  InvalidToolCall as InvalidCall,
  InvalidToolCallReasonSchema as InvalidCallReasonSchema,
  InvalidToolProjection as InvalidProjection,
  InvalidToolProjectionReasonSchema as InvalidProjectionReasonSchema,
  ToolDescriptionSchema as DescriptionSchema,
  ToolNameSchema as NameSchema,
} from "./core/tool.js"

export {
  CommandIdSchema,
  deriveCommandId,
} from "./core/command.js"

export type {
  CommandId,
  CommandIdentityInput,
} from "./core/command.js"

export type {
  CommandDefinitionContract,
  CommandExecutionContext,
  DefineCommandInput,
  DefineToolInput as DefineInput,
  ModelToolDefinition as ModelDefinition,
  StructuredCommand as Command,
  StructuredTool as Definition,
  ToolBoundaryParseError as BoundaryParseError,
  ToolCall as Call,
  ToolExecution as Execution,
  ToolPresenter as Presenter,
  ToolViewPart as ViewPart,
} from "./core/tool.js"

export type {
  ToolSet as Set,
  ToolSetCall as SetCall,
  ToolSetError as SetError,
  ToolSetExecution as SetExecution,
  ToolSetRequirements as SetRequirements,
  ToolTuple as Tuple,
} from "./core/tool-set.js"

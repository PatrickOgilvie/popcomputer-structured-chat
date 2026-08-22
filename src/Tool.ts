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

/** Encode one typed tool input into a transport-safe call. */
export const makeCall = Tool.makeToolCall

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
  EncodedToolCall as EncodedCall,
  EncodedToolCallOf as EncodedCallOf,
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
  EncodedToolSetCall as EncodedSetCall,
  ToolSet as Set,
  ToolSetCall as SetCall,
  ToolSetError as SetError,
  ToolSetExecution as SetExecution,
  ToolSetRequirements as SetRequirements,
  ToolSetRun as SetRun,
  ToolTuple as Tuple,
} from "./core/tool-set.js"

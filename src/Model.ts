/** Define Effect-native policy around one model step. */
export { defineModelGuard as guard } from "./core/model-guard.js"

export {
  ChatModelUnavailable as Unavailable,
  ChatModelUnavailableReasonSchema as UnavailableReasonSchema,
  ConversationRoleSchema as RoleSchema,
  Instruction,
  Message,
  runToolStep,
  StructuredChatModel as Service,
  TrustedInstructionSchema as InstructionSchema,
  UnsupportedModelToolSchema as UnsupportedToolSchema,
  UnsupportedModelToolSchemaReasonSchema as UnsupportedToolSchemaReasonSchema,
  UntrustedMessageSchema as MessageSchema,
} from "./core/model.js"

export {
  ModelGuardNameSchema as GuardNameSchema,
} from "./core/model-guard.js"

export type {
  RunToolStepInput,
  StructuredChatModelService as ServiceContract,
  ToolModelRequest as ToolRequest,
  TrustedInstruction,
  UntrustedMessage,
} from "./core/model.js"

export type {
  DefineModelGuardInput as DefineGuardInput,
  ModelGuard as Guard,
  ModelGuardCall as GuardCall,
  ModelGuardCallContext as GuardCallContext,
  ModelGuardContext as GuardContext,
  ModelGuardError as GuardError,
  ModelGuardRequirements as GuardRequirements,
  ModelGuardTuple as GuardTuple,
} from "./core/model-guard.js"

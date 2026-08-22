export {
  makeStructuredChatModel as make,
  ModelProvider as Provider,
  structuredChatModelLayer as layer,
  StructuredChatModelIdSchema as ModelIdSchema,
  StructuredChatProviderIdSchema as ProviderIdSchema,
  StructuredChatRequestTimeoutSchema as RequestTimeoutSchema,
} from "../adapters/openai-compatible-model.js"

export type {
  CloudflareWorkersAIProviderConfig,
  GuidanceSchemaOverride,
  OpenAIProviderConfig,
  ProviderToolSchemaView as ToolSchemaView,
  StructuredChatModelConfig as Config,
  StructuredChatModelId as ModelId,
  StructuredChatModelRetryPolicy as RetryPolicy,
  StructuredChatProvider as ProviderDefinition,
  StructuredChatProviderId as ProviderId,
  StructuredChatProviderRequest as ProviderRequest,
} from "../adapters/openai-compatible-model.js"

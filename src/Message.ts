/** Define an application-authored message and its conditional reply hints. */
export {
  defineMessage as define,
  hint,
  emit,
  InvalidOutboundMessage as InvalidMessage,
} from "./core/outbound-message.js"
export type {
  OutboundMessage as Definition,
  OutboundMessageContract as DefinitionContract,
  ReplyHint,
  ReplyTarget,
  ReplyArguments,
} from "./core/outbound-message.js"

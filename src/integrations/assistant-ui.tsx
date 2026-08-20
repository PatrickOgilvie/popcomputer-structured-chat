import {
  makeAssistantDataUI,
} from "@assistant-ui/core/react"
import { Exit, Result, Schema } from "effect"
import { createElement, type ComponentType, type FC } from "react"
import type { StructuredChatDebugSnapshot } from "../core/debug.js"
import type {
  ViewData,
  ViewDefinitionContract,
} from "../core/view.js"
import {
  type StructuredChatSessionReference,
  type StructuredChatAssistantMessage,
  type StructuredChatTurnResponse,
  StructuredChatSessionReferenceSchema,
  StructuredChatTurnRequestSchema,
  StructuredChatTurnResponseSchema,
} from "../core/protocol.js"
import { JsonValueSchema } from "../core/json-value.js"

/** Runtime status supplied by assistant-ui to a data-part renderer. */
export type AssistantViewPartStatus =
  | { readonly type: "running" }
  | { readonly type: "complete" }
  | {
      readonly type: "incomplete"
      readonly reason:
        | "cancelled"
        | "length"
        | "content-filter"
        | "other"
        | "error"
      readonly error?: unknown
    }
  | { readonly type: "requires-action"; readonly reason: "interrupt" }

/** Stable data-part props consumed without exposing assistant-ui internals. */
export interface AssistantDataMessagePartProps<Data = unknown> {
  readonly type: "data"
  readonly name: string
  readonly data: Data
  readonly status: AssistantViewPartStatus
}

/** Parsed props supplied to one schema-bound assistant-ui data renderer. */
export type AssistantViewRenderProps<View extends ViewDefinitionContract> =
  Omit<AssistantDataMessagePartProps, "data"> & {
    readonly data: ViewData<View>
  }

/** Renderer and safe fallback for one schema-bound assistant-ui view. */
export interface AssistantViewConfig<View extends ViewDefinitionContract> {
  readonly render: ComponentType<AssistantViewRenderProps<View>>
  readonly fallback?: ComponentType<AssistantDataMessagePartProps>
}

/** Structural data-UI component returned by assistant-ui registration. */
export type AssistantDataUI = FC & {
  readonly unstable_data: {
    readonly name: string
    readonly render: ComponentType<AssistantDataMessagePartProps>
  }
}

/**
 * Register one defineView contract as a strictly decoded assistant-ui data UI.
 *
 * Unknown or version-mismatched browser data never reaches the application
 * renderer. It renders the configured fallback, or nothing when omitted.
 */
export const makeAssistantView = <View extends ViewDefinitionContract>(
  view: View,
  config: AssistantViewConfig<View>,
): AssistantDataUI => {
  const Renderer = (props: AssistantDataMessagePartProps) => {
    const data = Schema.decodeUnknownResult(JsonValueSchema)(props.data)
    if (Result.isFailure(data)) {
      return config.fallback === undefined
        ? null
        : createElement(config.fallback, props)
    }

    const decoded = view.decodeResult({
      type: "data",
      name: view.name,
      data: data.success,
    })
    if (Result.isFailure(decoded)) {
      return config.fallback === undefined
        ? null
        : createElement(config.fallback, props)
    }

    return createElement(config.render, {
      ...props,
      data: decoded.success.data,
    })
  }

  return makeAssistantDataUI<unknown>({
    name: view.name,
    render: Renderer,
  })
}

/** assistant-ui metadata key carrying the latest opaque session reference. */
export const assistantChatSessionMetadataKey =
  "popcomputerStructuredChatSession" as const

/** Small fetch capability required by the assistant-ui chat adapter. */
export type AssistantChatFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>

/** Browser dependencies for one structured assistant-ui endpoint. */
export interface AssistantChatModelAdapterOptions {
  readonly endpoint: string
  readonly fetch?: AssistantChatFetch
  /**
   * Select the explicit debug response contract and receive its safe state
   * projection after every successful turn. Observer failures are ignored so
   * they cannot change the outcome of an already-persisted chat turn.
   */
  readonly onDebugSnapshot?: (
    snapshot: StructuredChatDebugSnapshot,
  ) => void | Promise<void>
}

const notifyDebugSnapshot = (
  callback: NonNullable<
    AssistantChatModelAdapterOptions["onDebugSnapshot"]
  >,
  snapshot: StructuredChatDebugSnapshot,
): void => {
  try {
    const notified = callback(snapshot)
    void Promise.resolve(notified).catch(() => undefined)
  } catch {
    // Debug observers are deliberately isolated from the persisted turn.
  }
}

/** Minimum assistant message shape consumed by the browser adapter. */
export interface AssistantChatThreadMessage {
  readonly role: string
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: string }
  >
  readonly attachments?: ReadonlyArray<unknown>
  readonly metadata: {
    readonly custom: {
      readonly [assistantChatSessionMetadataKey]?: unknown
    }
  }
}

/** Assistant runtime input consumed without importing its nominal types. */
export interface AssistantChatModelRunInput {
  readonly messages: ReadonlyArray<AssistantChatThreadMessage>
  readonly abortSignal: AbortSignal
}

/** Structural chat adapter that remains compatible across peer installations. */
export interface AssistantChatModelAdapter {
  readonly run: (input: AssistantChatModelRunInput) => Promise<{
    readonly content: StructuredChatAssistantMessage["content"]
    readonly metadata: {
      readonly custom:
        | Readonly<Record<never, never>>
        | {
            readonly [assistantChatSessionMetadataKey]:
              StructuredChatSessionReference
          }
    }
  }>
}

const readMessageText = (message: AssistantChatThreadMessage): string =>
  message.content
    .flatMap((part) =>
      part.type === "text" && "text" in part ? [part.text] : [],
    )
    .join("\n")
    .trim()

const readLatestSession = (
  messages: ReadonlyArray<AssistantChatThreadMessage>,
): Schema.Schema.Type<
  typeof StructuredChatTurnRequestSchema
>["session"] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant") {
      continue
    }
    const session = Schema.decodeUnknownExit(
      StructuredChatSessionReferenceSchema,
    )(message.metadata.custom[assistantChatSessionMetadataKey])
    if (Exit.isSuccess(session)) {
      return session.value
    }
  }

  return undefined
}

const readTurnRequest = (
  messages: ReadonlyArray<AssistantChatThreadMessage>,
) => {
  const message = messages.at(-1)
  if (message?.role !== "user") {
    throw new Error("A user message is required")
  }
  if ((message.attachments?.length ?? 0) > 0) {
    throw new Error("Attachments are not supported")
  }

  return Schema.decodeSync(StructuredChatTurnRequestSchema)({
    session: readLatestSession(messages),
    message: readMessageText(message),
  })
}

/**
 * Adapt assistant-ui to one server-owned structured chat endpoint.
 *
 * By default, only the latest text and opaque prior revision cross the browser
 * boundary. Supplying `onDebugSnapshot` explicitly selects the separate debug
 * response contract and receives its safe answer-and-stage projection.
 */
export const makeAssistantChatModelAdapter = (
  options: AssistantChatModelAdapterOptions,
): AssistantChatModelAdapter => {
  const fetch_ =
    options.fetch ??
    ((input: string, init: RequestInit) =>
      globalThis.fetch(input, init))
  const onDebugSnapshot = options.onDebugSnapshot

  return {
    run: async ({ messages, abortSignal }) => {
      const request = readTurnRequest(messages)
      const response = await fetch_(options.endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: abortSignal,
      })
      if (!response.ok) {
        throw new Error("Structured chat is temporarily unavailable")
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error("Structured chat returned an invalid response")
      }
      let value: StructuredChatTurnResponse
      if (onDebugSnapshot === undefined) {
        const decoded = Schema.decodeUnknownExit(
          StructuredChatTurnResponseSchema,
        )(body, { onExcessProperty: "error" })
        if (Exit.isFailure(decoded)) {
          throw new Error("Structured chat returned an invalid response")
        }
        value = decoded.value
      } else {
        const { StructuredChatDebugTurnResponseSchema } = await import(
          "../core/debug-protocol.js"
        )
        const decoded = Schema.decodeUnknownExit(
          StructuredChatDebugTurnResponseSchema,
        )(body, { onExcessProperty: "error" })
        if (Exit.isFailure(decoded)) {
          throw new Error("Structured chat returned an invalid response")
        }
        notifyDebugSnapshot(onDebugSnapshot, decoded.value.debug)
        value = decoded.value
      }

      return {
        content: value.message.content,
        metadata: {
          custom:
            value.session === undefined
              ? {}
              : {
                  [assistantChatSessionMetadataKey]:
                    value.session,
                },
        },
      }
    },
  }
}

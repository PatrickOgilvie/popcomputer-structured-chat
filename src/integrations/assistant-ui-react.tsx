"use client"

import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type LocalRuntimeOptions,
} from "@assistant-ui/react"
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  type FC,
  type ReactNode,
} from "react"
import {
  makeAssistantChatModelAdapter,
  type AssistantChatFetch,
  type AssistantChatModelAdapterOptions,
} from "./assistant-ui.js"
import {
  createStructuredChatDebugStore,
  type StructuredChatDebugStoreOptions,
} from "./assistant-ui-debug-store.js"
import type { StructuredChatDebugPanelProps } from "./assistant-ui-debug.js"

const LazyStructuredChatDebugPanel = lazy(() =>
  import("./assistant-ui-debug.js").then(({ StructuredChatDebugPanel }) => ({
    default: StructuredChatDebugPanel,
  })),
)

/** Package-owned debug-window retention and presentation options. */
export type StructuredChatDebugWindowOptions = StructuredChatDebugStoreOptions &
  Omit<StructuredChatDebugPanelProps, "store">

/** High-level assistant-ui runtime and optional debug-window configuration. */
export interface StructuredChatAssistantProviderProps {
  readonly children: ReactNode
  /** Stable identity for one browser chat; changing it starts a new runtime. */
  readonly chatKey: string
  /** Ordinary structured-chat turn endpoint. */
  readonly endpoint: string
  /** Sole switch selecting the debug contract and mounting its window. */
  readonly debug?: boolean
  /** Authorized debug endpoint; defaults to `endpoint` when omitted. */
  readonly debugEndpoint?: string
  readonly fetch?: AssistantChatFetch
  readonly onAnswerSnapshot?: AssistantChatModelAdapterOptions["onAnswerSnapshot"]
  readonly runtimeOptions?: LocalRuntimeOptions
  readonly debugWindow?: StructuredChatDebugWindowOptions
}

interface AssistantChatModelAdapterOptionsBuilder {
  endpoint: AssistantChatModelAdapterOptions["endpoint"]
  fetch?: NonNullable<AssistantChatModelAdapterOptions["fetch"]>
  onAnswerSnapshot?: NonNullable<
    AssistantChatModelAdapterOptions["onAnswerSnapshot"]
  >
  onDebugTurn?: NonNullable<AssistantChatModelAdapterOptions["onDebugTurn"]>
}

type StructuredChatAssistantRuntimeProps = Omit<
  StructuredChatAssistantProviderProps,
  "chatKey"
>

const StructuredChatAssistantRuntime: FC<
  StructuredChatAssistantRuntimeProps
> = ({
  children,
  endpoint,
  debug = false,
  debugEndpoint,
  fetch,
  onAnswerSnapshot,
  runtimeOptions,
  debugWindow,
}) => {
  const resolvedEndpoint = debug ? (debugEndpoint ?? endpoint) : endpoint

  const maximumTurns = debugWindow?.maximumTurns

  const debugStore = useMemo(
    () =>
      debug
        ? createStructuredChatDebugStore(
            maximumTurns === undefined ? {} : { maximumTurns },
          )
        : null,
    [debug, maximumTurns],
  )

  const model = useMemo(() => {
    const options: AssistantChatModelAdapterOptionsBuilder = {
      endpoint: resolvedEndpoint,
    }

    if (fetch !== undefined) {
      options.fetch = fetch
    }

    if (onAnswerSnapshot !== undefined) {
      options.onAnswerSnapshot = onAnswerSnapshot
    }

    if (debugStore !== null) {
      options.onDebugTurn = debugStore.receiveTurn
    }

    return makeAssistantChatModelAdapter(options)
  }, [debugStore, fetch, onAnswerSnapshot, resolvedEndpoint])

  const runtime = useLocalRuntime(model, runtimeOptions)

  useEffect(
    () => () => {
      debugStore?.clear()
    },
    [debugStore],
  )

  const { maximumTurns: _maximumTurns, ...panelOptions } = debugWindow ?? {}

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
      {debugStore === null ? null : (
        <Suspense fallback={null}>
          <LazyStructuredChatDebugPanel {...panelOptions} store={debugStore} />
        </Suspense>
      )}
    </AssistantRuntimeProvider>
  )
}

/**
 * Mount the lowest-friction assistant-ui runtime for one structured chat.
 *
 * The base endpoint and `chatKey` jointly own the runtime lifecycle. Changing
 * either discards browser-held messages, session metadata, and debug state;
 * changing only the selected debug endpoint preserves the current chat.
 * Debug mode remains a display and transport switch only; the server must
 * independently authorize the debug endpoint.
 */
export const StructuredChatAssistantProvider: FC<
  StructuredChatAssistantProviderProps
> = ({ chatKey, ...props }) => (
  <StructuredChatAssistantRuntime
    {...props}
    key={JSON.stringify([props.endpoint, chatKey])}
  />
)

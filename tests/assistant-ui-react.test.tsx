import { describe, expect, test } from "bun:test"
import {
  useAui,
  type AssistantClient,
} from "@assistant-ui/react"
import {
  act,
  create,
  type ReactTestRenderer,
} from "react-test-renderer"
import {
  StructuredChatAssistantProvider,
  type StructuredChatAssistantProviderProps,
} from "../src/integrations/assistant-ui-react.js"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const normalResponseBody = {
  schemaVersion: 2,
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Continue" }],
  },
} as const

const normalResponseBodyWithSession = {
  ...normalResponseBody,
  session: { id: "chat:01", revision: "1" },
} as const

const successfulDebugResponseBody = {
  schemaVersion: 2,
  outcome: "success",
  session: { id: "chat:01", revision: "1" },
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Continue" }],
  },
  answers: {
    schemaVersion: 1,
    chat: { name: "resource_finder", version: 1 },
    sections: [],
  },
  debug: {
    schemaVersion: 1,
    chat: { name: "resource_finder", version: 1 },
    status: "active",
    currentStage: { index: 0, name: "lookup", kind: "tool" },
    stages: [
      {
        _tag: "ToolStage",
        index: 0,
        name: "lookup",
        status: "current",
        repairPending: false,
        tools: ["find_resources"],
        afterExecution: "stay",
      },
    ],
  },
  trace: {
    schemaVersion: 1,
    events: [],
  },
} as const

const mountProvider = async (
  props: Omit<StructuredChatAssistantProviderProps, "children">,
): Promise<{
  readonly client: AssistantClient
  readonly renderer: ReactTestRenderer
  readonly update: (
    props: Omit<
      StructuredChatAssistantProviderProps,
      "children"
    >,
  ) => Promise<void>
}> => {
  let client: AssistantClient | undefined
  const Capture = () => {
    client = useAui()
    return null
  }

  const render = (
    nextProps: Omit<
      StructuredChatAssistantProviderProps,
      "children"
    >,
  ) => (
    <StructuredChatAssistantProvider {...nextProps}>
      <Capture />
    </StructuredChatAssistantProvider>
  )

  const loadDebugPanel = async (debug: boolean | undefined) => {
    if (debug === true) {
      await import("../src/integrations/assistant-ui-debug.js")
    }
  }

  let renderer: ReactTestRenderer | undefined
  await act(async () => {
    renderer = create(render(props))
    await loadDebugPanel(props.debug)
  })
  if (client === undefined || renderer === undefined) {
    throw new Error("Structured-chat assistant provider did not mount")
  }
  const mountedRenderer = renderer

  const getClient = (): AssistantClient => {
    if (client === undefined) {
      throw new Error("Structured-chat assistant provider is unavailable")
    }
    return client
  }

  return {
    get client() {
      return getClient()
    },
    renderer: mountedRenderer,
    update: async (nextProps) => {
      await act(async () => {
        mountedRenderer.update(render(nextProps))
        await loadDebugPanel(nextProps.debug)
      })
    },
  }
}

const send = async (client: AssistantClient, text: string) => {
  await act(async () => {
    const reply = new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | undefined
      unsubscribe = client.on("thread.runEnd", () => {
        unsubscribe?.()
        resolve()
      })
    })
    client.thread.append({
      role: "user",
      content: [{ type: "text", text }],
    })
    await reply
  })
}

describe("StructuredChatAssistantProvider", () => {
  test("uses the ordinary endpoint and omits the debug window by default", async () => {
    const requests: Array<string> = []
    const { client, renderer } = await mountProvider(
      {
        chatKey: "resource-finder:01",
        endpoint: "/api/chat/turn",
        fetch: async (input) => {
          requests.push(input)
          return new Response(JSON.stringify(normalResponseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        },
      },
    )

    await send(client, "Find a resource")

    expect(requests).toEqual(["/api/chat/turn"])
    expect(
      renderer.root.findAllByProps({ className: "pcsc-debug" }),
    ).toHaveLength(0)

    await act(() => {
      renderer.unmount()
    })
  })

  test("one debug toggle selects the debug endpoint and mounts the window", async () => {
    const requests: Array<string> = []
    const { client, renderer } = await mountProvider(
      {
        chatKey: "resource-finder:01",
        endpoint: "/api/chat/turn",
        debug: true,
        debugEndpoint: "/api/chat/debug/turn",
        fetch: async (input) => {
          requests.push(input)
          return new Response(JSON.stringify(successfulDebugResponseBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        },
      },
    )

    expect(
      renderer.root.findAllByProps({ className: "pcsc-debug" }),
    ).toHaveLength(1)

    await send(client, "Find a resource")

    expect(requests).toEqual(["/api/chat/debug/turn"])

    await act(() => {
      renderer.unmount()
    })
  })

  test("starts a fresh session when the chat key or base endpoint changes", async () => {
    const requests: Array<{
      readonly endpoint: string
      readonly body: RequestInit["body"]
    }> = []
    const fetch = async (input: string, init: RequestInit) => {
      requests.push({ endpoint: input, body: init.body })
      return new Response(
        JSON.stringify(normalResponseBodyWithSession),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      )
    }
    const mounted = await mountProvider({
      chatKey: "resource-finder:01",
      endpoint: "/api/chat-a/turn",
      fetch,
    })

    await send(mounted.client, "first")
    await send(mounted.client, "continue first")
    await mounted.update({
      chatKey: "resource-finder:02",
      endpoint: "/api/chat-a/turn",
      fetch,
    })
    await send(mounted.client, "second")
    await send(mounted.client, "continue second")
    await mounted.update({
      chatKey: "resource-finder:02",
      endpoint: "/api/chat-b/turn",
      fetch,
    })
    await send(mounted.client, "third")

    expect(requests).toEqual([
      {
        endpoint: "/api/chat-a/turn",
        body: JSON.stringify({ message: "first" }),
      },
      {
        endpoint: "/api/chat-a/turn",
        body: JSON.stringify({
          session: { id: "chat:01", revision: "1" },
          message: "continue first",
        }),
      },
      {
        endpoint: "/api/chat-a/turn",
        body: JSON.stringify({ message: "second" }),
      },
      {
        endpoint: "/api/chat-a/turn",
        body: JSON.stringify({
          session: { id: "chat:01", revision: "1" },
          message: "continue second",
        }),
      },
      {
        endpoint: "/api/chat-b/turn",
        body: JSON.stringify({ message: "third" }),
      },
    ])

    await act(() => {
      mounted.renderer.unmount()
    })
  })

  test("preserves the session when only debug transport changes", async () => {
    const requests: Array<{
      readonly endpoint: string
      readonly body: RequestInit["body"]
    }> = []
    const fetch = async (input: string, init: RequestInit) => {
      requests.push({ endpoint: input, body: init.body })
      const body =
        input === "/api/chat/debug/turn"
          ? successfulDebugResponseBody
          : normalResponseBodyWithSession
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    const mounted = await mountProvider({
      chatKey: "resource-finder:01",
      endpoint: "/api/chat/turn",
      fetch,
    })

    await send(mounted.client, "first")
    await mounted.update({
      chatKey: "resource-finder:01",
      endpoint: "/api/chat/turn",
      debug: true,
      debugEndpoint: "/api/chat/debug/turn",
      fetch,
    })
    await send(mounted.client, "second")

    expect(requests).toEqual([
      {
        endpoint: "/api/chat/turn",
        body: JSON.stringify({ message: "first" }),
      },
      {
        endpoint: "/api/chat/debug/turn",
        body: JSON.stringify({
          session: { id: "chat:01", revision: "1" },
          message: "second",
        }),
      },
    ])

    await act(() => {
      mounted.renderer.unmount()
    })
  })
})

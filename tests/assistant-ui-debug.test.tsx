import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from "react-test-renderer"
import type { StructuredChatDebugSnapshot } from "../src/core/debug.js"
import type { StructuredChatDebugTurn } from "../src/core/debug-protocol.js"
import type { StructuredChatDebugTrace } from "../src/core/debug-trace.js"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "../src/integrations/assistant-ui-debug.js"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface MountedRenderer {
  renderer?: ReactTestRenderer
}

const snapshot: StructuredChatDebugSnapshot = {
  schemaVersion: 1,
  chat: { name: "resource_finder", version: 3 },
  status: "active",
  currentStage: { index: 0, name: "request_details", kind: "collect" },
  stages: [
    {
      _tag: "CollectStage",
      index: 0,
      name: "request_details",
      status: "current",
      repairPending: true,
      satisfiedFields: 4,
      totalFields: 5,
      fields: [
        {
          field: "enabled",
          mode: "explicit",
          description: "Whether the feature is enabled <now>",
          question: {
            _tag: "FixedQuestion",
            text: "Should this be enabled?",
          },
          state: {
            _tag: "Accepted",
            value: false,
            evidence: {
              messageIndex: 1,
              quote: '<img src=x onerror="alert(1)"> no',
            },
            issuedQuestion: {
              messageIndex: 0,
              text: "Should this be enabled?",
            },
          },
        },
        {
          field: "budget",
          mode: "semantic",
          description: "Available budget",
          question: {
            _tag: "AdaptiveQuestion",
            goal: "Ask for the available budget",
            fallback: "What budget is available?",
          },
          state: {
            _tag: "Accepted",
            value: 0,
            evidence: null,
            issuedQuestion: null,
          },
        },
        {
          field: "note",
          mode: "semantic",
          description: "Optional note",
          question: {
            _tag: "AdaptiveChoiceQuestion",
            prompt: "Which note fits?",
            minimumOptions: 2,
            maximumOptions: 3,
            fallbackOptions: ["Short", "Detailed"],
          },
          state: {
            _tag: "Accepted",
            value: "",
            evidence: null,
            issuedQuestion: null,
          },
        },
        {
          field: "audience",
          mode: "confirmed",
          description: "Intended audience",
          question: {
            _tag: "ChoiceQuestion",
            text: "Who is this for?",
            options: [{ label: "Customers" }, { label: "Staff" }],
          },
          state: {
            _tag: "Asked",
            issuedQuestion: {
              messageIndex: 2,
              text: "Who is this for?",
            },
          },
        },
        {
          field: "deadline",
          mode: "semantic",
          description: "Known deadline",
          question: {
            _tag: "FixedQuestion",
            text: "When is this needed?",
          },
          state: {
            _tag: "Accepted",
            value: null,
            evidence: null,
            issuedQuestion: null,
          },
        },
      ],
    },
    {
      _tag: "ToolStage",
      index: 1,
      name: "lookup",
      status: "upcoming",
      repairPending: false,
      tools: ["find_resources"],
      afterExecution: "stay",
    },
    {
      _tag: "CommandStage",
      index: 2,
      name: "submit",
      status: "upcoming",
      repairPending: false,
      command: "submit_request",
    },
  ],
}

const trace: StructuredChatDebugTrace = {
  schemaVersion: 1,
  events: [
    {
      _tag: "ModelInput",
      sequence: 0,
      call: 0,
      provider: "openai",
      model: "gpt-5-mini",
      providerAttempt: 1,
      request: {
        model: "gpt-5-mini",
        input: {
          messages: [{ role: "user", content: "literal <request>" }],
        },
      },
    },
    {
      _tag: "ModelOutput",
      sequence: 1,
      call: 0,
      response: {
        choices: [{ message: { content: "literal <response>" } }],
      },
    },
    {
      _tag: "ToolCalled",
      sequence: 2,
      tool: "find_resources",
    },
    {
      _tag: "QuestionAnswered",
      sequence: 3,
      stage: "request_details",
      field: "audience",
    },
    {
      _tag: "TraceTruncated",
      sequence: 4,
    },
  ],
}

const successfulTurn: StructuredChatDebugTurn = {
  _tag: "Succeeded",
  session: { id: "resource:01", revision: "1" },
  snapshot,
  trace,
}

const uncorrelatedFailedTurn: StructuredChatDebugTurn = {
  _tag: "Failed",
  session: null,
  trace: {
    schemaVersion: 1,
    events: [{ _tag: "TurnFailed", sequence: 0 }],
  },
}

describe("createStructuredChatDebugStore", () => {
  test("isolates snapshot ownership and unsubscribe behavior", () => {
    const store = createStructuredChatDebugStore()
    const otherStore = createStructuredChatDebugStore()
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    expect(store.getSnapshot()).toBeNull()
    store.receive(snapshot)
    expect(store.getSnapshot()).toBe(snapshot)
    expect(otherStore.getSnapshot()).toBeNull()
    expect(notifications).toBe(1)

    store.receive(snapshot)
    expect(notifications).toBe(1)

    unsubscribe()
    store.receive({ ...snapshot, status: "complete" })
    expect(notifications).toBe(1)
    otherStore.receive(snapshot)
    expect(otherStore.getSnapshot()).toBe(snapshot)
    expect(store.getSnapshot()?.status).toBe("complete")
  })

  test("continues notifying subscribers after one listener fails", () => {
    const store = createStructuredChatDebugStore()
    let laterNotifications = 0

    store.subscribe(() => {
      throw new Error("faulty preview subscriber")
    })
    store.subscribe(() => {
      laterNotifications += 1
    })

    expect(() => store.receive(snapshot)).not.toThrow()
    expect(laterNotifications).toBe(1)
    expect(store.getSnapshot()).toBe(snapshot)
  })

  test("bounds turns by session and replaces duplicate revisions", () => {
    const store = createStructuredChatDebugStore()
    store.receiveTurn(successfulTurn)
    store.receiveTurn({
      _tag: "Succeeded",
      session: { id: "resource:01", revision: "2" },
      snapshot: { ...snapshot, status: "complete" },
      trace: {
        ...trace,
        events: [],
      },
    })
    store.receiveTurn({
      _tag: "Succeeded",
      session: { id: "resource:01", revision: "2" },
      snapshot,
      trace,
    })

    expect(store.getView().turns).toHaveLength(2)
    expect(store.getView().turns[1]?.trace.events).toEqual(trace.events)

    store.receiveTurn({
      _tag: "Succeeded",
      session: { id: "resource:02", revision: "1" },
      snapshot,
      trace,
    })
    expect(store.getView().turns).toHaveLength(1)
    expect(store.getView().turns[0]?.session?.id).toBe("resource:02")
  })

  test("retains a known session across an uncorrelated failure", () => {
    const store = createStructuredChatDebugStore()
    store.receiveTurn(successfulTurn)
    store.receiveTurn(uncorrelatedFailedTurn)

    expect(store.getView().snapshot).toBe(snapshot)
    expect(store.getView().turns).toHaveLength(2)
    expect(store.getView().turns[1]?.session).toBeNull()

    store.receiveTurn({
      ...successfulTurn,
      session: { id: "resource:01", revision: "2" },
    })
    expect(store.getView().turns).toHaveLength(3)
    expect(store.getView().snapshot).toBe(snapshot)
  })

  test("retains failed turns, enforces the configured bound, and clears", () => {
    const store = createStructuredChatDebugStore({ maximumTurns: 2 })
    store.receiveTurn(successfulTurn)
    store.receiveTurn({
      _tag: "Failed",
      session: { id: "resource:01" },
      trace: {
        schemaVersion: 1,
        events: [{ _tag: "TurnFailed", sequence: 0 }],
      },
    })
    store.receiveTurn({
      ...successfulTurn,
      session: { id: "resource:01", revision: "2" },
    })

    expect(store.getView().turns).toHaveLength(2)
    expect(store.getView().turns[0]?._tag).toBe("Failed")
    store.clear()
    expect(store.getView()).toEqual({ snapshot: null, turns: [] })
  })
})

describe("StructuredChatDebugPanel", () => {
  test("wraps arrow navigation and preserves Home and End", async () => {
    const store = createStructuredChatDebugStore()
    const mounted: MountedRenderer = {}

    await act(() => {
      mounted.renderer = create(
        createElement(StructuredChatDebugPanel, { store }),
      )
    })
    const renderer = mounted.renderer
    if (renderer === undefined) {
      throw new Error("React debug-panel test renderer did not mount")
    }

    const readTabs = (): ReadonlyArray<ReactTestInstance> =>
      renderer.root.findAllByProps({ role: "tab" })
    const selectedTabIndex = (): number =>
      readTabs().findIndex((tab) => tab.props["aria-selected"] === true)
    const pressTabKey = async (
      tabIndex: number,
      key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
    ): Promise<void> => {
      const tab = readTabs()[tabIndex]
      if (tab === undefined) {
        throw new Error(`Debug-panel tab ${tabIndex} was not rendered`)
      }
      let defaultPrevented = false
      await act(() => {
        tab.props.onKeyDown({
          key,
          preventDefault: () => {
            defaultPrevented = true
          },
        })
      })
      expect(defaultPrevented).toBe(true)
    }

    expect(selectedTabIndex()).toBe(0)
    await pressTabKey(0, "ArrowLeft")
    expect(selectedTabIndex()).toBe(1)
    await pressTabKey(1, "ArrowRight")
    expect(selectedTabIndex()).toBe(0)
    await pressTabKey(0, "End")
    expect(selectedTabIndex()).toBe(1)
    await pressTabKey(1, "Home")
    expect(selectedTabIndex()).toBe(0)

    await act(() => {
      renderer.unmount()
    })
  })

  test("renders stage progress, answer states, and escaped debug data", () => {
    const store = createStructuredChatDebugStore()
    store.receive(snapshot)

    const html = renderToStaticMarkup(
      createElement(StructuredChatDebugPanel, {
        store,
        position: "top-left",
        theme: "light",
      }),
    )

    expect(html).toContain('data-position="top-left"')
    expect(html).toContain('data-theme="light"')
    expect(html).toContain("Resource Finder")
    expect(html).toContain("Request Details")
    expect(html).toContain("Required Answers")
    expect(html).toContain("4 of 5 answered")
    expect(html).toContain(
      "Request Details is current. 4 of 5 required answers are answered.",
    )
    expect(html).toContain('aria-current="step"')
    expect(html).toContain("Find Resources")
    expect(html).toContain("Submit Request")
    expect(html).toContain("Current Step")
    expect(html).toContain("Awaiting Answer")
    expect(html).toContain("First Asked As")
    expect(html).toContain("Answered")
    expect(
      html.match(/<details[^>]*data-focused-answer="true"/gu),
    ).toHaveLength(1)
    expect(html).toContain(
      'class="pcsc-debug__answer-preview" data-status="answered">No</span>',
    )
    expect(html).toContain(
      'class="pcsc-debug__answer-preview" data-status="answered">0</span>',
    )
    expect(html).toContain(
      'class="pcsc-debug__answer-preview" data-status="answered">Empty</span>',
    )
    expect(html).toContain(
      'class="pcsc-debug__answer-preview" data-status="asked">Awaiting</span>',
    )
    expect(html).toContain(
      'class="pcsc-debug__question-copy">Who is this for?</p>',
    )
    expect(html).toContain(
      'class="pcsc-debug__answer-preview" data-status="answered">Null</span>',
    )
    expect(html).toContain('class="pcsc-debug__meter" role="progressbar"')
    expect(html).toContain(">No</p>")
    expect(html).toContain(">0</p>")
    expect(html).toContain("Empty answer")
    expect(html).toContain(">Null</p>")
    expect(html).toContain("This step needs review before continuing")
    expect(html).toContain("Raw State")
    expect(html).toContain("Schema Key")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; no")
    expect(html).not.toContain('<img src=x onerror="alert(1)">')
    expect(html).toContain('aria-label="Copy debug state as JSON"')
    expect(html).toContain('aria-label="Collapse debug panel"')
  })

  test("opens only the most recently first-issued unresolved field", () => {
    const store = createStructuredChatDebugStore()
    const multipleAskedSnapshot: StructuredChatDebugSnapshot = {
      ...snapshot,
      stages: snapshot.stages.map((stage) =>
        stage._tag === "CollectStage"
          ? {
              ...stage,
              satisfiedFields: 3,
              fields: stage.fields.map((field) =>
                field.field === "deadline"
                  ? {
                      ...field,
                      state: {
                        _tag: "Asked" as const,
                        issuedQuestion: {
                          messageIndex: 4,
                          text: "When do you need this?",
                        },
                      },
                    }
                  : field,
              ),
            }
          : stage,
      ),
    }
    store.receive(multipleAskedSnapshot)

    const html = renderToStaticMarkup(
      createElement(StructuredChatDebugPanel, { store }),
    )

    expect(
      html.match(/<details[^>]*data-focused-answer="true"/gu),
    ).toHaveLength(1)
    expect(html).toMatch(
      /data-focused-answer="true"[^>]*><summary[^>]*>.*?class="pcsc-debug__answer-title">Deadline/u,
    )
    expect(html).toContain(
      'class="pcsc-debug__sr-only">, Awaiting Answer</span>',
    )
  })

  test("renders an accessible collapsed waiting state", () => {
    const store = createStructuredChatDebugStore()
    const html = renderToStaticMarkup(
      createElement(StructuredChatDebugPanel, {
        store,
        position: "bottom-right",
        theme: "system",
        defaultOpen: false,
      }),
    )

    expect(html).toContain('data-open="false"')
    expect(html).toContain("Waiting for a reply")
    expect(html).toContain("Ready for the first reply")
    expect(html).toContain('aria-label="Expand debug panel"')
    expect(html).toContain("disabled")
    expect(html).toContain("hidden")
  })

  test("renders the literal model chain and semantic annotations on its own tab", () => {
    const store = createStructuredChatDebugStore()
    store.receiveTurn(successfulTurn)

    const html = renderToStaticMarkup(
      createElement(StructuredChatDebugPanel, {
        store,
        defaultTab: "calls",
      }),
    )

    expect(html).toContain('data-tab="calls"')
    expect(html).toContain(">Conversation</button>")
    expect(html).toContain("LLM Trace")
    expect(html.indexOf('class="pcsc-debug__tabs"')).toBeLessThan(
      html.indexOf('class="pcsc-debug__body"'),
    )
    expect(html).toContain('aria-label="Literal LLM call trace"')
    expect(html).toContain("LLM Input")
    expect(html).toContain("LLM Output")
    expect(html).toContain("openai · gpt-5-mini · call 1")
    expect(html).toContain("literal &lt;request&gt;")
    expect(html).toContain("literal &lt;response&gt;")
    expect(html).not.toContain("literal <request>")
    expect(html).toContain("Find Resources Called")
    expect(html).toContain("Question Answered")
    expect(html).toContain("Audience")
    expect(html).toContain("Capture Limit Reached")
    expect(html).toContain("Later events were omitted")
    expect(html).toContain('aria-label="Copy LLM call trace as JSON"')
  })

  test("renders an uncorrelated failure without claiming persistence certainty", () => {
    const store = createStructuredChatDebugStore()
    store.receiveTurn(successfulTurn)
    store.receiveTurn(uncorrelatedFailedTurn)

    const html = renderToStaticMarkup(
      createElement(StructuredChatDebugPanel, {
        store,
        defaultTab: "calls",
      }),
    )

    expect(html).toContain("Turn 2")
    expect(html).toContain("no revision returned")
    expect(html).toContain("Turn Failed")
    expect(html).toContain("No new session revision was returned")
    expect(html).toContain(
      "The latest debug turn failed; no new session revision was returned.",
    )
    expect(html).not.toContain("failed before persistence")
    expect(html).not.toContain("was persisted")
  })
})

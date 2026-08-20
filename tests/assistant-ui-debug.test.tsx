import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { StructuredChatDebugSnapshot } from "../src/core/debug.js"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "../src/integrations/assistant-ui-debug.js"

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
})

describe("StructuredChatDebugPanel", () => {
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
})

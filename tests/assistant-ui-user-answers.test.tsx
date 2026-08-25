import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import {
  act,
  create,
  type ReactTestRenderer,
} from "react-test-renderer"
import {
  createStructuredChatUserAnswerStore,
  useStructuredChatUserAnswers,
  type StructuredChatUserAnswerStore,
  type StructuredChatUserAnswerUpdate,
} from "../src/integrations/assistant-ui.js"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface MountedRenderer {
  renderer?: ReactTestRenderer
}

const firstUpdate = {
  session: { id: "chat:01", revision: "1" },
  snapshot: {
    schemaVersion: 1,
    chat: { name: "supplier_onboarding", version: 1 },
    sections: [
      {
        key: "company",
        label: "Company",
        fields: [
          {
            key: "name",
            label: "Name",
            state: { _tag: "Accepted", value: "Acme" },
          },
          {
            key: "location",
            label: "Location",
            state: { _tag: "Missing" },
          },
        ],
      },
    ],
  },
} as const satisfies StructuredChatUserAnswerUpdate

const replacementUpdate = {
  session: { id: "chat:01", revision: "opaque-next" },
  snapshot: {
    schemaVersion: 1,
    chat: { name: "supplier_onboarding", version: 1 },
    sections: [
      {
        key: "company",
        label: "Company",
        fields: [
          {
            key: "name",
            label: "Name",
            state: { _tag: "Accepted", value: "Acme Ltd" },
          },
        ],
      },
    ],
  },
} as const satisfies StructuredChatUserAnswerUpdate

describe("createStructuredChatUserAnswerStore", () => {
  test("retains only the latest complete update", () => {
    const store = createStructuredChatUserAnswerStore()
    const otherStore = createStructuredChatUserAnswerStore()
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    expect(store.getSnapshot()).toBeNull()
    store.receive(firstUpdate)
    expect(store.getSnapshot()).toBe(firstUpdate)
    expect(otherStore.getSnapshot()).toBeNull()
    expect(notifications).toBe(1)

    store.receive(firstUpdate)
    expect(notifications).toBe(1)

    store.receive(replacementUpdate)
    expect(store.getSnapshot()).toBe(replacementUpdate)
    expect(
      store.getSnapshot()?.snapshot.sections[0]?.fields,
    ).toHaveLength(1)
    expect(notifications).toBe(2)

    unsubscribe()
    store.receive({
      ...replacementUpdate,
      session: { id: "chat:02", revision: "1" },
    })
    expect(notifications).toBe(2)
    expect(store.getSnapshot()?.session.id).toBe("chat:02")
  })

  test("continues notifying after one subscriber throws", () => {
    const store = createStructuredChatUserAnswerStore()
    let laterNotifications = 0

    store.subscribe(() => {
      throw new Error("faulty answer-form subscriber")
    })
    store.subscribe(() => {
      laterNotifications += 1
    })

    expect(() => store.receive(firstUpdate)).not.toThrow()
    expect(laterNotifications).toBe(1)
    expect(store.getSnapshot()).toBe(firstUpdate)
  })

  test("clears explicitly without redundant notifications", () => {
    const store = createStructuredChatUserAnswerStore()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })

    store.clear()
    expect(notifications).toBe(0)
    store.receive(firstUpdate)
    store.clear()
    store.clear()

    expect(store.getSnapshot()).toBeNull()
    expect(notifications).toBe(2)
  })
})

describe("useStructuredChatUserAnswers", () => {
  const Answers = ({
    store,
  }: Readonly<{ store: StructuredChatUserAnswerStore }>) => {
    const update = useStructuredChatUserAnswers(store)
    return createElement(
      "output",
      null,
      update === null
        ? "Waiting"
        : `${update.session.id}:${update.session.revision}:${update.snapshot.sections.length}`,
    )
  }

  test("rerenders mounted subscribers and cleans up on unmount", async () => {
    const source = createStructuredChatUserAnswerStore()
    let activeSubscriptions = 0
    const store: StructuredChatUserAnswerStore = {
      receive: source.receive,
      clear: source.clear,
      getSnapshot: source.getSnapshot,
      subscribe: (listener) => {
        activeSubscriptions += 1
        const unsubscribe = source.subscribe(listener)
        return () => {
          unsubscribe()
          activeSubscriptions -= 1
        }
      },
    }
    const mounted: MountedRenderer = {}

    await act(() => {
      mounted.renderer = create(createElement(Answers, { store }))
    })
    const renderer = mounted.renderer
    if (renderer === undefined) {
      throw new Error("React answer-store test renderer did not mount")
    }

    expect(renderer.root.findByType("output").children).toEqual(["Waiting"])
    expect(activeSubscriptions).toBe(1)

    await act(() => {
      source.receive(replacementUpdate)
    })

    expect(renderer.root.findByType("output").children).toEqual([
      "chat:01:opaque-next:1",
    ])
    expect(activeSubscriptions).toBe(1)

    await act(() => {
      renderer.unmount()
    })
    expect(activeSubscriptions).toBe(0)
  })
})

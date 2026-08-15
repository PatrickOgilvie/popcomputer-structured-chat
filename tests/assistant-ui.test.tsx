import { describe, expect, test } from "bun:test"
import type { DataMessagePartProps } from "@assistant-ui/react"
import { Schema } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { defineView } from "../src/index.js"
import { makeAssistantView } from "../src/integrations/assistant-ui.js"

const AgencyCards = defineView({
  name: "agency_cards",
  version: 1,
  schema: Schema.Struct({
    title: Schema.String,
    agencies: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String }),
    ),
  }),
})

const props = (
  data: DataMessagePartProps<unknown>["data"],
): DataMessagePartProps<unknown> => ({
  type: "data",
  name: "agency_cards",
  data,
  status: { type: "complete" },
})

describe("makeAssistantView", () => {
  test("registers the schema name and supplies parsed data", () => {
    const UI = makeAssistantView(AgencyCards, {
      render: ({ data }) => (
        <section>
          <h2>{data.title}</h2>
          <p>{data.agencies[0]?.name}</p>
        </section>
      ),
      fallback: () => <p>Invalid cards</p>,
    })
    const html = renderToStaticMarkup(
      createElement(
        UI.unstable_data.render,
        props({
          schemaVersion: 1,
          title: "Recommended agencies",
          agencies: [{ id: "agency:1", name: "Northbank" }],
        }),
      ),
    )

    expect(UI.unstable_data.name).toBe("agency_cards")
    expect(html).toContain("Recommended agencies")
    expect(html).toContain("Northbank")
  })

  test("routes invalid or version-mismatched data to the fallback", () => {
    const UI = makeAssistantView(AgencyCards, {
      render: ({ data }) => <p>{data.title}</p>,
      fallback: () => <p>Invalid cards</p>,
    })
    const html = renderToStaticMarkup(
      createElement(
        UI.unstable_data.render,
        props({
          schemaVersion: 2,
          title: "Wrong version",
          agencies: [],
        }),
      ),
    )

    expect(html).toBe("<p>Invalid cards</p>")
  })

  test("renders nothing for invalid data when no fallback is configured", () => {
    const UI = makeAssistantView(AgencyCards, {
      render: ({ data }) => <p>{data.title}</p>,
    })
    const html = renderToStaticMarkup(
      createElement(UI.unstable_data.render, props({})),
    )

    expect(html).toBe("")
  })
})

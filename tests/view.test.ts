import { View } from "../src/index.js"
import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"

const AgencyCards = View.define({
  name: "agency_cards",
  version: 2,
  schema: Schema.Struct({
    title: Schema.Trimmed.check(Schema.isNonEmpty()),
    agencyIds: Schema.Array(Schema.String),
  }),
})

const EventCard = View.define({
  name: "event_card",
  version: 1,
  schema: Schema.Struct({ when: Schema.DateFromString }),
})

describe("View.define", () => {
  test("constructs transformed Type-side view data", () => {
    const when = new Date("2026-08-10T12:00:00.000Z")

    const part = EventCard.make({ when })

    expect(part.data.when).toBeInstanceOf(Date)
    expect(part.data.when.toISOString()).toBe(
      "2026-08-10T12:00:00.000Z",
    )
  })

  test("decodes transformed Encoded-side browser data", async () => {
    const part = await Effect.runPromise(
      EventCard.decode({
        type: "data",
        name: "event_card",
        data: {
          schemaVersion: 1,
          when: "2026-08-10T12:00:00.000Z",
        },
      }),
    )

    expect(part.data.when).toBeInstanceOf(Date)
  })

  test("constructs its versioned protocol part", () => {
    expect(
      AgencyCards.make({
        title: "Recommended agencies",
        agencyIds: ["agency:1"],
      }),
    ).toEqual({
      type: "data",
      name: "agency_cards",
      data: {
        schemaVersion: 2,
        title: "Recommended agencies",
        agencyIds: ["agency:1"],
      },
    })
  })

  test("strictly parses application-owned display data", async () => {
    const applicationData = {
      title: "Recommended agencies",
      agencyIds: ["agency:1"],
      privateNotes: "must not reach the browser",
    }
    const parsed = await Effect.runPromise(
      Effect.result(AgencyCards.parseData(applicationData)),
    )

    expect(Result.isFailure(parsed)).toBe(true)
  })

  test("strictly decodes serialized browser parts", () => {
    const decoded = AgencyCards.decodeResult({
      type: "data",
      name: "agency_cards",
      data: {
        schemaVersion: 1,
        title: "Old payload",
        agencyIds: [],
      },
    })

    expect(Result.isFailure(decoded)).toBe(true)
  })

  test("reserves schemaVersion for the protocol", () => {
    expect(() =>
      View.define({
        name: "invalid",
        version: 1,
        schema: Schema.Struct({ schemaVersion: Schema.Number }),
      }),
    ).toThrow("reserved schemaVersion")
  })
})

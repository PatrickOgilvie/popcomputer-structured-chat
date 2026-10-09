import { describe, expect, test } from "bun:test"

import { Result, Schema, Struct } from "effect"

import { ownFields } from "../src/core/record.js"

// Field names that are also Object.prototype members are legal answer keys.
const Fields = ownFields(
  Schema.Struct({
    constructor: Schema.String,
    toString: Schema.String,
  }).mapFields(Struct.map(Schema.optionalKey)),
)

describe("ownFields", () => {
  test("reads absent prototype-named fields as missing in both directions", () => {
    const decoded = Schema.decodeUnknownSync(Fields)(
      {},
      { onExcessProperty: "error" },
    )
    const own = Schema.decodeUnknownSync(Fields)({ constructor: "own" })

    expect(Object.keys(decoded)).toEqual([])
    expect(Object.keys(Schema.encodeSync(Fields)(decoded))).toEqual([])
    expect(
      Object.keys(Schema.decodeUnknownSync(Schema.toType(Fields))({})),
    ).toEqual([])
    expect(Object.entries(own)).toEqual([["constructor", "own"]])
  })

  test("still rejects invalid values, excess properties and non-objects", () => {
    for (const input of [{ constructor: 1 }, [], null])
      expect(Result.isFailure(Schema.decodeUnknownResult(Fields)(input))).toBe(
        true,
      )

    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(Fields)(
          { other: "x" },
          { onExcessProperty: "error" },
        ),
      ),
    ).toBe(true)
  })
})

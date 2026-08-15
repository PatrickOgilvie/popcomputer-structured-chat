import { describe, expect, test } from "bun:test"
import { Effect, Either, Schema } from "effect"
import {
  defineTool,
  defineToolSet,
  InvalidToolCall,
  InvalidToolProjection,
  Tool,
} from "../src/index.js"

const Search = defineTool({
  name: "search",
  description: "Search the catalogue.",
  input: Schema.Struct({ query: Schema.String }),
  execute: ({ query }) => Effect.succeed({ query }),
})

const Delete = defineTool({
  name: "delete",
  description: "Delete a catalogue item.",
  input: Schema.Struct({ id: Schema.String }),
  execute: ({ id }) => Effect.succeed({ id }),
})

describe("defineToolSet", () => {
  test("classifies envelope, name, and argument failures without sentinels", async () => {
    const tools = defineToolSet(Search)
    const [envelope, name, arguments_] = await Effect.runPromise(
      Effect.all([
        Effect.either(tools.parseCall({ arguments: {} })),
        Effect.either(
          tools.parseCall({ name: "missing", arguments: {} }),
        ),
        Effect.either(
          tools.parseCall({
            name: "search",
            arguments: { query: 42 },
          }),
        ),
      ]),
    )

    expect(Either.isLeft(envelope)).toBe(true)
    expect(Either.isLeft(name)).toBe(true)
    expect(Either.isLeft(arguments_)).toBe(true)
    if (
      Either.isLeft(envelope) &&
      Either.isLeft(name) &&
      Either.isLeft(arguments_)
    ) {
      expect(envelope.left).toMatchObject({
        reason: "invalid_envelope",
        tool: null,
      })
      expect(name.left).toMatchObject({
        reason: "unknown_tool",
        tool: "missing",
      })
      expect(arguments_.left).toMatchObject({
        reason: "invalid_arguments",
        tool: "search",
      })
    }
  })

  test("preserves projection failures in its runtime contract", async () => {
    const InvalidProjection = defineTool({
      name: "invalid_projection",
      description: "Return one invalid projection.",
      input: Schema.Struct({}),
      execute: () => Effect.succeed({ value: "valid" }),
    }).pipe(
      Tool.modelResult(
        Schema.Struct({ value: Schema.String }),
        // SAFETY: Deliberately violate the projector type to prove the public
        // ToolSet error channel retains InvalidToolProjection.
        () => ({ value: 42 }) as never,
      ),
    )
    const result = await Effect.runPromise(
      Effect.either(
        defineToolSet(InvalidProjection).executeCall({
          name: "invalid_projection",
          arguments: {},
        }),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidToolProjection)
    }
  })

  test("advertises and executes only registered tools", async () => {
    const tools = defineToolSet(Search)
    const execution = await Effect.runPromise(
      tools.executeCall({
        name: "search",
        arguments: { query: "public sector" },
      }),
    )

    expect(tools.models).toHaveLength(1)
    expect(tools.models[0]?.name).toBe("search")
    expect(execution.serverResult).toEqual({ query: "public sector" })
  })

  test("rejects a valid tool that is outside the current set", async () => {
    const tools = defineToolSet(Search)
    const result = await Effect.runPromise(
      Effect.either(
        tools.executeCall({
          name: Delete.name,
          arguments: { id: "agency:1" },
        }),
      ),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(InvalidToolCall)
    }
  })

  test("rejects duplicate names at definition time", () => {
    expect(() => defineToolSet(Search, Search)).toThrow(
      "Duplicate structured chat tool name: search",
    )
  })
})

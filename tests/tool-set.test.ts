import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
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
        Effect.result(tools.parseCall({ arguments: {} })),
        Effect.result(
          tools.parseCall({ name: "missing", arguments: {} }),
        ),
        Effect.result(
          tools.parseCall({
            name: "search",
            arguments: { query: 42 },
          }),
        ),
      ]),
    )

    expect(Result.isFailure(envelope)).toBe(true)
    expect(Result.isFailure(name)).toBe(true)
    expect(Result.isFailure(arguments_)).toBe(true)
    if (
      Result.isFailure(envelope) &&
      Result.isFailure(name) &&
      Result.isFailure(arguments_)
    ) {
      expect(envelope.failure).toMatchObject({
        reason: "invalid_envelope",
        tool: null,
      })
      expect(name.failure).toMatchObject({
        reason: "unknown_tool",
        tool: "missing",
      })
      expect(arguments_.failure).toMatchObject({
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
      Effect.result(
        defineToolSet(InvalidProjection).executeCall({
          name: "invalid_projection",
          arguments: {},
        }),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidToolProjection)
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
      Effect.result(
        tools.executeCall({
          name: Delete.name,
          arguments: { id: "agency:1" },
        }),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidToolCall)
    }
  })

  test("rejects duplicate names at definition time", () => {
    expect(() => defineToolSet(Search, Search)).toThrow(
      "Duplicate structured chat tool name: search",
    )
  })
})

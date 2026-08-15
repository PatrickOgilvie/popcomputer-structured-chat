/** Package-owned kinds for executable structured-chat definitions. */
export type StructuredDefinitionKind =
  | "tool"
  | "collect_stage"
  | "tool_stage"
  | "command_stage"
  | "repair"
  | "model_guard"

const structuredDefinitionKind = Symbol(
  "@popcomputer/structured-chat/StructuredDefinitionKind",
)

/** @internal Nominal proof that a definition came from this package. */
export interface StructuredDefinition<
  Kind extends StructuredDefinitionKind,
> {
  readonly [structuredDefinitionKind]: Kind
}

/** @internal Attach a non-copying nominal identity in a public builder. */
export const structuredDefinition = <
  const Kind extends StructuredDefinitionKind,
>(kind: Kind) =>
  <Value extends object>(
    value: Omit<Value, keyof StructuredDefinition<Kind>>,
  ): Value & StructuredDefinition<Kind> => {
    Object.defineProperty(value, structuredDefinitionKind, {
      value: kind,
      enumerable: false,
      configurable: false,
      writable: false,
    })

    // SAFETY: defineProperty attached the exact private symbol and literal
    // kind to this freshly constructed package definition. The non-enumerable
    // proof cannot be copied by ordinary object spread.
    return value as Value & StructuredDefinition<Kind>
  }

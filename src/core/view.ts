import { Effect, Either, Schema, unsafeCoerce } from "effect"
import type * as ParseResult from "effect/ParseResult"
import type { JsonValue } from "./json-value.js"

/** Stable machine-facing name for one structured chat view. */
export const ViewNameSchema = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(100),
  Schema.pattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Positive protocol version for one structured chat view. */
export const ViewVersionSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 2_147_483_647),
)

/** Minimum runtime shape retained for every structured chat view. */
export interface ViewDefinitionContract<
  Name extends string = string,
  Version extends number = number,
  InputSchema extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
  DataSchema extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
  PartSchema extends Schema.Schema.AnyNoContext = Schema.Schema.AnyNoContext,
> {
  readonly name: Name
  readonly version: Version
  readonly inputSchema: InputSchema
  readonly dataSchema: DataSchema
  readonly partSchema: PartSchema

  /** Parse unknown application data into one display-safe data part. */
  readonly parseData: (
    input: JsonValue,
  ) => Effect.Effect<Schema.Schema.Type<PartSchema>, ParseResult.ParseError>

  /** Parse an unknown serialized part without requiring an Effect runtime. */
  readonly decodeEither: (
    input: JsonValue,
  ) => Either.Either<Schema.Schema.Type<PartSchema>, ParseResult.ParseError>
}

/** Parsed data accepted when constructing one view part. */
export type ViewInput<View extends ViewDefinitionContract> =
  Schema.Schema.Type<View["inputSchema"]>

/** Versioned display data carried by one view part. */
export type ViewData<View extends ViewDefinitionContract> =
  Schema.Schema.Type<View["dataSchema"]>

/** Complete structured message part produced by one view. */
export type ViewPart<View extends ViewDefinitionContract> =
  Schema.Schema.Type<View["partSchema"]>

/** One schema-defined, versioned structured chat view. */
export interface ViewDefinition<
  Name extends string,
  Version extends number,
  InputSchema extends Schema.Schema.AnyNoContext,
  DataSchema extends Schema.Schema.AnyNoContext,
  PartSchema extends Schema.Schema.AnyNoContext,
> extends ViewDefinitionContract<
    Name,
    Version,
    InputSchema,
    DataSchema,
    PartSchema
  > {
  /** Construct and validate one display-safe data part. */
  readonly make: (
    input: Schema.Schema.Type<InputSchema>,
  ) => Schema.Schema.Type<PartSchema>

  /** Parse unknown input into one display-safe data part. */
  readonly parseData: (
    input: JsonValue,
  ) => Effect.Effect<Schema.Schema.Type<PartSchema>, ParseResult.ParseError>

  /** Parse an unknown serialized part at a runtime boundary. */
  readonly decode: (
    input: JsonValue,
  ) => Effect.Effect<Schema.Schema.Type<PartSchema>, ParseResult.ParseError>

  /** Parse an unknown serialized part without requiring an Effect runtime. */
  readonly decodeEither: (
    input: JsonValue,
  ) => Either.Either<Schema.Schema.Type<PartSchema>, ParseResult.ParseError>
}

/** Definition input for one versioned structured chat view. */
export interface DefineViewInput<
  Name extends string,
  Version extends number,
  Fields extends Schema.Struct.Fields,
> {
  readonly name: Name
  readonly version: Version
  readonly schema: Schema.Struct<Fields>
}

type NoContextFields<Fields extends Schema.Struct.Fields> = [
  Schema.Struct.Context<Fields>,
] extends [never]
  ? unknown
  : never

/**
 * Define one typed server-to-browser view contract.
 *
 * The package injects `schemaVersion`; application schemas describe display
 * data only. Every constructor and decoder rejects excess properties.
 */
export const defineView = <
  const Name extends string,
  const Version extends number,
  Fields extends Schema.Struct.Fields,
>(
  definition: DefineViewInput<Name, Version, Fields> &
    NoContextFields<Fields>,
) => {
  Schema.decodeSync(ViewNameSchema)(definition.name)
  Schema.decodeSync(ViewVersionSchema)(definition.version)

  if ("schemaVersion" in definition.schema.fields) {
    throw new Error(
      "View schemas cannot define the reserved schemaVersion field",
    )
  }

  // SAFETY: the reserved schemaVersion field cannot be supplied by Fields;
  // the literal therefore augments the exact application schema once.
  const dataSchema = Schema.Struct({
    schemaVersion: Schema.Literal(definition.version),
    ...definition.schema.fields,
  }) as Schema.Struct<
    { readonly schemaVersion: Schema.Literal<[Version]> } &
      Fields
  >
  // SAFETY: these literals and dataSchema exactly describe ViewPart<Name,
  // Version, Fields>; the assertions retain that generic correlation.
  const partSchema = Schema.Struct({
    type: Schema.Literal("data"),
    name: Schema.Literal(definition.name),
    data: dataSchema,
  }) as Schema.Struct<{
    readonly type: Schema.Literal<["data"]>
    readonly name: Schema.Literal<[Name]>
    readonly data: typeof dataSchema
  }>
  type Input = Schema.Schema.Type<typeof definition.schema>
  type Part = Schema.Schema.Type<typeof partSchema>
  // SAFETY: NoContextFields excludes schemas with runtime requirements; this
  // assertion preserves definition.schema's existing Type and Encoded sides.
  const runtimeInputSchema = unsafeCoerce<
    typeof definition.schema,
    Schema.Schema<
      Input,
      Schema.Schema.Encoded<typeof definition.schema>,
      never
    >
  >(definition.schema)
  // SAFETY: partSchema was built immediately above from the exact view name,
  // version, and application fields, with no runtime schema requirements.
  const runtimePartSchema = unsafeCoerce<
    typeof partSchema,
    Schema.Schema<
      Part,
      Schema.Schema.Encoded<typeof partSchema>,
      never
    >
  >(partSchema)
  const decodePart = Schema.decodeUnknown(runtimePartSchema)
  const decodePartEither = Schema.decodeUnknownEither(runtimePartSchema)
  const validatePart = Schema.validate(runtimePartSchema)

  const parseData = (
    input: JsonValue,
  ): Effect.Effect<Part, ParseResult.ParseError> =>
    Schema.validate(runtimeInputSchema)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.flatMap((data) =>
        validatePart(
          {
            type: "data",
            name: definition.name,
            data: {
              schemaVersion: definition.version,
              ...data,
            },
          },
          { onExcessProperty: "error" },
        ),
      ),
    )

  const make = (input: Input): Part =>
    Schema.validateSync(runtimePartSchema)(
      {
        type: "data",
        name: definition.name,
        data: {
          schemaVersion: definition.version,
          ...input,
        },
      },
      { onExcessProperty: "error" },
    )

  return {
    name: definition.name,
    version: definition.version,
    inputSchema: definition.schema,
    dataSchema,
    partSchema,
    make,
    parseData,
    decode: (input: JsonValue) =>
      decodePart(input, { onExcessProperty: "error" }),
    decodeEither: (input: JsonValue) =>
      decodePartEither(input, { onExcessProperty: "error" }),
  }
}

import { Effect, Function as Fn, Result, Schema } from "effect"
import type { JsonValue } from "./json-value.js"

/** Stable machine-facing name for one structured chat view. */
export const ViewNameSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
)

/** Positive protocol version for one structured chat view. */
export const ViewVersionSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }),
)

/** Schema accepted at view boundaries without runtime services. */
export type ViewSchema = Schema.Codec<unknown, unknown, never, never>

/** Schema for one decoded view part correlated with its view data. */
export type ViewPartSchema<
  Name extends string = string,
  DataSchema extends ViewSchema = ViewSchema,
> = Schema.Codec<
  {
    readonly type: "data"
    readonly name: Name
    readonly data: Schema.Schema.Type<DataSchema>
  },
  unknown,
  never,
  never
>

/** Minimum runtime shape retained for every structured chat view. */
export interface ViewDefinitionContract<
  Name extends string = string,
  Version extends number = number,
  InputSchema extends ViewSchema = ViewSchema,
  DataSchema extends ViewSchema = ViewSchema,
  PartSchema extends ViewPartSchema<Name, DataSchema> = ViewPartSchema<
    Name,
    DataSchema
  >,
> {
  readonly name: Name
  readonly version: Version
  readonly inputSchema: InputSchema
  readonly dataSchema: DataSchema
  readonly partSchema: PartSchema

  /** Parse unknown application data into one display-safe data part. */
  parseData(
    input: ViewInput<this>,
  ): Effect.Effect<ViewPart<this>, Schema.SchemaError>

  /** Parse an unknown serialized part without requiring an Effect runtime. */
  decodeResult(
    input: JsonValue,
  ): Result.Result<ViewPart<this>, Schema.SchemaError>
}

/** Parsed data accepted when constructing one view part. */
export type ViewInput<View extends ViewDefinitionContract> =
  Schema.Schema.Type<View["inputSchema"]>

/** Versioned display data carried by one view part. */
export type ViewData<View extends ViewDefinitionContract> =
  Schema.Schema.Type<View["dataSchema"]>

/** Complete structured message part produced by one view. */
export type ViewPart<View extends ViewDefinitionContract> =
  Schema.Schema.Type<View["partSchema"]> & {
    readonly data: ViewData<View>
  }

/** One schema-defined, versioned structured chat view. */
export interface ViewDefinition<
  Name extends string,
  Version extends number,
  InputSchema extends ViewSchema,
  DataSchema extends ViewSchema,
  PartSchema extends ViewPartSchema<Name, DataSchema>,
> extends ViewDefinitionContract<
    Name,
    Version,
    InputSchema,
    DataSchema,
    PartSchema
  > {
  /** Construct and validate one display-safe data part. */
  make(
    input: Schema.Schema.Type<InputSchema>,
  ): Schema.Schema.Type<PartSchema>

  /** Parse unknown input into one display-safe data part. */
  parseData(
    input: ViewInput<this>,
  ): Effect.Effect<ViewPart<this>, Schema.SchemaError>

  /** Parse an unknown serialized part at a runtime boundary. */
  decode(
    input: JsonValue,
  ): Effect.Effect<ViewPart<this>, Schema.SchemaError>

  /** Parse an unknown serialized part without requiring an Effect runtime. */
  decodeResult(
    input: JsonValue,
  ): Result.Result<ViewPart<this>, Schema.SchemaError>
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
  | Schema.Struct.DecodingServices<Fields>
  | Schema.Struct.EncodingServices<Fields>,
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

  const dataSchema = Schema.Struct({
    schemaVersion: Schema.Literal(definition.version),
    ...definition.schema.fields,
  })
  const partSchema = Schema.Struct({
    type: Schema.Literal("data"),
    name: Schema.Literal(definition.name),
    data: dataSchema,
  })
  type Input = Schema.Schema.Type<typeof definition.schema>
  type Part = Schema.Schema.Type<typeof partSchema>
  // SAFETY: NoContextFields excludes schemas with runtime requirements; this
  // assertion preserves definition.schema's existing Type and Encoded sides.
  const runtimeInputSchema = Fn.cast<
    typeof definition.schema,
    Schema.Codec<
      Input,
      Schema.Codec.Encoded<typeof definition.schema>,
      never,
      never
    >
  >(definition.schema)
  // SAFETY: partSchema was built immediately above from the exact view name,
  // version, and application fields, with no runtime schema requirements.
  const runtimePartSchema = Fn.cast<
    typeof partSchema,
    Schema.Codec<
      Part,
      Schema.Codec.Encoded<typeof partSchema>,
      never,
      never
    >
  >(partSchema)
  const decodePart = Schema.decodeUnknownEffect(runtimePartSchema)
  const decodePartResult = Schema.decodeUnknownResult(runtimePartSchema)
  const validateInput = Schema.decodeUnknownEffect(
    Schema.toType(runtimeInputSchema),
  )
  const validatePart = Schema.decodeUnknownEffect(
    Schema.toType(runtimePartSchema),
  )

  const parseData = (
    input: Input,
  ): Effect.Effect<Part, Schema.SchemaError> =>
    validateInput(input, {
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
    Schema.decodeUnknownSync(Schema.toType(runtimePartSchema))(
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
    decodeResult: (input: JsonValue) =>
      decodePartResult(input, { onExcessProperty: "error" }),
  }
}

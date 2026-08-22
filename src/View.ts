/** Define one schema-validated browser view. */
export { defineView as define } from "./core/view.js"

export {
  ViewNameSchema as NameSchema,
  ViewVersionSchema as VersionSchema,
} from "./core/view.js"

export type {
  DefineViewInput as DefineInput,
  ViewData as Data,
  ViewDefinition as Definition,
  ViewDefinitionContract as DefinitionContract,
  ViewInput as Input,
  ViewPart as Part,
  ViewPartSchema as PartSchema,
  ViewSchema as Schema,
} from "./core/view.js"

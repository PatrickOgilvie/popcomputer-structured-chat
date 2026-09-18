import { Data, Schema } from "effect"

const QuestionTextSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
)

const QuestionGoalSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_000),
)

const ChoiceLabelSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
)

const ChoiceCountSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 20 }),
)

/** One application-authored question whose wording never changes. */
export interface FixedQuestion {
  readonly _tag: "FixedQuestion"
  readonly text: string
}

/** A goal from which a model may phrase one contextual question. */
export interface AdaptiveQuestion {
  readonly _tag: "AdaptiveQuestion"
  /** Model-facing phrasing goal; never shown to the user. */
  readonly goal: string
  /** User-facing question shown when no valid model wording is available. */
  readonly fallback: string
}

/** A contextual question with bounded model suggestions and safe fallbacks. */
export interface AdaptiveChoiceQuestion {
  readonly _tag: "AdaptiveChoiceQuestion"
  readonly prompt: string
  readonly minimumOptions: number
  readonly maximumOptions: number
  readonly fallbackOptions: ReadonlyArray<string>
}

/** One typed answer offered by an application-authored choice question. */
export interface QuestionChoice<Value> {
  readonly label: string
  readonly value: Value
}

/** A fixed question with typed suggestions; the answer schema defines all accepted values. */
export interface ChoiceQuestion<Value> {
  readonly _tag: "ChoiceQuestion"
  readonly text: string
  readonly options: readonly [
    QuestionChoice<Value>,
    ...ReadonlyArray<QuestionChoice<Value>>,
  ]
}

/** Question strategies supported by a collect stage. */
export type QuestionDefinition<Value = unknown> =
  | FixedQuestion
  | AdaptiveQuestion
  | (Value extends string ? AdaptiveChoiceQuestion : never)
  | ChoiceQuestion<Value>

/** Minimum runtime union retained for any typed question definition. */
export type QuestionDefinitionContract =
  | FixedQuestion
  | AdaptiveQuestion
  | AdaptiveChoiceQuestion
  | ChoiceQuestion<unknown>

interface QuestionConstructors extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum:
    | FixedQuestion
    | AdaptiveQuestion
    | AdaptiveChoiceQuestion
    | ChoiceQuestion<this["A"]>
}

const Definition = Data.taggedEnum<QuestionConstructors>()

const fixed = (text: string): FixedQuestion =>
  Definition.FixedQuestion({
    text: QuestionTextSchema.make(text),
  })

const adaptive = (
  goal: string,
  options: { readonly fallback: string },
): AdaptiveQuestion =>
  Definition.AdaptiveQuestion({
    goal: QuestionGoalSchema.make(goal),
    fallback: QuestionTextSchema.make(options.fallback),
  })

const adaptiveChoice = (
  prompt: string,
  options: {
    readonly minimumOptions: number
    readonly maximumOptions: number
    readonly fallbackOptions?: ReadonlyArray<string>
  },
): AdaptiveChoiceQuestion => {
  const minimumOptions = ChoiceCountSchema.make(options.minimumOptions)

  const maximumOptions = ChoiceCountSchema.make(options.maximumOptions)

  if (minimumOptions > maximumOptions) {
    throw new Error(
      "Adaptive choice minimumOptions cannot exceed maximumOptions",
    )
  }

  const fallbackOptions = (options.fallbackOptions ?? []).map((label) =>
    ChoiceLabelSchema.make(label),
  )

  const normalizedFallbacks = fallbackOptions.map((label) =>
    label.toLocaleLowerCase("en"),
  )

  if (new Set(normalizedFallbacks).size !== fallbackOptions.length) {
    throw new Error("Adaptive choice fallback options must be unique")
  }

  if (
    fallbackOptions.length > 0 &&
    (fallbackOptions.length < minimumOptions ||
      fallbackOptions.length > maximumOptions)
  ) {
    throw new Error(
      "Adaptive choice fallback options must satisfy the configured bounds",
    )
  }

  return Definition.AdaptiveChoiceQuestion({
    prompt: QuestionTextSchema.make(prompt),
    minimumOptions,
    maximumOptions,
    fallbackOptions,
  })
}

const choice = <
  const Options extends readonly [
    QuestionChoice<unknown>,
    ...ReadonlyArray<QuestionChoice<unknown>>,
  ],
>(
  text: string,
  options: Options,
): ChoiceQuestion<Options[number]["value"]> => {
  const firstOption = {
    ...options[0],
    label: ChoiceLabelSchema.make(options[0].label),
  }

  const remainingOptions = options.slice(1).map((option) => ({
    ...option,
    label: ChoiceLabelSchema.make(option.label),
  }))

  const normalized = [firstOption, ...remainingOptions].map(({ label }) =>
    label.toLocaleLowerCase("en"),
  )

  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Choice question labels must be unique")
  }

  return Definition.ChoiceQuestion({
    text: QuestionTextSchema.make(text),
    options: [firstOption, ...remainingOptions],
  })
}

/** Constructors for static, adaptive, and typed choice questions. */
export const Question = {
  fixed,
  adaptive,
  adaptiveChoice,
  choice,
} as const

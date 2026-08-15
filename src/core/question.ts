import { Schema } from "effect"

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

/** One application-authored question with a closed set of typed answers. */
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

const fixed = (text: string): FixedQuestion => ({
  _tag: "FixedQuestion",
  text: Schema.decodeSync(QuestionTextSchema)(text),
})

const adaptive = (
  goal: string,
  options: { readonly fallback: string },
): AdaptiveQuestion => ({
  _tag: "AdaptiveQuestion",
  goal: Schema.decodeSync(QuestionGoalSchema)(goal),
  fallback: Schema.decodeSync(QuestionTextSchema)(options.fallback),
})

const adaptiveChoice = (
  prompt: string,
  options: {
    readonly minimumOptions: number
    readonly maximumOptions: number
    readonly fallbackOptions?: ReadonlyArray<string>
  },
): AdaptiveChoiceQuestion => {
  const minimumOptions = Schema.decodeSync(ChoiceCountSchema)(
    options.minimumOptions,
  )
  const maximumOptions = Schema.decodeSync(ChoiceCountSchema)(
    options.maximumOptions,
  )
  if (minimumOptions > maximumOptions) {
    throw new Error(
      "Adaptive choice minimumOptions cannot exceed maximumOptions",
    )
  }
  const fallbackOptions = (options.fallbackOptions ?? []).map((label) =>
    Schema.decodeSync(ChoiceLabelSchema)(label),
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

  return {
    _tag: "AdaptiveChoiceQuestion",
    prompt: Schema.decodeSync(QuestionTextSchema)(prompt),
    minimumOptions,
    maximumOptions,
    fallbackOptions,
  }
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
    label: Schema.decodeSync(ChoiceLabelSchema)(options[0].label),
  }
  const remainingOptions = options.slice(1).map((option) => ({
    ...option,
    label: Schema.decodeSync(ChoiceLabelSchema)(option.label),
  }))
  const normalized = [firstOption, ...remainingOptions].map(({ label }) =>
    label.toLocaleLowerCase("en"),
  )
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Choice question labels must be unique")
  }

  return {
    _tag: "ChoiceQuestion",
    text: Schema.decodeSync(QuestionTextSchema)(text),
    options: [firstOption, ...remainingOptions],
  }
}

/** Constructors for static, adaptive, and typed choice questions. */
export const Question = {
  fixed,
  adaptive,
  adaptiveChoice,
  choice,
} as const

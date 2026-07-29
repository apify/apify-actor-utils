/**
 * An array of `T` guaranteed to hold at least one element.
 *
 * Modelled as a tuple with a required head and a variadic tail (`[T, ...T[]]`),
 * so the compiler knows `list[0]` always exists and treats it as `T` rather
 * than `T | undefined`. Narrow a plain `T[]` to this with {@link isNonEmptyList}.
 *
 * @example
 * ```ts
 * function first<T>(list: NonEmptyList<T>): T {
 *     return list[0]; // safe: no undefined
 * }
 * ```
 */
export type NonEmptyList<T> = [T, ...T[]];

/**
 * Type guard that narrows an array to a {@link NonEmptyList} when it holds at
 * least one element.
 *
 * Use it to let the compiler know `list[0]` is safe to access after the check,
 * without a non-null assertion.
 *
 * @param list - The array to check.
 * @returns `true` if `list` has at least one element, narrowing it to
 * `NonEmptyList<T>`.
 *
 * @example
 * ```ts
 * const items: number[] = getItems();
 *
 * if (isNonEmptyList(items)) {
 *     const first = items[0]; // typed as number, not number | undefined
 * }
 * ```
 */
export function isNonEmptyList<T>(list: T[]): list is NonEmptyList<T> {
    return Boolean(list.length);
}

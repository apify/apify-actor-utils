export type Falsy = false | 0 | '' | null | undefined;
export type Nullish = null | undefined;

/**
 * Narrows `T` to only its truthy members by stripping every {@link Falsy}
 * value (`false`, `0`, `''`, `null`, `undefined`).
 *
 * Unlike `Exclude<T, Falsy>`, this checks each falsy literal individually so a
 * broad type such as `boolean` or `number` is preserved rather than collapsed:
 * `boolean` only loses `false` if `false` is the whole type, not when it's part
 * of `boolean`. Object types short-circuit first, so `''`/`0` don't accidentally
 * match structural (`{}`) types.
 *
 * @example
 * ```ts
 * type A = Truthy<string | undefined>;   // string
 * type B = Truthy<0 | 1 | 2>;            // 1 | 2
 * type C = Truthy<'' | 'hello'>;         // 'hello'
 * type D = Truthy<false>;                // never
 * ```
 */
export type Truthy<T> =
    // clause to catch "" extending {}
    T extends object
        ? T
        : false extends T
          ? never
          : 0 extends T
            ? never
            : '' extends T
              ? never
              : null extends T
                ? never
                : undefined extends T
                  ? never
                  : T;

export type Defined<T> = Exclude<T, Nullish>;

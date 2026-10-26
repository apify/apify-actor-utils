/**
 * A `Type` distinguished from other values of the same type by a compile-time
 * string label. The brand does not add a property to the value at runtime.
 *
 * @example
 * ```ts
 * type UserId = Branded<string, 'UserId'>;
 *
 * function isUserId(value: string): value is UserId {
 *     return value.startsWith('user-');
 * }
 * ```
 */
export type Branded<Type, Brand extends string> = Type & { __brand: Brand };

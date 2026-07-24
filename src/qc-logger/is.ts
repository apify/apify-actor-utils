import type { Defined, Falsy, Nullish, Truthy } from '../type-utils/types.js';
import { type Ctx, emit } from './structured-logger.js';

/**
 * Checks for falsy values and logs a `warning` when they are.
 *
 * Sample usage:
 * ```ts
 * if (isFalsy(someValue, "my-key-here")) {
 *     // someValue is falsy, warning gets logged `qc:is:falsy:my-key-here`
 *     return; // do my early return
 * }
 * ```
 *
 * The overloads narrow the return type based on what's statically known about
 * `value`: a {@link Truthy} input returns the literal `false`, a {@link Falsy}
 * input returns the literal `true`, and only genuinely uncertain values get the
 * `value is Falsy & T` type guard. This means a redundant call — e.g.
 * `isFalsy` on something the compiler already knows is truthy — produces a
 * branch whose condition is a constant.
 *
 * Enable the `@typescript-eslint/no-unnecessary-condition` rule to have that
 * surfaced as a lint error instead of a silent dead branch. The rule ships with
 * both [typescript-eslint](https://typescript-eslint.io/rules/no-unnecessary-condition/)
 * and [oxlint](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html)
 * (note: it requires type-aware linting).
 */
export function isFalsy<T>(value: Truthy<T>, key: string, ctx?: Ctx): false;
export function isFalsy(value: Falsy, key: string, ctx?: Ctx): true;
export function isFalsy<T>(value: T, key: string, ctx?: Ctx): value is Falsy & T;
export function isFalsy<T>(value: T, key: string, ctx?: Ctx): value is Falsy & T {
    const result = !value;
    if (result) emit('warning', 'is:falsy', key, ctx);
    return result;
}

/**
 * Checks for truthy values and logs a `warning` when they are — the
 * inverse of {@link isFalsy}.
 *
 * Sample usage:
 * ```ts
 * if (isTruthy(someValue, "my-key-here")) {
 *     // someValue is truthy, warning gets logged `qc:is:truthy:my-key-here`
 *     return someValue; // do my early return
 * }
 * // fallback behavior here
 * ```
 *
 * Mirroring {@link isFalsy}, the overloads narrow the return type based on what's
 * statically known about `value`: a {@link Falsy} input returns the literal
 * `false`, a {@link Truthy} input returns the literal `true`, and only genuinely
 * uncertain values get the `value is Truthy<T>` type guard. A redundant call —
 * e.g. `isTruthy` on something the compiler already knows is falsy — produces a
 * branch whose condition is a constant.
 *
 * Enable the `@typescript-eslint/no-unnecessary-condition` rule to have that
 * surfaced as a lint error instead of a silent dead branch. The rule ships with
 * both [typescript-eslint](https://typescript-eslint.io/rules/no-unnecessary-condition/)
 * and [oxlint](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html)
 * (note: it requires type-aware linting).
 */
export function isTruthy(value: Falsy, key: string, ctx?: Ctx): false;
export function isTruthy<T>(value: Truthy<T>, key: string, ctx?: Ctx): true;
export function isTruthy<T>(value: T, key: string, ctx?: Ctx): value is Truthy<T>;
export function isTruthy<T>(value: T, key: string, ctx?: Ctx): value is Truthy<T> {
    const result = Boolean(value);
    if (result) emit('warning', 'is:truthy', key, ctx);
    return result;
}

/**
 * Checks for `null | undefined` values and logs a `warning` when they are.
 * Unlike {@link isFalsy}, `0`, `false`, and `""` are not considered a match.
 *
 * Sample usage:
 * ```ts
 * if (isNullish(someValue, "my-key-here")) {
 *     // someValue is null or undefined, warning gets logged `qc:is:nullish:my-key-here`
 *     return; // do my early return
 * }
 * // keep on truckin'
 * ```
 *
 * Like {@link isFalsy}, the overloads narrow the return type based on what's
 * statically known about `value`: a {@link Defined} input returns the literal
 * `false`, a {@link Nullish} input returns the literal `true`, and only
 * genuinely uncertain values get the `value is Nullish & T` type guard. A
 * redundant call — e.g. `isNullish` on something the compiler already knows is
 * defined — produces a branch whose condition is a constant.
 *
 * Enable the `@typescript-eslint/no-unnecessary-condition` rule to have that
 * surfaced as a lint error instead of a silent dead branch. The rule ships with
 * both [typescript-eslint](https://typescript-eslint.io/rules/no-unnecessary-condition/)
 * and [oxlint](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html)
 * (note: it requires type-aware linting).
 */
export function isNullish<T>(value: Defined<T>, key: string, ctx?: Ctx): false;
export function isNullish(value: Nullish, key: string, ctx?: Ctx): true;
export function isNullish<T>(value: T, key: string, ctx?: Ctx): value is Nullish & T;
export function isNullish<T>(value: T, key: string, ctx?: Ctx): value is Nullish & T {
    const result = value === undefined || value === null;
    if (result) emit('warning', 'is:nullish', key, ctx);
    return result;
}

/**
 * Checks that a value is neither `null` nor `undefined` and logs a
 * `warning` when that's the case — the inverse of {@link isNullish}.
 *
 * Sample usage:
 * ```ts
 * if (isDefined(someValue, "my-key-here")) {
 *     // someValue is neither null nor undefined, warning gets logged `qc:is:defined:my-key-here`
 *     return; // do my early return
 * }
 * ```
 *
 * Like {@link isFalsy}, the overloads narrow the return type based on what's
 * statically known about `value`: a {@link Nullish} input returns the literal
 * `false`, a {@link Defined} input returns the literal `true`, and only
 * genuinely uncertain values get the `value is Defined<T>` type guard. A
 * redundant call — e.g. `isDefined` on something the compiler already knows is
 * defined — produces a branch whose condition is a constant.
 *
 * Enable the `@typescript-eslint/no-unnecessary-condition` rule to have that
 * surfaced as a lint error instead of a silent dead branch. The rule ships with
 * both [typescript-eslint](https://typescript-eslint.io/rules/no-unnecessary-condition/)
 * and [oxlint](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html)
 * (note: it requires type-aware linting).
 */
export function isDefined(value: Nullish, key: string, ctx?: Ctx): false;
export function isDefined<T>(value: Defined<T>, key: string, ctx?: Ctx): true;
export function isDefined<T>(value: T, key: string, ctx?: Ctx): value is Defined<T>;
export function isDefined<T>(value: T, key: string, ctx?: Ctx): value is Defined<T> {
    const result = value !== undefined && value !== null;
    if (result) emit('warning', 'is:defined', key, ctx);
    return result;
}

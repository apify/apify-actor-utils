import { type Ctx, emit, formatMessage } from './structured-logger.js';

/**
 * Glorified assertion that also logs at `error` level. Throws a plain `Error`
 * by default; pass e.g. Crawlee's `NonRetryableError` or `CriticalError` to
 * control what the failure means to the crawler.
 *
 *
 * ```ts
 * const someEnvVar = process.env.SOME_ENV_VAR; // string | undefined
 * assert(typeof someEnvVar === "string", "some-env-var");
 * // someEnvVar is now guaranteed to be a `string`, unless the assertion fails.
 * assert(someEnvVar, "some-env-var");
 * // someEnvVar is now guaranteed to be a truthy `string` (non-empty), unless the assertion fails.
 * ```
 */
export function assert(
    cond: unknown,
    key: string,
    ctx?: Ctx,
    ErrorCtor: new (message: string) => Error = Error,
): asserts cond {
    if (cond) return;
    const error = new ErrorCtor(formatMessage('assert', key));
    emit('error', 'assert', key, { ...ctx, name: error.name, stack: error.stack });
    throw error;
}

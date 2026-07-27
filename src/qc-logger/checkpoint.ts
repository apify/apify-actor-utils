import { type Ctx, emit } from './structured-logger.js';

/**
 * Logs an `info`-level checkpoint marking that a point in the run was reached.
 * Unlike the `is*` predicates or {@link assert}, this has no condition — it
 * always emits — so it's meant for tracing progress through a run.
 *
 * @param key - Identifies the checkpoint; emitted as `qc:checkpoint:<key>`.
 * @param ctx - Optional extra fields to attach to the log line.
 *
 * @example
 * ```ts
 * checkpoint("started");
 * // logs `qc:checkpoint:started`
 *
 * await doWork();
 * checkpoint("work-done", { itemsProcessed: 42 });
 * // logs `qc:checkpoint:work-done` with { itemsProcessed: 42 }
 * ```
 */
export function checkpoint(key: string, ctx?: Ctx): void {
    emit('info', 'checkpoint', key, ctx);
}

/**
 * Conditionally logs an `info`-level checkpoint — only when `cond` is truthy.
 * A convenience wrapper over {@link checkpoint} for guarding a marker behind a
 * condition without an explicit `if` at the call site.
 *
 * @param cond - The condition; the checkpoint is emitted only when it's truthy.
 * @param key - Identifies the checkpoint; emitted as `qc:checkpoint:<key>`.
 * @param ctx - Optional extra fields to attach to the log line.
 *
 * @example
 * ```ts
 * checkpointIf(items.length === 0, "empty-batch");
 * // logs `qc:checkpoint:empty-batch` only when the batch is empty
 *
 * checkpointIf(retries > 3, "many-retries", { retries });
 * // logs `qc:checkpoint:many-retries` with { retries } only past the threshold
 * ```
 */
export function checkpointIf(cond: unknown, key: string, ctx?: Ctx): void {
    if (cond) checkpoint(key, ctx);
}

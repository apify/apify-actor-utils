// Apify SDK is imported lazily inside the default `pushFn` / log path so
// that this module can be imported (and unit-tested) without it installed.
// Override `pushFn` / `logger` to bypass the import entirely.

/**
 * Wrapper around Actor.pushData that survives dataset-schema validation
 * failures. The Apify API rejects the *entire* push request when any item
 * in the batch fails JSON-schema validation, which means a single bad row
 * coming from an upstream data source can take the whole batch down.
 *
 * safePushData parses the schema-validation error returned by the API,
 * either drops the offending items or strips the offending fields, then
 * retries with the cleaned batch.
 *
 * Error shape returned by the API (ApifyApiError):
 *   {
 *     statusCode: 400,
 *     type: 'schema-validation-error',
 *     message: 'Schema validation failed',
 *     data: {
 *       invalidItems: [
 *         {
 *           itemPosition: <index in submitted array>,
 *           validationErrors: [<AJV error>...]
 *         }
 *       ]
 *     }
 *   }
 *
 * Each AJV error has at least: { instancePath, schemaPath, keyword, params, message }.
 */

const SCHEMA_ERROR_TYPE = 'schema-validation-error';

async function defaultLogger() {
    try {
        const { log } = await import('apify');
        return log;
    } catch {
        return {
            warning: (msg) => console.warn(msg),
            error: (msg) => console.error(msg),
        };
    }
}

/**
 * @param {unknown} err
 * @returns {err is { type: string, statusCode: number, data: { invalidItems: Array<{ itemPosition: number, validationErrors: Array<object> }> } }}
 */
export function isSchemaValidationError(err) {
    if (!err || typeof err !== 'object') return false;
    // ApifyApiError exposes both `type` and `statusCode` directly.
    if (err.type !== SCHEMA_ERROR_TYPE) return false;
    if (err.statusCode !== 400) return false;
    return Array.isArray(err.data?.invalidItems);
}

/**
 * Parse a JSON Pointer (RFC 6901) into an array of decoded path segments.
 * "" -> []; "/foo/bar" -> ["foo", "bar"]; "/tags/0" -> ["tags", "0"].
 */
function parseJsonPointer(pointer) {
    if (!pointer) return [];
    return pointer
        .split('/')
        .slice(1)
        .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Delete the value at `path` inside `obj`. No-op if the path doesn't exist.
 * Arrays: removes the element with splice (shifts later indices).
 */
function deleteAtPath(obj, path) {
    if (path.length === 0) return false;
    let cursor = obj;
    for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        if (cursor == null || typeof cursor !== 'object') return false;
        cursor = Array.isArray(cursor) ? cursor[Number(key)] : cursor[key];
    }
    if (cursor == null || typeof cursor !== 'object') return false;
    const last = path[path.length - 1];
    if (Array.isArray(cursor)) {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) return false;
        cursor.splice(idx, 1);
        return true;
    }
    if (Object.prototype.hasOwnProperty.call(cursor, last)) {
        delete cursor[last];
        return true;
    }
    return false;
}

/**
 * Try to clean a single item given its AJV validation errors.
 *
 * Strategy:
 *  - `required` at root path: the item is missing a required property. We
 *    cannot fabricate it, so the item is unfixable -> return null.
 *  - `additionalProperties`: delete the unknown property.
 *  - any other keyword (`type`, `enum`, `minLength`, `format`, ...): delete
 *    the offending field. If the schema later marks that field as required,
 *    a follow-up `required` error will surface on the next attempt and the
 *    item will be dropped then.
 *
 * Returns the cleaned item or null when the item cannot be salvaged.
 */
function cleanItemFields(item, validationErrors) {
    // structuredClone keeps us from mutating the caller's data.
    const cloned = structuredClone(item);

    for (const err of validationErrors) {
        const path = parseJsonPointer(err.instancePath || '');

        // Errors whose instancePath is the root of the item describe a
        // problem with the item as a whole. For `required` we have no
        // way to invent a value, so the item is unsalvageable.
        if (path.length === 0) {
            if (err.keyword === 'required') return null;
            if (err.keyword === 'additionalProperties' && err.params?.additionalProperty) {
                delete cloned[err.params.additionalProperty];
                continue;
            }
            if (err.keyword === 'type') {
                // The whole item is the wrong type (e.g., not an object). Unfixable.
                return null;
            }
            // Any other root-level keyword we don't recognise -> drop to be safe.
            return null;
        }

        // additionalProperties errors point at the parent object, with the
        // offending key in params.additionalProperty.
        if (err.keyword === 'additionalProperties' && err.params?.additionalProperty) {
            deleteAtPath(cloned, [...path, err.params.additionalProperty]);
            continue;
        }

        deleteAtPath(cloned, path);
    }

    return cloned;
}

/**
 * @typedef {object} SafePushDataOptions
 * @property {'drop' | 'cleanFields'} [strategy='drop']
 *   `drop`         - remove invalid items, push the rest.
 *   `cleanFields`  - try to delete offending fields from each invalid item
 *                    and push the cleaned version. Items that can't be
 *                    cleaned (missing required field, wrong root type) are
 *                    still dropped.
 * @property {number} [maxAttempts=5]
 *   Hard ceiling on retries. The API returns all invalid items in one shot,
 *   so a healthy run resolves in 1 retry; higher values are insurance against
 *   pathological schemas (e.g. fields whose deletion exposes another error).
 * @property {(invalid: Array<{ item: unknown, errors: Array<object> }>) => Promise<void> | void} [onDropped]
 *   Called with the items that ended up being dropped (after cleaning, if
 *   any). Useful for archiving to a side dataset / key-value store.
 * @property {boolean} [silent=false] - suppress logs (overrides logger).
 * @property {(items: Array<unknown>) => Promise<unknown>} [pushFn]
 *   Override the push call. Defaults to `Actor.pushData`. Pass a custom
 *   function to push to a non-default dataset, or for unit testing.
 *   Example: `pushFn: (items) => client.dataset(id).pushItems(items)`.
 * @property {{ warning?: Function, error?: Function }} [logger]
 *   Override the logger. Defaults to Apify SDK's `log` if available, else console.
 */

/**
 * @typedef {object} SafePushDataResult
 * @property {number} pushed   Number of items successfully sent to the dataset.
 * @property {Array<{ item: unknown, errors: Array<object> }>} dropped
 *   Items that could not be pushed (either because the strategy is `drop`
 *   and they were invalid, or because `cleanFields` couldn't fix them).
 * @property {Array<{ item: unknown, errors: Array<object> }>} cleaned
 *   Items that were modified before being pushed (only populated when
 *   strategy === 'cleanFields').
 * @property {number} attempts Number of pushData calls made.
 */

/**
 * Push items to the default dataset, surviving schema validation failures.
 *
 * @param {unknown | Array<unknown>} input - single item or array of items.
 * @param {SafePushDataOptions} [options]
 * @returns {Promise<SafePushDataResult>}
 */
export async function safePushData(input, options = {}) {
    const {
        strategy = 'drop',
        maxAttempts = 5,
        onDropped,
        silent = false,
        pushFn,
        logger,
    } = options;

    const effectivePushFn = pushFn ?? (async (batch) => {
        const { Actor } = await import('apify');
        return Actor.pushData(batch);
    });
    const effectiveLogger = logger ?? (silent ? null : await defaultLogger());

    const items = Array.isArray(input) ? [...input] : [input];
    const dropped = [];
    // `cleaned` records the cumulative AJV errors per original item that we
    // attempted to clean. Indexed by original-item reference so the same item
    // cleaned across multiple attempts produces a single entry.
    const cleanedByOriginal = new Map();

    // We track the items still pending push, plus the original input
    // they correspond to so we can return useful diagnostics.
    let pending = items.map((item) => ({ original: item, current: item }));
    let attempts = 0;

    let pushedCount = 0;

    while (pending.length > 0 && attempts < maxAttempts) {
        attempts++;
        try {
            await effectivePushFn(pending.map((p) => p.current));
            pushedCount = pending.length;
            pending = [];
            break;
        } catch (err) {
            if (!isSchemaValidationError(err)) throw err;

            const errorsByPosition = new Map();
            for (const invalid of err.data.invalidItems) {
                errorsByPosition.set(invalid.itemPosition, invalid.validationErrors);
            }

            const next = [];
            for (let i = 0; i < pending.length; i++) {
                const entry = pending[i];
                const validationErrors = errorsByPosition.get(i);

                if (!validationErrors) {
                    // Item is valid — keep it for the next push.
                    next.push(entry);
                    continue;
                }

                if (strategy === 'drop') {
                    dropped.push({ item: entry.original, errors: validationErrors });
                    continue;
                }

                // cleanFields strategy
                const cleanedItem = cleanItemFields(entry.current, validationErrors);
                if (cleanedItem === null) {
                    // Could not salvage; if we already counted it as cleaned in
                    // an earlier round, drop that bookkeeping too — it ended up
                    // discarded.
                    cleanedByOriginal.delete(entry.original);
                    dropped.push({ item: entry.original, errors: validationErrors });
                    continue;
                }
                const existing = cleanedByOriginal.get(entry.original);
                cleanedByOriginal.set(entry.original, {
                    item: entry.original,
                    errors: existing ? [...existing.errors, ...validationErrors] : [...validationErrors],
                });
                next.push({ original: entry.original, current: cleanedItem });
            }

            effectiveLogger?.warning?.(
                `safePushData: schema validation failed on attempt ${attempts}: `
                + `${err.data.invalidItems.length} invalid item(s); `
                + `retrying with ${next.length} item(s).`,
            );

            // Guard against an infinite loop if cleaning didn't change anything
            // (shouldn't happen with the above logic, but be defensive).
            if (next.length === pending.length
                && next.every((entry, i) => entry.current === pending[i].current)) {
                effectiveLogger?.error?.('safePushData: no progress after cleaning; aborting.');
                for (const entry of next) {
                    dropped.push({
                        item: entry.original,
                        errors: errorsByPosition.get(pending.indexOf(entry)) || [],
                    });
                }
                pending = [];
                break;
            }

            pending = next;
        }
    }

    if (pending.length > 0) {
        // We've exhausted maxAttempts and still have items. They get reported
        // as dropped so the caller can decide what to do.
        effectiveLogger?.error?.(
            `safePushData: gave up after ${attempts} attempts with ${pending.length} item(s) still failing.`,
        );
        for (const entry of pending) {
            dropped.push({ item: entry.original, errors: [] });
        }
    }

    if (dropped.length > 0 && onDropped) {
        await onDropped(dropped);
    }

    return {
        pushed: pushedCount,
        dropped,
        cleaned: [...cleanedByOriginal.values()],
        attempts,
    };
}

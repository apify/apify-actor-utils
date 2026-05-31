/**
 * Wrapper around a dataset push call that survives JSON-schema validation
 * failures. The Apify API rejects the *entire* push request when any item
 * in the batch fails validation, so a single bad row from an upstream
 * source can take down the whole batch. safePushData parses the schema
 * error, strips the offending fields (or array elements) from each bad
 * item, and retries.
 *
 * Error shape returned by the API (ApifyApiError):
 *   {
 *     statusCode: 400,
 *     type: 'schema-validation-error',
 *     message: 'Schema validation failed',
 *     data: {
 *       invalidItems: [
 *         { itemPosition: <index>, validationErrors: [<AJV error>...] }
 *       ]
 *     }
 *   }
 *
 * Each AJV error has at least: { instancePath, schemaPath, keyword, params, message }.
 */

const SCHEMA_ERROR_TYPE = 'schema-validation-error';

export function isSchemaValidationError(err) {
    if (!err || typeof err !== 'object') return false;
    if (err.type !== SCHEMA_ERROR_TYPE) return false;
    if (err.statusCode !== 400) return false;
    return Array.isArray(err.data?.invalidItems);
}

// Parse a JSON Pointer (RFC 6901) into decoded segments.
// "" -> []; "/foo/bar" -> ["foo","bar"]; "/tags/0" -> ["tags","0"].
function parseJsonPointer(pointer) {
    if (!pointer) return [];
    return pointer
        .split('/')
        .slice(1)
        .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// Delete the value at `path` inside `obj`. Arrays: splice the element.
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
 * Try to clean a single item given its AJV errors:
 *  - `required` at root: can't fabricate the value -> null (drop).
 *  - `additionalProperties`: delete the unknown property.
 *  - any other keyword (`type`, `enum`, `minLength`, `format`, ...):
 *    delete the offending field / array element.
 *
 * Returns the cleaned item or null when unsalvageable.
 */
function cleanItemFields(item, validationErrors) {
    const cloned = structuredClone(item);

    for (const err of validationErrors) {
        const path = parseJsonPointer(err.instancePath || '');

        if (path.length === 0) {
            if (err.keyword === 'required') return null;
            if (err.keyword === 'additionalProperties' && err.params?.additionalProperty) {
                delete cloned[err.params.additionalProperty];
                continue;
            }
            if (err.keyword === 'type') return null;
            return null;
        }

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
 * @property {(items: Array<unknown>) => Promise<unknown>} pushFn
 *   Required. Function that actually pushes the batch (e.g.
 *   `(b) => Actor.pushData(b)` or `(b) => client.dataset(id).pushItems(b)`).
 * @property {number} [maxAttempts=5]
 */

/**
 * Push items to a dataset, surviving schema validation failures by stripping
 * invalid fields and retrying. Accepts a single item or array.
 *
 * The retry loop is necessary: deleting a field to fix a `type`/`enum`/etc.
 * error can expose a `required` error on the same field on the next push,
 * which the first response couldn't have told us about. Each round of
 * cleaning may surface the next layer of errors, so we loop until the push
 * succeeds, every remaining item is unsalvageable, or maxAttempts is hit.
 *
 * Returns { pushed, dropped, attempts }.
 */
export async function safePushData(input, options) {
    const { pushFn, maxAttempts = 5 } = options;
    if (typeof pushFn !== 'function') {
        throw new TypeError('safePushData: options.pushFn is required');
    }

    const items = Array.isArray(input) ? [...input] : [input];
    const dropped = [];
    let pending = items.map((item) => ({ original: item, current: item }));
    let attempts = 0;
    let pushedCount = 0;

    while (pending.length > 0 && attempts < maxAttempts) {
        attempts++;
        try {
            await pushFn(pending.map((p) => p.current));
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
                    next.push(entry);
                    continue;
                }

                const cleanedItem = cleanItemFields(entry.current, validationErrors);
                if (cleanedItem === null) {
                    dropped.push({ item: entry.original, errors: validationErrors });
                    continue;
                }
                next.push({ original: entry.original, current: cleanedItem });
            }

            console.log(
                `safePushData: schema validation failed on attempt ${attempts}: `
                + `${err.data.invalidItems.length} invalid item(s); `
                + `retrying with ${next.length} item(s).`,
            );

            pending = next;
        }
    }

    if (pending.length > 0) {
        console.log(
            `safePushData: gave up after ${attempts} attempts with ${pending.length} item(s) still failing.`,
        );
        for (const entry of pending) {
            dropped.push({ item: entry.original, errors: [] });
        }
    }

    return { pushed: pushedCount, dropped, attempts };
}

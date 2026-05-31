// safePushData: parse the Apify dataset schema-validation error, strip the
// offending fields from each invalid item, and retry the push.

const SCHEMA_ERROR_TYPE = 'schema-validation-error';

// One AJV error in the API response. The keyword + instancePath pair tells
// us what's wrong and where; params holds keyword-specific extras
// (e.g. { missingProperty: 'name' } for `required`).
export interface ValidationError {
    instancePath: string;
    schemaPath?: string;
    keyword: string;
    params?: Record<string, unknown>;
    message?: string;
}

interface InvalidItem {
    itemPosition: number;
    validationErrors: ValidationError[];
}

// Shape of ApifyApiError when a push hits schema validation. The full
// envelope is documented at:
// https://docs.apify.com/platform/actors/development/actor-definition/dataset-schema/validation
interface SchemaValidationError {
    type: typeof SCHEMA_ERROR_TYPE;
    statusCode: 400;
    message: string;
    data: { invalidItems: InvalidItem[] };
}

export function isSchemaValidationError(err: unknown): err is SchemaValidationError {
    if (!err || typeof err !== 'object') return false;
    const e = err as Partial<SchemaValidationError>;
    if (e.type !== SCHEMA_ERROR_TYPE) return false;
    if (e.statusCode !== 400) return false;
    return Array.isArray(e.data?.invalidItems);
}

export interface DroppedItem<T> {
    item: T;
    errors: ValidationError[];
}

export interface SafePushDataResult<T> {
    pushed: number;
    dropped: DroppedItem<T>[];
    attempts: number;
}

export interface SafePushDataOptions {
    maxAttempts?: number;
}

export type PushFn<T> = (items: T[]) => Promise<unknown>;

/**
 * Push `input` via `pushFn`, surviving Apify dataset schema-validation
 * failures by cleaning offending items and retrying.
 *
 * `pushFn` is mandatory and intentionally not bundled — a CI check forbids
 * direct `.pushData()` calls in this library, so the binding lives at the
 * call site: `(b) => Actor.pushData(b)` or
 * `(b) => client.dataset(id).pushItems(b)`.
 */
export async function safePushData<T>(
    pushFn: PushFn<T>,
    input: T | T[],
    options: SafePushDataOptions = {},
): Promise<SafePushDataResult<T>> {
    const items = Array.isArray(input) ? input : [input];

    // Happy path: assume validation will succeed (the overwhelmingly common
    // case). No working copies, no maps, no per-item wrapper objects — just
    // hand the caller's array to pushFn and return on success.
    try {
        await pushFn(items);
        return { pushed: items.length, dropped: [], attempts: 1 };
    } catch (err) {
        if (!isSchemaValidationError(err)) throw err;
        return cleanAndRetry(pushFn, items, err, options.maxAttempts ?? 5);
    }
}

async function cleanAndRetry<T>(
    pushFn: PushFn<T>,
    originalItems: readonly T[],
    initialError: SchemaValidationError,
    maxAttempts: number,
): Promise<SafePushDataResult<T>> {
    // working[i] is what we'll send on the next push. We mutate this array
    // in place (splicing drops, replacing cleaned entries); the caller's
    // `originalItems` is never touched.
    const working: T[] = originalItems.slice();
    // Parallel to `working`. Holds the original (untouched) reference so a
    // dropped report shows what the caller actually passed in, even if the
    // item was partially cleaned before being dropped on a later round.
    const originalAt: T[] = originalItems.slice();
    const dropped: DroppedItem<T>[] = [];
    let attempts = 1;
    let lastError: SchemaValidationError = initialError;

    while (true) {
        // Apply this round's errors. Process highest position first so the
        // splices below don't shift positions we still need to look at.
        const invalids = lastError.data.invalidItems
            .slice()
            .sort((a, b) => b.itemPosition - a.itemPosition);

        for (const invalid of invalids) {
            const i = invalid.itemPosition;
            const cleaned = cleanItemFields(working[i], invalid.validationErrors);
            if (cleaned === null) {
                dropped.push({ item: originalAt[i], errors: invalid.validationErrors });
                working.splice(i, 1);
                originalAt.splice(i, 1);
            } else {
                working[i] = cleaned;
            }
        }

        console.log(
            `safePushData: schema validation failed on attempt ${attempts}: `
            + `${lastError.data.invalidItems.length} invalid item(s); `
            + `retrying with ${working.length} item(s).`,
        );

        if (working.length === 0) {
            return { pushed: originalItems.length - dropped.length, dropped, attempts };
        }

        attempts++;
        if (attempts > maxAttempts) {
            console.log(
                `safePushData: gave up after ${maxAttempts} attempts with ${working.length} item(s) still failing.`,
            );
            for (let i = 0; i < working.length; i++) {
                dropped.push({ item: originalAt[i], errors: [] });
            }
            return { pushed: originalItems.length - dropped.length, dropped, attempts: maxAttempts };
        }

        try {
            await pushFn(working);
            return { pushed: originalItems.length - dropped.length, dropped, attempts };
        } catch (err) {
            if (!isSchemaValidationError(err)) throw err;
            lastError = err;
        }
    }
}

// Try to repair a single item given its AJV errors. Returns null when the
// item can't be salvaged (missing required field, wrong root type) — the
// caller then drops it.
function cleanItemFields<T>(item: T, validationErrors: ValidationError[]): T | null {
    // structuredClone so we never mutate the caller's data.
    const cloned = structuredClone(item) as T;

    for (const err of validationErrors) {
        const path = parseJsonPointer(err.instancePath || '');

        // Root-level errors describe the item as a whole.
        if (path.length === 0) {
            // We have no value to invent for a missing required field.
            if (err.keyword === 'required') return null;
            // Strip an unknown property reported at the root.
            if (err.keyword === 'additionalProperties'
                && typeof err.params?.additionalProperty === 'string') {
                delete (cloned as Record<string, unknown>)[err.params.additionalProperty];
                continue;
            }
            // type/format/etc. at the root means the item itself is the wrong shape.
            return null;
        }

        // additionalProperties errors point at the *parent* object; the
        // offending key is in params, not instancePath.
        if (err.keyword === 'additionalProperties'
            && typeof err.params?.additionalProperty === 'string') {
            deleteAtPath(cloned, [...path, err.params.additionalProperty]);
            continue;
        }

        // Any other keyword (type/enum/minLength/format/...): delete the
        // offending field. If the schema declares it required, the next push
        // will surface a `required` error and the item will be dropped then.
        deleteAtPath(cloned, path);
    }

    return cloned;
}

// Parse a JSON Pointer (RFC 6901) into decoded segments.
// "" -> []; "/foo/bar" -> ["foo","bar"]; "/tags/0" -> ["tags","0"].
function parseJsonPointer(pointer: string): string[] {
    if (!pointer) return [];
    return pointer
        .split('/')
        .slice(1)
        .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

// Delete the value at `path` inside `obj`. Arrays splice (so later
// `/tags/N` errors in the same round line up with their original indices).
function deleteAtPath(obj: unknown, path: string[]): boolean {
    if (path.length === 0) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any = obj;
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

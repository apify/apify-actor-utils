// safePushData: parse the Apify dataset schema-validation error, repair the
// offending items (strip bad fields, placeholder missing required ones), and
// retry the push.

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
        // Clamp to >=1: the initial push above always counts as one attempt,
        // so 0/negative would make the reported `attempts` lie about it.
        return cleanAndRetry(pushFn, items, err, Math.max(1, options.maxAttempts ?? 5));
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
    // Parallel to `working`. Tracks which paths inside each item are
    // placeholders we set (vs. real user data). Needed so we can chase
    // follow-up type/minLength/enum errors on the placeholder field
    // without looping forever; for user-supplied fields the existing
    // "delete the field" behaviour stays in effect.
    const placeholderPaths: Set<string>[] = originalItems.map(() => new Set<string>());
    // Parallel to `working`. The validation errors that were last reported
    // for this position — kept so a give-up drop (maxAttempts exceeded) can
    // still report *why*, not just that it gave up.
    const lastErrorsAt: ValidationError[][] = originalItems.map(() => []);
    const dropped: DroppedItem<T>[] = [];
    let attempts = 1;
    let lastError: SchemaValidationError = initialError;

    while (true) {
        // Process this round's errors. Highest position first so the splices
        // below don't shift positions we still need to look at.
        const invalids = lastError.data.invalidItems.slice().sort((a, b) => b.itemPosition - a.itemPosition);

        for (const invalid of invalids) {
            const i = invalid.itemPosition;
            // Guard against a malformed/unexpected error payload (e.g. a
            // position outside the batch we actually sent) instead of
            // crashing on `working[i]` being undefined.
            if (i < 0 || i >= working.length) {
                console.log(`safePushData: ignoring out-of-range itemPosition ${i} in validation error response.`);
                continue;
            }
            const cleaned = cleanItemFields(working[i], invalid.validationErrors, placeholderPaths[i]);
            if (cleaned === null) {
                dropped.push({ item: originalAt[i], errors: invalid.validationErrors });
                working.splice(i, 1);
                originalAt.splice(i, 1);
                placeholderPaths.splice(i, 1);
                lastErrorsAt.splice(i, 1);
            } else {
                working[i] = cleaned;
                lastErrorsAt[i] = invalid.validationErrors;
            }
        }

        console.log(
            `safePushData: schema validation failed on attempt ${attempts}: ` +
                `${lastError.data.invalidItems.length} invalid item(s); ` +
                `retrying with ${working.length} item(s).`,
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
                dropped.push({ item: originalAt[i], errors: lastErrorsAt[i] });
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
// item can't be salvaged.
//
// Mutates `placeholderPaths` to record any fields we filled in ourselves,
// so the caller can keep iterating on them across rounds.
function cleanItemFields<T>(item: T, validationErrors: ValidationError[], placeholderPaths: Set<string>): T | null {
    // structuredClone so we never mutate the caller's data.
    const cloned = structuredClone(item) as T;

    for (const err of validationErrors) {
        const instancePath = err.instancePath || '';
        const path = parseJsonPointer(instancePath);

        // Root-level errors describe the item as a whole.
        if (path.length === 0) {
            // Missing required field: insert a placeholder and remember we
            // did so. The next round will see a `type` error on this path
            // and we'll upgrade null to a type-appropriate value.
            if (err.keyword === 'required' && typeof err.params?.missingProperty === 'string') {
                const prop = err.params.missingProperty;
                (cloned as Record<string, unknown>)[prop] = null;
                placeholderPaths.add(`/${prop}`);
                continue;
            }
            // Strip an unknown property reported at the root.
            if (err.keyword === 'additionalProperties' && typeof err.params?.additionalProperty === 'string') {
                delete (cloned as Record<string, unknown>)[err.params.additionalProperty];
                continue;
            }
            // type/format/etc. at the root means the item itself is the wrong shape.
            return null;
        }

        // Errors on a path we placeholder'd: try to satisfy the constraint
        // rather than delete the field (deleting would re-trigger required).
        if (placeholderPaths.has(instancePath)) {
            const fix = placeholderFor(err);
            if (fix.ok) {
                setAtPath(cloned, path, fix.value);
                continue;
            }
            // Constraint we don't know how to satisfy on a placeholder field
            // (e.g. pattern, custom format). Give up on this item.
            return null;
        }

        // additionalProperties errors point at the *parent* object; the
        // offending key is in params, not in instancePath.
        if (err.keyword === 'additionalProperties' && typeof err.params?.additionalProperty === 'string') {
            deleteAtPath(cloned, [...path, err.params.additionalProperty]);
            continue;
        }

        // User-supplied field with a violation we don't try to coerce.
        // Strip it; if the schema declares it required, the next push will
        // re-add a placeholder.
        deleteAtPath(cloned, path);
    }

    return cloned;
}

// Pick a value that will satisfy `err.keyword` on a placeholder field.
// Returns ok:false when we don't have a sensible default (e.g. `pattern`,
// custom formats); the caller drops the item in that case.
function placeholderFor(err: ValidationError): { ok: true; value: unknown } | { ok: false } {
    const params = err.params ?? {};
    switch (err.keyword) {
        case 'type': {
            // params.type is the expected type as a string, or array of strings.
            const t = Array.isArray(params.type) ? params.type[0] : params.type;
            switch (t) {
                case 'string':
                    return { ok: true, value: '' };
                case 'integer':
                case 'number':
                    return { ok: true, value: 0 };
                case 'boolean':
                    return { ok: true, value: false };
                case 'array':
                    return { ok: true, value: [] };
                case 'object':
                    return { ok: true, value: {} };
                case 'null':
                    return { ok: true, value: null };
                default:
                    break;
            }
            return { ok: false };
        }
        case 'minLength': {
            const limit = Number(params.limit) || 1;
            return { ok: true, value: '_'.repeat(limit) };
        }
        case 'maxLength':
            return { ok: true, value: '' };
        case 'minimum':
        case 'exclusiveMinimum': {
            const limit = Number(params.limit);
            if (!Number.isFinite(limit)) return { ok: false };
            return { ok: true, value: err.keyword === 'exclusiveMinimum' ? limit + 1 : limit };
        }
        case 'maximum':
        case 'exclusiveMaximum': {
            const limit = Number(params.limit);
            if (!Number.isFinite(limit)) return { ok: false };
            return { ok: true, value: err.keyword === 'exclusiveMaximum' ? limit - 1 : limit };
        }
        case 'enum': {
            const allowed = params.allowedValues;
            if (Array.isArray(allowed) && allowed.length > 0) return { ok: true, value: allowed[0] };
            return { ok: false };
        }
        case 'format': {
            switch (params.format) {
                case 'email':
                    return { ok: true, value: 'placeholder@example.com' };
                case 'uri':
                case 'uri-reference':
                case 'url':
                    return { ok: true, value: 'about:blank' };
                case 'date':
                    return { ok: true, value: '1970-01-01' };
                case 'date-time':
                    return { ok: true, value: '1970-01-01T00:00:00Z' };
                case 'uuid':
                    return { ok: true, value: '00000000-0000-0000-0000-000000000000' };
                default:
                    break;
            }
            return { ok: false };
        }
        default:
            break;
    }
    return { ok: false };
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

// Set the value at `path` inside `obj`. Creates nothing — the path must
// already exist (placeholder fields are created at the root, not nested).
function setAtPath(obj: unknown, path: string[], value: unknown): boolean {
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
        if (!Number.isInteger(idx) || idx < 0) return false;
        cursor[idx] = value;
        return true;
    }
    cursor[last] = value;
    return true;
}

// safePushData: parse the Apify dataset schema-validation error, repair the
// offending items (strip bad fields, placeholder missing required ones), and
// retry the push.
//
// NOTE: instead of recursively healing the data one error-round at a time, we
// could parse the Actor's `dataset_schema.json` up front and fix every item in
// a single pass (we'd know each field's expected type / constraints without
// waiting for the API to report them). That would avoid the multi-round retry
// loop, but requires heavier code (locating + loading the schema, resolving
// $refs, walking the schema tree). Something to consider in the future.

const SCHEMA_ERROR_TYPE = 'schema-validation-error';

// Cap on how many distinct field issues we spell out in one log line. A
// pathological batch can fail on hundreds of fields; the overflow is
// summarised as a count instead of flooding the Actor log.
const MAX_LOGGED_FIELDS = 20;

// Shared empty error list. Positions that validated fine in the current round
// point at this instead of allocating a fresh array each time.
const NO_ERRORS: ValidationError[] = [];

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

// Field names say what they hold: `*Count` is a number, `*Items` is an array
// of objects. `R` is whatever the caller's push function resolves to.
export interface SafePushDataResult<T, R = unknown> {
    /** How many of the caller's items made it into the dataset. */
    pushedCount: number;
    /** The items we couldn't repair, each with the errors that doomed it. */
    droppedItems: DroppedItem<T>[];
    /** How many times `pushFn` was actually called. */
    attemptCount: number;
    /**
     * What the successful `pushFn` call resolved to (e.g. the API response).
     * Absent when no push ever succeeded — i.e. when every item was dropped.
     */
    pushResult?: R;
}

export interface SafePushDataOptions {
    maxAttempts?: number;
}

export type PushFn<T, R = unknown> = (items: T[]) => Promise<R>;

/**
 * Push `input` via `pushFn`, surviving Apify dataset schema-validation
 * failures by cleaning offending items and retrying.
 *
 * `pushFn` is mandatory and intentionally not bundled — a CI check forbids
 * direct `.pushData()` calls in this library, so the binding lives at the
 * call site: `(b) => Actor.pushData(b)` or
 * `(b) => client.dataset(id).pushItems(b)`.
 *
 * Whatever `pushFn` resolves to is handed back untouched as `pushResult`.
 */
export async function safePushData<T, R = unknown>(
    pushFn: PushFn<T, R>,
    input: T | T[],
    options: SafePushDataOptions = {},
): Promise<SafePushDataResult<T, R>> {
    const items = Array.isArray(input) ? input : [input];

    // Happy path: assume validation will succeed (the overwhelmingly common
    // case). No working copies, no maps, no per-item wrapper objects — just
    // hand the caller's array to pushFn and return on success.
    try {
        const pushResult = await pushFn(items);
        return { pushedCount: items.length, droppedItems: [], attemptCount: 1, pushResult };
    } catch (err) {
        if (!isSchemaValidationError(err)) throw err;
        // Clamp to >=1: the initial push above always counts as one attempt,
        // so 0/negative would make the reported `attemptCount` lie about it.
        return cleanAndRetry(pushFn, items, err, Math.max(1, options.maxAttempts ?? 5));
    }
}

async function cleanAndRetry<T, R>(
    pushFn: PushFn<T, R>,
    originalItems: readonly T[],
    initialError: SchemaValidationError,
    maxAttempts: number,
): Promise<SafePushDataResult<T, R>> {
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
    // Parallel to `working`. The errors the API reported for this position in
    // the *current* round, reset every round. Non-empty therefore means "still
    // failing right now", which is what decides who gets dropped when we run
    // out of attempts — and it gives that drop a reason to report.
    const roundErrors: ValidationError[][] = originalItems.map(() => NO_ERRORS);
    const dropped: DroppedItem<T>[] = [];
    let attempts = 1;
    let lastError: SchemaValidationError = initialError;

    // Remove position `i` from every parallel array and record why it went.
    const dropAt = (i: number, errors: ValidationError[]): void => {
        dropped.push({ item: originalAt[i], errors });
        working.splice(i, 1);
        originalAt.splice(i, 1);
        placeholderPaths.splice(i, 1);
        roundErrors.splice(i, 1);
    };

    // Every return path below either follows a successful push or has dropped
    // everything that isn't in it, so "original minus dropped" is exactly what
    // landed. (A rejected push stores nothing at all — not even the items the
    // API found no fault with.)
    const result = (attemptCount: number, pushResult?: R): SafePushDataResult<T, R> => ({
        pushedCount: originalItems.length - dropped.length,
        droppedItems: dropped,
        attemptCount,
        pushResult,
    });

    while (true) {
        // Process this round's errors. Highest position first so the splices
        // below don't shift positions we still need to look at.
        const invalids = lastError.data.invalidItems.slice().sort((a, b) => b.itemPosition - a.itemPosition);
        roundErrors.fill(NO_ERRORS);

        // Which fields went wrong this round, across every failing item. We
        // deliberately don't track which item had which problem — with more
        // than one bad item that detail is noise, and the field set is what
        // actually tells you what to fix in the schema or the scraper.
        const repairedFields = new Set<string>();
        const droppedFields = new Set<string>();
        let droppedThisRound = 0;

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
                collectFieldIssues(invalid.validationErrors, droppedFields);
                droppedThisRound++;
                dropAt(i, invalid.validationErrors);
            } else {
                working[i] = cleaned;
                roundErrors[i] = invalid.validationErrors;
                collectFieldIssues(invalid.validationErrors, repairedFields);
            }
        }

        const report = [
            `safePushData: schema validation failed on attempt ${attempts}: ${lastError.data.invalidItems.length} invalid item(s)`,
        ];
        if (repairedFields.size > 0) report.push(`repaired fields: ${formatFields(repairedFields)}`);
        if (droppedThisRound > 0) {
            report.push(`dropped ${droppedThisRound} item(s) on unfixable fields: ${formatFields(droppedFields)}`);
        }
        if (working.length === 0) report.push('nothing left to retry.');
        else if (attempts < maxAttempts) report.push(`retrying with ${working.length} item(s).`);
        else report.push(`attempt cap reached with ${working.length} item(s) left.`);
        console.log(report.join('; '));

        if (working.length === 0) return result(attempts);

        attempts++;
        if (attempts > maxAttempts) {
            // Out of repair rounds. Drop what's still failing — but a rejected
            // push stores *nothing*, so keeping the rest in the batch would
            // throw away perfectly valid items along with the bad ones. Give
            // the survivors one clean push of their own instead. They were
            // validated in the round above and left untouched since, so this
            // push is expected to go through.
            const unresolvedFields = new Set<string>();
            let unresolved = 0;
            for (let i = working.length - 1; i >= 0; i--) {
                if (roundErrors[i].length === 0) continue;
                collectFieldIssues(roundErrors[i], unresolvedFields);
                unresolved++;
                dropAt(i, roundErrors[i]);
            }
            const giveUp = [`safePushData: gave up after ${maxAttempts} attempts`];
            if (unresolved > 0) {
                giveUp.push(`dropped ${unresolved} item(s) still failing on fields: ${formatFields(unresolvedFields)}`);
            }
            giveUp.push(
                working.length > 0 ? `pushing the ${working.length} valid item(s) left.` : 'nothing to salvage.',
            );
            console.log(giveUp.join('; '));

            if (working.length === 0) return result(maxAttempts);

            try {
                const pushResult = await pushFn(working);
                return result(attempts, pushResult);
            } catch (err) {
                if (!isSchemaValidationError(err)) throw err;
                // Even the survivors were rejected, so nothing landed. Report
                // each one with whatever the API said about it this time.
                const errorsAt = new Map<number, ValidationError[]>();
                for (const invalid of err.data.invalidItems) {
                    errorsAt.set(invalid.itemPosition, invalid.validationErrors);
                }
                console.log(`safePushData: final push of ${working.length} item(s) was rejected too; dropping them.`);
                for (let i = working.length - 1; i >= 0; i--) dropAt(i, errorsAt.get(i) ?? NO_ERRORS);
                return result(attempts);
            }
        }

        try {
            const pushResult = await pushFn(working);
            return result(attempts, pushResult);
        } catch (err) {
            if (!isSchemaValidationError(err)) throw err;
            lastError = err;
        }
    }
}

// Add a `path (keyword)` label for every AJV error into `into`. A Set is
// used on purpose: one bad field usually shows up on many items in the
// batch, and repeating it once per item makes the log unreadable.
function collectFieldIssues(validationErrors: readonly ValidationError[], into: Set<string>): void {
    for (const err of validationErrors) into.add(fieldIssueLabel(err));
}

// Human-readable "which field is broken, and how" for one AJV error.
//
// `required` and `additionalProperties` report the *parent* in instancePath
// and name the offending key in params, so we re-attach it — otherwise a
// missing top-level field would log as the useless `(item root)`.
function fieldIssueLabel(err: ValidationError): string {
    const child = offendingKey(err.params);
    const parent = err.instancePath || '';
    const path = child === undefined ? parent : `${parent}/${escapeJsonPointerSegment(child)}`;
    return `${path === '' ? '(item root)' : collapseArrayIndices(path)} (${err.keyword})`;
}

// The key an error blames when instancePath points at its parent.
function offendingKey(params: Record<string, unknown> | undefined): string | undefined {
    if (typeof params?.missingProperty === 'string') return params.missingProperty;
    if (typeof params?.additionalProperty === 'string') return params.additionalProperty;
    return undefined;
}

// `/tags/0` and `/tags/7` are the same *field* as far as the log is
// concerned, so collapse numeric segments into `/tags/[]`. Keeps a batch
// with a hundred bad array elements down to a single entry.
function collapseArrayIndices(path: string): string {
    return path.replace(/\/\d+(?=\/|$)/g, '/[]');
}

// Render a field-issue set as a stable, bounded, comma-separated list.
function formatFields(fields: ReadonlySet<string>): string {
    const sorted = [...fields].sort();
    if (sorted.length <= MAX_LOGGED_FIELDS) return sorted.join(', ');
    const shown = sorted.slice(0, MAX_LOGGED_FIELDS);
    return `${shown.join(', ')} (+${sorted.length - MAX_LOGGED_FIELDS} more)`;
}

// Try to repair a single item given its AJV errors. Returns null when the
// item can't be salvaged — including when none of its errors turned out to
// be actionable, since re-pushing an unchanged item would just reproduce the
// same errors and burn the remaining attempts.
//
// Mutates `placeholderPaths` to record any fields we filled in ourselves,
// so the caller can keep iterating on them across rounds.
function cleanItemFields<T>(item: T, validationErrors: ValidationError[], placeholderPaths: Set<string>): T | null {
    // structuredClone so we never mutate the caller's data.
    const cloned = structuredClone(item) as T;
    let changed = false;

    for (const err of sortForRepair(validationErrors)) {
        const instancePath = err.instancePath || '';
        const path = parseJsonPointer(instancePath);

        // Missing required field: insert a placeholder and remember we did
        // so. The next round will see a `type` error on this path and we'll
        // upgrade null to a type-appropriate value. The property is named in
        // params — instancePath points at the object that's missing it, which
        // may be the item root or any object nested inside it.
        if (err.keyword === 'required' && typeof err.params?.missingProperty === 'string') {
            const target = [...path, err.params.missingProperty];
            if (setAtPath(cloned, target, null)) {
                placeholderPaths.add(toJsonPointer(target));
                changed = true;
            }
            continue;
        }

        // Unknown property: also named in params, with instancePath pointing
        // at its parent. Strip it.
        if (err.keyword === 'additionalProperties' && typeof err.params?.additionalProperty === 'string') {
            if (deleteAtPath(cloned, [...path, err.params.additionalProperty])) changed = true;
            continue;
        }

        // Any other error at the root means the item itself is the wrong
        // shape (wrong type, failed `anyOf`, …) — there's no field to strip.
        if (path.length === 0) return null;

        // Errors on a path we placeholder'd: try to satisfy the constraint
        // rather than delete the field (deleting would re-trigger required).
        if (placeholderPaths.has(instancePath)) {
            const fix = placeholderFor(err);
            if (!fix.ok) {
                // Constraint we don't know how to satisfy on a placeholder
                // field (e.g. pattern, custom format). Give up on this item.
                return null;
            }
            if (setAtPath(cloned, path, fix.value)) changed = true;
            continue;
        }

        // User-supplied field with a violation we don't try to coerce.
        // Strip it; if the schema declares it required, the next push will
        // re-add a placeholder.
        if (deleteAtPath(cloned, path)) changed = true;
    }

    // Nothing we could act on (paths that no longer exist, keywords with no
    // handler): the next push would fail identically, so drop the item now
    // instead of spending every remaining attempt to learn that.
    return changed ? cloned : null;
}

// Order one item's errors so the repairs don't interfere with each other.
// Deleting `/tags/0` shifts every later element down, so sibling array
// indices have to be handled highest-first; deeper paths come before their
// ancestors for the same reason.
function sortForRepair(validationErrors: ValidationError[]): ValidationError[] {
    return validationErrors
        .map((err) => ({ err, path: parseJsonPointer(err.instancePath || '') }))
        .sort((a, b) => comparePaths(a.path, b.path))
        .map((entry) => entry.err);
}

function comparePaths(a: string[], b: string[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        const ai = Number(a[i]);
        const bi = Number(b[i]);
        // Sibling array elements: highest index first.
        if (Number.isInteger(ai) && Number.isInteger(bi)) return bi - ai;
        return a[i] < b[i] ? -1 : 1;
    }
    // Same prefix: the deeper path first.
    return b.length - a.length;
}

// Pick a value that will satisfy `err.keyword` on a placeholder field.
// Returns ok:false when we don't have a sensible default; the caller drops
// the item in that case.
//
// We deliberately only placeholder the four "empty" values — `''`, `[]`, `{}`,
// and `null`. These are unambiguously empty and can't be mistaken for real
// data. We do NOT fabricate values for `enum`, `format`, `minLength`, numeric
// bounds, etc.: a made-up email, a first-enum-value, or a `'_'.repeat(N)`
// string all silently poison the customer's dataset with plausible-looking
// junk. Better to drop the item than to lie about its contents. As a result
// the only keyword we handle is `type` (only for those four target types) —
// everything else falls through to ok:false and the item is dropped.
function placeholderFor(err: ValidationError): { ok: true; value: unknown } | { ok: false } {
    const params = err.params ?? {};
    if (err.keyword !== 'type') return { ok: false };

    // params.type is the expected type as a string, or an array of strings
    // when the field allows multiple types (e.g. `['string', 'null']`).
    const types = Array.isArray(params.type) ? params.type : [params.type];

    // Union type that permits null: prefer null. It's the cleanest possible
    // placeholder — it commits to no concrete value at all — so whenever the
    // schema allows it, that's what we use.
    if (types.length > 1 && types.includes('null')) {
        return { ok: true, value: null };
    }

    // Otherwise take the first allowed type we have an "empty" default for.
    // integer / number / boolean are intentionally absent: 0 / false read as
    // real data, so a field of only those types is dropped instead.
    for (const t of types) {
        switch (t) {
            case 'null':
                return { ok: true, value: null };
            case 'string':
                return { ok: true, value: '' };
            case 'array':
                return { ok: true, value: [] };
            case 'object':
                return { ok: true, value: {} };
            default:
                break;
        }
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

// Inverse of parseJsonPointer — used to record placeholder paths in the same
// encoding the API reports them in, so later errors match by string.
function toJsonPointer(path: string[]): string {
    return path.map((seg) => `/${escapeJsonPointerSegment(seg)}`).join('');
}

function escapeJsonPointerSegment(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

// Delete the value at `path` inside `obj`. Arrays splice; `sortForRepair`
// makes sure sibling indices are processed highest-first so the shift
// doesn't invalidate the paths we haven't handled yet.
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

// Set the value at `path` inside `obj`. Only the final segment is created —
// every parent on the way has to exist already (it does: the API reports the
// error against an object it found).
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

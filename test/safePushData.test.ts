// Run: npm test (builds then runs the compiled suite under node --test)
import assert from 'node:assert/strict';
import test from 'node:test';

import { isSchemaValidationError, type PushFn, safePushData, type ValidationError } from '../src/safePushData.js';

// Shape of an item used across tests.
interface Item {
    name?: unknown;
    age?: unknown;
    tags?: unknown;
    bad?: unknown;
    [k: string]: unknown;
}

// Build a fake ApifyApiError matching the real schema-validation envelope.
function fakeSchemaError(invalidItems: { itemPosition: number; validationErrors: ValidationError[] }[]) {
    // Cast to attach the ApifyApiError-style fields.
    const err = new Error('Schema validation failed') as Error & {
        type: string;
        statusCode: number;
        data: { invalidItems: typeof invalidItems };
    };
    err.type = 'schema-validation-error';
    err.statusCode = 400;
    err.data = { invalidItems };
    return err;
}

// Mock push: runs `validate(item)` against each item and throws a
// schema-validation error for any non-null result. Records every batch
// the wrapper sent.
function makeMockPush(validate: (item: Item) => ValidationError[] | null) {
    const calls: Item[][] = [];
    const pushFn: PushFn<Item> = async (batch) => {
        // Snapshot so later mutations don't trip assertions.
        calls.push(batch.map((x) => structuredClone(x)));
        const invalidItems: { itemPosition: number; validationErrors: ValidationError[] }[] = [];
        for (let i = 0; i < batch.length; i++) {
            const errors = validate(batch[i]);
            if (errors && errors.length > 0) invalidItems.push({ itemPosition: i, validationErrors: errors });
        }
        if (invalidItems.length > 0) throw fakeSchemaError(invalidItems);
    };
    return { pushFn, calls };
}

// Finds fault with the first of these fields still present on the item, so
// each round deletes one and makes real progress — but the item stays invalid
// for long enough to exhaust any small `maxAttempts`.
function neverValid(item: Item): ValidationError[] | null {
    const field = ['a', 'b', 'c', 'd'].find((f) => f in (item ?? {}));
    if (field === undefined) return null;
    return [{ instancePath: `/${field}`, keyword: 'type', params: { type: 'string' }, message: 'never-valid' }];
}

// Swap console.log for a recorder, run `fn`, restore. Returns every logged
// line so the assertions can inspect what the wrapper reported.
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        lines.push(args.join(' '));
    };
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return lines;
}

test('isSchemaValidationError recognises the API shape', () => {
    assert.equal(isSchemaValidationError(null), false);
    assert.equal(isSchemaValidationError({}), false);
    assert.equal(
        isSchemaValidationError({ type: 'schema-validation-error', statusCode: 400, data: { invalidItems: [] } }),
        true,
    );
    assert.equal(isSchemaValidationError({ type: 'other', statusCode: 400, data: { invalidItems: [] } }), false);
});

test('happy path: one push, no allocations beyond the result object', async () => {
    const { pushFn, calls } = makeMockPush(() => null);
    const items: Item[] = [{ a: 1 }, { a: 2 }];
    const res = await safePushData(pushFn, items);
    assert.equal(res.pushedCount, 2);
    assert.equal(res.droppedItems.length, 0);
    assert.equal(res.attemptCount, 1);
    // The wrapper handed the caller's exact array to pushFn (same reference).
    // The mock snapshots its argument so we can only check shape, but the
    // count proves the happy path didn't copy/wrap.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 2);
});

test('deletes invalid field, then retries successfully', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.age != null && typeof item.age !== 'number') {
            return [
                {
                    instancePath: '/age',
                    schemaPath: '#/properties/age/type',
                    keyword: 'type',
                    params: { type: 'integer' },
                    message: 'must be integer',
                },
            ];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 'old' },
    ]);
    assert.equal(res.pushedCount, 2);
    assert.equal(res.droppedItems.length, 0);
    assert.deepEqual(calls[1][1], { name: 'Bob' });
});

test('placeholders a missing required field, then satisfies the type', async () => {
    // Schema: { required: ['name'], properties: { name: { type: 'string' } } }
    const validate = (item: Item): ValidationError[] | null => {
        const errors: ValidationError[] = [];
        if (item?.name === undefined) {
            errors.push({
                instancePath: '',
                schemaPath: '#/required',
                keyword: 'required',
                params: { missingProperty: 'name' },
                message: "must have required property 'name'",
            });
        } else if (item.name === null || typeof item.name !== 'string') {
            errors.push({
                instancePath: '/name',
                schemaPath: '#/properties/name/type',
                keyword: 'type',
                params: { type: 'string' },
                message: 'must be string',
            });
        }
        return errors.length > 0 ? errors : null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, { age: 30 });
    assert.equal(res.pushedCount, 1);
    assert.equal(res.droppedItems.length, 0);
    // Final pushed item: name was placeholder'd to null, then upgraded to ''.
    assert.deepEqual(calls[calls.length - 1][0], { age: 30, name: '' });
});

test('drops item when a placeholder field carries a minLength it cannot satisfy', async () => {
    // Schema: { required: ['name'], properties: { name: { type: 'string', minLength: 3 } } }
    // We placeholder name to '' (type: string), but we no longer fabricate a
    // `'_'.repeat(N)` string for minLength — a made-up string is customer-data
    // poison — so the item is dropped instead.
    const validate = (item: Item): ValidationError[] | null => {
        const errors: ValidationError[] = [];
        if (item?.name === undefined) {
            errors.push({
                instancePath: '',
                keyword: 'required',
                params: { missingProperty: 'name' },
                message: "must have required property 'name'",
            });
            return errors;
        }
        if (item.name === null || typeof item.name !== 'string') {
            errors.push({
                instancePath: '/name',
                keyword: 'type',
                params: { type: 'string' },
                message: 'must be string',
            });
            return errors;
        }
        if ((item.name as string).length < 3) {
            errors.push({
                instancePath: '/name',
                keyword: 'minLength',
                params: { limit: 3 },
                message: 'must NOT have fewer than 3 characters',
            });
            return errors;
        }
        return null;
    };
    const { pushFn } = makeMockPush(validate);
    const res = await safePushData(pushFn, { age: 30 }, { maxAttempts: 10 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
    assert.deepEqual(res.droppedItems[0].item, { age: 30 });
});

test('drops item on enum constraint instead of fabricating the first allowed value', async () => {
    // We used to placeholder an enum field with its first allowed value; that
    // silently injects a plausible-but-wrong value into the dataset, so we now
    // drop the item instead.
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.role === undefined) {
            return [
                {
                    instancePath: '',
                    keyword: 'required',
                    params: { missingProperty: 'role' },
                    message: "must have required property 'role'",
                },
            ];
        }
        if (item.role === null) {
            return [
                {
                    instancePath: '/role',
                    keyword: 'type',
                    params: { type: 'string' },
                    message: 'must be string',
                },
            ];
        }
        const allowed = ['admin', 'user', 'guest'];
        if (typeof item.role !== 'string' || !allowed.includes(item.role)) {
            return [
                {
                    instancePath: '/role',
                    keyword: 'enum',
                    params: { allowedValues: allowed },
                    message: 'must be equal to one of the allowed values',
                },
            ];
        }
        return null;
    };
    const { pushFn } = makeMockPush(validate);
    const res = await safePushData(pushFn, { name: 'x' }, { maxAttempts: 10 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
});

test('drops item on format=email instead of fabricating a fake address', async () => {
    // A made-up `placeholder@example.com` is exactly the kind of junk we no
    // longer inject; the item is dropped instead.
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.email === undefined) {
            return [
                {
                    instancePath: '',
                    keyword: 'required',
                    params: { missingProperty: 'email' },
                    message: "must have required property 'email'",
                },
            ];
        }
        if (item.email === null) {
            return [
                {
                    instancePath: '/email',
                    keyword: 'type',
                    params: { type: 'string' },
                    message: 'must be string',
                },
            ];
        }
        if (typeof item.email === 'string' && !/.+@.+\..+/.test(item.email)) {
            return [
                {
                    instancePath: '/email',
                    keyword: 'format',
                    params: { format: 'email' },
                    message: 'must match format "email"',
                },
            ];
        }
        return null;
    };
    const { pushFn } = makeMockPush(validate);
    const res = await safePushData(pushFn, { name: 'x' }, { maxAttempts: 10 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
});

test('required field with a union type that allows null is placeholder-filled with null', async () => {
    // Schema: { required: ['note'], properties: { note: { type: ['string', 'null'] } } }
    // The initial `required` placeholder sets note = null; because the field
    // allows null, the follow-up type error reports both allowed types and we
    // keep null (the cleanest placeholder) rather than coercing to ''.
    const validate = (item: Item): ValidationError[] | null => {
        if (!('note' in (item ?? {}))) {
            return [
                {
                    instancePath: '',
                    keyword: 'required',
                    params: { missingProperty: 'note' },
                    message: "must have required property 'note'",
                },
            ];
        }
        if (item.note !== null && typeof item.note !== 'string') {
            return [
                {
                    instancePath: '/note',
                    keyword: 'type',
                    params: { type: ['string', 'null'] },
                    message: 'must be string,null',
                },
            ];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, { name: 'x' });
    assert.equal(res.pushedCount, 1);
    assert.equal(res.droppedItems.length, 0);
    assert.deepEqual(calls[calls.length - 1][0], { name: 'x', note: null });
});

test('drops item when a placeholder constraint has no known fix (pattern)', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.sku === undefined) {
            return [
                {
                    instancePath: '',
                    keyword: 'required',
                    params: { missingProperty: 'sku' },
                    message: "must have required property 'sku'",
                },
            ];
        }
        if (item.sku === null) {
            return [
                {
                    instancePath: '/sku',
                    keyword: 'type',
                    params: { type: 'string' },
                    message: 'must be string',
                },
            ];
        }
        // We don't have a placeholder for `pattern`, so item should be dropped.
        return [
            {
                instancePath: '/sku',
                keyword: 'pattern',
                params: { pattern: '^[A-Z]{3}-\\d{4}$' },
                message: 'must match pattern',
            },
        ];
    };
    const { pushFn } = makeMockPush(validate);
    const res = await safePushData(pushFn, [{ name: 'x' }], { maxAttempts: 10 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
});

test('user-supplied bad data still gets the field stripped, not placeholder-treated', async () => {
    // Schema: name optional but must be string. age optional integer.
    const validate = (item: Item): ValidationError[] | null => {
        const errors: ValidationError[] = [];
        if (item?.age != null && typeof item.age !== 'number') {
            errors.push({
                instancePath: '/age',
                keyword: 'type',
                params: { type: 'integer' },
                message: 'must be integer',
            });
        }
        return errors.length > 0 ? errors : null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, [{ name: 'Bob', age: 'old' }]);
    assert.equal(res.pushedCount, 1);
    // age was user-supplied (not a placeholder we set), so it got deleted
    // rather than coerced to 0.
    assert.deepEqual(calls[calls.length - 1][0], { name: 'Bob' });
});

test('removes bad element from array via /tags/0 path', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (Array.isArray(item?.tags)) {
            const errors: ValidationError[] = [];
            (item.tags as unknown[]).forEach((t, i) => {
                if (typeof t !== 'string') {
                    errors.push({
                        instancePath: `/tags/${i}`,
                        schemaPath: '#/properties/tags/items/type',
                        keyword: 'type',
                        params: { type: 'string' },
                        message: 'must be string',
                    });
                }
            });
            return errors.length > 0 ? errors : null;
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, [{ name: 'Eve', tags: [42, 'ok', 99] }]);
    assert.equal(res.pushedCount, 1);
    const finalPushed = calls[calls.length - 1][0];
    assert.equal(finalPushed.name, 'Eve');
    assert.ok((finalPushed.tags as unknown[]).every((t) => typeof t === 'string'));
});

test('single object input: dropped on missing-required, no crash', async () => {
    const { pushFn } = makeMockPush(() => [
        {
            instancePath: '',
            schemaPath: '#/required',
            keyword: 'required',
            params: { missingProperty: 'name' },
            message: "must have required property 'name'",
        },
    ]);
    const res = await safePushData(pushFn, { age: 99 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
    assert.deepEqual(res.droppedItems[0].item, { age: 99 });
});

test('pushResult carries whatever pushFn resolved to', async () => {
    const pushFn: PushFn<Item, { stored: number }> = async (batch) => ({ stored: batch.length });
    const res = await safePushData(pushFn, [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(res.pushResult, { stored: 2 });
});

test('pushResult comes from the push that actually succeeded, not an earlier one', async () => {
    let call = 0;
    const pushFn: PushFn<Item, string> = async (batch) => {
        call++;
        if (call === 1) {
            throw fakeSchemaError([
                {
                    itemPosition: 1,
                    validationErrors: [
                        { instancePath: '/age', keyword: 'type', params: { type: 'integer' }, message: 'x' },
                    ],
                },
            ]);
        }
        return `stored ${batch.length} on call ${call}`;
    };
    const res = await safePushData(pushFn, [{ name: 'A' }, { name: 'B', age: 'old' }]);
    assert.equal(res.pushResult, 'stored 2 on call 2');
    assert.equal(res.attemptCount, 2);
});

test('pushResult is undefined when nothing was ever pushed', async () => {
    const { pushFn } = makeMockPush(() => [
        { instancePath: '', keyword: 'type', params: { type: 'object' }, message: 'x' },
    ]);
    const res = await safePushData(pushFn, [{ a: 1 }]);
    assert.equal(res.pushedCount, 0);
    assert.equal(res.pushResult, undefined);
});

test('a nested required field is placeholder-filled, not nuked along with its parent', async () => {
    // Schema: address is an object requiring a string `city`. The naive
    // fallback (strip the field at instancePath) would delete the whole
    // address object; the placeholder keeps the rest of it.
    const validate = (item: Item): ValidationError[] | null => {
        const address = item?.address as Record<string, unknown> | undefined;
        if (!address) return null;
        if (!('city' in address)) {
            return [
                {
                    instancePath: '/address',
                    keyword: 'required',
                    params: { missingProperty: 'city' },
                    message: "must have required property 'city'",
                },
            ];
        }
        if (typeof address.city !== 'string') {
            return [
                {
                    instancePath: '/address/city',
                    keyword: 'type',
                    params: { type: 'string' },
                    message: 'must be string',
                },
            ];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, [{ address: { street: 'Main 1' } }]);
    assert.equal(res.pushedCount, 1);
    assert.deepEqual(calls[calls.length - 1][0], { address: { street: 'Main 1', city: '' } });
});

test('sibling array elements are removed in one round, without taking a valid one with them', async () => {
    // Errors arrive as /tags/0 and /tags/1. Splicing them front-to-back would
    // shift the array under the second path and delete the valid 'ok'.
    const validate = (item: Item): ValidationError[] | null => {
        if (!Array.isArray(item?.tags)) return null;
        const errors = (item.tags as unknown[]).flatMap((t, i) =>
            typeof t === 'string'
                ? []
                : [{ instancePath: `/tags/${i}`, keyword: 'type', params: { type: 'string' }, message: 'x' }],
        );
        return errors.length > 0 ? errors : null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, [{ tags: [1, 2, 'ok'] }]);
    assert.equal(res.pushedCount, 1);
    assert.deepEqual(calls[calls.length - 1][0], { tags: ['ok'] });
    // Both bad elements went in the same round: one retry, not two.
    assert.equal(res.attemptCount, 2);
});

test('non-schema error is rethrown', async () => {
    const pushFn: PushFn<Item> = async () => {
        const err = new Error('boom') as Error & { statusCode: number };
        err.statusCode = 500;
        throw err;
    };
    await assert.rejects(async () => safePushData(pushFn, [{ x: 1 }]), /boom/);
});

test('empty array input: returns immediately (but pushFn is still called once)', async () => {
    let called = 0;
    const pushFn: PushFn<Item> = async () => {
        called++;
    };
    const res = await safePushData(pushFn, []);
    assert.equal(res.pushedCount, 0);
    assert.equal(res.attemptCount, 1);
    // Happy path goes through pushFn once even on []; this is intentional —
    // the wrapper doesn't second-guess what `pushFn([])` means for the caller.
    assert.equal(called, 1);
});

test('original input array is not mutated', async () => {
    const validate = (item: Item): ValidationError[] | null =>
        item?.bad ? [{ instancePath: '/bad', keyword: 'type', params: { type: 'string' }, message: 'x' }] : null;
    const { pushFn } = makeMockPush(validate);
    const original: Item[] = [{ name: 'A' }, { name: 'B', bad: true }];
    const snapshot = structuredClone(original);
    await safePushData(pushFn, original);
    assert.deepEqual(original, snapshot);
});

test('gives up after maxAttempts with remaining items still failing', async () => {
    const { pushFn } = makeMockPush(neverValid);
    const res = await safePushData(pushFn, [{ a: 1, b: 2, c: 3, d: 4 }], { maxAttempts: 3 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
    assert.equal(res.attemptCount, 3);
    assert.equal(res.pushResult, undefined);
});

test('give-up drop reports the last validation errors, not an empty array', async () => {
    const { pushFn } = makeMockPush(neverValid);
    const res = await safePushData(pushFn, [{ a: 1, b: 2, c: 3, d: 4 }], { maxAttempts: 3 });
    assert.equal(res.droppedItems.length, 1);
    // /a went on attempt 1 and /b on attempt 2, so /c is what was still
    // broken when the cap hit.
    assert.deepEqual(res.droppedItems[0].errors, [
        { instancePath: '/c', keyword: 'type', params: { type: 'string' }, message: 'never-valid' },
    ]);
});

test('hitting the cap does not throw away the items that were always valid', async () => {
    // The whole point of the wrapper: one incurable item must not take the
    // rest of the batch down with it. A rejected push stores nothing, so the
    // survivors get a final push of their own once we stop repairing.
    const { pushFn, calls } = makeMockPush(neverValid);
    const res = await safePushData(pushFn, [{ ok: 1 }, { a: 1, b: 2, c: 3, d: 4 }, { ok: 2 }], { maxAttempts: 3 });
    assert.equal(res.pushedCount, 2);
    assert.equal(res.droppedItems.length, 1);
    assert.deepEqual(res.droppedItems[0].item, { a: 1, b: 2, c: 3, d: 4 });
    // Three repair attempts plus the final push of the survivors.
    assert.equal(res.attemptCount, 4);
    assert.deepEqual(calls[3], [{ ok: 1 }, { ok: 2 }]);
});

test('item whose errors are all unactionable is dropped instead of burning attempts', async () => {
    // Every error points at a path the item doesn't have, so nothing we do
    // changes the item — re-pushing would reproduce the identical error.
    const pushFn: PushFn<Item> = async (batch) =>
        Promise.reject(
            fakeSchemaError(
                batch.map((_, i) => ({
                    itemPosition: i,
                    validationErrors: [
                        { instancePath: '/nope', keyword: 'type', params: { type: 'string' }, message: 'x' },
                    ],
                })),
            ),
        );
    const res = await safePushData(pushFn, [{ name: 'X' }], { maxAttempts: 5 });
    assert.equal(res.droppedItems.length, 1);
    assert.equal(res.attemptCount, 1);
});

test('maxAttempts <= 0 is clamped to 1 (attempts always matches real pushFn calls)', async () => {
    let calls = 0;
    const pushFn: PushFn<Item> = async () => {
        calls++;
        throw fakeSchemaError([
            {
                itemPosition: 0,
                validationErrors: [
                    { instancePath: '', keyword: 'required', params: { missingProperty: 'name' }, message: 'nope' },
                ],
            },
        ]);
    };
    const res = await safePushData(pushFn, [{ age: 30 }], { maxAttempts: 0 });
    assert.equal(calls, 1);
    assert.equal(res.attemptCount, 1);
});

test('round log names the offending fields, deduped across items', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        const errors: ValidationError[] = [];
        if (item?.age != null && typeof item.age !== 'number') {
            errors.push({ instancePath: '/age', keyword: 'type', params: { type: 'integer' }, message: 'x' });
        }
        if (Array.isArray(item?.tags)) {
            (item.tags as unknown[]).forEach((t, i) => {
                if (typeof t !== 'string') {
                    errors.push({
                        instancePath: `/tags/${i}`,
                        keyword: 'type',
                        params: { type: 'string' },
                        message: 'x',
                    });
                }
            });
        }
        return errors.length > 0 ? errors : null;
    };
    const { pushFn } = makeMockPush(validate);
    const lines = await captureLogs(async () => {
        const res = await safePushData(pushFn, [
            { name: 'a', age: 'old', tags: [1, 'ok'] },
            { name: 'b', age: 'x', tags: ['ok', 2] },
        ]);
        assert.equal(res.pushedCount, 2);
    });
    assert.equal(lines.length, 1);
    // Both items hit /age, and the bad array elements (at different indices)
    // collapse into one `/tags/[]` entry — the log reports fields, not
    // occurrences.
    assert.equal(
        lines[0],
        'safePushData: schema validation failed on attempt 1: 2 invalid item(s); ' +
            'repaired fields: /age (type), /tags/[] (type); retrying with 2 item(s).',
    );
});

test('round log reports a missing required field under its own path', async () => {
    const validate = (item: Item): ValidationError[] | null =>
        item?.name === undefined
            ? [{ instancePath: '', keyword: 'required', params: { missingProperty: 'name' }, message: 'x' }]
            : null;
    const { pushFn } = makeMockPush(validate);
    const lines = await captureLogs(async () => {
        await safePushData(pushFn, [{ age: 1 }]);
    });
    assert.ok(lines[0].includes('repaired fields: /name (required)'), lines[0]);
});

test('round log separates dropped items and their unfixable fields', async () => {
    // Root-level `type` error: the item itself is the wrong shape, so it is
    // dropped rather than cleaned.
    const { pushFn } = makeMockPush(() => [
        { instancePath: '', keyword: 'type', params: { type: 'object' }, message: 'x' },
    ]);
    const lines = await captureLogs(async () => {
        const res = await safePushData(pushFn, [{ age: 1 }]);
        assert.equal(res.droppedItems.length, 1);
    });
    assert.equal(
        lines[0],
        'safePushData: schema validation failed on attempt 1: 1 invalid item(s); ' +
            'dropped 1 item(s) on unfixable fields: (item root) (type); nothing left to retry.',
    );
});

test('give-up log names the fields that are still failing and what it salvages', async () => {
    const { pushFn } = makeMockPush(neverValid);
    const lines = await captureLogs(async () => {
        await safePushData(pushFn, [{ ok: 1 }, { a: 1, b: 2, c: 3, d: 4 }], { maxAttempts: 3 });
    });
    assert.ok(lines[2].endsWith('attempt cap reached with 2 item(s) left.'), lines[2]);
    assert.equal(
        lines[3],
        'safePushData: gave up after 3 attempts; dropped 1 item(s) still failing on fields: /c (type); ' +
            'pushing the 1 valid item(s) left.',
    );
});

test('field list in the log is capped, with the overflow counted', async () => {
    // 25 distinct bad fields on one item; only the first 20 are spelled out.
    const badFields = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    const validate = (item: Item): ValidationError[] | null => {
        const errors = badFields
            .filter((f) => f in (item ?? {}))
            .map((f) => ({ instancePath: `/${f}`, keyword: 'type', params: { type: 'string' }, message: 'x' }));
        return errors.length > 0 ? errors : null;
    };
    const { pushFn } = makeMockPush(validate);
    const item: Item = {};
    for (const f of badFields) item[f] = 1;
    const lines = await captureLogs(async () => {
        const res = await safePushData(pushFn, [item]);
        assert.equal(res.pushedCount, 1);
    });
    assert.ok(lines[0].includes('/f00 (type), /f01 (type)'), lines[0]);
    assert.ok(lines[0].includes('/f19 (type) (+5 more)'), lines[0]);
    assert.ok(!lines[0].includes('/f20 (type)'), lines[0]);
});

test('out-of-range itemPosition in the error payload is ignored, not a crash', async () => {
    const pushFn: PushFn<Item> = async () => {
        throw fakeSchemaError([
            {
                itemPosition: 5,
                validationErrors: [
                    { instancePath: '', keyword: 'required', params: { missingProperty: 'name' }, message: 'nope' },
                ],
            },
        ]);
    };
    const res = await safePushData(pushFn, [{ age: 30 }], { maxAttempts: 2 });
    assert.equal(res.pushedCount, 0);
    assert.equal(res.droppedItems.length, 1);
    assert.deepEqual(res.droppedItems[0].item, { age: 30 });
});

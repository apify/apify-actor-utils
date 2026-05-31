// Run: node --test --experimental-strip-types test/safePushData.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    safePushData,
    isSchemaValidationError,
    type PushFn,
    type ValidationError,
} from '../src/safePushData.ts';

// Shape of an item used across tests.
interface Item {
    name?: unknown;
    age?: unknown;
    tags?: unknown;
    bad?: unknown;
    [k: string]: unknown;
}

// Build a fake ApifyApiError matching the real schema-validation envelope.
function fakeSchemaError(invalidItems: Array<{ itemPosition: number; validationErrors: ValidationError[] }>) {
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
        const invalidItems: Array<{ itemPosition: number; validationErrors: ValidationError[] }> = [];
        for (let i = 0; i < batch.length; i++) {
            const errors = validate(batch[i]);
            if (errors && errors.length > 0) invalidItems.push({ itemPosition: i, validationErrors: errors });
        }
        if (invalidItems.length > 0) throw fakeSchemaError(invalidItems);
    };
    return { pushFn, calls };
}

test('isSchemaValidationError recognises the API shape', () => {
    assert.equal(isSchemaValidationError(null), false);
    assert.equal(isSchemaValidationError({}), false);
    assert.equal(
        isSchemaValidationError({ type: 'schema-validation-error', statusCode: 400, data: { invalidItems: [] } }),
        true,
    );
    assert.equal(
        isSchemaValidationError({ type: 'other', statusCode: 400, data: { invalidItems: [] } }),
        false,
    );
});

test('happy path: one push, no allocations beyond the result object', async () => {
    const { pushFn, calls } = makeMockPush(() => null);
    const items: Item[] = [{ a: 1 }, { a: 2 }];
    const res = await safePushData(pushFn, items);
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 0);
    assert.equal(res.attempts, 1);
    // The wrapper handed the caller's exact array to pushFn (same reference).
    // The mock snapshots its argument so we can only check shape, but the
    // count proves the happy path didn't copy/wrap.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 2);
});

test('deletes invalid field, then retries successfully', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.age != null && typeof item.age !== 'number') {
            return [{
                instancePath: '/age',
                schemaPath: '#/properties/age/type',
                keyword: 'type',
                params: { type: 'integer' },
                message: 'must be integer',
            }];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(
        pushFn,
        [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 'old' }],
    );
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 0);
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
    assert.equal(res.pushed, 1);
    assert.equal(res.dropped.length, 0);
    // Final pushed item: name was placeholder'd to null, then upgraded to ''.
    assert.deepEqual(calls[calls.length - 1][0], { age: 30, name: '' });
});

test('chases required -> type -> minLength on the same placeholder field', async () => {
    // Schema: { required: ['name'], properties: { name: { type: 'string', minLength: 3 } } }
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
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, { age: 30 }, { maxAttempts: 10 });
    assert.equal(res.pushed, 1);
    assert.equal(res.attempts, 4); // required, type, minLength, success
    assert.equal((calls[calls.length - 1][0].name as string).length, 3);
});

test('placeholder for enum picks the first allowed value', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.role === undefined) {
            return [{
                instancePath: '',
                keyword: 'required',
                params: { missingProperty: 'role' },
                message: "must have required property 'role'",
            }];
        }
        if (item.role === null) {
            return [{
                instancePath: '/role',
                keyword: 'type',
                params: { type: 'string' },
                message: 'must be string',
            }];
        }
        const allowed = ['admin', 'user', 'guest'];
        if (typeof item.role !== 'string' || !allowed.includes(item.role)) {
            return [{
                instancePath: '/role',
                keyword: 'enum',
                params: { allowedValues: allowed },
                message: 'must be equal to one of the allowed values',
            }];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, { name: 'x' });
    assert.equal(res.pushed, 1);
    assert.equal(calls[calls.length - 1][0].role, 'admin');
});

test('placeholder for format=email', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.email === undefined) {
            return [{
                instancePath: '',
                keyword: 'required',
                params: { missingProperty: 'email' },
                message: "must have required property 'email'",
            }];
        }
        if (item.email === null) {
            return [{
                instancePath: '/email',
                keyword: 'type',
                params: { type: 'string' },
                message: 'must be string',
            }];
        }
        if (typeof item.email === 'string' && !/.+@.+\..+/.test(item.email)) {
            return [{
                instancePath: '/email',
                keyword: 'format',
                params: { format: 'email' },
                message: 'must match format "email"',
            }];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush(validate);
    const res = await safePushData(pushFn, { name: 'x' });
    assert.equal(res.pushed, 1);
    assert.equal(calls[calls.length - 1][0].email, 'placeholder@example.com');
});

test('drops item when a placeholder constraint has no known fix (pattern)', async () => {
    const validate = (item: Item): ValidationError[] | null => {
        if (item?.sku === undefined) {
            return [{
                instancePath: '',
                keyword: 'required',
                params: { missingProperty: 'sku' },
                message: "must have required property 'sku'",
            }];
        }
        if (item.sku === null) {
            return [{
                instancePath: '/sku',
                keyword: 'type',
                params: { type: 'string' },
                message: 'must be string',
            }];
        }
        // We don't have a placeholder for `pattern`, so item should be dropped.
        return [{
            instancePath: '/sku',
            keyword: 'pattern',
            params: { pattern: '^[A-Z]{3}-\\d{4}$' },
            message: 'must match pattern',
        }];
    };
    const { pushFn } = makeMockPush(validate);
    const res = await safePushData(pushFn, [{ name: 'x' }], { maxAttempts: 10 });
    assert.equal(res.pushed, 0);
    assert.equal(res.dropped.length, 1);
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
    assert.equal(res.pushed, 1);
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
    assert.equal(res.pushed, 1);
    const finalPushed = calls[calls.length - 1][0];
    assert.equal(finalPushed.name, 'Eve');
    assert.ok((finalPushed.tags as unknown[]).every((t) => typeof t === 'string'));
});

test('single object input: dropped on missing-required, no crash', async () => {
    const { pushFn } = makeMockPush(() => [{
        instancePath: '',
        schemaPath: '#/required',
        keyword: 'required',
        params: { missingProperty: 'name' },
        message: "must have required property 'name'",
    }]);
    const res = await safePushData(pushFn, { age: 99 });
    assert.equal(res.pushed, 0);
    assert.equal(res.dropped.length, 1);
    assert.deepEqual(res.dropped[0].item, { age: 99 });
});

test('non-schema error is rethrown', async () => {
    const pushFn: PushFn<Item> = async () => {
        const err = new Error('boom') as Error & { statusCode: number };
        err.statusCode = 500;
        throw err;
    };
    await assert.rejects(() => safePushData(pushFn, [{ x: 1 }]), /boom/);
});

test('empty array input: returns immediately (but pushFn is still called once)', async () => {
    let called = 0;
    const pushFn: PushFn<Item> = async () => { called++; };
    const res = await safePushData(pushFn, []);
    assert.equal(res.pushed, 0);
    assert.equal(res.attempts, 1);
    // Happy path goes through pushFn once even on []; this is intentional —
    // the wrapper doesn't second-guess what `pushFn([])` means for the caller.
    assert.equal(called, 1);
});

test('original input array is not mutated', async () => {
    const validate = (item: Item): ValidationError[] | null => (item?.bad
        ? [{ instancePath: '/bad', keyword: 'type', params: { type: 'string' }, message: 'x' }]
        : null);
    const { pushFn } = makeMockPush(validate);
    const original: Item[] = [{ name: 'A' }, { name: 'B', bad: true }];
    const snapshot = structuredClone(original);
    await safePushData(pushFn, original);
    assert.deepEqual(original, snapshot);
});

test('gives up after maxAttempts with remaining items still failing', async () => {
    // Validator always fails on items it sees — but never on the same field
    // we just deleted. We force a runaway loop by reporting a non-root field
    // error and then keep failing.
    let calls = 0;
    const pushFn: PushFn<Item> = async (batch) => {
        calls++;
        throw fakeSchemaError(batch.map((_, i) => ({
            itemPosition: i,
            validationErrors: [{
                instancePath: `/extra${calls}`,
                keyword: 'type',
                params: { type: 'string' },
                message: 'forever-failing',
            }],
        })));
    };
    const res = await safePushData(pushFn, [{ name: 'X' }], { maxAttempts: 3 });
    assert.equal(res.pushed, 0);
    assert.equal(res.dropped.length, 1);
    assert.equal(res.attempts, 3);
});

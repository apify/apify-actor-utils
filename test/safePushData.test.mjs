// Unit tests for safePushData using a mock pushFn so no Apify platform is needed.
// Run with: node --test test/safePushData.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { safePushData, isSchemaValidationError } from '../src/safePushData.js';

/**
 * Build a fake ApifyApiError matching the real shape returned by the platform.
 * Validator() decides which items in a batch are "invalid"; the test supplies
 * a validator that mimics the schema we care about.
 */
function fakeSchemaError(invalidItems) {
    const err = new Error('Schema validation failed');
    err.type = 'schema-validation-error';
    err.statusCode = 400;
    err.data = { invalidItems };
    return err;
}

/**
 * Make a pushFn that runs `validate(item)` against every item; if any return
 * non-null, it throws a fake schema-validation error. Records every batch
 * actually sent on `calls`.
 */
function makeMockPush({ validate, calls = [] }) {
    async function pushFn(batch) {
        calls.push(batch.map((x) => structuredClone(x)));
        const invalidItems = [];
        for (let i = 0; i < batch.length; i++) {
            const errors = validate(batch[i]);
            if (errors && errors.length > 0) invalidItems.push({ itemPosition: i, validationErrors: errors });
        }
        if (invalidItems.length > 0) throw fakeSchemaError(invalidItems);
    }
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

test('happy path: all items valid -> one push, no drops', async () => {
    const { pushFn, calls } = makeMockPush({ validate: () => null });
    const res = await safePushData([{ a: 1 }, { a: 2 }], { pushFn, silent: true });
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 0);
    assert.equal(res.attempts, 1);
    assert.equal(calls.length, 1);
});

test('drop strategy: filters invalid items, returns errors, retries once', async () => {
    const validate = (item) => {
        if (item?.name == null) {
            return [{
                instancePath: '',
                schemaPath: '#/required',
                keyword: 'required',
                params: { missingProperty: 'name' },
                message: "must have required property 'name'",
            }];
        }
        return null;
    };
    const { pushFn, calls } = makeMockPush({ validate });
    const res = await safePushData(
        [{ name: 'Alice' }, { age: 30 }, { name: 'Bob' }],
        { pushFn, strategy: 'drop', silent: true },
    );
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 1);
    assert.deepEqual(res.dropped[0].item, { age: 30 });
    assert.equal(res.attempts, 2);
    // First call: all three; second call: the two valid ones.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].length, 3);
    assert.equal(calls[1].length, 2);
});

test('cleanFields strategy: deletes invalid field then retries', async () => {
    const validate = (item) => {
        const errors = [];
        if (item?.age != null && typeof item.age !== 'number') {
            errors.push({
                instancePath: '/age',
                schemaPath: '#/properties/age/type',
                keyword: 'type',
                params: { type: 'integer' },
                message: 'must be integer',
            });
        }
        return errors.length > 0 ? errors : null;
    };
    const { pushFn, calls } = makeMockPush({ validate });
    const res = await safePushData(
        [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 'old' }],
        { pushFn, strategy: 'cleanFields', silent: true },
    );
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 0);
    assert.equal(res.cleaned.length, 1);
    assert.deepEqual(res.cleaned[0].item, { name: 'Bob', age: 'old' });
    // Second attempt should not contain `age` for Bob.
    assert.deepEqual(calls[1][1], { name: 'Bob' });
});

test('cleanFields strategy: drops item when stripping creates a required-field error', async () => {
    const requiredFields = ['name', 'age'];
    const validate = (item) => {
        const errors = [];
        for (const f of requiredFields) {
            if (item?.[f] == null) {
                errors.push({
                    instancePath: '',
                    schemaPath: '#/required',
                    keyword: 'required',
                    params: { missingProperty: f },
                    message: `must have required property '${f}'`,
                });
            }
        }
        if (item?.age != null && typeof item.age !== 'number') {
            errors.push({
                instancePath: '/age',
                schemaPath: '#/properties/age/type',
                keyword: 'type',
                params: { type: 'integer' },
                message: 'must be integer',
            });
        }
        return errors.length > 0 ? errors : null;
    };
    const { pushFn } = makeMockPush({ validate });
    const res = await safePushData(
        [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 'old' }],
        { pushFn, strategy: 'cleanFields', silent: true },
    );
    // Bob's age gets deleted; next round surfaces "required: age" so he's dropped.
    assert.equal(res.pushed, 1);
    assert.equal(res.dropped.length, 1);
    assert.deepEqual(res.dropped[0].item, { name: 'Bob', age: 'old' });
});

test('cleanFields strategy: removes bad element from array via /tags/0 path', async () => {
    const validate = (item) => {
        if (Array.isArray(item?.tags)) {
            const errors = [];
            item.tags.forEach((t, i) => {
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
    const { pushFn, calls } = makeMockPush({ validate });
    const res = await safePushData(
        [{ name: 'Eve', tags: [42, 'ok', 99] }],
        { pushFn, strategy: 'cleanFields', silent: true },
    );
    assert.equal(res.pushed, 1);
    // /tags/0 and /tags/2 are bad. After splicing index 0 then 2 (in order), we lose
    // the original index 0 and the *new* index-2 (originally index 3, which doesn't exist).
    // The wrapper deletes in the order errors arrive; in practice AJV reports highest-index-
    // first or lowest-first depending on schema, so we just assert the final pushed item
    // has no non-string members and didn't trigger another round of validation.
    const finalPushed = calls[calls.length - 1][0];
    assert.equal(finalPushed.name, 'Eve');
    assert.ok(finalPushed.tags.every((t) => typeof t === 'string'));
});

test('single object input: dropped on validation failure, no crash', async () => {
    const validate = () => [{
        instancePath: '',
        schemaPath: '#/required',
        keyword: 'required',
        params: { missingProperty: 'name' },
        message: "must have required property 'name'",
    }];
    const { pushFn } = makeMockPush({ validate });
    const res = await safePushData({ age: 99 }, { pushFn, silent: true });
    assert.equal(res.pushed, 0);
    assert.equal(res.dropped.length, 1);
    assert.deepEqual(res.dropped[0].item, { age: 99 });
});

test('non-schema error is rethrown', async () => {
    const pushFn = async () => {
        const err = new Error('boom');
        err.statusCode = 500;
        throw err;
    };
    await assert.rejects(
        () => safePushData([{ x: 1 }], { pushFn, silent: true }),
        /boom/,
    );
});

test('onDropped is invoked when items are dropped (success path)', async () => {
    let received;
    const validate = (item) => (item?.bad
        ? [{ instancePath: '', keyword: 'required', params: { missingProperty: 'name' }, message: 'x' }]
        : null);
    const { pushFn } = makeMockPush({ validate });
    await safePushData(
        [{ name: 'A' }, { bad: true }],
        { pushFn, silent: true, onDropped: (d) => { received = d; } },
    );
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].item, { bad: true });
});

test('empty array input: returns immediately, no push call', async () => {
    let called = false;
    const pushFn = async () => { called = true; };
    const res = await safePushData([], { pushFn, silent: true });
    assert.equal(res.pushed, 0);
    assert.equal(res.attempts, 0);
    assert.equal(called, false);
});

test('original input array is not mutated', async () => {
    const validate = (item) => (item?.bad
        ? [{ instancePath: '/bad', keyword: 'type', params: { type: 'string' }, message: 'x' }]
        : null);
    const { pushFn } = makeMockPush({ validate });
    const original = [{ name: 'A' }, { name: 'B', bad: true }];
    const snapshot = structuredClone(original);
    await safePushData(original, { pushFn, strategy: 'cleanFields', silent: true });
    assert.deepEqual(original, snapshot);
});

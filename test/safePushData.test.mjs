// Unit tests for safePushData. No Apify install required.
// Run: node --test test/safePushData.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { safePushData, isSchemaValidationError } from '../src/safePushData.js';

function fakeSchemaError(invalidItems) {
    const err = new Error('Schema validation failed');
    err.type = 'schema-validation-error';
    err.statusCode = 400;
    err.data = { invalidItems };
    return err;
}

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

test('pushFn is required', async () => {
    await assert.rejects(
        () => safePushData([{ a: 1 }], {}),
        /pushFn is required/,
    );
});

test('happy path: all items valid -> one push, no drops', async () => {
    const { pushFn, calls } = makeMockPush({ validate: () => null });
    const res = await safePushData([{ a: 1 }, { a: 2 }], { pushFn });
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 0);
    assert.equal(res.attempts, 1);
    assert.equal(calls.length, 1);
});

test('deletes invalid field, then retries successfully', async () => {
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
        { pushFn },
    );
    assert.equal(res.pushed, 2);
    assert.equal(res.dropped.length, 0);
    assert.deepEqual(calls[1][1], { name: 'Bob' });
});

test('drops item when stripping creates a required-field error', async () => {
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
        { pushFn },
    );
    // Bob's age gets deleted; next round surfaces "required: age" so he's dropped.
    assert.equal(res.pushed, 1);
    assert.equal(res.dropped.length, 1);
    assert.deepEqual(res.dropped[0].item, { name: 'Bob', age: 'old' });
});

test('removes bad element from array via /tags/0 path', async () => {
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
        { pushFn },
    );
    assert.equal(res.pushed, 1);
    const finalPushed = calls[calls.length - 1][0];
    assert.equal(finalPushed.name, 'Eve');
    assert.ok(finalPushed.tags.every((t) => typeof t === 'string'));
});

test('single object input: dropped on missing-required, no crash', async () => {
    const validate = () => [{
        instancePath: '',
        schemaPath: '#/required',
        keyword: 'required',
        params: { missingProperty: 'name' },
        message: "must have required property 'name'",
    }];
    const { pushFn } = makeMockPush({ validate });
    const res = await safePushData({ age: 99 }, { pushFn });
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
        () => safePushData([{ x: 1 }], { pushFn }),
        /boom/,
    );
});

test('empty array input: returns immediately, no push call', async () => {
    let called = false;
    const pushFn = async () => { called = true; };
    const res = await safePushData([], { pushFn });
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
    await safePushData(original, { pushFn });
    assert.deepEqual(original, snapshot);
});

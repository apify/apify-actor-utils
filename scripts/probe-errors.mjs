// Probe Apify dataset push errors against a real schema-bound dataset.
//
// Used during development to lock down the exact shape of the
// schema-validation error that the API returns. Kept in the repo as a
// reference / regression check — re-run if Apify ever changes the error
// envelope.
//
// Usage:
//   APIFY_TOKEN=... DATASET_ID=<schema-bound-dataset> node scripts/probe-errors.mjs
import { writeFileSync } from 'node:fs';

import { ApifyClient } from 'apify-client';

const TOKEN = process.env.APIFY_TOKEN;
const { DATASET_ID } = process.env;
if (!TOKEN || !DATASET_ID) {
    console.error('Set APIFY_TOKEN and DATASET_ID env vars first.');
    process.exit(1);
}

const client = new ApifyClient({ token: TOKEN });
const ds = client.dataset(DATASET_ID);

const cases = [
    {
        name: 'single-invalid (missing required field "name")',
        items: { age: 30 },
    },
    {
        name: 'single-invalid (wrong type on "age")',
        items: { name: 'Bob', age: 'thirty' },
    },
    {
        name: 'array-mixed (1 valid, 2 invalid)',
        items: [{ name: 'Valid', age: 25 }, { age: 99 }, { name: '', age: -1 }],
    },
    {
        name: 'array-all-invalid',
        items: [{ age: 30 }, { name: 123, age: 'old' }, { name: 'X', age: 200 }],
    },
    {
        name: 'array-tags-wrong-type',
        items: [
            { name: 'TagsBad', age: 20, tags: 'not-an-array' },
            { name: 'TagsBad2', age: 21, tags: [123, 'ok'] },
        ],
    },
];

const captured = [];

for (const c of cases) {
    console.log('\n=================');
    console.log('CASE:', c.name);
    try {
        const res = await ds.pushItems(c.items);
        console.log('SUCCESS (unexpected):', res);
        captured.push({ case: c.name, ok: true });
    } catch (err) {
        console.log('ERROR class:', err?.constructor?.name);
        console.log('ERROR keys :', Object.keys(err));
        console.log('err.type   :', err.type);
        console.log('err.message:', err.message);
        console.log('err.statusCode:', err.statusCode);
        console.log('err.clientMethod:', err.clientMethod);
        console.log('err.attempt:', err.attempt);
        console.log('err.httpMethod:', err.httpMethod);
        console.log('err.path:', err.path);
        console.log('err.data:', JSON.stringify(err.data, null, 2));
        captured.push({
            case: c.name,
            type: err.type,
            message: err.message,
            statusCode: err.statusCode,
            data: err.data,
            errorKeys: Object.keys(err),
        });
    }
}

writeFileSync('/tmp/error-probe.json', JSON.stringify(captured, null, 2));
console.log('\nWrote /tmp/error-probe.json');

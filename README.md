# safePushData

Library wrapper that survives Apify dataset-schema validation failures. When
an upstream data source produces an item that doesn't match the dataset's
JSON schema, the platform rejects the **entire batch** with a 400 error —
losing every other valid item in that push. `safePushData` parses the
validation error, strips the offending fields, and retries.

## Why

If your Actor declares `.actor/dataset_schema.json` with a `fields`
definition, Apify validates every pushed item with AJV. Validation is
all-or-nothing per request:

```js
await Actor.pushData([validItem, invalidItem, validItem]); // throws — 0 items pushed
```

The thrown `ApifyApiError` looks like this:

```js
{
    statusCode: 400,
    type: 'schema-validation-error',
    message: 'Schema validation failed',
    data: {
        invalidItems: [
            {
                itemPosition: 1,
                validationErrors: [
                    { instancePath: '/age', keyword: 'type', params: { type: 'integer' }, message: 'must be integer' },
                ],
            },
        ],
    },
}
```

`safePushData` parses this, cleans the bad rows, and retries with what's
left.

## Usage

```js
import { Actor } from 'apify';
import { safePushData } from 'claude-safe-pushdata';

await Actor.init();

const result = await safePushData(items, {
    pushFn: (batch) => Actor.pushData(batch),
});

console.log(result);
// { pushed: 2, dropped: [...], attempts: 2 }
```

Accepts a single item or an array, mirroring `Actor.pushData`.

`pushFn` is required and intentionally not bundled with the library: this
repo's CI (`scripts/check-pushdata.mjs`) enforces that `.pushData` never
appears inside the library source, so the binding lives at the call site.
For a non-default dataset, pass
`(b) => client.dataset(id).pushItems(b)` instead.

### How cleaning works

For each invalid item, the wrapper inspects every AJV error:

| Error                                                | Action                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `required` at the root (`instancePath: ''`)          | Item is unsalvageable → dropped.                                    |
| `additionalProperties` at the root                   | Delete the unknown property.                                        |
| `type` at the root (item itself wrong type)          | Item is unsalvageable → dropped.                                    |
| Anything else (`type`, `enum`, `minLength`, …)       | Delete the field (or splice the array element) at `instancePath`.   |

After cleaning, the batch is pushed again. The loop is necessary because
deleting a field can expose a *new* `required` error on the next push — the
first response only reports the errors AJV saw on that pass. Each round
chases the next layer of errors, with `maxAttempts` (default 5) as a safety
net.

### Options

| Option         | Type                                         | Default | Notes                                                  |
| -------------- | -------------------------------------------- | ------- | ------------------------------------------------------ |
| `pushFn`       | `(items: unknown[]) => Promise<unknown>`     | —       | Required. See above.                                   |
| `maxAttempts`  | `number`                                     | `5`     | Hard cap on retries.                                   |

### Return shape

```ts
{
    pushed: number,                                       // items that landed
    dropped: Array<{ item: unknown, errors: object[] }>,  // items we gave up on
    attempts: number,                                     // pushFn calls made
}
```

## CI

`scripts/check-pushdata.mjs` greps `src/` and `test/` for any `.pushData(`
call expression. If one is found, it prints the offending lines and exits
non-zero. The library itself never imports Apify SDK — callers own that.

```
npm run ci   # check:pushdata + tests
```

## Layout

```
.
├── src/safePushData.js          # the library
├── test/safePushData.test.mjs   # node:test suite (no Apify install needed)
├── scripts/
│   ├── check-pushdata.mjs       # CI guard against direct .pushData() calls
│   └── probe-errors.mjs         # reference: re-derive the API error shape
└── package.json
```

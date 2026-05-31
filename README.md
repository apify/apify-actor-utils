# safePushData

Wrapper around `Actor.pushData` that survives Apify dataset-schema validation
failures. When an upstream data source produces an item that doesn't match the
dataset's JSON schema, the platform rejects the **entire batch** with a 400
error — losing every other valid item in that push. `safePushData` parses the
validation error, removes (or cleans) the offending items, and retries.

## Why

If your Actor declares `.actor/dataset_schema.json` with a `fields` definition,
Apify validates every pushed item with AJV. Validation is all-or-nothing per
request:

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
                itemPosition: 1, // index in the submitted array
                validationErrors: [
                    {
                        instancePath: '/age',
                        schemaPath: '#/properties/age/type',
                        keyword: 'type',
                        params: { type: 'integer' },
                        message: 'must be integer',
                    },
                ],
            },
        ],
    },
}
```

`safePushData` parses this, decides what to do with the bad rows, and retries
with what's left.

## Usage

```js
import { Actor } from 'apify';
import { safePushData } from './safePushData.js';

await Actor.init();

const result = await safePushData(items, {
    strategy: 'drop',              // 'drop' (default) or 'cleanFields'
    maxAttempts: 5,                // safety cap; healthy runs finish in 2
    onDropped: async (drops) => {  // archive items we couldn't push
        await Actor.setValue('dropped-items', drops);
    },
});

console.log(result);
// { pushed: 2, dropped: [...], cleaned: [...], attempts: 2 }
```

Accepts a single item or an array, mirroring `Actor.pushData`.

### Strategies

| Strategy        | What it does                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `drop`          | Removes every item that has any validation error and retries with the valid remainder. Default.                                             |
| `cleanFields`   | Deletes the offending field (or the offending array element) from the item, then retries. Falls back to dropping when a required field is missing or the root type is wrong. |

Pick `cleanFields` when partial data is better than no data; pick `drop` when
items are atomic and a bad field means the whole row is suspect.

### Options

| Option         | Type                  | Default        | Notes                                                                       |
| -------------- | --------------------- | -------------- | --------------------------------------------------------------------------- |
| `strategy`     | `'drop'` \| `'cleanFields'` | `'drop'` | See above.                                                                  |
| `maxAttempts`  | `number`              | `5`            | Hard cap on retries. The API returns all bad items in one shot, so healthy runs use 2 attempts; the rest is insurance against pathological schemas. |
| `onDropped`    | `(drops) => Promise`  | —              | Called once at the end with everything that couldn't be pushed. Each entry is `{ item, errors }`. |
| `silent`       | `boolean`             | `false`        | Suppress logger output.                                                     |
| `pushFn`       | `(batch) => Promise`  | `Actor.pushData` | Override the push call — useful for pushing to a non-default dataset (`pushFn: (b) => client.dataset(id).pushItems(b)`) or for tests. |
| `logger`       | `{ warning, error }`  | Apify SDK `log` | Override the logger.                                                        |

### Return shape

```ts
{
    pushed: number,                                       // items that landed
    dropped: Array<{ item: unknown, errors: object[] }>,  // items we gave up on
    cleaned: Array<{ item: unknown, errors: object[] }>,  // items modified before push
    attempts: number,                                     // pushData calls made
}
```

## Repository layout

```
.
├── .actor/
│   ├── actor.json            # actor manifest (points at dataset_schema)
│   ├── dataset_schema.json   # JSON schema the dataset enforces
│   └── input_schema.json     # input UI for the demo actor
├── src/
│   ├── safePushData.js       # the wrapper
│   └── main.js               # demo Actor entry point
├── scripts/
│   └── probe-errors.mjs      # reference script to inspect the API error shape
├── test/
│   └── safePushData.test.mjs # node:test suite (no Apify platform needed)
├── Dockerfile
└── package.json
```

## Running

**Unit tests** (no Apify account needed):

```
node --test test/safePushData.test.mjs
```

**Demo Actor on the Apify platform:**

```
apify push
apify call --input '{"strategy":"drop"}'        # or "cleanFields"
```

The demo pushes a mix of valid and intentionally invalid items and writes the
dropped rows to the key-value store under the `dropped-items` key.

**Re-probe the API error shape** (useful if Apify changes the envelope):

```
APIFY_TOKEN=<your-token> DATASET_ID=<schema-bound-dataset> node scripts/probe-errors.mjs
```

## What the demo proves

With the schema in `.actor/dataset_schema.json` and the 8-item batch in
`src/main.js`:

- **`drop`**: 2 items pushed (Alice, Frank), 6 dropped, 2 attempts.
- **`cleanFields`**: 4 items pushed (Alice, Carol with `tags` stripped, Eve
  with the bad `tags[0]` element spliced out, Frank), 4 dropped, 3 attempts.

The dropped items are archived to the key-value store with their original AJV
errors so nothing is silently lost.

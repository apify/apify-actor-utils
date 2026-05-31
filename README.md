# safePushData

TypeScript library wrapper that survives Apify dataset schema-validation
failures. When an upstream data source produces an item that doesn't match
the dataset's JSON schema, the platform rejects the **entire batch** with
a 400 error — losing every other valid item in that push. `safePushData`
parses the validation error, strips the offending fields, and retries.

## Usage

```ts
import { Actor } from 'apify';
import { safePushData } from 'claude-safe-pushdata';

await Actor.init();

const result = await safePushData(
    (batch) => Actor.pushData(batch),
    items,
);

console.log(result);
// { pushed: 2, dropped: [...], attempts: 2 }
```

Accepts a single item or an array. `pushFn` is the first positional arg
and is required — the library itself never imports the Apify SDK, and a
CI check forbids `.pushData(` from appearing anywhere in the source.

## Performance notes

The happy path is a single `try/await pushFn(items)` with **no extra
allocations** — no wrapper objects, no working copies, no maps. Only when
a `schema-validation-error` is caught does the wrapper materialise the
working state needed to clean and retry.

## How cleaning works

For each invalid item, the wrapper inspects every AJV error:

| Error                                                | Action                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `required` at the root (`instancePath: ''`)          | Item is unsalvageable → dropped.                                    |
| `additionalProperties` at the root                   | Delete the unknown property.                                        |
| `type` at the root (item itself wrong shape)         | Item is unsalvageable → dropped.                                    |
| Anything else (`type`, `enum`, `minLength`, …)       | Delete the field, or splice the array element at `instancePath`.    |

The retry loop is necessary because deleting a field can expose a *new*
`required` error on the next push that the first response couldn't have
told us about. `maxAttempts` (default 5) caps the loop.

## Options

| Option         | Type                                         | Default | Notes                                                  |
| -------------- | -------------------------------------------- | ------- | ------------------------------------------------------ |
| `maxAttempts`  | `number`                                     | `5`     | Hard cap on retries.                                   |

## Return shape

```ts
interface SafePushDataResult<T> {
    pushed: number;
    dropped: { item: T; errors: ValidationError[] }[];
    attempts: number;
}
```

## CI

Run `npm run ci` (typecheck + push-data guard + tests). Highlights:

- `scripts/check-pushdata.mjs` greps `src/` and `test/` for any
  `.pushData(` call expression and fails if one exists.
- Tests run via Node 22.6+ `--experimental-strip-types`, no compile step.

## Layout

```
.
├── src/safePushData.ts          # the library
├── test/safePushData.test.ts    # node:test suite
├── scripts/
│   ├── check-pushdata.mjs       # CI guard against direct .pushData() calls
│   └── probe-errors.mjs         # reference: re-derive the API error shape
├── tsconfig.json
└── package.json
```

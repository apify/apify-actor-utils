# safePushData

TypeScript library wrapper that survives Apify dataset schema-validation
failures. When an upstream data source produces an item that doesn't match
the dataset's JSON schema, the platform rejects the **entire batch** with
a 400 error — losing every other valid item in that push. `safePushData`
parses the validation error, strips the offending fields, and retries.

## Usage

```ts
import { Actor } from 'apify';
import { safePushData } from 'apify-actor-utils';

await Actor.init();

const result = await safePushData((batch) => Actor.pushData(batch), items);

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

When the push fails with a `schema-validation-error`, the wrapper inspects
every AJV error per item:

| Error                                | Action                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `required` at the root               | Set the missing field to `null` and mark the path as a placeholder.                |
| `additionalProperties` at the root   | Delete the unknown property.                                                       |
| `type` / `format` / etc. at the root | Item itself is the wrong shape → dropped.                                          |
| Constraint on a **placeholder** path | Replace with a type-aware default (see below). If no default is known → dropped.   |
| Constraint on **user-supplied** data | Delete the field. If the schema later marks it required, a placeholder takes over. |

### Placeholder defaults

When a constraint fires on a path we placeholder'd ourselves, the wrapper
picks a value that should satisfy it:

| AJV keyword                                             | Placeholder value               |
| ------------------------------------------------------- | ------------------------------- |
| `type: string`                                          | `''`                            |
| `type: integer` / `number`                              | `0`                             |
| `type: boolean`                                         | `false`                         |
| `type: array`                                           | `[]`                            |
| `type: object`                                          | `{}`                            |
| `type: null`                                            | `null`                          |
| `minLength: N` / `maxLength`                            | `'_'.repeat(N)` / `''`          |
| `minimum: N` / `maximum`                                | `N`                             |
| `exclusiveMinimum: N` / `exclusiveMaximum`              | `N + 1` / `N - 1`               |
| `enum`                                                  | First allowed value             |
| `format: email` / `uri` / `date` / `date-time` / `uuid` | a static valid example for each |
| Anything else (`pattern`, custom formats…)              | Item is dropped.                |

The retry loop chases one layer of errors per round
(`required` → `type` → `minLength` → push) until either the push succeeds
or `maxAttempts` (default 5) is hit.

## Options

| Option        | Type     | Default | Notes                |
| ------------- | -------- | ------- | -------------------- |
| `maxAttempts` | `number` | `5`     | Hard cap on retries. |

## Return shape

```ts
interface SafePushDataResult<T> {
    pushed: number;
    dropped: { item: T; errors: ValidationError[] }[];
    attempts: number;
}
```

## CI

Run `npm run ci` (typecheck + lint + format check + push-data guard + tests).
Highlights:

- `scripts/check-pushdata.mjs` greps `src/` and `test/` for any
  `.pushData(` call expression and fails if one exists.
- The package is consumed as compiled output (`dist/`), so `npm test`
  builds via `tsc` first, then runs the compiled suite under `node --test`.

## Layout

```
.
├── index.ts                      # package entry point, re-exports src/
├── src/safePushData.ts           # the library
├── test/safePushData.test.ts     # node:test suite
├── scripts/
│   ├── check-pushdata.mjs        # CI guard against direct .pushData() calls
│   └── probe-errors.mjs          # reference: re-derive the API error shape
├── tsconfig.json
└── package.json
```

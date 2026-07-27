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
// { pushedCount: 2, droppedItems: [...], attemptCount: 2, pushResult: undefined }
```

Accepts a single item or an array. `pushFn` is the first positional arg
and is required — the library itself never imports the Apify SDK, and a
CI check forbids `.pushData(` from appearing anywhere in the source.

Whatever `pushFn` resolves to comes back as `pushResult`, so a push
function with a meaningful return value stays usable:

```ts
const { pushResult } = await safePushData((batch) => client.dataset(id).pushItems(batch), items);
```

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
| `required` (at any depth)            | Set the missing field to `null` and mark the path as a placeholder.                |
| `additionalProperties` (any depth)   | Delete the unknown property.                                                       |
| `type` / `format` / etc. at the root | Item itself is the wrong shape → dropped.                                          |
| Constraint on a **placeholder** path | Replace with a type-aware default (see below). If no default is known → dropped.   |
| Constraint on **user-supplied** data | Delete the field. If the schema later marks it required, a placeholder takes over. |
| Nothing on the item was actionable   | Item is dropped — an unchanged item would fail identically on the next push.       |

### Placeholder defaults

When a constraint fires on a path we placeholder'd ourselves, the wrapper
picks a value that should satisfy it. We deliberately only fill in the four
**empty** values below — they're unambiguously empty and can't be mistaken
for real data:

| AJV keyword    | Placeholder value |
| -------------- | ----------------- |
| `type: string` | `''`              |
| `type: array`  | `[]`              |
| `type: object` | `{}`              |
| `type: null`   | `null`            |
| Anything else  | Item is dropped.  |

When a field allows **multiple types** (e.g. `['string', 'null']`), the
wrapper always picks `null` — it's the cleanest placeholder because it
commits to no concrete value at all.

Everything else (`enum`, `format`, `minLength`, numeric bounds, `type:
integer` / `number` / `boolean`, …) is **not** placeholdered: a made-up
email, a first-enum-value, or a fabricated number would silently poison the
customer's dataset with plausible-looking junk, so the item is dropped
instead.

The retry loop chases one layer of errors per round
(`required` → `type` → push) until either the push succeeds
or `maxAttempts` (default 5) is hit.

### When the attempt cap is hit

Items still failing on the last allowed attempt are dropped — but the rest
of the batch is **not** lost with them. Because a rejected push stores
nothing at all, the wrapper drops the incurable items and then makes one
final push with the survivors, which the API already validated in the
previous round. That final push is counted in `attemptCount`, so a run that
exhausts `maxAttempts: 5` can report `attemptCount: 6`.

## Logging

Every failed round logs which fields went wrong, so you can fix the schema
(or the scraper) without digging through the returned `droppedItems`:

```
safePushData: schema validation failed on attempt 1: 12 invalid item(s); repaired fields: /age (type), /name (required), /tags/[] (type); dropped 2 item(s) on unfixable fields: /email (format); retrying with 10 item(s).
safePushData: gave up after 5 attempts; dropped 3 item(s) still failing on fields: /sku (pattern); pushing the 9 valid item(s) left.
```

The field list is a **set**, not a per-item breakdown — one bad field
usually shows up on many items in a batch, and knowing which item had which
problem rarely changes what you do about it. Array indices collapse
(`/tags/0`, `/tags/7` → `/tags/[]`) for the same reason, and the list is
capped at 20 entries with the rest reported as `(+N more)`.

## Options

| Option        | Type     | Default | Notes                                                          |
| ------------- | -------- | ------- | -------------------------------------------------------------- |
| `maxAttempts` | `number` | `5`     | Cap on repair rounds, plus the final salvage push if it's hit. |

## Return shape

Names say what they hold: `*Count` is a number, `*Items` is an array of
objects.

```ts
interface SafePushDataResult<T, R = unknown> {
    /** How many of the caller's items made it into the dataset. */
    pushedCount: number;
    /** The items we couldn't repair, each with the errors that doomed it. */
    droppedItems: { item: T; errors: ValidationError[] }[];
    /** How many times `pushFn` was actually called. */
    attemptCount: number;
    /** What the successful `pushFn` call resolved to; absent if none did. */
    pushResult?: R;
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

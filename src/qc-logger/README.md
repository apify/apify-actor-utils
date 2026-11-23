# qc-logger

Structured logging helpers for tracing an Actor run's quality: checkpoints,
assertions, and truthy/falsy/nullish checks that all emit through
[`@apify/log`](https://www.npmjs.com/package/@apify/log) in one canonical
format, so the lines are greppable and parseable downstream (e.g. in Mezmo).

## Log format

Every line emitted by this module follows the same shape:

```
qc:<verb>:<key>
```

- `verb` identifies which helper emitted the line (`checkpoint`, `assert`, `is:falsy`, `is:truthy`, `is:nullish`, `is:defined`).
- `key` is a caller-supplied identifier, lowercased and normalized to `[a-z0-9-]` (invalid/empty keys become `invalid-key`).

Each call also attaches structured fields (`level`, `qcKey`, `qcVerb`, plus any caller-supplied `ctx`) to the log entry via `@apify/log`, so the message text and the structured data stay in sync.

## Usage

```ts
import { assert, checkpoint, checkpointIf, isDefined, isFalsy, isNullish, isTruthy } from '@apify/actor-utils/qc-logger';
```

See each helper below for a usage example.

## API

### `checkpoint(key, ctx?)`

Logs an `info`-level marker meaning "this point in the run was reached." Unconditional — always emits — so it's meant for tracing progress through a run rather than flagging a problem.

```ts
checkpoint('started');
// logs `qc:checkpoint:started`

await doWork();
checkpoint('work-done', { itemsProcessed: 42 });
// logs `qc:checkpoint:work-done` with { itemsProcessed: 42 }
```

### `checkpointIf(cond, key, ctx?)`

Same as `checkpoint`, but only emits when `cond` is truthy. Convenience wrapper for guarding a marker without an explicit `if` at the call site.

```ts
checkpointIf(items.length === 0, 'empty-batch');
// logs `qc:checkpoint:empty-batch` only when the batch is empty

checkpointIf(retries > 3, 'many-retries', { retries });
// logs `qc:checkpoint:many-retries` with { retries } only past the threshold
```

### `assert(cond, key, ctx?, ErrorCtor?)`

Asserts `cond` is truthy. If not, logs an `error`-level line (`qc:assert:<key>`) and throws. Throws a plain `Error` by default; pass a custom constructor (e.g. Crawlee's `NonRetryableError` or `CriticalError`) to control what the failure means to the crawler. Narrows the type of `cond` via a TypeScript assertion signature.

```ts
import { NonRetryableError } from '@crawlee/core';

const requestHandler: PlaywrightCrawlingFunction = async ({ request }) => {
    const { detailUrl } = request.userData as { detailUrl?: string };

    assert(detailUrl, 'detail-url-in-user-data', { url: request.url }, NonRetryableError);
    // detailUrl is now guaranteed to be a truthy `string`. If it's missing,
    // `qc:assert:detail-url-in-user-data` is logged at `error` level and the
    // request fails as non-retryable — the enqueue step never set it, so
    // retrying the same request would fail identically every time.
};
```

### `isFalsy` / `isTruthy` / `isNullish` / `isDefined`

Each checks `value` against a condition, logs a `warning`-level line when the check matches (`qc:is:falsy:<key>`, `qc:is:truthy:<key>`, `qc:is:nullish:<key>`, `qc:is:defined:<key>`), and returns whether it matched. Meant to be used inline in an `if` for an early return/continue.

`isFalsy`/`isTruthy` treat `0`, `''`, and `false` as matches, so they're best reserved for values that are never legitimately falsy (a non-empty label, a flag) — for something like a numeric price, where `0` can be a real value, use `isNullish`/`isDefined` instead so a real `0` doesn't get flagged as missing:

```ts
function processItem(item: { title?: string; price?: number }) {
    if (isFalsy(item.title, 'item-title')) {
        // item.title is falsy (undefined or ''); a `warning` was logged as
        // `qc:is:falsy:item-title` — bail out rather than push an untitled item.
        return;
    }

    if (isNullish(item.price, 'item-price')) {
        // item.price is null/undefined (0 is fine); a `warning` was logged as
        // `qc:is:nullish:item-price`.
        return;
    }

    // item.title is now a truthy `string`, item.price a defined `number`.
    return { title: item.title, price: item.price };
}
```

All four are typed with overloads that narrow the return type — and the value's type — based on what's statically known about the input. A call that's redundant given the compiler's own narrowing (e.g. `isFalsy` on a value already known to be truthy) resolves to a literal `true`/`false`, producing a branch with a constant condition. Enable [`@typescript-eslint/no-unnecessary-condition`](https://typescript-eslint.io/rules/no-unnecessary-condition/) (or its [oxlint equivalent](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-unnecessary-condition.html), which needs type-aware linting) to surface that as a lint error instead of a silent dead branch.

## Failure isolation

`emit` (the shared internals behind every helper here) wraps its own logging in a `try`/`catch` — a key-normalization bug or a `@apify/log` failure can never break the run it's trying to observe. On error it falls back to logging `qc:unknown:qc-error-generating-key`.

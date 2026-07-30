# type-utils

`@apify/actor-utils/type-utils` is a separate export holding small,
dependency-free TypeScript helpers — one runtime function and a set of
type-level operators. It imports nothing, so pulling it in costs nothing
beyond the helpers themselves.

```ts
import { unreachable } from '@apify/actor-utils/type-utils';
import type { Truthy, Falsy, Nullish, Defined } from '@apify/actor-utils/type-utils';
```

## `unreachable(x: never): never`

Asserts a code path can't be reached, giving you a compile-time
exhaustiveness check. Pass a value that should be `never` — if a new union
variant is added but not handled, `x` is no longer `never` and the call
fails to compile. At runtime it always throws.

```ts
type Shape = 'circle' | 'square';

function area(shape: Shape): number {
    switch (shape) {
        case 'circle':
            return Math.PI;
        case 'square':
            return 1;
        default:
            // Compile-time error here if a new Shape variant is added.
            return unreachable(shape);
    }
}
```

## Type-level helpers

| Type         | Result                                                           |
| ------------ | ---------------------------------------------------------------- |
| `Falsy`      | `false \| 0 \| '' \| null \| undefined` — the falsy primitives.  |
| `Nullish`    | `null \| undefined`.                                             |
| `Defined<T>` | `T` with `null` and `undefined` removed (`Exclude<T, Nullish>`). |
| `Truthy<T>`  | `T` narrowed to only its truthy members.                         |

```ts
type A = Truthy<string | undefined>; // string
type B = Truthy<0 | 1 | 2>; // 1 | 2
type C = Truthy<'' | 'hello'>; // 'hello'
type D = Truthy<false>; // never
```

`Truthy` checks each falsy literal individually rather than using
`Exclude<T, Falsy>`, so a broad type like `boolean` or `number` is preserved
instead of collapsed — `boolean` only loses `false` when `false` is the
whole type, not when it's one member of `boolean`. Object types
short-circuit first, so `''` / `0` never accidentally match structural
(`{}`) types.

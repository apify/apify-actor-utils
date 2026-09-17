# `partialSafeParse`

Like `schema.safeParse(data)`, but instead of giving up on the first invalid field, it recurses into objects, arrays and tuples and keeps whatever it validates. All while reporting all errors found along the way.

```ts
import { z } from 'zod';
import { partialSafeParse } from '@apify/actor-utils/zod';

const ResponseSchema = z.object({
    name: z.string(),
    price: z.number(),
    inventory: z.object({ warehouse: z.string(), quantity: z.number() }),
});

const result = partialSafeParse(ResponseSchema, {
    name: 'John',
    price: 'thirty', // wrong type
    inventory: { warehouse: 'Main', quantity: 'ten' }, // quantity is wrong type
});

// result.success === false
// result.data === { name: 'John', inventory: { warehouse: 'Main' } }
// result.error is a ZodError with issues at ['price'] and ['inventory', 'quantity']
```

On success, the result is a plain `{ success: true, data }` matching `schema.safeParse`'s output. `data` is partial and typed as `RecursivePartial<T>` when something failed to parse.

## Real-world example

In practice you log the error (if any) for visibility and keep going with whatever `data` you got, since a partial result is still more useful than nothing:

```ts
import { log } from '@apify/log';
import { z } from 'zod';
import { partialSafeParse } from '@apify/actor-utils/zod';

const ResponseSchema = z.object({
    name: z.string(),
    price: z.number(),
    inventory: z.object({ warehouse: z.string(), quantity: z.number() }),
});

type Product = {
    name: string | null;
    price: number | null;
    warehouse: string | null;
    quantity: number | null;
};

function parseResponse(response: unknown): Product {
    const { data, error } = partialSafeParse(ResponseSchema, response);
    if (error) log.warning('Failed to parse Response', { error: z.prettifyError(error) });

    return {
        name: data?.name ?? null,
        price: data?.price ?? null,
        warehouse: data?.inventory?.warehouse ?? null,
        quantity: data?.inventory?.quantity ?? null,
    };
}
```

This usually results in your codebase having almost all fields nullable on output. It might sounds bad at first, but this is actually a good thing - it means that the codebase is ready to gracefully handle missing data fields properly without crashing. And you ensure that the scraper can function to the fullest even if things go wrong :)

### Not parsing the whole response at once

Sometimes parsing the response in multiple steps is easier and produces nicer code. It depends heavily on the specific case. The most common one may be parsing unions and it serves as a good example. If an array's elements can be of multiple types, it's usually easier to parse them individually:

```ts
import { log } from '@apify/log';
import { z } from 'zod';
import { partialSafeParse } from '@apify/actor-utils/zod';

const ResponseSchema = z.array(z.looseObject({ type: z.string() }));
const ProductSchema = z.object({ title: z.string(), id: z.string() });
const OfferSchema = z.object({ productId: z.string(), price: z.number() });

type Product = { title: string | null; id: string | null };
type Offer = { productId: string | null; price: number | null };

const ELEMENT_PARSERS = { PRODUCT: parseProduct, OFFER: parseOffer } as const;

function parseResponse(response: unknown): (Product | Offer)[] {
    const { data, error } = partialSafeParse(ResponseSchema, response);
    if (error) log.warning('Failed to parse response', { error: z.prettifyError(error) });
    if (!data) return [];

    return data
        .map((element) => (element?.type ? parseElement(element, element.type) : null))
        .filter((element) => !!element);
}

function parseElement(element: unknown, type: string): Product | Offer | null {
    const matchingParser = ELEMENT_PARSERS[type as keyof typeof ELEMENT_PARSERS];
    if (!matchingParser) {
        log.warning('No matching parser found for element type', { type });
        return null;
    }

    return matchingParser(element);
}

function parseProduct(product: unknown): Product {
    const { data, error } = partialSafeParse(ProductSchema, product);
    if (error) log.warning('Failed to parse product', { error: z.prettifyError(error) });

    return { title: data?.title ?? null, id: data?.id ?? null };
}

function parseOffer(offer: unknown): Offer {
    const { data, error } = partialSafeParse(OfferSchema, offer);
    if (error) log.warning('Failed to parse offer', { error: z.prettifyError(error) });

    return { productId: data?.productId ?? null, price: data?.price ?? null };
}
```

## Parsing rules

| Schema type                                                                 | Behavior on invalid data                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Object                                                                      | Each key is parsed independently; failing keys are dropped, passing keys are kept. |
| Array / tuple                                                               | Each item is parsed independently and kept if it passes, by index.                 |
| Primitive                                                                   | No partial value is possible, the field is dropped.                                |
| `.optional()` / `.nullable()` / `.nullish()` / `.readonly()` / `.default()` | Unwrapped transparently, so the check above runs against the inner schema.         |

## Why not just `safeParse`?

`schema.safeParse` is all-or-nothing. One bad field somewhere in the response and it fails the whole thing.

`partialSafeParse` lets you take the fields that did parse and handle the fields for the ones that didn't, instead of discarding everything because of one bad field. All while giving you the errors for the failed fields.

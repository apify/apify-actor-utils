import { Actor, log } from 'apify';

import { safePushData } from './safePushData.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const strategy = input.strategy === 'cleanFields' ? 'cleanFields' : 'drop';

log.info(`Running safePushData demo with strategy="${strategy}".`);

// A representative mix: required-missing, type-wrong, value-out-of-range,
// array-element-of-wrong-type, plus a few valid items so we can verify
// they actually land in the dataset.
const items = [
    { name: 'Alice', age: 30, email: 'alice@example.com', tags: ['vip'] },
    { age: 99 },                                          // missing required `name`
    { name: 'Bob', age: 'old' },                          // type error on `age`
    { name: '', age: -1 },                                // minLength + minimum
    { name: 'Carol', age: 28, email: 'carol@example.com', tags: 'oops' }, // tags wrong type
    { name: 'Dave', age: 200 },                          // age above maximum
    { name: 'Eve', age: 22, tags: [123, 'mixed'] },      // tags items wrong type
    { name: 'Frank', age: 45 },
];

const result = await safePushData(items, {
    strategy,
    onDropped: async (drops) => {
        log.warning(`safePushData dropped ${drops.length} item(s); saving to KVS for inspection.`);
        await Actor.setValue('dropped-items', drops);
    },
});

log.info(
    `safePushData done. pushed=${result.pushed} dropped=${result.dropped.length} `
    + `cleaned=${result.cleaned.length} attempts=${result.attempts}`,
);

// Also demonstrate single-item usage:
log.info('Testing single-item push (invalid).');
const single = await safePushData(
    { age: 50 }, // missing required `name`
    { strategy, silent: true },
);
log.info(`single-item: pushed=${single.pushed} dropped=${single.dropped.length}`);

await Actor.exit();

import { NonRetryableError } from '@crawlee/core';
import type { ChargeResult } from 'apify';
import { Actor, log } from 'apify';
import { ApifyApiError } from 'apify-client';

/**
 * Wraps a push call, converting a dataset schema-validation failure into a
 * {@link NonRetryableError} instead of a retryable one — a schema mismatch
 * will never fix itself on retry, so retrying just burns compute.
 */
async function wrapPushData<R>(pushDataFn: () => Promise<R>): Promise<R> {
    try {
        return await pushDataFn();
    } catch (error) {
        if (!(error instanceof ApifyApiError) || !Array.isArray(error.data?.invalidItems)) {
            throw error;
        }
        const msg = 'Dataset validation failed';
        for (const { validationErrors } of error.data.invalidItems) {
            log.error(msg, { msg, error: `${error}`, validationErrors });
        }
        throw new NonRetryableError(msg);
    }
}

/**
 * Pushes to the default dataset, or a named dataset when `alias` is given,
 * converting a schema-validation failure into a {@link NonRetryableError}
 * instead of leaving it to be retried.
 *
 * @param data - A single item or array of items to push.
 * @param options.alias - Alias of the dataset to push to, opened via {@link Actor.openDataset}.
 *   Omit to push to the default dataset. Does not charge — call {@link Actor.charge}
 *   yourself afterwards if the push should be billable.
 *
 * @example
 * ```ts
 * await safePushData(item);
 * await safePushData(report, { alias: 'competitorAnalysis' });
 * ```
 */
export async function safePushData<T extends object>(
    data: T | T[],
    options?: { alias: string; eventName?: never },
): Promise<void>;
/**
 * Pushes to the default dataset and atomically charges for `eventName`, via
 * {@link Actor.pushData}'s built-in pay-per-event support. Converts a
 * schema-validation failure into a {@link NonRetryableError} instead of
 * leaving it to be retried.
 *
 * @param data - A single item or array of items to push.
 * @param options.eventName - Pay-per-event event name to charge for this push.
 * @returns The {@link ChargeResult}, e.g. to check `chargeableWithinLimit` and decide whether to keep scraping.
 *
 * @example
 * ```ts
 * const { chargeableWithinLimit } = await safePushData(item, { eventName: 'result-scraped' });
 * ```
 */
export async function safePushData<T extends object>(
    data: T | T[],
    options: { eventName: string; alias?: never },
): Promise<ChargeResult>;
export async function safePushData<T extends object>(
    data: T | T[],
    options?: { alias?: string; eventName?: string },
): Promise<ChargeResult | void> {
    const { alias, eventName } = options ?? {};

    // Default dataset: Actor.pushData(data, eventName) already pushes and
    // charges atomically, so delegate to it as-is instead of reimplementing charging.
    if (!alias) {
        if (eventName) {
            return wrapPushData(async () => Actor.pushData(data, eventName));
        }
        return wrapPushData(async () => Actor.pushData(data));
    }

    // Named dataset: charging is handled by the caller — call Actor.charge() themselves after this push.
    const dataset = await Actor.openDataset<T>({ alias });
    return wrapPushData(async () => {
        await dataset.pushData(data);
    });
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { safePushData } from '../../src/gteam-internal/index.js';

vi.mock('apify', () => ({
    Actor: {
        pushData: vi.fn(),
        openDataset: vi.fn(),
        charge: vi.fn(),
    },
    log: {
        error: vi.fn(),
    },
}));

vi.mock('apify-client', () => {
    class ApifyApiError extends Error {
        data: unknown;

        constructor(message: string) {
            super(message);
            this.name = 'ApifyApiError';
        }
    }
    return { ApifyApiError };
});

vi.mock('@crawlee/core', () => {
    class NonRetryableError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'NonRetryableError';
        }
    }
    return { NonRetryableError };
});

// Import after mocks are defined so vi.mocked() works
const { Actor } = await import('apify');
const { ApifyApiError } = await import('apify-client');
const { NonRetryableError } = await import('@crawlee/core');

// The real ApifyApiError takes (response, attempt); the mock above takes
// just a message. Cast the constructor to the mock's actual runtime shape
// instead of fighting the real package's .d.ts on every call site.
const MockApifyApiError = ApifyApiError as unknown as new (message: string) => Error & { data: unknown };
function makeApiError(message: string, data: unknown): Error & { data: unknown } {
    const error = new MockApifyApiError(message);
    error.data = data;
    return error;
}

describe('safePushData', () => {
    let mockDataset: { pushData: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        mockDataset = { pushData: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(Actor.pushData).mockResolvedValue(undefined as never);
        vi.mocked(Actor.openDataset).mockResolvedValue(mockDataset as never);
        vi.mocked(Actor.charge).mockResolvedValue({
            chargeableWithinLimit: {},
            eventChargeLimitReached: false,
            chargedCount: 1,
        } as never);
    });

    describe('default dataset (no alias)', () => {
        it('delegates to Actor.pushData(data) when no options given', async () => {
            const data = [{ id: 1 }, { id: 2 }];
            await safePushData(data);
            expect(Actor.pushData).toHaveBeenCalledWith(data);
            expect(Actor.openDataset).not.toHaveBeenCalled();
        });

        it('delegates to Actor.pushData(data, eventName) when eventName given', async () => {
            const data = [{ id: 1 }];
            await safePushData(data, { eventName: 'place-scraped' });
            expect(Actor.pushData).toHaveBeenCalledWith(data, 'place-scraped');
        });

        it('returns the ChargeResult from Actor.pushData', async () => {
            const chargeResult = { chargeableWithinLimit: {}, eventChargeLimitReached: false, chargedCount: 2 };
            vi.mocked(Actor.pushData).mockResolvedValue(chargeResult as never);
            const result = await safePushData([{ id: 1 }], { eventName: 'place-scraped' });
            expect(result).toBe(chargeResult);
        });
    });

    describe('named dataset (alias given)', () => {
        it('opens the aliased dataset and pushes to it', async () => {
            const data = [{ id: 1 }];
            await safePushData(data, { alias: 'myDataset' });
            expect(Actor.openDataset).toHaveBeenCalledWith({ alias: 'myDataset' });
            expect(mockDataset.pushData).toHaveBeenCalledWith(data);
            expect(Actor.pushData).not.toHaveBeenCalled();
        });

        it('never charges on an aliased push — the caller owns Actor.charge()', async () => {
            await safePushData([{ id: 1 }], { alias: 'ds' });
            expect(Actor.charge).not.toHaveBeenCalled();
        });

        it('returns void for an aliased push', async () => {
            const result = await safePushData([{ id: 1 }], { alias: 'ds' });
            expect(result).toBeUndefined();
        });
    });

    describe('error handling', () => {
        it('wraps ApifyApiError with invalidItems into NonRetryableError (default dataset)', async () => {
            const apiError = makeApiError('Validation failed', {
                invalidItems: [{ validationErrors: ['field required'] }],
            });
            vi.mocked(Actor.pushData).mockRejectedValueOnce(apiError as never);

            await expect(safePushData([{ id: 1 }])).rejects.toBeInstanceOf(NonRetryableError);
        });

        it('wraps ApifyApiError with invalidItems into NonRetryableError (named dataset)', async () => {
            const apiError = makeApiError('Validation failed', {
                invalidItems: [{ validationErrors: ['field required'] }],
            });
            mockDataset.pushData.mockRejectedValueOnce(apiError);

            await expect(safePushData([{ id: 1 }], { alias: 'ds' })).rejects.toBeInstanceOf(NonRetryableError);
        });

        it('rethrows ApifyApiError without invalidItems unchanged', async () => {
            const apiError = makeApiError('Not found', {});
            vi.mocked(Actor.pushData).mockRejectedValueOnce(apiError as never);

            await expect(safePushData([{ id: 1 }])).rejects.toBeInstanceOf(ApifyApiError);
        });

        it('rethrows ApifyApiError without invalidItems unchanged (named dataset)', async () => {
            const apiError = makeApiError('Not found', {});
            mockDataset.pushData.mockRejectedValueOnce(apiError);

            await expect(safePushData([{ id: 1 }], { alias: 'ds' })).rejects.toBeInstanceOf(ApifyApiError);
        });

        it('rethrows ApifyApiError where invalidItems is not an array unchanged', async () => {
            const apiError = makeApiError('Bad request', { invalidItems: 'not-an-array' });
            vi.mocked(Actor.pushData).mockRejectedValueOnce(apiError as never);

            await expect(safePushData([{ id: 1 }])).rejects.toBeInstanceOf(ApifyApiError);
        });

        it('rethrows generic errors unchanged', async () => {
            const err = new Error('Network error');
            vi.mocked(Actor.pushData).mockRejectedValueOnce(err as never);

            await expect(safePushData([{ id: 1 }])).rejects.toBe(err);
        });

        it('wraps a failing aliased push and never charges', async () => {
            const apiError = makeApiError('Validation failed', {
                invalidItems: [{ validationErrors: ['field required'] }],
            });
            mockDataset.pushData.mockRejectedValueOnce(apiError);

            await expect(safePushData([{ id: 1 }], { alias: 'ds' })).rejects.toThrow();
            expect(Actor.charge).not.toHaveBeenCalled();
        });
    });
});

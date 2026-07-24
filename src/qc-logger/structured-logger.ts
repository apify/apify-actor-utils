import log from '@apify/log';

export type Ctx = Record<string, unknown>;

/**
 * Keys are part of the log line's parse structure (`qc:<verb>:<key>`)
 * Turns any string into a valid qc key.
 *
 * If a key is completely invalid, it is replaced with "invalid-key".
 */
function normalizeKey(key: string): string {
    return (
        String(key)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-|-$/g, '') || 'invalid-key'
    );
}

/**
 * Builds the canonical log line (`qc:<verb>:<key>`) without emitting it.
 * Exposed so callers (e.g. `assert`) can reuse the exact same message when
 * constructing an error to throw.
 */
export function formatMessage(qcVerb: string, rawKey: string): string {
    return `qc:${qcVerb}:${normalizeKey(rawKey)}`;
}

export function emit(level: 'debug' | 'info' | 'warning' | 'error', qcVerb: string, rawKey: string, ctx?: Ctx): string {
    let message: string;
    try {
        const qcKey = normalizeKey(rawKey);
        message = formatMessage(qcVerb, rawKey);
        // Caller ctx is spread first so it can never clobber the canonical fields.
        // Run/actor identity is not attached here — Mezmo enriches lines with it.
        log[level](message, { ...ctx, level, qcKey, qcVerb });
        return message;
    } catch {
        // Telemetry must never break a run.
        message ??= `qc:unknown:qc-error-generating-key`;
        return message;
    }
}

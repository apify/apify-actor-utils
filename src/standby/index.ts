/**
 * Generic Apify Standby-actor library — shared surface only.
 *
 * Synthesized from two independent standby implementations (contact-info/leads-enrichment
 * and Google-Maps-Reviews) that converged on the same core pieces. Everything actor-specific
 * (input schema fields beyond the base, the actual scrape/enrichment logic, response shaping)
 * stays in the consuming actor and plugs into `Standby`'s `handler`.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';

import { Actor, log } from 'apify';
import { z, type ZodType } from 'zod';

/** Internal failures are logged in full; callers only learn that retrying is worth it */
export const GENERIC_INTERNAL_ERROR = 'The request failed unexpectedly, please retry.';
const DEFAULT_API_BASE_URL = 'https://api.apify.com';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for invalid/unparseable input. Caught by the server to produce a 400 instead of a 500. */
export class ParseError extends Error {}

class ChargingError extends Error {}

// ---------------------------------------------------------------------------
// Request registry — exactly-once response tracking
// ---------------------------------------------------------------------------

/**
 * Friendly response-sending methods, available once a request has been claimed. Content-Type
 * is derived from `body`'s type rather than passed in explicitly, since it's always determined
 * by it anyway: a string is sent as-is as `text/plain`, anything else is JSON-stringified as
 * `application/json`.
 */
export class StandbyResponder {
    constructor(protected readonly res: ServerResponse) {}

    /** Responds 200 OK with `body`. */
    ok(body: unknown): void {
        this.send(200, body);
    }

    /** Responds 400 Bad Request with `body`. */
    badRequest(body: unknown): void {
        this.send(400, body);
    }

    /** Responds 500 Internal Server Error with `body`. */
    serverError(body: unknown): void {
        this.send(500, body);
    }

    /** Responds with an arbitrary status code and `body`. */
    custom(statusCode: number, body: unknown): void {
        this.send(statusCode, body);
    }

    private send(statusCode: number, body: unknown): void {
        if (typeof body === 'string') {
            this.res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
            this.res.end(body);
        } else {
            this.res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            this.res.end(JSON.stringify(body));
        }
    }
}

/** A single in-flight standby request being tracked between receipt and response. */
export class StandbyRequestData<TInput> {
    readonly standbyRequestId: string;
    readonly input: TInput;
    readonly response: StandbyResponder;

    constructor(standbyRequestId: string, input: TInput, serverResponse: ServerResponse) {
        this.standbyRequestId = standbyRequestId;
        this.input = input;
        this.response = new StandbyResponder(serverResponse);
    }
}

/**
 * Tracks in-flight standby requests and guarantees each one is answered exactly once.
 *
 * Claiming is the safety mechanism: whoever claims a request owns responding to it, so a
 * slow downstream side effect (e.g. charging) can't race a shutdown drain into writing two
 * responses to the same socket. No per-request timeout — a request stays in the registry
 * until the handler resolves it or a shutdown drain force-closes it.
 *
 * Also tracks received/processed counts for platform-visible status messages — both are
 * free byproducts of `register()`/`claim()`, the two events that already mark a request's
 * lifecycle endpoints, so there's no separate bookkeeping for callers to keep in sync.
 */
export class StandbyRequestRegistry<TInput> {
    private readonly requests = new Map<string, StandbyRequestData<TInput>>();
    private receivedCount = 0;
    private processedCount = 0;

    /** Number of requests currently in flight — used for shutdown draining and concurrency logging. */
    get size(): number {
        return this.requests.size;
    }

    /** Registers a newly received request. */
    register(standbyRequestId: string, input: TInput, serverResponse: ServerResponse): StandbyRequestData<TInput> {
        const data = new StandbyRequestData<TInput>(standbyRequestId, input, serverResponse);
        this.requests.set(standbyRequestId, data);
        this.receivedCount++;
        return data;
    }

    /**
     * Removes a request from the registry. Must be called before any non-idempotent
     * side effect (e.g. charging) and before writing the response. Returns undefined if the
     * request was already claimed (e.g. by a shutdown drain).
     */
    claim(standbyRequestId: string): StandbyRequestData<TInput> | undefined {
        const data = this.requests.get(standbyRequestId);
        if (!data) return undefined;
        this.requests.delete(standbyRequestId);
        this.processedCount++;
        return data;
    }

    /** Claims the request (if not already claimed) and writes a JSON response to it. */
    respond(standbyRequestId: string, statusCode: number, body: unknown): boolean {
        const data = this.claim(standbyRequestId);
        if (!data) return false;
        data.response.custom(statusCode, body);
        return true;
    }

    /**
     * Force-claims and answers every still-open request with the given status/body, so no
     * caller is left with a hanging or dropped connection. Called by `registerStandbyShutdown`
     * once a shutdown drain budget elapses.
     */
    drainAll(statusCode: number, body: unknown): void {
        for (const standbyRequestId of [...this.requests.keys()]) {
            this.respond(standbyRequestId, statusCode, body);
        }
    }

    /** e.g. "Processed 12/15 standby requests" — feed into Actor.setStatusMessage(...). */
    get statusMessage(): string {
        return `Processed ${this.processedCount}/${this.receivedCount} standby requests`;
    }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export type ShutdownEvent = 'migrating' | 'aborting' | 'SIGTERM';

/**
 * Drain budget in milliseconds per shutdown event — each leaves a different real deadline
 * before SIGKILL. No library-provided default: the right budget is deployment-specific, so
 * callers must supply all three explicitly.
 */
export type ShutdownDrainMillis = Record<ShutdownEvent, number>;

const SHUTDOWN_POLL_INTERVAL_MILLIS = 250;

/** Response body sent to any request still pending once its shutdown drain budget elapses. */
export interface StandbyShutdownResponseBody {
    error: 'actor_migration';
    errorDescription: string;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** Where standby input may arrive from, matching the documented Actor Standby contract. */
export type StandbyInputSource = 'query-json' | 'query-params' | 'body';

const MAX_INPUT_BODY_BYTES = 1024 * 1024; // 1 MB

/** Reads a request body up to `maxBytes`, throwing ParseError if the limit is exceeded. */
async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;

        req.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                req.destroy();
                reject(new ParseError(`Request body exceeds the maximum allowed size of ${maxBytes} bytes.`));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

function formatZodError(error: z.ZodError): string {
    return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Parses and validates a standby request's input against a Zod schema.
 *
 * Supports GET with `?input=<url-encoded-json>`, GET with discrete query params, and POST
 * with a raw, size-limited JSON body. Throws ParseError on malformed JSON or schema
 * validation failure, with a message built from the ZodError's per-field issues.
 */
export async function parseStandbyInput<TInput>(
    req: IncomingMessage,
    schema: ZodType<TInput>,
    sources: StandbyInputSource[],
): Promise<TInput> {
    const url = new URL(req.url ?? '/', 'http://standby.local');
    let rawInput: unknown;

    for (const source of sources) {
        if (source === 'query-json') {
            const raw = url.searchParams.get('input');
            if (raw === null) continue;
            try {
                rawInput = JSON.parse(raw);
            } catch {
                throw new ParseError('Invalid JSON in the "input" query parameter.');
            }
            break;
        }

        if (source === 'query-params') {
            if ([...url.searchParams.keys()].length === 0) continue;
            rawInput = Object.fromEntries(url.searchParams.entries());
            break;
        }

        if (source === 'body') {
            if (req.method !== 'POST') continue;
            const body = await readRequestBody(req, MAX_INPUT_BODY_BYTES);
            if (body.length === 0) continue;
            try {
                rawInput = JSON.parse(body);
            } catch {
                throw new ParseError('Invalid JSON in the request body.');
            }
            break;
        }
    }

    const result = schema.safeParse(rawInput ?? {});
    if (!result.success) {
        throw new ParseError(formatZodError(result.error));
    }
    return result.data;
}

/** Base fields recurring across standby actors for caller identification / call auditing. Extend per-actor. */
export const BaseStandbyInputSchema = z.object({
    standbyCallMetadataRunId: z.string().optional(),
    standbyCallMetadataUserId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

export interface StandbyRequestContext<TInput> {
    standbyRequestId: string;
    input: TInput;
    registry: StandbyRequestRegistry<TInput>;
}

export interface StandbyOptions<TInput> {
    /**
     * Defaults to reading ACTOR_STANDBY_PORT — confirmed as the env var actually read by
     * existing standby actors, despite current Apify docs naming ACTOR_WEB_SERVER_PORT.
     */
    port?: number;
    inputSchema: ZodType<TInput>;
    inputSources: StandbyInputSource[];
    /** Runs once input is parsed/validated and the request registered. Owns eventually responding via the registry. */
    handler: (context: StandbyRequestContext<TInput>) => Promise<void>;
    /** Optional: reported alongside in-flight count in the periodic concurrency log. */
    getConcurrency?: () => number | string;
}

const READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe';
const CONCURRENCY_LOG_INTERVAL_MILLIS = 60_000;

function respondWithError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) return;
    const message = err instanceof Error ? err.message : 'Unknown error.';
    const statusCode = err instanceof ParseError ? 400 : 500;
    log.error(message, { err });
    new StandbyResponder(res).custom(statusCode, { error: message });
}

/** Drain budget `Standby` applies internally before registering shutdown handling. */
const STANDBY_SHUTDOWN_DRAIN_MILLIS: ShutdownDrainMillis = {
    migrating: 10_000,
    aborting: 10_000,
    SIGTERM: 3_000,
};

/**
 * Composes the pieces every standby actor needs — request registry and shutdown draining —
 * behind a single `launch()` call, so consumers don't have to wire `registerStandbyShutdown`
 * themselves.
 */
export class Standby<TInput> {
    readonly registry = new StandbyRequestRegistry<TInput>();

    constructor(private readonly options: StandbyOptions<TInput>) {
        this.registerStandbyShutdown();
    }

    /**
     * Boots the standby HTTP server: readiness-probe short-circuit, HEAD handling, input
     * parsing/validation, request registration, and a uniform `{ error }` JSON error envelope for
     * anything the handler throws (ParseError -> 400, else -> 500). Runs forever; the returned
     * promise never resolves on its own — the platform decides when the run ends, via the
     * migrating/aborting/SIGTERM handling registered in the constructor.
     */
    launch = async () => {
        const {
            port = Number(process.env.ACTOR_STANDBY_PORT ?? 8080),
            inputSchema,
            inputSources,
            handler,
            getConcurrency,
        } = this.options;
        const { registry } = this;

        const handleIncomingRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
            // Readiness probes and HEAD requests are answered before any input parsing happens.
            if (req.headers[READINESS_PROBE_HEADER] !== undefined || req.method === 'HEAD') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method !== 'GET' && req.method !== 'POST') {
                res.writeHead(400);
                res.end();
                return;
            }

            const extracted = extractStandbyRequestId(req.headers);
            if (!extracted) {
                log.error('Standby request is missing a controller header, is the Actor in multi-tenant standby?');
                res.writeHead(500);
                res.end(
                    JSON.stringify({
                        error: 'internal_error',
                        errorDescription: GENERIC_INTERNAL_ERROR,
                    }),
                );
                return;
            }
            const { standbyRequestId, userId } = extracted;

            try {
                const input = await parseStandbyInput(req, inputSchema, inputSources);
                registry.register(standbyRequestId, input, res);
                log.info('Standby request received', {
                    standbyRequestId,
                    userId,
                    input,
                    inProgress: this.registry.size,
                });
                // The handler owns writing the eventual success response via the registry —
                // launch() itself only ever writes error responses.
                try {
                    await handler({ standbyRequestId, input, registry });
                } catch (error) {
                    log.exception(error as Error, 'Standby request handler failed', { standbyRequestId, userId });
                    res.writeHead(500);
                    res.end(
                        JSON.stringify({
                            error: 'internal_error',
                            errorDescription: GENERIC_INTERNAL_ERROR,
                        }),
                    );
                }
            } catch (err) {
                respondWithError(res, err);
            }
        };

        const server = createServer((req, res) => {
            handleIncomingRequest(req, res).catch((err) => respondWithError(res, err));
        });

        server.listen(port, () => log.info(`Standby server is listening on port ${port}`));

        const concurrencyLogInterval = setInterval(() => {
            const concurrency = getConcurrency ? getConcurrency() : 'N/A';
            log.info(`Standby requests in process: ${registry.size}, Crawler concurrency: ${concurrency}`);
        }, CONCURRENCY_LOG_INTERVAL_MILLIS);
        concurrencyLogInterval.unref();
    };

    /**
     * Subscribes to Actor.on('migrating'), Actor.on('aborting'), and process.on('SIGTERM'), and
     * drains the given registry when the first one fires.
     *
     * SIGTERM is handled directly, not only via 'aborting', as a workaround for a platform bug
     * where standby actors sometimes never receive the 'aborting' event. Idempotent: only the
     * first event observed triggers a drain.
     *
     * Waits up to `drainMillisByEvent[event]` for in-flight requests to finish naturally. Once
     * that budget elapses, every request still open in the registry is force-claimed and answered
     * via `registry.drainAll(503, ...)` with a `StandbyShutdownResponseBody` — callers must always
     * receive an explicit, retryable HTTP response, never a connection dropped by the process
     * exiting underneath them.
     */
    registerStandbyShutdown = () => {
        let shutdownInProgress = false;

        const drain = async (event: ShutdownEvent) => {
            if (shutdownInProgress) return;
            shutdownInProgress = true;

            const deadline = Date.now() + STANDBY_SHUTDOWN_DRAIN_MILLIS[event];
            const poll = setInterval(() => {
                if (this.registry.size === 0 || Date.now() >= deadline) {
                    clearInterval(poll);
                    const body: StandbyShutdownResponseBody = {
                        error: 'actor_migration',
                        errorDescription:
                            'Actor has initiated migration/is aborting, please retry this request after one minute.',
                    };
                    this.registry.drainAll(503, body);
                }
            }, SHUTDOWN_POLL_INTERVAL_MILLIS);
            poll.unref();

            await Actor.exit();
        };

        Actor.on('migrating', async () => drain('migrating'));
        Actor.on('aborting', async () => drain('aborting'));
        process.on('SIGTERM', async () => drain('SIGTERM'));
    };
}

// ---------------------------------------------------------------------------
// Call-metadata audit trail (post-resolution hook — the default debugging mechanism)
// ---------------------------------------------------------------------------

export interface StandbyCallMetadataRecord<TInput, TOutput> {
    timestamp: string;
    callerActorRunId: string | null;
    callerUserId: string | null;
    standbyRequestId: string;
    input: TInput;
    output: TOutput;
}

/**
 * Writes an audit record for a resolved standby call to the run's default dataset, and — if
 * the caller supplied standbyCallMetadataRunId/UserId — to a named per-caller dataset, so a
 * single caller's traffic can be inspected in isolation from the rest of the run.
 *
 * This is independent of monetization: call it regardless of whether the actor also charges
 * via `chargeStandbyRequest` — it's the baseline debugging trail every standby actor should have.
 */
export async function storeStandbyCallMetadata<TInput, TOutput>(args: {
    input: TInput;
    output: TOutput;
    standbyRequestId: string;
    datasetNameForCaller?: (callerUserId: string) => string;
}): Promise<void> {
    const { input, output, standbyRequestId, datasetNameForCaller } = args;
    const metadataInput = input as Partial<z.infer<typeof BaseStandbyInputSchema>>;
    const callerActorRunId = metadataInput.standbyCallMetadataRunId ?? null;
    const callerUserId = metadataInput.standbyCallMetadataUserId ?? null;

    const record: StandbyCallMetadataRecord<TInput, TOutput> = {
        timestamp: new Date().toISOString(),
        callerActorRunId,
        callerUserId,
        standbyRequestId,
        input,
        output,
    };

    await Actor.pushData(record);

    if (callerUserId && datasetNameForCaller) {
        const dataset = await Actor.openDataset(datasetNameForCaller(callerUserId));
        await dataset.pushData(record);
    }
}

// ---------------------------------------------------------------------------
// Charging (fully optional post-resolution hook — not every standby actor monetizes this way)
// ---------------------------------------------------------------------------

export interface ChargeStandbyRequestArgs {
    eventName: string;
    count: number;
    standbyRequestId?: string;
}

/**
 * Charges for a resolved standby request. Uses Actor.charge() for single-tenant/local runs;
 * for multi-tenant runs (actorRequestId present and Actor.isAtHome()) bypasses it in favor of
 * a raw `POST /v2/actor-runs/{runId}/charge` call, since Actor.charge() would otherwise bill
 * the run owner instead of the caller identified by the x-actor-request-id header. Must be
 * called only after the request has been claimed — the charge endpoint rejects charges for
 * requests the caller has already closed out.
 *
 * Entirely opt-in: not wired into `Standby` — actors that don't monetize via PPE simply
 * never call this.
 *
 * Charging throws only on misconfiguration or platform trouble - never on the caller's budget:
 * multi-tenant standby has no per-request $ limit, and over-limit users are blocked by the
 * standby controller before their request reaches us
 */
export async function chargeStandbyRequest(args: ChargeStandbyRequestArgs): Promise<void> {
    const { eventName, count, standbyRequestId } = args;

    if (!standbyRequestId || !Actor.isAtHome() || count < 1) {
        return;
    }
    const { actorRunId, token, apiBaseUrl } = Actor.getEnv();
    if (!actorRunId || !token) {
        throw new ChargingError('Cannot charge a multi-tenant standby request without an actor run id and API token.');
    }

    const response = await fetch(`${apiBaseUrl ?? DEFAULT_API_BASE_URL}/v2/actor-runs/${actorRunId}/charge`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': `${standbyRequestId}-${eventName}`,
        },
        body: JSON.stringify({ eventName, count, standbyRequestId }),
    });

    if (!response.ok) {
        throw new ChargingError(
            `Failed to charge standby request "${standbyRequestId}": ${response.status} ${await response.text()}`,
        );
    }
}

const extractStandbyRequestId = (headers: IncomingHttpHeaders) => {
    if (!Actor.isAtHome()) {
        return {
            standbyRequestId: randomUUID(),
            userId: 'user_id',
        };
    }
    // Needed for charging
    const standbyRequestId = headers['x-actor-request-id']?.toString();
    const userId = headers['x-apify-user-id']?.toString();

    if (!standbyRequestId || !userId) {
        return null;
    }

    return {
        standbyRequestId,
        userId,
    };
};

// ---------------------------------------------------------------------------
// Optional Crawlee integration
// ---------------------------------------------------------------------------

export interface CreateCrawleeStandbyCrawlerOptions<TRequestHandler> {
    requestHandler: TRequestHandler;
    /** Floor so concurrency doesn't ramp up from 1 on an otherwise-idle standby run. */
    minConcurrency?: number;
    maxConcurrency?: number;
}

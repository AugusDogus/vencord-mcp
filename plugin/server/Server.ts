/*
 * The loopback HTTP server: routing, the guards every request passes, and the adapter from
 * node:http to web Requests. Discord itself is reached only through the Bridge, which the
 * main process implements by asking the renderer.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { ToolName } from "../shared/tools";
import type { ToolResult } from "../shared/ToolResult";
import { AgentStore } from "./AgentStore";
import { handleMcp } from "./Mcp";
import { handleOAuth, isLoopbackHost, unauthorized } from "./OAuth";

export type Decision = { readonly kind: "allowed" } | { readonly kind: "denied" } | { readonly kind: "unavailable"; readonly reason: string };

export type Bridge = {
    /** Asks the user in Discord whether to let the agent in; `signal` withdraws the question. */
    readonly approve: (clientName: string, signal: AbortSignal) => Promise<Decision>;
    readonly callTool: (name: ToolName, args: unknown) => Promise<ToolResult>;
};

export type Config = {
    readonly store: AgentStore;
    readonly bridge: Bridge;
    readonly version: string;
    /** How long /authorize waits for an answer (default four minutes). */
    readonly approvalWaitMs?: number;
};

export type Listening =
    | { readonly kind: "listening"; readonly port: number; readonly close: () => Promise<void> }
    | { readonly kind: "failed"; readonly reason: string };

const MAX_BODY_BYTES = 1024 * 1024;

function bearer(req: Request): string | undefined {
    const header = req.headers.get("authorization");
    return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function plain(status: number, text: string): Response {
    return new Response(text, { status, headers: { "Content-Type": "text/plain" } });
}

function handler(config: Config): (req: Request) => Promise<Response> {
    return async req => {
        const url = new URL(req.url);
        // A rebound DNS name reaches 127.0.0.1 with a foreign Host; a web page's fetch carries its Origin.
        if (!isLoopbackHost(url.hostname)) return plain(403, "this server answers only to 127.0.0.1, localhost or [::1]");
        const origin = req.headers.get("origin");
        if (origin !== null && !isLoopbackOrigin(origin)) return plain(403, "requests from web pages are refused");

        const base = url.origin;
        if (url.pathname !== "/mcp") return (await handleOAuth(req, base, config)) ?? plain(404, "the MCP endpoint is /mcp");

        const token = bearer(req);
        if (token === undefined || !AgentStore.tokenOk(config.store, token)) return unauthorized(base);
        return handleMcp(req, config);
    };
}

function isLoopbackOrigin(origin: string): boolean {
    try {
        return isLoopbackHost(new URL(origin).hostname);
    } catch {
        return false;
    }
}

async function readBody(req: IncomingMessage): Promise<Buffer | "too large"> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > MAX_BODY_BYTES) return "too large";
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function toRequest(req: IncomingMessage, body: Buffer, signal: AbortSignal): Request | string {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    }
    const method = req.method ?? "GET";
    try {
        return new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, {
            method,
            headers,
            signal,
            ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
        });
    } catch (error) {
        return `the request could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
}

async function serveNode(handle: (req: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Withdraws a held /authorize when the browser goes away.
    const gone = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) gone.abort();
    });

    const body = await readBody(req);
    const request = body === "too large" ? plain(413, `the body is over ${MAX_BODY_BYTES} bytes`) : toRequest(req, body, gone.signal);
    const response = request instanceof Response ? request : typeof request === "string" ? plain(400, request) : await handle(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
}

export const Server = {
    handler,

    /** Listens on 127.0.0.1 only. Port 0 picks a free one (for tests). */
    listen(port: number, config: Config): Promise<Listening> {
        const handle = handler(config);
        const server = createServer((req, res) => {
            serveNode(handle, req, res).catch(error => {
                if (!res.headersSent) res.statusCode = 500;
                res.end(`the server failed on this request: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
        return new Promise(resolve => {
            server.once("error", error => resolve({ kind: "failed", reason: `could not listen on 127.0.0.1:${port}: ${error.message}` }));
            server.listen(port, "127.0.0.1", () => {
                const address = server.address();
                const bound = typeof address === "object" && address !== null ? address.port : port;
                resolve({
                    kind: "listening",
                    port: bound,
                    close: () =>
                        new Promise<void>(done => {
                            server.close(() => done());
                            server.closeAllConnections();
                        }),
                });
            });
        });
    },
} as const;

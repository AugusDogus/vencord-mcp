import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "../plugin/server/AgentStore";
import { type Bridge, type Decision, Server, type Listening } from "../plugin/server/Server";
import { ToolResult } from "../plugin/shared/ToolResult";

type Ask = { readonly clientName: string; readonly signal: AbortSignal };

let dir = "";
let currentStore: AgentStore | undefined;
let listening: Extract<Listening, { kind: "listening" }> | undefined;
let asks: Ask[] = [];
let decide: (ask: Ask) => Promise<Decision> = async () => ({ kind: "allowed" });
let calls: { name: string; args: unknown }[] = [];
let answer: (name: string, args: unknown) => ToolResult = () => ToolResult.json({ ok: true });

const bridge: Bridge = {
    approve: (clientName, signal) => {
        const ask = { clientName, signal };
        asks.push(ask);
        return decide(ask);
    },
    callTool: async (name, args) => {
        calls.push({ name, args });
        return answer(name, args);
    },
};

async function start(approvalWaitMs?: number) {
    const loaded = AgentStore.load(join(dir, "mcp-auth.json"));
    if (loaded.kind !== "loaded") throw new Error(loaded.reason);
    currentStore = loaded.store;
    const result = await Server.listen(0, { store: loaded.store, bridge, version: "test", ...(approvalWaitMs === undefined ? {} : { approvalWaitMs }) });
    if (result.kind !== "listening") throw new Error(result.reason);
    listening = result;
    return `http://127.0.0.1:${result.port}`;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vencord-mcp-server-"));
    asks = [];
    calls = [];
    decide = async () => ({ kind: "allowed" });
    answer = () => ToolResult.json({ ok: true });
});
afterEach(async () => {
    await listening?.close();
    listening = undefined;
    rmSync(dir, { recursive: true, force: true });
});

const REDIRECT = "http://localhost:43210/callback";

async function register(base: string, redirect = REDIRECT) {
    return fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Claude Code (discord)", redirect_uris: [redirect], grant_types: ["authorization_code"] }),
    });
}

function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(base: string, clientId: string, challenge: string) {
    const url = new URL(`${base}/authorize`);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "the-state",
        scope: "read",
    }).toString();
    return url;
}

/** Runs the whole sign-in the way an MCP client does, and returns the bearer token. */
async function signIn(base: string): Promise<string> {
    const reg = await register(base);
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const { verifier, challenge } = pkce();

    const authorized = await fetch(authorizeUrl(base, client_id, challenge), { redirect: "manual" });
    expect(authorized.status).toBe(302);
    const back = new URL(authorized.headers.get("location") ?? "");
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("the-state");
    const code = back.searchParams.get("code");
    if (code === null) throw new Error(`no code in ${back}`);

    const token = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }),
    });
    expect(token.status).toBe(200);
    const body = await token.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBeUndefined();
    return body.access_token;
}

let rpcId = 0;
async function rpc(base: string, token: string, method: string, params?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${token}`,
            ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) }),
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : await response.text() };
}

describe("before sign-in", () => {
    test("/mcp answers 401 pointing at the protected resource metadata on the same host", async () => {
        const base = await start();
        const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    });

    test("the metadata names this server as the resource and its own authorization server", async () => {
        const base = await start();
        const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
        expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });

        const server = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
        expect(server).toMatchObject({
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
        });
    });

    test("a client may register only loopback redirects", async () => {
        const base = await start();
        const response = await register(base, "https://evil.example/callback");
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("invalid_redirect_uri");
    });

    test("a request whose Host is not loopback is refused, against DNS rebinding", async () => {
        const base = await start();
        const handler = Server.handler({ store: currentStore ?? fail(), bridge, version: "test" });
        const response = await handler(new Request(`http://rebound.example:${new URL(base).port}/.well-known/oauth-authorization-server`));
        expect(response.status).toBe(403);
    });

    test("a request from a web page's origin is refused", async () => {
        const base = await start();
        const response = await fetch(`${base}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
            body: JSON.stringify({ redirect_uris: [REDIRECT] }),
        });
        expect(response.status).toBe(403);
    });
});

describe("sign-in", () => {
    test("asks in Discord with the client's name, and its token then reaches the tools", async () => {
        const base = await start();
        const token = await signIn(base);
        expect(asks.map(a => a.clientName)).toEqual(["Claude Code (discord)"]);

        const init = await rpc(base, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
        expect(init.status).toBe(200);
        expect(init.body.result.protocolVersion).toBe("2025-06-18");
        expect(init.body.result.capabilities.tools).toBeDefined();
    });

    test("a Deny comes back to the client as access_denied with its state", async () => {
        decide = async () => ({ kind: "denied" });
        const base = await start();
        const { client_id } = await (await register(base)).json();
        const response = await fetch(authorizeUrl(base, client_id, pkce().challenge), { redirect: "manual" });
        const back = new URL(response.headers.get("location") ?? "");
        expect(back.searchParams.get("error")).toBe("access_denied");
        expect(back.searchParams.get("state")).toBe("the-state");
        expect(back.searchParams.get("code")).toBeNull();
    });

    test("when nobody answers in time the ask is withdrawn and the client is turned away", async () => {
        decide = ask => new Promise(resolve => ask.signal.addEventListener("abort", () => resolve({ kind: "denied" })));
        const base = await start(50);
        const { client_id } = await (await register(base)).json();
        const response = await fetch(authorizeUrl(base, client_id, pkce().challenge), { redirect: "manual" });
        expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
        expect(asks[0]?.signal.aborted).toBe(true);
    });

    test("PKCE with S256 is required", async () => {
        const base = await start();
        const { client_id } = await (await register(base)).json();
        const url = authorizeUrl(base, client_id, "challenge");
        url.searchParams.set("code_challenge_method", "plain");
        const response = await fetch(url, { redirect: "manual" });
        expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");
        expect(asks).toEqual([]);
    });

    test("the token survives a restart of the server", async () => {
        const base = await start();
        const token = await signIn(base);
        await listening?.close();
        const again = await start();
        expect((await rpc(again, token, "tools/list")).status).toBe(200);
    });
});

describe("MCP", () => {
    test("tools/list gives every tool with a JSON Schema for its arguments", async () => {
        const base = await start();
        const token = await signIn(base);
        const { body } = await rpc(base, token, "tools/list");
        const read = body.result.tools.find((t: { name: string }) => t.name === "read_messages");
        expect(read.inputSchema).toMatchObject({ type: "object", required: ["channel_id"] });
        expect(read.inputSchema.properties.limit).toMatchObject({ type: "integer", maximum: 100 });
    });

    test("tools/call reaches Discord with the arguments and returns one text block", async () => {
        answer = () => ToolResult.json({ servers: [] });
        const base = await start();
        const token = await signIn(base);
        const { body } = await rpc(base, token, "tools/call", { name: "list_servers", arguments: { unread_only: true } });
        expect(calls).toEqual([{ name: "list_servers", args: { unread_only: true } }]);
        expect(body.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ servers: [] }, null, 2) }] });
    });

    test("a tool that fails tells the agent why, as a tool error it can read", async () => {
        answer = () => ToolResult.failed("no channel with that id");
        const base = await start();
        const token = await signIn(base);
        const { body } = await rpc(base, token, "tools/call", { name: "read_messages", arguments: { channel_id: "1" } });
        expect(body.result).toEqual({ content: [{ type: "text", text: "no channel with that id" }], isError: true });
    });

    test("an unknown tool is a protocol error and never reaches Discord", async () => {
        const base = await start();
        const token = await signIn(base);
        for (const name of ["send_message", "toString"]) {
            const { body } = await rpc(base, token, "tools/call", { name, arguments: {} });
            expect(body.error.code).toBe(-32602);
        }
        expect(calls).toEqual([]);
    });

    test("notifications are accepted without a body", async () => {
        const base = await start();
        const token = await signIn(base);
        const response = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
        expect(response.status).toBe(202);
    });

    test("an unsupported MCP-Protocol-Version header is refused", async () => {
        const base = await start();
        const token = await signIn(base);
        expect((await rpc(base, token, "tools/list", undefined, { "MCP-Protocol-Version": "1999-01-01" })).status).toBe(400);
    });

    test("initialize falls back to the newest version it speaks when asked for one it does not", async () => {
        const base = await start();
        const token = await signIn(base);
        const { body } = await rpc(base, token, "initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } });
        expect(body.result.protocolVersion).toBe("2025-11-25");
    });

    describe("2026-07-28: no initialize, the version on every request", () => {
        const meta = (version: string) => ({
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" },
        });

        test("server/discover names the versions, the tools capability and the server", async () => {
            const base = await start();
            const token = await signIn(base);
            const { status, body } = await rpc(base, token, "server/discover", { _meta: meta("2026-07-28") }, { "MCP-Protocol-Version": "2026-07-28" });
            expect(status).toBe(200);
            expect(body.result).toMatchObject({
                resultType: "complete",
                supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]),
                capabilities: { tools: {} },
                ttlMs: 0,
                cacheScope: "private",
                _meta: { "io.modelcontextprotocol/serverInfo": { name: "discord" } },
            });
        });

        test("tools/list and tools/call answer straight away, marked complete", async () => {
            const base = await start();
            const token = await signIn(base);
            const headers = { "MCP-Protocol-Version": "2026-07-28" };
            const list = await rpc(base, token, "tools/list", { _meta: meta("2026-07-28") }, headers);
            expect(list.body.result).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
            expect(list.body.result.tools.length).toBeGreaterThan(0);

            const call = await rpc(base, token, "tools/call", { name: "list_servers", arguments: {}, _meta: meta("2026-07-28") }, headers);
            expect(call.body.result.resultType).toBe("complete");
            expect(calls).toEqual([{ name: "list_servers", args: {} }]);
        });

        test("older versions get results without the 2026 fields", async () => {
            const base = await start();
            const token = await signIn(base);
            const { body } = await rpc(base, token, "tools/list", undefined, { "MCP-Protocol-Version": "2025-06-18" });
            expect(body.result.resultType).toBeUndefined();
            expect(body.result.ttlMs).toBeUndefined();
        });

        test("a header that disagrees with the request's _meta version is refused", async () => {
            const base = await start();
            const token = await signIn(base);
            const { status, body } = await rpc(base, token, "tools/list", { _meta: meta("2026-07-28") }, { "MCP-Protocol-Version": "2025-11-25" });
            expect(status).toBe(400);
            expect(body).toContain("-32020");
        });

        test("an unsupported _meta version is refused with the versions there are", async () => {
            const base = await start();
            const token = await signIn(base);
            const { status, body } = await rpc(base, token, "tools/list", { _meta: meta("2099-01-01") }, { "MCP-Protocol-Version": "2099-01-01" });
            expect(status).toBe(400);
            const parsed = JSON.parse(body);
            expect(parsed.error.code).toBe(-32022);
            expect(parsed.error.data.supported).toContain("2026-07-28");
        });

        test("Mcp-Method and Mcp-Name headers that disagree with the body are refused", async () => {
            const base = await start();
            const token = await signIn(base);
            const params = { name: "list_servers", arguments: {}, _meta: meta("2026-07-28") };
            const wrongMethod = await rpc(base, token, "tools/call", params, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" });
            expect(wrongMethod.status).toBe(400);
            expect(JSON.parse(wrongMethod.body).error.code).toBe(-32020);
            const wrongName = await rpc(base, token, "tools/call", params, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "read_messages" });
            expect(wrongName.status).toBe(400);
            expect(calls).toEqual([]);
            const right = await rpc(base, token, "tools/call", params, { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "list_servers" });
            expect(right.status).toBe(200);
        });

        test("an unknown method is 404 at 2026-07-28, as the transport asks", async () => {
            const base = await start();
            const token = await signIn(base);
            const { status, body } = await rpc(base, token, "resources/list", { _meta: meta("2026-07-28") }, { "MCP-Protocol-Version": "2026-07-28" });
            expect(status).toBe(404);
            expect(JSON.parse(body).error.code).toBe(-32601);
        });

        test("initialize asked for 2026-07-28 falls back to the newest version that has a handshake", async () => {
            const base = await start();
            const token = await signIn(base);
            const { body } = await rpc(base, token, "initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "t", version: "1" } });
            expect(body.result.protocolVersion).toBe("2025-11-25");
        });
    });

    test("GET /mcp is 405: the server offers no event stream", async () => {
        const base = await start();
        const token = await signIn(base);
        const response = await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` } });
        expect(response.status).toBe(405);
    });
});

function fail(): never {
    throw new Error("the server is not listening");
}

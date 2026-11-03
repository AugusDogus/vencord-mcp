/*
 * OAuth 2.1 with PKCE, the plugin being its own authorization server, the way MCP clients
 * sign in to any HTTP server: protected-resource and authorization-server metadata, dynamic
 * client registration, /authorize and /token.
 *
 * /authorize holds the browser's request open while Discord asks the user whether to let the
 * agent in, then redirects back to the client's loopback callback with a code or an error.
 */

import { AgentStore } from "./AgentStore";
import type { Config, Decision } from "./Server";

/** Under the four-to-five minutes Codex and opencode keep their callback open. */
const APPROVAL_WAIT_MS = 4 * 60 * 1000;
const SCOPE = "read";

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

function oauthError(status: number, error: string, description: string): Response {
    return json(status, { error, error_description: description });
}

/** The answer every /mcp request without a valid token gets. */
export function unauthorized(base: string): Response {
    return new Response("sign in: this server uses OAuth; its metadata is at /.well-known/oauth-protected-resource", {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`, "Content-Type": "text/plain" },
    });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname);
}

/** Any port and path, but only plain http on this machine: the code never leaves it. */
function isLoopbackRedirect(uri: string): boolean {
    try {
        const url = new URL(uri);
        return url.protocol === "http:" && isLoopbackHost(url.hostname);
    } catch {
        return false;
    }
}

function redirectBack(redirectUri: string, state: string | null, params: Readonly<Record<string, string>>): Response {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (state !== null) url.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}

const isJson = (req: Request) => (req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");

async function register(req: Request, config: Config): Promise<Response> {
    // A web page can POST text/plain without a preflight; requiring JSON keeps it out.
    if (!isJson(req)) return oauthError(415, "invalid_client_metadata", "send the registration as application/json");
    let body: unknown;
    try {
        body = await req.json();
    } catch (error) {
        return oauthError(400, "invalid_client_metadata", `the registration is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof body !== "object" || body === null) return oauthError(400, "invalid_client_metadata", "the registration must be a JSON object");
    const fields: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(body));
    const uris = fields.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u): u is string => typeof u === "string" && isLoopbackRedirect(u))) {
        return oauthError(400, "invalid_redirect_uri", "every redirect_uri must be http on 127.0.0.1, localhost or [::1]");
    }
    const name = typeof fields.client_name === "string" && fields.client_name.trim() !== "" ? fields.client_name.trim() : "an agent";

    const registered = AgentStore.register(config.store, name, uris);
    if (registered.kind === "unsaved") {
        return oauthError(500, "server_error", `the registration was not saved, so the client cannot sign in: ${registered.reason}`);
    }
    const { client } = registered;
    return json(201, {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
    });
}

async function authorize(req: Request, config: Config): Promise<Response> {
    const query = new URL(req.url).searchParams;
    const get = (key: string) => query.get(key) ?? "";
    const client = AgentStore.client(config.store, get("client_id"));
    if (client === undefined) return oauthError(400, "invalid_client", "unknown client_id: register first");
    const redirectUri = get("redirect_uri");
    if (!client.redirectUris.includes(redirectUri)) {
        return oauthError(400, "invalid_request", "redirect_uri is not one the client registered");
    }
    // From here on the redirect is trusted, so errors go back to the client there.
    const state = query.get("state");
    if (get("response_type") !== "code") return redirectBack(redirectUri, state, { error: "unsupported_response_type" });
    const challenge = get("code_challenge");
    if (challenge === "" || get("code_challenge_method") !== "S256") {
        return redirectBack(redirectUri, state, { error: "invalid_request", error_description: "PKCE with S256 is required" });
    }

    // Withdrawn when the browser gives up or nobody answers in time.
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(config.approvalWaitMs ?? APPROVAL_WAIT_MS)]);
    let decision: Decision;
    try {
        decision = await config.bridge.approve(client.clientName, signal);
    } catch (error) {
        decision = { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
    switch (decision.kind) {
        case "allowed":
            break;
        case "denied":
            return redirectBack(redirectUri, state, { error: "access_denied", error_description: "not let in from Discord" });
        case "unavailable":
            return redirectBack(redirectUri, state, {
                error: "temporarily_unavailable",
                error_description: `Discord could not ask whether to let ${client.clientName} in (${decision.reason}); open Discord and sign in again`,
            });
    }
    if (signal.aborted) return redirectBack(redirectUri, state, { error: "access_denied", error_description: "the request expired" });

    const code = AgentStore.issueCode(config.store, client.clientId, redirectUri, challenge);
    return redirectBack(redirectUri, state, { code });
}

async function token(req: Request, config: Config): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const get = (key: string) => form.get(key) ?? "";
    if (get("grant_type") !== "authorization_code") {
        return oauthError(400, "unsupported_grant_type", "only authorization_code is issued; the token never expires, so there is nothing to refresh");
    }
    const redeemed = AgentStore.redeem(config.store, {
        code: get("code"),
        verifier: get("code_verifier"),
        clientId: get("client_id"),
        redirectUri: get("redirect_uri"),
    });
    switch (redeemed.kind) {
        case "token":
            return json(200, { access_token: redeemed.token, token_type: "Bearer", scope: SCOPE });
        case "invalid_grant":
            return oauthError(400, "invalid_grant", redeemed.reason);
        case "unsaved":
            return oauthError(500, "server_error", `the sign-in was not saved, so no token was issued; sign in again: ${redeemed.reason}`);
    }
}

/** The auth routes, or undefined for any other path. */
export async function handleOAuth(req: Request, base: string, config: Config): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] });
    }
    if (req.method === "GET" && pathname.startsWith("/.well-known/oauth-authorization-server")) {
        return json(200, {
            issuer: base,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: [SCOPE],
        });
    }
    switch (`${req.method} ${pathname}`) {
        case "POST /register":
            return register(req, config);
        case "GET /authorize":
            return authorize(req, config);
        case "POST /token":
            return token(req, config);
        default:
            return undefined;
    }
}

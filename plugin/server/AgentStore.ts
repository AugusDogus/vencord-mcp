/*
 * The agents let in, and the OAuth state that lets them in.
 *
 * Registered clients and linked agents persist in one JSON file (mode 0600, written
 * atomically). Only a SHA-256 of each token is kept, so the file cannot sign anyone in.
 * Authorization codes live in memory: single use, ten minutes. Tokens never expire;
 * an agent stays linked until it is removed in the plugin's settings.
 *
 * Every copy of Discord with Vencord shares the file, so each operation first re-reads it
 * when it changed on disk: a removal made in another copy (or by deleting the file) holds
 * here at once, and a save here never brings back what another copy removed.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Client = {
    readonly clientId: string;
    readonly clientName: string;
    readonly redirectUris: readonly string[];
    /** RFC 3339. */
    readonly registeredAt: string;
};

export type Agent = {
    readonly clientId: string;
    readonly clientName: string;
    readonly tokenHash: string;
    /** RFC 3339. */
    readonly linkedAt: string;
};

type PendingCode = {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly codeChallenge: string;
    readonly issuedAt: number;
};

type Persisted = {
    readonly clients: readonly Client[];
    readonly agents: readonly Agent[];
};

export type AgentStore = {
    readonly path: string;
    readonly now: () => number;
    readonly codes: Map<string, PendingCode>;
    persisted: Persisted;
    /** The file's mtime when `persisted` was read or written; undefined while there is no file. */
    seen: number | undefined;
};

export type Loaded =
    | { readonly kind: "loaded"; readonly store: AgentStore }
    | { readonly kind: "unreadable"; readonly path: string; readonly reason: string };

export type Registered =
    | { readonly kind: "registered"; readonly client: Client }
    | { readonly kind: "unsaved"; readonly reason: string };

export type Redeemed =
    | { readonly kind: "token"; readonly token: string }
    | { readonly kind: "invalid_grant"; readonly reason: string }
    | { readonly kind: "unsaved"; readonly reason: string };

export type Revoked =
    | { readonly kind: "revoked" }
    | { readonly kind: "unknown" }
    | { readonly kind: "unsaved"; readonly reason: string };

export type Redemption = {
    readonly code: string;
    readonly verifier: string;
    readonly clientId: string;
    readonly redirectUri: string;
};

const CODE_TTL_MS = 10 * 60 * 1000;
/** A client that has not finished signing in a day after registering never will. */
const IDLE_CLIENT_MS = 24 * 60 * 60 * 1000;
const EMPTY: Persisted = { clients: [], agents: [] };

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const freshSecret = () => randomBytes(32).toString("hex");

function sameText(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");

function parseClient(v: unknown): Client | undefined {
    if (!isRecord(v)) return undefined;
    const { clientId, clientName, redirectUris, registeredAt } = v;
    if (typeof clientId !== "string" || typeof clientName !== "string" || !isStringArray(redirectUris) || typeof registeredAt !== "string") return undefined;
    return { clientId, clientName, redirectUris, registeredAt };
}

function parseAgent(v: unknown): Agent | undefined {
    if (!isRecord(v)) return undefined;
    const { clientId, clientName, tokenHash, linkedAt } = v;
    if (typeof clientId !== "string" || typeof clientName !== "string" || typeof tokenHash !== "string" || typeof linkedAt !== "string") return undefined;
    return { clientId, clientName, tokenHash, linkedAt };
}

function parsePersisted(text: string): Persisted | string {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (error) {
        return `it is not JSON (${describe(error)})`;
    }
    if (!isRecord(raw) || !Array.isArray(raw.clients) || !Array.isArray(raw.agents)) return "it lacks the clients and agents lists";
    const clients = raw.clients.map(parseClient);
    const agents = raw.agents.map(parseAgent);
    const goodClients = clients.filter((c): c is Client => c !== undefined);
    const goodAgents = agents.filter((a): a is Agent => a !== undefined);
    if (goodClients.length !== clients.length || goodAgents.length !== agents.length) return "an entry in it is malformed";
    return { clients: goodClients, agents: goodAgents };
}

type Read =
    | { readonly kind: "file"; readonly persisted: Persisted; readonly mtimeMs: number }
    | { readonly kind: "missing" }
    | { readonly kind: "unreadable"; readonly reason: string };

const isMissing = (error: unknown) => isRecord(error) && error.code === "ENOENT";

function read(path: string): Read {
    let text: string;
    let mtimeMs: number;
    try {
        mtimeMs = statSync(path).mtimeMs;
        text = readFileSync(path, "utf8");
    } catch (error) {
        return isMissing(error) ? { kind: "missing" } : { kind: "unreadable", reason: `it could not be read (${describe(error)})` };
    }
    const persisted = parsePersisted(text);
    return typeof persisted === "string" ? { kind: "unreadable", reason: persisted } : { kind: "file", persisted, mtimeMs };
}

/** Adopts the file when another copy changed it. A file that turned unreadable is not adopted: memory stands. */
function refresh(store: AgentStore): void {
    let mtimeMs: number;
    try {
        mtimeMs = statSync(store.path).mtimeMs;
    } catch (error) {
        if (isMissing(error) && store.seen !== undefined) {
            store.persisted = EMPTY;
            store.seen = undefined;
        }
        return;
    }
    if (mtimeMs === store.seen) return;
    const current = read(store.path);
    if (current.kind === "file") {
        store.persisted = current.persisted;
        store.seen = current.mtimeMs;
    }
}

/** Writes the whole file to a sibling and renames it over, so a crash never leaves half a file. */
function save(path: string, persisted: Persisted): { readonly mtimeMs: number } | string {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
        renameSync(temp, path);
        return { mtimeMs: statSync(path).mtimeMs };
    } catch (error) {
        return `could not write ${path}: ${describe(error)}`;
    }
}

/** Applies `next` only once it is on disk, so memory never claims what a restart would lose. */
function commit(store: AgentStore, next: Persisted): string | undefined {
    const saved = save(store.path, next);
    if (typeof saved === "string") return saved;
    store.persisted = next;
    store.seen = saved.mtimeMs;
    return undefined;
}

export const AgentStore = {
    load(path: string, now: () => number = Date.now): Loaded {
        const current = read(path);
        switch (current.kind) {
            case "missing":
                return { kind: "loaded", store: { path, now, codes: new Map(), persisted: EMPTY, seen: undefined } };
            case "unreadable":
                return { kind: "unreadable", path, reason: current.reason };
            case "file":
                return { kind: "loaded", store: { path, now, codes: new Map(), persisted: current.persisted, seen: current.mtimeMs } };
        }
    },

    register(store: AgentStore, clientName: string, redirectUris: readonly string[]): Registered {
        refresh(store);
        const now = store.now();
        const { clients, agents } = store.persisted;
        const kept = clients.filter(c => agents.some(a => a.clientId === c.clientId) || now - Date.parse(c.registeredAt) < IDLE_CLIENT_MS);
        const client: Client = { clientId: randomUUID(), clientName, redirectUris: [...redirectUris], registeredAt: new Date(now).toISOString() };
        const failure = commit(store, { ...store.persisted, clients: [...kept, client] });
        return failure === undefined ? { kind: "registered", client } : { kind: "unsaved", reason: failure };
    },

    client(store: AgentStore, clientId: string): Client | undefined {
        refresh(store);
        return store.persisted.clients.find(c => c.clientId === clientId);
    },

    issueCode(store: AgentStore, clientId: string, redirectUri: string, codeChallenge: string): string {
        const now = store.now();
        for (const [code, pending] of store.codes) {
            if (now - pending.issuedAt > CODE_TTL_MS) store.codes.delete(code);
        }
        const code = freshSecret();
        store.codes.set(code, { clientId, redirectUri, codeChallenge, issuedAt: now });
        return code;
    },

    /** The code is spent before any check, so a failed attempt cannot be retried with it. */
    redeem(store: AgentStore, { code, verifier, clientId, redirectUri }: Redemption): Redeemed {
        const pending = store.codes.get(code);
        store.codes.delete(code);
        if (pending === undefined) return { kind: "invalid_grant", reason: "unknown or used code" };
        if (store.now() - pending.issuedAt > CODE_TTL_MS) return { kind: "invalid_grant", reason: "the code has expired" };
        if (pending.clientId !== clientId || pending.redirectUri !== redirectUri) {
            return { kind: "invalid_grant", reason: "the code was issued to another client or redirect_uri" };
        }
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (!sameText(expected, pending.codeChallenge)) return { kind: "invalid_grant", reason: "the code verifier does not match" };

        refresh(store);
        const token = freshSecret();
        const agent: Agent = {
            clientId,
            clientName: AgentStore.client(store, clientId)?.clientName ?? "an agent",
            tokenHash: sha256Hex(token),
            linkedAt: new Date(store.now()).toISOString(),
        };
        const failure = commit(store, { ...store.persisted, agents: [...store.persisted.agents, agent] });
        return failure === undefined ? { kind: "token", token } : { kind: "unsaved", reason: failure };
    },

    tokenOk(store: AgentStore, token: string): boolean {
        refresh(store);
        const hash = sha256Hex(token);
        return store.persisted.agents.some(a => sameText(a.tokenHash, hash));
    },

    agents(store: AgentStore): readonly Agent[] {
        refresh(store);
        return store.persisted.agents;
    },

    revoke(store: AgentStore, tokenHash: string): Revoked {
        refresh(store);
        const agents = store.persisted.agents.filter(a => a.tokenHash !== tokenHash);
        if (agents.length === store.persisted.agents.length) return { kind: "unknown" };
        const failure = commit(store, { ...store.persisted, agents });
        return failure === undefined ? { kind: "revoked" } : { kind: "unsaved", reason: failure };
    },
} as const;

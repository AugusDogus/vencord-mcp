import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStore } from "../plugin/server/AgentStore";

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

let dir = "";
let path = "";
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vencord-mcp-store-"));
    path = join(dir, "mcp-auth.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function loaded(now: () => number = Date.now): AgentStore {
    const result = AgentStore.load(path, now);
    if (result.kind !== "loaded") throw new Error(`expected a store, got ${result.kind}: ${result.reason}`);
    return result.store;
}

function registered(store: AgentStore, name = "Claude Code", redirect = "http://localhost:5555/callback") {
    const result = AgentStore.register(store, name, [redirect]);
    if (result.kind !== "registered") throw new Error(`expected registration, got ${result.kind}`);
    return result.client;
}

describe("AgentStore", () => {
    test("a missing file loads as an empty store", () => {
        const store = loaded();
        expect(AgentStore.agents(store)).toEqual([]);
    });

    test("a file it cannot parse is reported, not replaced with an empty store", () => {
        writeFileSync(path, "{ not json");
        const result = AgentStore.load(path);
        expect(result.kind).toBe("unreadable");
        expect(readFileSync(path, "utf8")).toBe("{ not json");
    });

    test("a code redeems once for a token that then checks out, with the agent on file", () => {
        const store = loaded();
        const client = registered(store);
        const verifier = "a-verifier-of-reasonable-length-0123456789";
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf(verifier));

        const redeemed = AgentStore.redeem(store, { code, verifier, clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        if (redeemed.kind !== "token") throw new Error(`expected a token, got ${redeemed.kind}`);

        expect(AgentStore.tokenOk(store, redeemed.token)).toBe(true);
        expect(AgentStore.tokenOk(store, "not-the-token")).toBe(false);
        expect(AgentStore.agents(store).map(a => a.clientName)).toEqual(["Claude Code"]);

        const again = AgentStore.redeem(store, { code, verifier, clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        expect(again.kind).toBe("invalid_grant");
    });

    test("a wrong verifier is refused and still uses up the code", () => {
        const store = loaded();
        const client = registered(store);
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf("right"));
        const wrong = AgentStore.redeem(store, { code, verifier: "wrong", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        expect(wrong.kind).toBe("invalid_grant");
        const right = AgentStore.redeem(store, { code, verifier: "right", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        expect(right.kind).toBe("invalid_grant");
    });

    test("a code issued to one client does not redeem for another", () => {
        const store = loaded();
        const a = registered(store, "A");
        const b = registered(store, "B");
        const code = AgentStore.issueCode(store, a.clientId, "http://localhost:5555/callback", challengeOf("v"));
        const result = AgentStore.redeem(store, { code, verifier: "v", clientId: b.clientId, redirectUri: "http://localhost:5555/callback" });
        expect(result.kind).toBe("invalid_grant");
    });

    test("a code expires after ten minutes", () => {
        let now = 1_000_000;
        const store = loaded(() => now);
        const client = registered(store);
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf("v"));
        now += 10 * 60 * 1000 + 1;
        const result = AgentStore.redeem(store, { code, verifier: "v", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        expect(result.kind).toBe("invalid_grant");
    });

    test("agents and clients survive a reload, the file holds only token hashes and is private", () => {
        const store = loaded();
        const client = registered(store);
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf("v"));
        const redeemed = AgentStore.redeem(store, { code, verifier: "v", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        if (redeemed.kind !== "token") throw new Error("expected a token");

        const raw = readFileSync(path, "utf8");
        expect(raw).not.toContain(redeemed.token);
        expect(statSync(path).mode & 0o777).toBe(0o600);

        const reloaded = loaded();
        expect(AgentStore.tokenOk(reloaded, redeemed.token)).toBe(true);
        expect(AgentStore.client(reloaded, client.clientId)?.clientName).toBe("Claude Code");
    });

    test("revoking an agent stops its token at once and on reload", () => {
        const store = loaded();
        const client = registered(store);
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf("v"));
        const redeemed = AgentStore.redeem(store, { code, verifier: "v", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        if (redeemed.kind !== "token") throw new Error("expected a token");
        const [agent] = AgentStore.agents(store);
        if (!agent) throw new Error("expected an agent");

        expect(AgentStore.revoke(store, agent.tokenHash).kind).toBe("revoked");
        expect(AgentStore.tokenOk(store, redeemed.token)).toBe(false);
        expect(AgentStore.tokenOk(loaded(), redeemed.token)).toBe(false);
        expect(AgentStore.revoke(store, agent.tokenHash).kind).toBe("unknown");
    });

    test("an agent removed through another copy of the store (a second Discord) is refused here too", () => {
        const serving = loaded();
        const client = registered(serving);
        const code = AgentStore.issueCode(serving, client.clientId, "http://localhost:5555/callback", challengeOf("v"));
        const redeemed = AgentStore.redeem(serving, { code, verifier: "v", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        if (redeemed.kind !== "token") throw new Error("expected a token");

        const other = loaded();
        const [agent] = AgentStore.agents(other);
        if (!agent) throw new Error("expected the other copy to see the agent");
        expect(AgentStore.revoke(other, agent.tokenHash).kind).toBe("revoked");

        expect(AgentStore.tokenOk(serving, redeemed.token)).toBe(false);
        // and the serving copy's next save does not bring it back
        registered(serving, "Codex");
        expect(AgentStore.agents(loaded())).toEqual([]);
    });

    test("deleting the file signs every agent out", () => {
        const store = loaded();
        const client = registered(store);
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf("v"));
        const redeemed = AgentStore.redeem(store, { code, verifier: "v", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        if (redeemed.kind !== "token") throw new Error("expected a token");
        rmSync(path);
        expect(AgentStore.tokenOk(store, redeemed.token)).toBe(false);
    });

    test("a client that never signed in is dropped a day after it registered; one with an agent is kept", () => {
        let now = 1_000_000_000;
        const store = loaded(() => now);
        const idle = registered(store, "Idle");
        const used = registered(store, "Used");
        const code = AgentStore.issueCode(store, used.clientId, "http://localhost:5555/callback", challengeOf("v"));
        AgentStore.redeem(store, { code, verifier: "v", clientId: used.clientId, redirectUri: "http://localhost:5555/callback" });
        now += 24 * 60 * 60 * 1000 + 1;
        registered(store, "New");
        expect(AgentStore.client(store, idle.clientId)).toBeUndefined();
        expect(AgentStore.client(store, used.clientId)?.clientName).toBe("Used");
    });

    test("when the file cannot be written the sign-in is refused and nothing changes in memory", () => {
        const store = loaded();
        const client = registered(store);
        rmSync(dir, { recursive: true, force: true });
        writeFileSync(dir, "a file where the directory was");
        const code = AgentStore.issueCode(store, client.clientId, "http://localhost:5555/callback", challengeOf("v"));
        const result = AgentStore.redeem(store, { code, verifier: "v", clientId: client.clientId, redirectUri: "http://localhost:5555/callback" });
        expect(result.kind).toBe("unsaved");
        expect(AgentStore.agents(store)).toEqual([]);
        rmSync(dir, { force: true });
    });
});

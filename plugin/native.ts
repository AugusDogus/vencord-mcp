/*
 * The main-process half. Vencord loads every plugin's native.ts at Discord's launch, enabled
 * or not, and makes each export an IPC handler, so nothing listens until the renderer's
 * start() calls start() here, and every export is a function.
 *
 * The server reaches Discord through the window that started it: approvals and tool calls
 * run in that renderer via executeJavaScript, and come back as values parsed again here.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { app, BrowserWindow, type IpcMainInvokeEvent, type WebContents } from "electron";

import { AgentStore, type Loaded } from "./server/AgentStore";
import { type Bridge, Server } from "./server/Server";
import { PLUGIN_NAME, PORT, VERSION } from "./shared/constants";
import { ToolResult } from "./shared/ToolResult";

const STORE_PATH = join(DATA_DIR, "MCP", "agents.json");
/** Under opencode's 30-second default, so the agent reads why instead of timing out itself. */
const TOOL_TIMEOUT_MS = 25_000;
const PLUGIN = `Vencord.Plugins.plugins[${JSON.stringify(PLUGIN_NAME)}]`;

export type Status =
    | { readonly kind: "serving"; readonly url: string }
    | { readonly kind: "off" }
    | { readonly kind: "failed"; readonly reason: string };

export type AgentRow = { readonly tokenHash: string; readonly clientName: string; readonly linkedAt: string };

export type AgentsView =
    | { readonly kind: "listed"; readonly status: Status; readonly agents: readonly AgentRow[] }
    | { readonly kind: "unreadable"; readonly reason: string };

type State =
    | { readonly kind: "off" }
    | { readonly kind: "serving"; readonly port: number; readonly close: () => Promise<void> }
    | { readonly kind: "failed"; readonly reason: string };

let state: State = { kind: "off" };
/** One card at a time: a second sign-in while one waits is turned away, so cards cannot pile up. */
let asking = false;
let renderer: WebContents | undefined;
let loaded: Extract<Loaded, { kind: "loaded" }> | undefined;
/** start and stop run one at a time, so a quick toggle cannot leave two servers or none. */
let queue: Promise<unknown> = Promise.resolve();

function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function statusOf(current: State): Status {
    switch (current.kind) {
        case "serving":
            return { kind: "serving", url: `http://127.0.0.1:${current.port}/mcp` };
        case "off":
            return { kind: "off" };
        case "failed":
            return { kind: "failed", reason: current.reason };
    }
}

/** Loads the agents file once; a file it cannot read is left untouched and reported every time. */
function store(): Loaded {
    if (loaded !== undefined) return loaded;
    const result = AgentStore.load(STORE_PATH);
    if (result.kind === "loaded") loaded = result;
    return result;
}

const unreadableReason = (path: string, reason: string) =>
    `the agents file at ${path} could not be read: ${reason}. It was left as it is. Move it aside to start over; agents will then need to sign in again.`;

function liveRenderer(): WebContents | undefined {
    return renderer !== undefined && !renderer.isDestroyed() ? renderer : undefined;
}

/** Brings Discord to the front, since the user is in a browser when an agent signs in. */
function raise(target: WebContents) {
    const window = BrowserWindow.fromWebContents(target);
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
}

function timeout(ms: number): Promise<"timed out"> {
    return new Promise(resolve => setTimeout(() => resolve("timed out"), ms));
}

const bridge: Bridge = {
    async approve(clientName, signal) {
        const target = liveRenderer();
        if (target === undefined) return { kind: "unavailable", reason: "Discord's window is closed" };
        if (signal.aborted) return { kind: "denied" };
        if (asking) return { kind: "unavailable", reason: "another agent's sign-in is waiting in Discord; answer that one first" };
        asking = true;
        const id = randomUUID();
        const withdraw = () => {
            target.executeJavaScript(`${PLUGIN}.withdrawApproval(${JSON.stringify(id)})`).catch(() => undefined);
        };
        // A page that reloads mid-question never answers; the abort (timeout or browser gone) still ends it.
        const withdrawn = new Promise<"withdrawn">(resolve => {
            if (signal.aborted) resolve("withdrawn");
            signal.addEventListener("abort", () => resolve("withdrawn"), { once: true });
        });
        signal.addEventListener("abort", withdraw, { once: true });
        try {
            raise(target);
            const answer: unknown = await Promise.race([target.executeJavaScript(`${PLUGIN}.askApproval(${JSON.stringify(id)}, ${JSON.stringify(clientName)})`), withdrawn]);
            return answer === true ? { kind: "allowed" } : { kind: "denied" };
        } catch (error) {
            return { kind: "unavailable", reason: `the plugin in Discord did not answer (${describe(error)})` };
        } finally {
            signal.removeEventListener("abort", withdraw);
            asking = false;
        }
    },

    async callTool(name, args) {
        const target = liveRenderer();
        if (target === undefined) return ToolResult.failed("Discord's window is closed, so nothing could be read; open Discord and call again");
        // The arguments travel as a JSON string literal, never as code.
        const code = `${PLUGIN}.runTool(${JSON.stringify(name)}, ${JSON.stringify(JSON.stringify(args))})`;
        try {
            const answer: unknown = await Promise.race([target.executeJavaScript(code), timeout(TOOL_TIMEOUT_MS)]);
            if (answer === "timed out") {
                return ToolResult.failed(`${name} got no answer from Discord within ${TOOL_TIMEOUT_MS / 1000} seconds; Discord may be busy or reloading, so call again`);
            }
            return ToolResult.parse(answer) ?? ToolResult.failed(`${name} answered with something that is not a tool result; this is a bug in the MCP plugin`);
        } catch (error) {
            return ToolResult.failed(`${name} could not run in Discord (${describe(error)}); if Discord is reloading, call again in a moment`);
        }
    },
};

export function start(event: IpcMainInvokeEvent): Promise<Status> {
    // A reload of the window starts the plugin again: keep serving, through the new page.
    renderer = event.sender;
    return inTurn(async () => {
        if (state.kind === "serving") return statusOf(state);
        const current = store();
        if (current.kind === "unreadable") {
            state = { kind: "failed", reason: unreadableReason(current.path, current.reason) };
            return statusOf(state);
        }
        const listening = await Server.listen(PORT, { store: current.store, bridge, version: VERSION });
        state =
            listening.kind === "listening"
                ? { kind: "serving", port: listening.port, close: listening.close }
                : { kind: "failed", reason: `${listening.reason}. Another app (or a second Discord) may hold the port; agents cannot connect until it is free and the plugin is restarted.` };
        return statusOf(state);
    });
}

export function stop(): Promise<Status> {
    return inTurn(async () => {
        if (state.kind === "serving") await state.close();
        state = { kind: "off" };
        return statusOf(state);
    });
}

export function agents(): AgentsView {
    const current = store();
    if (current.kind === "unreadable") return { kind: "unreadable", reason: unreadableReason(current.path, current.reason) };
    return {
        kind: "listed",
        status: statusOf(state),
        agents: AgentStore.agents(current.store).map(({ tokenHash, clientName, linkedAt }) => ({ tokenHash, clientName, linkedAt })),
    };
}

export function revoke(_event: IpcMainInvokeEvent, tokenHash: unknown): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (typeof tokenHash !== "string") return { ok: false, reason: "no agent was named" };
    const current = store();
    if (current.kind === "unreadable") return { ok: false, reason: unreadableReason(current.path, current.reason) };
    const result = AgentStore.revoke(current.store, tokenHash);
    switch (result.kind) {
        case "revoked":
            return { ok: true };
        case "unknown":
            return { ok: false, reason: "that agent was already removed" };
        case "unsaved":
            return { ok: false, reason: `the agent was not removed, because ${result.reason}; it can still connect` };
    }
}

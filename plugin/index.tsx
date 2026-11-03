/*
 * MCP: serves the signed-in Discord account to agents (Claude Code, Codex, opencode...)
 * over MCP at http://127.0.0.1:7326/mcp, read-only. An agent signs in once with
 * OAuth; Discord asks here whether to let it in, and the settings list the ones let in.
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { CodeBlock } from "@components/CodeBlock";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { closeModal, ConfirmModal, openModal, useEffect, useState } from "@webpack/common";

import { runTool } from "./discord/tools";
import type { AgentsView } from "./native";
import { PORT } from "./shared/constants";

const Native = VencordNative.pluginHelpers.MCP as PluginNative<typeof import("./native")>;

const MCP_URL = `http://127.0.0.1:${PORT}/mcp`;

const SETUP = [
    `claude mcp add --transport http discord ${MCP_URL}   # then /mcp in Claude Code to sign in`,
    `codex mcp add discord --url ${MCP_URL} && codex mcp login discord`,
    `# opencode: {"type": "remote", "url": "${MCP_URL}"} under "mcp", then \`opencode mcp auth discord\``,
].join("\n");

type Pending = { readonly modalKey: string; readonly settle: (allowed: boolean) => void };
const pending = new Map<string, Pending>();

function withdraw(id: string) {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    waiting.settle(false);
    closeModal(waiting.modalKey);
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type View = { readonly kind: "loading" } | AgentsView | { readonly kind: "failed"; readonly reason: string };

function Agents() {
    const [view, setView] = useState<View>({ kind: "loading" });
    const [notice, setNotice] = useState<string | undefined>(undefined);
    const refresh = () =>
        Native.agents().then(setView, (error: unknown) => setView({ kind: "failed", reason: error instanceof Error ? error.message : String(error) }));
    useEffect(() => {
        void refresh();
    }, []);

    const remove = async (tokenHash: string) => {
        const result = await Native.revoke(tokenHash);
        setNotice(result.ok ? undefined : result.reason);
        await refresh();
    };

    switch (view.kind) {
        case "loading":
            return <Paragraph>Loading…</Paragraph>;
        case "failed":
        case "unreadable":
            return <Paragraph>{view.reason}</Paragraph>;
        case "listed":
            break;
    }
    const { status, agents } = view;
    return (
        <Flex flexDirection="column" gap="0.75em">
            <Paragraph>
                {status.kind === "serving"
                    ? `Serving ${MCP_URL}, read-only. Add it to an agent and sign in from there.`
                    : status.kind === "failed"
                        ? `Not serving: ${status.reason}`
                        : "Off. Agents already let in keep their access."}
            </Paragraph>
            <CodeBlock lang="sh" content={SETUP} />
            {notice === undefined ? null : <Paragraph>{notice}</Paragraph>}
            {agents.length === 0 ? (
                <Paragraph>No agents yet.</Paragraph>
            ) : (
                agents.map(agent => (
                    <Flex key={agent.tokenHash} justifyContent="space-between" alignItems="center">
                        <Paragraph>{`${agent.clientName}, linked ${formatDate(agent.linkedAt)}`}</Paragraph>
                        <Button variant="dangerSecondary" size="small" onClick={() => void remove(agent.tokenHash)}>
                            Remove
                        </Button>
                    </Flex>
                ))
            )}
        </Flex>
    );
}

const settings = definePluginSettings({
    agents: {
        type: OptionType.COMPONENT,
        component: () => <Agents />,
    },
});

export default definePlugin({
    name: "MCP",
    description: "Lets agents like Claude Code and Codex read your Discord over MCP.",
    authors: [{ name: "AugusDogus", id: 0n }],
    settings,

    async start() {
        const status = await Native.start();
        if (status.kind === "failed") showNotification({ title: "MCP is not serving", body: status.reason });
    },

    stop() {
        for (const id of [...pending.keys()]) withdraw(id);
        void Native.stop();
    },

    /** Called by the main process while /authorize waits: true lets the agent in. */
    askApproval(id: string, clientName: string): Promise<boolean> {
        return new Promise(resolve => {
            let settled = false;
            const settle = (allowed: boolean) => {
                if (settled) return;
                settled = true;
                pending.delete(id);
                resolve(allowed);
            };
            const modalKey = openModal(
                props => (
                    <ConfirmModal
                        {...props}
                        variant="primary"
                        title={`Let ${clientName} read your Discord?`}
                        subtitle="Read-only, while Discord runs. You can remove it in the plugin's settings."
                        confirmText="Allow"
                        cancelText="Deny"
                        onConfirm={() => settle(true)}
                        onCancel={() => settle(false)}
                    />
                ),
                { onCloseCallback: () => settle(false) },
            );
            pending.set(id, { modalKey, settle });
            if (!document.hasFocus()) showNotification({ title: "An agent wants in", body: `Let ${clientName} read your Discord?` });
        });
    },

    /** Called by the main process when the browser gave up or nobody answered in time. */
    withdrawApproval: withdraw,

    runTool,
});

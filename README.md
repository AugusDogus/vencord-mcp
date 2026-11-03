<div align="center">
    <br/>
    <p>
        <img src="assets/icon.svg" title="vencord-mcp" alt="vencord-mcp logo" width="120" />
        <h1>vencord-mcp</h1>
    </p>
    <p>
        Let your agents read your Discord.
    </p>
</div>

A Vencord plugin that serves your account over MCP to Claude Code, Codex and opencode. An agent can't read anything until you click Allow in Discord.

## What it reads

| Tool | Returns |
| --- | --- |
| `list_servers` | Servers in sidebar order, with unread and mention counts |
| `list_channels` | A server's channels and joined threads |
| `list_dms` | DMs and group DMs, most recent first |
| `read_messages` | A channel, thread or DM, newest first (`before` pages back) |
| `search_messages` | Discord's search, in a server or a DM |

Read-only: nothing is sent, edited, reacted to or marked read. Reads go through Discord's own client, so your token is never touched.

## Install

Userplugins need Vencord built from source. The normal Vencord installer can't load them.

```sh
git clone https://github.com/Vendicated/Vencord ~/dev/Vencord
git clone https://github.com/AugusDogus/vencord-mcp ~/dev/vencord-mcp
cd ~/dev/Vencord && pnpm install --frozen-lockfile
sh ~/dev/vencord-mcp/scripts/link.sh ~/dev/Vencord
pnpm build
pnpm inject   # with Discord quit
```

Then enable **MCP** in Settings > Vencord > Plugins. To update: `git pull` in vencord-mcp, `pnpm build` in Vencord, restart Discord.

Tested on macOS with Discord stable. Client mods are against Discord's terms of service.

## Connect

```sh
# Claude Code
claude mcp add --transport http --scope user discord http://127.0.0.1:7326/mcp
claude mcp login discord

# Codex
codex mcp add discord --url http://127.0.0.1:7326/mcp
codex mcp login discord
```

opencode: add this under `"mcp"` in its config, then run `opencode mcp auth discord`.

```json
"discord": { "type": "remote", "url": "http://127.0.0.1:7326/mcp" }
```

Tokens never expire. Remove an agent in the plugin's settings to revoke it.

## Develop

```sh
bun install
bun test
bun run typecheck
```

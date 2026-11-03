/*
 * The tools the server lists. Every one only reads: none sends, edits, reacts or marks
 * anything read. The main process lists them; the renderer parses their arguments and runs
 * them (plugin/discord).
 */

import { type ArgsOf, Field, Tool } from "./Tool";

export const Tools = {
    list_servers: Tool.define(
        "The servers in the sidebar, in its order, with each one's unread state and mention count.",
        { unread_only: Field.flag("Only servers with unread messages.") },
    ),

    list_channels: Tool.define(
        "A server's text channels (text, announcement, forum and voice chats) in sidebar order, each with its category, unread state and mention count, followed by the threads I have joined. Pass a channel id to read_messages.",
        { server_id: Field.id("The server id from list_servers.") },
    ),

    list_dms: Tool.define(
        "My direct messages and group DMs, most recent first, with the people in each, unread state and mention count.",
        {
            limit: Field.count("How many conversations (default 50, at most 500).", 50, 500),
            unread_only: Field.flag("Only conversations with unread messages."),
        },
    ),

    read_messages: Tool.define(
        "The latest messages of a channel, thread or DM, newest first, as Discord markdown with mentions spelled out (@name, #channel), attachments as links and embeds summarized. Pass before to page further back.",
        {
            channel_id: Field.id("The channel, thread or DM id from list_channels or list_dms."),
            limit: Field.count("How many messages, newest first (default 30, at most 100).", 30, 100),
            before: Field.optionalId("Only messages older than this message id, to page back from the oldest one a previous call gave."),
        },
    ),

    search_messages: Tool.define(
        "Search messages with Discord's search, newest first: in one server (server_id, optionally narrowed with channel_id), or in one DM (channel_id). Gives the total match count and the matching messages with their channel.",
        {
            query: Field.text("The words to search for."),
            server_id: Field.optionalId("Search this server (from list_servers)."),
            channel_id: Field.optionalId("Search only this channel or DM (from list_channels or list_dms)."),
            author_id: Field.optionalId("Only messages by this user id."),
            limit: Field.count("How many messages (default 25, at most 25).", 25, 25),
        },
    ),
} as const;

export type ToolName = keyof typeof Tools;

export type ToolArgs<K extends ToolName> = ArgsOf<(typeof Tools)[K]["fields"]>;

/** Own keys only: `"toString" in Tools` is true, and must not name a tool. */
export const isToolName = (name: string): name is ToolName => Object.hasOwn(Tools, name);

export const ToolNames: readonly ToolName[] = Object.keys(Tools).filter(isToolName);

/*
 * The tools, run in the renderer against the client's own stores and its REST client, so the
 * account's token is never touched. Nothing here writes: no message is sent, nothing is
 * marked read, and the REST calls are the ones the client makes when you scroll or search.
 */

import {
    ActiveJoinedThreadsStore,
    ChannelStore,
    Constants,
    GuildChannelStore,
    GuildMemberStore,
    GuildReadStateStore,
    GuildRoleStore,
    GuildStore,
    PrivateChannelSortStore,
    ReadStateStore,
    RestAPI,
    SnowflakeUtils,
    SortedGuildStore,
    UserGuildSettingsStore,
    UserStore,
} from "@webpack/common";

import { Tool } from "../shared/Tool";
import { isToolName, type ToolArgs, type ToolName, Tools } from "../shared/tools";
import { ToolResult } from "../shared/ToolResult";
import { Message, type Names } from "./Message";

type Channel = NonNullable<ReturnType<typeof ChannelStore.getChannel>>;
type Guild = NonNullable<ReturnType<typeof GuildStore.getGuild>>;
type User = NonNullable<ReturnType<typeof UserStore.getUser>>;

/** Discord's channel types (stable API numbers). */
const ChannelType = {
    GUILD_TEXT: 0,
    DM: 1,
    GUILD_VOICE: 2,
    GROUP_DM: 3,
    GUILD_ANNOUNCEMENT: 5,
    ANNOUNCEMENT_THREAD: 10,
    PUBLIC_THREAD: 11,
    PRIVATE_THREAD: 12,
    GUILD_STAGE_VOICE: 13,
    GUILD_FORUM: 15,
    GUILD_MEDIA: 16,
} as const;

type Rec = Readonly<Record<string, unknown>>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const CHANNEL_KINDS: Readonly<Record<number, string>> = {
    [ChannelType.GUILD_TEXT]: "text",
    [ChannelType.GUILD_ANNOUNCEMENT]: "announcement",
    [ChannelType.GUILD_FORUM]: "forum",
    [ChannelType.GUILD_MEDIA]: "media",
    [ChannelType.GUILD_VOICE]: "voice",
    [ChannelType.GUILD_STAGE_VOICE]: "stage",
    [ChannelType.PUBLIC_THREAD]: "thread",
    [ChannelType.PRIVATE_THREAD]: "private_thread",
    [ChannelType.ANNOUNCEMENT_THREAD]: "thread",
    [ChannelType.DM]: "dm",
    [ChannelType.GROUP_DM]: "group_dm",
};

const kindOf = (channel: Channel) => CHANNEL_KINDS[channel.type] ?? `type_${channel.type}`;

// The stores answer undefined for ids they do not hold, whatever their typings say.
const channelById = (id: string): Channel | undefined => ChannelStore.getChannel(id) ?? undefined;
const guildById = (id: string): Guild | undefined => GuildStore.getGuild(id) ?? undefined;
const userById = (id: string): User | undefined => UserStore.getUser(id) ?? undefined;

function userName(id: string, guildId: string | undefined): string | undefined {
    const nick = guildId === undefined ? undefined : GuildMemberStore.getNick(guildId, id);
    if (nick) return nick;
    const user = userById(id);
    return user === undefined ? undefined : user.globalName || user.username;
}

function namesIn(guildId: string | undefined): Names {
    return {
        user: id => userName(id, guildId),
        channel: id => channelById(id)?.name || undefined,
        role: id => (guildId === undefined ? undefined : GuildRoleStore.getRole(guildId, id)?.name),
    };
}

const guildOf = (channel: Channel): string | undefined => channel.guild_id || undefined;

function lastActive(channel: Channel): string | undefined {
    return channel.lastMessageId ? new Date(SnowflakeUtils.extractTimestamp(channel.lastMessageId)).toISOString() : undefined;
}

function readState(channelId: string) {
    return { unread: ReadStateStore.hasUnread(channelId), mentions: ReadStateStore.getMentionCount(channelId) };
}

/**
 * Spaces calls out the way a person scrolling and searching would, so an agent's reads look
 * like the client's own traffic and stay well inside Discord's rate limits.
 */
function spacedBy(gapMs: number) {
    let next = 0;
    return async <T>(work: () => Promise<T>): Promise<T> => {
        const now = Date.now();
        const start = Math.max(now, next);
        next = start + gapMs;
        if (start > now) await new Promise(resolve => setTimeout(resolve, start - now));
        return work();
    };
}

const paced = spacedBy(1000);
const pacedSearch = spacedBy(2000);

/** What Discord said when a REST call failed, for the agent to read. */
function describeFailure(error: unknown): string {
    if (isRecord(error) && typeof error.status === "number") {
        const body = isRecord(error.body) ? error.body : {};
        const message = typeof body.message === "string" ? ` ${body.message}` : "";
        const code = typeof body.code === "number" ? ` (code ${body.code})` : "";
        return `Discord answered ${error.status}${message}${code}`;
    }
    return error instanceof Error ? error.message : String(error);
}

const READABLE: ReadonlySet<number> = new Set([
    ChannelType.GUILD_TEXT,
    ChannelType.GUILD_ANNOUNCEMENT,
    ChannelType.GUILD_VOICE,
    ChannelType.GUILD_STAGE_VOICE,
    ChannelType.PUBLIC_THREAD,
    ChannelType.PRIVATE_THREAD,
    ChannelType.ANNOUNCEMENT_THREAD,
    ChannelType.DM,
    ChannelType.GROUP_DM,
]);

function formatAll(raw: unknown, names: Names): Message[] {
    return (Array.isArray(raw) ? raw : []).flatMap(m => {
        const message = Message.fromApi(m, names);
        return message === undefined ? [] : [message];
    });
}

type Implementations = { readonly [K in ToolName]: (args: ToolArgs<K>) => Promise<ToolResult> };

const implementations: Implementations = {
    async list_servers({ unread_only }) {
        const servers = SortedGuildStore.getFlattenedGuildIds().flatMap(id => {
            const guild = guildById(id);
            if (guild === undefined) return [];
            const unread = GuildReadStateStore.hasUnread(id);
            if (unread_only && !unread) return [];
            return [{ id, name: guild.name, unread, mentions: GuildReadStateStore.getMentionCount(id), muted: UserGuildSettingsStore.isMuted(id) }];
        });
        return ToolResult.json({ servers });
    },

    async list_channels({ server_id }) {
        const guild = guildById(server_id);
        if (guild === undefined) return ToolResult.failed("I am not in a server with that id; list_servers gives the ids");
        const describe = (channel: Channel) => {
            const category = channel.parent_id ? channelById(channel.parent_id) : undefined;
            const topic = channel.topic || undefined;
            return {
                id: channel.id,
                name: channel.name,
                kind: kindOf(channel),
                ...(category === undefined ? {} : { category: category.name }),
                ...(topic === undefined ? {} : { topic }),
                ...readState(channel.id),
                muted: UserGuildSettingsStore.isGuildOrCategoryOrChannelMuted(server_id, channel.id),
            };
        };
        const { SELECTABLE, VOCAL } = GuildChannelStore.getChannels(server_id);
        const channels = [...SELECTABLE, ...VOCAL].map(entry => describe(entry.channel));
        const threads = Object.values(ActiveJoinedThreadsStore.getActiveJoinedThreadsForGuild(server_id)).flatMap(byThread =>
            Object.values(byThread).map(({ channel }) => {
                const parent = channelById(channel.parent_id);
                return { id: channel.id, name: channel.name, kind: kindOf(channel), ...(parent === undefined ? {} : { parent: parent.name }), ...readState(channel.id), last_active: lastActive(channel) };
            }),
        );
        return ToolResult.json({ server: guild.name, channels, threads });
    },

    async list_dms({ limit, unread_only }) {
        const dms = PrivateChannelSortStore.getPrivateChannelIds().flatMap(id => {
            const channel = channelById(id);
            if (channel === undefined || channel.isMessageRequest || channel.isSpam) return [];
            const state = readState(id);
            if (unread_only && !state.unread) return [];
            const people = channel.recipients.map(userId => ({ id: userId, name: userName(userId, undefined) ?? userId }));
            const name = channel.isGroupDM() ? channel.name || people.map(p => p.name).join(", ") : (people[0]?.name ?? id);
            return [{ id, name, kind: kindOf(channel), people, ...state, last_active: lastActive(channel) }];
        });
        return ToolResult.json({ dms: dms.slice(0, limit) });
    },

    async read_messages({ channel_id, limit, before }) {
        const channel = channelById(channel_id);
        if (channel === undefined) return ToolResult.failed("Discord has no channel, thread or DM with that id loaded; list_channels or list_dms give the ids");
        if (!READABLE.has(channel.type)) {
            return ToolResult.failed(
                channel.type === ChannelType.GUILD_FORUM || channel.type === ChannelType.GUILD_MEDIA
                    ? `#${channel.name} is a forum: its posts are threads, and list_channels lists the ones I have joined`
                    : `#${channel.name} holds no messages (it is a ${kindOf(channel)})`,
            );
        }
        const response = await paced(() =>
            RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channel_id),
                query: { limit, ...(before === undefined ? {} : { before }) },
                retries: 2,
            }),
        );
        const messages = formatAll(isRecord(response) ? response.body : undefined, namesIn(guildOf(channel)));
        return ToolResult.json({ channel: channel.name || kindOf(channel), messages });
    },

    async search_messages({ query, server_id, channel_id, author_id, limit }) {
        const channel = channel_id === undefined ? undefined : channelById(channel_id);
        if (channel_id !== undefined && channel === undefined) return ToolResult.failed("Discord has no channel or DM with that id loaded; list_channels or list_dms give the ids");
        const guildId = server_id ?? (channel === undefined ? undefined : guildOf(channel));
        if (server_id !== undefined && channel !== undefined && guildOf(channel) !== server_id) {
            return ToolResult.failed(`#${channel.name} is not in that server; leave out server_id to search it`);
        }
        if (guildId === undefined && channel === undefined) return ToolResult.failed("pass server_id to search a server, or channel_id to search a DM");

        const url = guildId === undefined ? `/channels/${channel_id}/messages/search` : `/guilds/${guildId}/messages/search`;
        const response = await pacedSearch(() =>
            RestAPI.get({
                url,
                query: {
                    content: query,
                    sort_by: "timestamp",
                    sort_order: "desc",
                    limit,
                    ...(guildId !== undefined && channel_id !== undefined ? { channel_id } : {}),
                    ...(author_id === undefined ? {} : { author_id }),
                },
            }),
        );
        if (isRecord(response) && response.status === 202) {
            return ToolResult.failed("Discord is still indexing these messages for search; try again in a few seconds");
        }
        const body = isRecord(response) && isRecord(response.body) ? response.body : {};
        const names = namesIn(guildId);
        // Each hit comes as a list of messages around it; the hit itself is flagged, or first.
        const messages = (Array.isArray(body.messages) ? body.messages : []).flatMap(group => {
            const around: unknown[] = Array.isArray(group) ? group : [];
            const hit = around.find(m => isRecord(m) && m.hit === true) ?? around[0];
            const message = Message.fromApi(hit, names);
            if (message === undefined || !isRecord(hit) || typeof hit.channel_id !== "string") return [];
            return [{ channel: channelById(hit.channel_id)?.name || hit.channel_id, channel_id: hit.channel_id, ...message }];
        });
        return ToolResult.json({ total: typeof body.total_results === "number" ? body.total_results : messages.length, messages });
    },
};

async function run<K extends ToolName>(name: K, raw: unknown): Promise<ToolResult> {
    const parsed = Tool.parse<(typeof Tools)[K]["fields"]>(Tools[name], raw);
    if (!parsed.ok) return ToolResult.failed(`${name} was not run: ${parsed.error}`);
    return implementations[name](parsed.value);
}

/** Called by the main process with the arguments as JSON text; always answers with a result, never throws. */
export async function runTool(name: string, argsJson: string): Promise<ToolResult> {
    if (!isToolName(name)) return ToolResult.failed(`there is no tool ${name}`);
    let raw: unknown;
    try {
        raw = JSON.parse(argsJson);
    } catch {
        return ToolResult.failed(`${name} was not run: its arguments are not JSON`);
    }
    try {
        return await run(name, raw);
    } catch (error) {
        return ToolResult.failed(`${name} failed: ${describeFailure(error)}`);
    }
}

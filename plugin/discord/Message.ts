/*
 * A message as an agent reads it, built from the JSON Discord's REST API returns. The API's
 * shape is Discord's to change, so it is parsed here, field by field, rather than trusted.
 * Names come from the caller (the client's stores), so this stays pure and testable.
 */

/** Names as the user would see them where the message was sent; undefined when unknown. */
export type Names = {
    readonly user: (id: string) => string | undefined;
    readonly channel: (id: string) => string | undefined;
    readonly role: (id: string) => string | undefined;
};

export type Attachment = { readonly name: string; readonly url: string; readonly type?: string };
export type EmbedSummary = { readonly title?: string; readonly url?: string; readonly description?: string };

export type Message = {
    readonly id: string;
    readonly author: string;
    readonly author_id: string;
    /** RFC 3339. */
    readonly time: string;
    /** Discord markdown with mentions, channels, roles, emoji and timestamps spelled out. */
    readonly text: string;
    /** Set for system messages (a member joined, a pin...), absent for ones people wrote. */
    readonly kind?: string;
    readonly edited?: string;
    readonly reply_to?: string;
    readonly forwarded?: string;
    readonly attachments?: readonly Attachment[];
    readonly embeds?: readonly EmbedSummary[];
    readonly stickers?: readonly string[];
    readonly poll?: { readonly question: string; readonly answers: readonly string[] };
};

type Rec = Readonly<Record<string, unknown>>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const records = (v: unknown): readonly Rec[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** Types people write (default, reply, slash command, context menu command); every other is a system message. */
const WRITTEN_TYPES = new Set([0, 19, 20, 23]);

const SYSTEM_KINDS: Readonly<Record<number, string>> = {
    1: "recipient_add",
    2: "recipient_remove",
    3: "call",
    4: "channel_name_change",
    5: "channel_icon_change",
    6: "pin",
    7: "member_join",
    8: "boost",
    9: "boost_tier_1",
    10: "boost_tier_2",
    11: "boost_tier_3",
    12: "channel_follow_add",
    18: "thread_created",
    21: "thread_starter",
    22: "invite_reminder",
    24: "auto_moderation",
    46: "poll_result",
};

const FORWARD_REFERENCE = 1;

function iso(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function personName(user: Rec): string | undefined {
    return nonEmpty(user.global_name) ?? nonEmpty(user.username);
}

/** Replaces Discord's <...> tokens with what the client shows; an id it cannot name stays as written. */
function spellOut(content: string, mentioned: ReadonlyMap<string, string>, names: Names): string {
    return content.replace(/<(@!?|@&|#|a?:\w+:|t:|\/[^:>]+:)(-?\d+)(?::[tTdDfFR])?>/g, (whole: string, sigil: string, id: string) => {
        if (sigil === "@" || sigil === "@!") {
            const name = names.user(id) ?? mentioned.get(id);
            return name === undefined ? whole : `@${name}`;
        }
        if (sigil === "@&") {
            const name = names.role(id);
            return name === undefined ? whole : `@${name}`;
        }
        if (sigil === "#") {
            const name = names.channel(id);
            return name === undefined ? whole : `#${name}`;
        }
        if (sigil === "t:") {
            const date = new Date(Number(id) * 1000);
            return Number.isNaN(date.getTime()) ? whole : date.toISOString();
        }
        if (sigil.startsWith("/")) return sigil.slice(0, -1);
        // :name: or a:name:
        return `:${sigil.replace(/^a?:/, "").slice(0, -1)}:`;
    });
}

function attachmentsOf(v: unknown): readonly Attachment[] {
    return records(v).flatMap(a => {
        const name = str(a.filename);
        const url = str(a.url);
        if (name === undefined || url === undefined) return [];
        const type = str(a.content_type);
        return [type === undefined ? { name, url } : { name, url, type }];
    });
}

function embedsOf(v: unknown): readonly EmbedSummary[] {
    return records(v).flatMap(e => {
        const title = nonEmpty(e.title);
        const url = nonEmpty(e.url);
        const description = nonEmpty(e.description);
        if (title === undefined && url === undefined && description === undefined) return [];
        return [{ ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }), ...(description === undefined ? {} : { description }) }];
    });
}

function pollOf(v: unknown): Message["poll"] {
    if (!isRecord(v) || !isRecord(v.question)) return undefined;
    const question = str(v.question.text);
    if (question === undefined) return undefined;
    const answers = records(v.answers).flatMap(a => {
        const text = isRecord(a.poll_media) ? str(a.poll_media.text) : undefined;
        return text === undefined ? [] : [text];
    });
    return { question, answers };
}

export const Message = {
    fromApi(raw: unknown, names: Names): Message | undefined {
        if (!isRecord(raw) || !isRecord(raw.author)) return undefined;
        const id = str(raw.id);
        const authorId = str(raw.author.id);
        const time = iso(raw.timestamp);
        const type = typeof raw.type === "number" ? raw.type : 0;
        if (id === undefined || authorId === undefined || time === undefined) return undefined;

        const mentioned = new Map(
            records(raw.mentions).flatMap(u => {
                const userId = str(u.id);
                const name = personName(u);
                return userId === undefined || name === undefined ? [] : [[userId, name] as const];
            }),
        );
        const reference = isRecord(raw.message_reference) ? raw.message_reference : undefined;
        const isForward = reference?.type === FORWARD_REFERENCE;
        const snapshot = records(raw.message_snapshots)[0];
        const forwardedText = isForward && snapshot !== undefined && isRecord(snapshot.message) ? str(snapshot.message.content) : undefined;
        const replyTo = !isForward && reference !== undefined ? str(reference.message_id) : undefined;
        const edited = iso(raw.edited_timestamp);
        const attachments = attachmentsOf(raw.attachments);
        const embeds = embedsOf(raw.embeds);
        const stickers = records(raw.sticker_items).flatMap(s => (typeof s.name === "string" ? [s.name] : []));
        const poll = pollOf(raw.poll);

        return {
            id,
            author: names.user(authorId) ?? personName(raw.author) ?? authorId,
            author_id: authorId,
            time,
            text: spellOut(str(raw.content) ?? "", mentioned, names),
            ...(WRITTEN_TYPES.has(type) ? {} : { kind: SYSTEM_KINDS[type] ?? `type_${type}` }),
            ...(edited === undefined ? {} : { edited }),
            ...(replyTo === undefined ? {} : { reply_to: replyTo }),
            ...(forwardedText === undefined ? {} : { forwarded: spellOut(forwardedText, mentioned, names) }),
            ...(attachments.length === 0 ? {} : { attachments }),
            ...(embeds.length === 0 ? {} : { embeds }),
            ...(stickers.length === 0 ? {} : { stickers }),
            ...(poll === undefined ? {} : { poll }),
        };
    },
} as const;

import { describe, expect, test } from "bun:test";

import { Message, type Names } from "../plugin/discord/Message";

const names: Names = {
    user: id => ({ "111111111111111111": "Ana (nick)" })[id],
    channel: id => ({ "222222222222222222": "general" })[id],
    role: id => ({ "333333333333333333": "mods" })[id],
};

const raw = (over: Record<string, unknown> = {}) => ({
    id: "900000000000000001",
    type: 0,
    channel_id: "222222222222222222",
    content: "hello",
    timestamp: "2026-11-03T12:00:00.000000+00:00",
    edited_timestamp: null,
    author: { id: "111111111111111111", username: "ana", global_name: "Ana" },
    mentions: [],
    attachments: [],
    embeds: [],
    ...over,
});

describe("Message.fromApi", () => {
    test("a plain message reads as its author, time and text", () => {
        expect(Message.fromApi(raw(), names)).toEqual({
            id: "900000000000000001",
            author: "Ana (nick)",
            author_id: "111111111111111111",
            time: "2026-11-03T12:00:00.000Z",
            text: "hello",
        });
    });

    test("the author falls back to the global name, then the username", () => {
        const none: Names = { user: () => undefined, channel: () => undefined, role: () => undefined };
        expect(Message.fromApi(raw(), none)?.author).toBe("Ana");
        expect(Message.fromApi(raw({ author: { id: "1", username: "ana", global_name: null } }), none)?.author).toBe("ana");
    });

    test("mentions, channels, roles, emoji, commands and timestamps are spelled out", () => {
        const message = Message.fromApi(
            raw({
                content: "<@111111111111111111> <@!444444444444444444> see <#222222222222222222>, ping <@&333333333333333333> <:blob:555> <a:spin:666> </deploy:777> at <t:1793750400:R>",
                mentions: [{ id: "444444444444444444", username: "bo", global_name: "Bo" }],
            }),
            names,
        );
        expect(message?.text).toBe("@Ana (nick) @Bo see #general, ping @mods :blob: :spin: /deploy at 2026-11-04T00:00:00.000Z");
    });

    test("unknown ids stay as Discord wrote them", () => {
        expect(Message.fromApi(raw({ content: "<@999999999999999999> <#888888888888888888>" }), names)?.text).toBe("<@999999999999999999> <#888888888888888888>");
    });

    test("edits, replies, attachments, embeds and stickers are carried, empty ones left out", () => {
        const message = Message.fromApi(
            raw({
                type: 19,
                edited_timestamp: "2026-11-03T12:05:00+00:00",
                message_reference: { message_id: "900000000000000000", channel_id: "222222222222222222" },
                attachments: [{ id: "1", filename: "shot.png", url: "https://cdn.discordapp.com/a/shot.png", content_type: "image/png", size: 10 }],
                embeds: [{ type: "link", title: "A page", url: "https://example.com", description: "about it" }, { type: "image" }],
                sticker_items: [{ id: "1", name: "wave" }],
            }),
            names,
        );
        expect(message).toMatchObject({
            edited: "2026-11-03T12:05:00.000Z",
            reply_to: "900000000000000000",
            attachments: [{ name: "shot.png", url: "https://cdn.discordapp.com/a/shot.png", type: "image/png" }],
            embeds: [{ title: "A page", url: "https://example.com", description: "about it" }],
            stickers: ["wave"],
        });
        expect(message?.kind).toBeUndefined();
    });

    test("a system message says what kind it is", () => {
        expect(Message.fromApi(raw({ type: 7, content: "" }), names)?.kind).toBe("member_join");
        expect(Message.fromApi(raw({ type: 999, content: "" }), names)?.kind).toBe("type_999");
    });

    test("a forwarded message carries the forwarded text", () => {
        const message = Message.fromApi(
            raw({ content: "", message_reference: { type: 1, message_id: "1", channel_id: "2" }, message_snapshots: [{ message: { content: "look <#222222222222222222>", attachments: [] } }] }),
            names,
        );
        expect(message?.forwarded).toBe("look #general");
        expect(message?.reply_to).toBeUndefined();
    });

    test("a poll carries its question and answers", () => {
        const message = Message.fromApi(raw({ content: "", poll: { question: { text: "Lunch?" }, answers: [{ answer_id: 1, poll_media: { text: "Yes" } }, { answer_id: 2, poll_media: { text: "No" } }] } }), names);
        expect(message?.poll).toEqual({ question: "Lunch?", answers: ["Yes", "No"] });
    });

    test("something that is not a message is refused", () => {
        expect(Message.fromApi({ id: 5 }, names)).toBeUndefined();
        expect(Message.fromApi(null, names)).toBeUndefined();
    });
});

/*
 * What a tool hands back to the agent. The renderer builds it; it crosses to the main
 * process through Electron, so the main process parses it again before trusting it.
 */

export type ToolResult =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "image"; readonly data: string; readonly mimeType: string }
    | { readonly kind: "failed"; readonly message: string };

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null;

export const ToolResult = {
    /** One text block of pretty JSON, the shape every listing and read returns. */
    json(value: unknown): ToolResult {
        return { kind: "text", text: JSON.stringify(value, null, 2) };
    },

    failed(message: string): ToolResult {
        return { kind: "failed", message };
    },

    parse(v: unknown): ToolResult | undefined {
        if (!isRecord(v)) return undefined;
        switch (v.kind) {
            case "text":
                return typeof v.text === "string" ? { kind: "text", text: v.text } : undefined;
            case "image":
                return typeof v.data === "string" && typeof v.mimeType === "string" ? { kind: "image", data: v.data, mimeType: v.mimeType } : undefined;
            case "failed":
                return typeof v.message === "string" ? { kind: "failed", message: v.message } : undefined;
            default:
                return undefined;
        }
    },
} as const;

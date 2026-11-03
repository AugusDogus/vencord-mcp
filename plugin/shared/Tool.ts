/*
 * A tool's arguments, declared once: each field gives both its JSON Schema (for tools/list)
 * and its parser (for tools/call), so the two cannot drift. Only the field kinds the tools
 * use exist. Imported by both the main process and the renderer, so it stays free of Node
 * and Discord.
 */

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export type Field<T> = {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly optional: boolean;
    readonly parse: (value: unknown, name: string) => Parsed<T>;
};

export type Fields = Readonly<Record<string, Field<unknown>>>;

export type ArgsOf<F extends Fields> = { readonly [K in keyof F]: F[K] extends Field<infer T> ? T : never };

export type Tool<F extends Fields> = {
    readonly description: string;
    readonly fields: F;
};

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

const SNOWFLAKE = /^\d{15,21}$/;

export const Field = {
    /** A Discord id (a snowflake, as a string). */
    id(description: string): Field<string> {
        return {
            schema: { type: "string", pattern: SNOWFLAKE.source, description },
            optional: false,
            parse: (v, name) => (typeof v === "string" && SNOWFLAKE.test(v) ? ok(v) : fail(`${name} must be a Discord id: a string of digits`)),
        };
    },

    optionalId(description: string): Field<string | undefined> {
        const required = Field.id(description);
        return { ...required, optional: true, parse: (v, name) => (v === undefined || v === null ? ok(undefined) : required.parse(v, name)) };
    },

    text(description: string): Field<string> {
        return {
            schema: { type: "string", minLength: 1, description },
            optional: false,
            parse: (v, name) => (typeof v === "string" && v.trim() !== "" ? ok(v) : fail(`${name} must be non-empty text`)),
        };
    },

    /** An optional count, `fallback` when left out; values past `max` are capped rather than refused. */
    count(description: string, fallback: number, max: number): Field<number> {
        return {
            schema: { type: "integer", minimum: 1, maximum: max, default: fallback, description },
            optional: true,
            parse: (v, name) => {
                if (v === undefined || v === null) return ok(fallback);
                if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return fail(`${name} must be a whole number of at least 1`);
                return ok(Math.min(v, max));
            },
        };
    },

    flag(description: string): Field<boolean> {
        return {
            schema: { type: "boolean", default: false, description },
            optional: true,
            parse: (v, name) => (v === undefined || v === null ? ok(false) : typeof v === "boolean" ? ok(v) : fail(`${name} must be true or false`)),
        };
    },
} as const;

export const Tool = {
    define<F extends Fields>(description: string, fields: F): Tool<F> {
        return { description, fields };
    },

    inputSchema(tool: Tool<Fields>): Readonly<Record<string, unknown>> {
        const entries = Object.entries(tool.fields);
        return {
            type: "object",
            properties: Object.fromEntries(entries.map(([name, field]) => [name, field.schema])),
            required: entries.filter(([, field]) => !field.optional).map(([name]) => name),
            additionalProperties: false,
        };
    },

    parse<F extends Fields>(tool: Tool<F>, raw: unknown): Parsed<ArgsOf<F>> {
        const given = raw === undefined || raw === null ? {} : raw;
        if (typeof given !== "object" || Array.isArray(given)) return fail("the arguments must be an object");
        const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(given));
        const unknown = Object.keys(record).filter(k => !Object.hasOwn(tool.fields, k));
        if (unknown.length > 0) return fail(`unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);

        const out: Record<string, unknown> = {};
        const errors: string[] = [];
        for (const [name, field] of Object.entries(tool.fields)) {
            const parsed = field.parse(record[name], name);
            if (parsed.ok) out[name] = parsed.value;
            else errors.push(parsed.error);
        }
        if (errors.length > 0) return fail(errors.join("; "));
        // Every field of F was parsed by its own Field<T> above, so `out` has exactly ArgsOf<F>'s shape.
        return ok(out as ArgsOf<F>);
    },
} as const;

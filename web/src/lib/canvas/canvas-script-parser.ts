import i18n from "@/i18n";

// Hand-written tokenizer + recursive descent parser for the canvas script console DSL.
// The DSL is project-specific (`@` references, `!` rerun, `:command`), so a generic expression
// parser would need more preprocessing than it saves. One line = one statement.

export const SCRIPT_FUNCTIONS = ["txt", "img", "vid", "aud"] as const;
export type ScriptFunction = (typeof SCRIPT_FUNCTIONS)[number];

export const SCRIPT_COMMANDS = ["ls", "focus", "mv", "unname", "rm", "undo", "clear", "help"] as const;
export type ScriptCommandName = (typeof SCRIPT_COMMANDS)[number];

export type ScriptExpr =
    | { type: "ref"; name: string; nodeId: boolean; quoted: boolean; from: number; to: number }
    | { type: "ident"; name: string; from: number; to: number }
    | { type: "string"; value: string; from: number; to: number }
    | { type: "number"; value: number; from: number; to: number }
    | { type: "list"; items: ScriptExpr[]; from: number; to: number }
    | { type: "call"; name: ScriptFunction; args: ScriptArg[]; from: number; to: number };

export type ScriptArg = { name?: string; value: ScriptExpr };

export type ScriptCommandArg = { value: string; from: number; to: number };

export type ScriptStatement =
    | { type: "empty"; from: number; to: number }
    | { type: "assign"; target: string; value: ScriptExpr; from: number; to: number }
    | { type: "expr"; value: ScriptExpr; from: number; to: number }
    | { type: "rerun"; target: string; from: number; to: number }
    | { type: "command"; name: ScriptCommandName; args: ScriptCommandArg[]; from: number; to: number };

export class ScriptParseError extends Error {
    from: number;
    to: number;

    constructor(message: string, from: number, to: number) {
        super(message);
        this.name = "ScriptParseError";
        this.from = from;
        this.to = to;
    }
}

type Token =
    | { type: "ref"; value: string; quoted: boolean; nodeId: boolean; from: number; to: number }
    | { type: "string"; value: string; from: number; to: number }
    | { type: "number"; value: number; from: number; to: number }
    | { type: "ident"; value: string; from: number; to: number }
    | { type: "punct"; value: string; from: number; to: number }
    | { type: "eof"; value: ""; from: number; to: number };

const IDENT_RE = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER_RE = /\d+(?:\.\d+)?/y;
const PUNCT = new Set(["=", "(", ")", "[", "]", ",", "!"]);
const REF_DELIMITERS = new Set([" ", "\t", "\r", "\n", ",", "(", ")", "[", "]", "=", "!", '"', ":"]);

function fail(key: string, from: number, to: number, options?: Record<string, unknown>) {
    return new ScriptParseError(i18n.t(`canvas.script.parse.${key}`, options), from, to);
}

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < source.length) {
        const char = source[index];
        if (char === " " || char === "\t" || char === "\r") {
            index += 1;
            continue;
        }
        if (char === "\n" || char === "#") break;

        if (char === ":" && tokens.length === 0) {
            tokens.push({ type: "punct", value: ":", from: index, to: index + 1 });
            index += 1;
            continue;
        }

        if (char === '"') {
            const read = readString(source, index);
            tokens.push({ type: "string", value: read.value, from: index, to: read.next });
            index = read.next;
            continue;
        }

        if (char === "@") {
            index = readReference(source, index, tokens);
            continue;
        }

        IDENT_RE.lastIndex = index;
        const ident = IDENT_RE.exec(source);
        if (ident) {
            tokens.push({ type: "ident", value: ident[0], from: index, to: index + ident[0].length });
            index += ident[0].length;
            continue;
        }

        NUMBER_RE.lastIndex = index;
        const number = NUMBER_RE.exec(source);
        if (number) {
            tokens.push({ type: "number", value: Number(number[0]), from: index, to: index + number[0].length });
            index += number[0].length;
            continue;
        }

        if (PUNCT.has(char)) {
            tokens.push({ type: "punct", value: char, from: index, to: index + 1 });
            index += 1;
            continue;
        }

        throw fail("unexpectedCharacter", index, index + 1, { char });
    }

    tokens.push({ type: "eof", value: "", from: source.length, to: source.length });
    return tokens;
}

function readString(source: string, start: number) {
    let value = "";
    let index = start + 1;
    while (index < source.length) {
        const char = source[index];
        if (char === "\\") {
            const escaped = source[index + 1];
            if (escaped === "n") value += "\n";
            else if (escaped === '"') value += '"';
            else if (escaped === "\\") value += "\\";
            else throw fail("badEscape", index, index + 2);
            index += 2;
            continue;
        }
        if (char === '"') return { value, next: index + 1 };
        value += char;
        index += 1;
    }
    throw fail("unterminatedString", start, source.length);
}

function readReference(source: string, start: number, tokens: Token[]) {
    let index = start + 1;
    if (source[index] === '"') {
        const read = readString(source, index);
        tokens.push({ type: "ref", value: read.value, quoted: true, nodeId: false, from: start, to: read.next });
        return read.next;
    }

    const nameStart = index;
    while (index < source.length && !REF_DELIMITERS.has(source[index])) index += 1;
    if (index === nameStart) throw fail("emptyReference", start, index + 1);
    let name = source.slice(nameStart, index);
    const nodeId = name.startsWith("#");
    if (nodeId) name = name.slice(1);
    if (!name) throw fail("emptyReference", start, index);
    tokens.push({ type: "ref", value: name, quoted: false, nodeId, from: start, to: index });
    return index;
}

export function parseScriptLine(source: string): ScriptStatement {
    const tokens = tokenize(source);
    const parser = new Parser(tokens);

    if (tokens[0].type === "punct" && tokens[0].value === ":") return parser.parseCommand();
    if (tokens[0].type === "eof") return { type: "empty", from: 0, to: source.length };
    if (tokens[0].type === "ident" && tokens[1].type === "punct" && tokens[1].value === "=") return parser.parseAssign();
    if (tokens[0].type === "ident" && tokens[1].type === "punct" && tokens[1].value === "!") {
        const target = tokens[0];
        if (tokens[2].type !== "eof") throw fail("unexpectedToken", tokens[2].from, tokens[2].to, { token: tokens[2].value });
        return { type: "rerun", target: target.value, from: target.from, to: target.to };
    }

    const value = parser.parseExpr();
    parser.expectEnd();
    return { type: "expr", value, from: value.from, to: value.to };
}

class Parser {
    private tokens: Token[];
    private index = 0;

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    private peek(offset = 0) {
        return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
    }

    private next() {
        const token = this.peek();
        this.index += 1;
        return token;
    }

    private expectPunct(value: string) {
        const token = this.next();
        if (token.type !== "punct" || token.value !== value) throw fail("unexpectedToken", token.from, token.to, { token: token.value || "EOF" });
        return token;
    }

    expectEnd() {
        const token = this.peek();
        if (token.type === "eof") return;
        throw fail("unexpectedToken", token.from, token.to, { token: token.value });
    }

    parseAssign(): ScriptStatement {
        const target = this.next() as Extract<Token, { type: "ident" }>;
        this.expectPunct("=");
        const value = this.parseExpr();
        this.expectEnd();
        return { type: "assign", target: target.value, value, from: target.from, to: value.to };
    }

    parseCommand(): ScriptStatement {
        const start = this.expectPunct(":");
        const name = this.next();
        if (name.type !== "ident") throw fail("unexpectedToken", name.from, name.to, { token: name.value });
        if (!(SCRIPT_COMMANDS as readonly string[]).includes(name.value)) throw fail("unknownCommand", name.from, name.to, { name: name.value });
        const args: ScriptCommandArg[] = [];
        while (this.peek().type !== "eof") {
            const token = this.next();
            if (token.type === "ident" || token.type === "string") args.push({ value: token.value, from: token.from, to: token.to });
            else throw fail("unexpectedToken", token.from, token.to, { token: token.value });
        }
        return { type: "command", name: name.value as ScriptCommandName, args, from: start.from, to: args.length ? args[args.length - 1].to : name.to };
    }

    parseExpr(): ScriptExpr {
        const token = this.next();
        if (token.type === "punct" && token.value === "[") return this.parseList(token);
        if (token.type === "string") return { type: "string", value: token.value, from: token.from, to: token.to };
        if (token.type === "number") return { type: "number", value: token.value, from: token.from, to: token.to };
        if (token.type === "ref") return { type: "ref", name: token.value, nodeId: token.nodeId, quoted: token.quoted, from: token.from, to: token.to };
        if (token.type === "ident") {
            const next = this.peek();
            if (next.type === "punct" && next.value === "(") return this.parseCall(token);
            return { type: "ident", name: token.value, from: token.from, to: token.to };
        }
        throw fail("unexpectedToken", token.from, token.to, { token: token.value || "EOF" });
    }

    private parseList(token: Token): ScriptExpr {
        const items: ScriptExpr[] = [];
        if (!(this.peek().type === "punct" && this.peek().value === "]")) {
            items.push(this.parseExpr());
            while (this.peek().type === "punct" && this.peek().value === ",") {
                this.next();
                items.push(this.parseExpr());
            }
        }
        const end = this.expectPunct("]");
        return { type: "list", items, from: token.from, to: end.to };
    }

    private parseCall(name: Extract<Token, { type: "ident" }>): ScriptExpr {
        if (!(SCRIPT_FUNCTIONS as readonly string[]).includes(name.value)) throw fail("unknownFunction", name.from, name.to, { name: name.value });
        this.expectPunct("(");
        const args: ScriptArg[] = [];
        if (!(this.peek().type === "punct" && this.peek().value === ")")) {
            args.push(this.parseArg());
            while (this.peek().type === "punct" && this.peek().value === ",") {
                this.next();
                args.push(this.parseArg());
            }
        }
        const end = this.expectPunct(")");
        return { type: "call", name: name.value as ScriptFunction, args, from: name.from, to: end.to };
    }

    private parseArg(): ScriptArg {
        const token = this.peek();
        if (token.type === "ident" && this.peek(1).type === "punct" && this.peek(1).value === "=") {
            this.next();
            this.next();
            return { name: token.value, value: this.parseExpr() };
        }
        return { value: this.parseExpr() };
    }
}

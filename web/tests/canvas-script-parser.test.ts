import { expect, test } from "bun:test";

// i18n reads localStorage at import time; shim it before the dynamic imports below.
if (!("localStorage" in globalThis)) Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });

const { parseScriptLine, ScriptParseError } = await import("../src/lib/canvas/canvas-script-parser");

test("parses an assignment with a bare @ reference", () => {
    expect(parseScriptLine("girl = @角色A.png")).toMatchObject({ type: "assign", target: "girl", value: { type: "ref", name: "角色A.png", nodeId: false, quoted: false } });
});

test("parses quoted references, node ids and comment lines", () => {
    expect(parseScriptLine('bgm = @"背景 音乐"')).toMatchObject({ target: "bgm", value: { type: "ref", name: "背景 音乐", quoted: true } });
    expect(parseScriptLine("ref2 = @#node-id")).toMatchObject({ target: "ref2", value: { type: "ref", name: "node-id", nodeId: true } });
    expect(parseScriptLine("# 只是注释")).toMatchObject({ type: "empty" });
    expect(parseScriptLine("img(girl)  # 尾注释")).toMatchObject({ type: "expr", value: { type: "call", name: "img" } });
});

test("parses lists, calls, keyword arguments and rerun", () => {
    const list = parseScriptLine("cast = [girl, ref2, bgm]");
    expect(list).toMatchObject({ type: "assign", value: { type: "list", items: [{ name: "girl" }, { name: "ref2" }, { name: "bgm" }] } });

    const call = parseScriptLine('shot = img(girl, p, style, size="2:3", n=2)');
    expect(call).toMatchObject({
        type: "assign",
        target: "shot",
        value: { type: "call", name: "img", args: [{ value: { name: "girl" } }, { value: { name: "p" } }, { value: { name: "style" } }, { name: "size", value: { type: "string", value: "2:3" } }, { name: "n", value: { type: "number", value: 2 } }] },
    });

    expect(parseScriptLine("shot!")).toMatchObject({ type: "rerun", target: "shot" });
    expect(parseScriptLine('aud("欢迎来到夜之城", voice="alloy")')).toMatchObject({ value: { type: "call", name: "aud", args: [{ value: { type: "string", value: "欢迎来到夜之城" } }, { name: "voice", value: { type: "string", value: "alloy" } }] } });
});

test("parses commands with ident and string arguments", () => {
    expect(parseScriptLine(":ls")).toMatchObject({ type: "command", name: "ls", args: [] });
    expect(parseScriptLine(":mv old new")).toMatchObject({ type: "command", name: "mv", args: [{ value: "old" }, { value: "new" }] });
    expect(parseScriptLine(':focus "带 空格"')).toMatchObject({ type: "command", name: "focus", args: [{ value: "带 空格" }] });
});

test("decodes string escapes", () => {
    expect(parseScriptLine('a = "第一行\\n第二行 \\"引用\\""')).toMatchObject({ value: { type: "string", value: '第一行\n第二行 "引用"' } });
});

test("reports parse errors with positions", () => {
    const unterminated = (() => {
        try {
            parseScriptLine('a = "x');
            return null;
        } catch (error) {
            return error as ScriptParseError;
        }
    })();
    expect(unterminated).toBeInstanceOf(ScriptParseError);
    expect(unterminated?.from).toBe(4);

    expect(() => parseScriptLine("foo(girl)")).toThrow(ScriptParseError);
    expect(() => parseScriptLine(":nope")).toThrow(ScriptParseError);
    expect(() => parseScriptLine("girl = @")).toThrow(ScriptParseError);
    expect(() => parseScriptLine("shot = img(girl")).toThrow(ScriptParseError);
});

import { expect, test } from "bun:test";

import type { Asset } from "../src/stores/use-asset-store";

// i18n reads localStorage at import time; shim it before the dynamic imports below.
if (!("localStorage" in globalThis)) Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });

const { compileScriptStatement, placeScriptNode, parseScriptDirective, scriptForSelection, CanvasScriptError, SCRIPT_KWARGS } = await import("../src/lib/canvas/canvas-script");
const { parseScriptLine } = await import("../src/lib/canvas/canvas-script-parser");
const { imageReferenceLabel } = await import("../src/lib/image-reference-prompt");
const { CanvasNodeType } = await import("../src/types/canvas");

const VIEWPORT = { x: 0, y: 0, k: 1 };
const CANVAS = { width: 1600, height: 900 };

function imageNode(id: string, alias?: string) {
    return { id, type: CanvasNodeType.Image, title: `${id} 图片`, position: { x: 0, y: 0 }, width: 340, height: 240, metadata: { content: `image:${id}`, storageKey: `image:${id}`, status: "success" as const, alias } };
}

function textNode(id: string, content: string, alias?: string) {
    return { id, type: CanvasNodeType.Text, title: `${id} 文本`, position: { x: 400, y: 0 }, width: 340, height: 240, metadata: { content, status: "success" as const, alias } };
}

function imageAsset(id: string, title: string): Asset {
    return { id, kind: "image", title, coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: `image:${id}`, storageKey: `image:${id}`, width: 800, height: 1200, bytes: 12, mimeType: "image/png" } };
}

function world(nodes: ReturnType<typeof imageNode>[] = [], assets: Asset[] = [], snippets: { id: string; name: string; params: string[]; template: string }[] = []) {
    return { nodes, connections: [], viewport: VIEWPORT, canvas: CANVAS, assets, snippets };
}

function compile(source: string, w = world()) {
    return compileScriptStatement(parseScriptLine(source), source, w as never);
}

test("binding an asset materializes a node and writes the alias", () => {
    const result = compile("girl = @角色A.png", world([], [imageAsset("a1", "角色A.png")]));
    const added = result.ops.find((op) => op.type === "add_node");
    expect(added).toMatchObject({ nodeType: CanvasNodeType.Image, metadata: { content: "image:a1", storageKey: "image:a1", status: "success" } });
    expect(result.ops.at(-1)).toMatchObject({ type: "update_node", metadata: { alias: "girl" } });
    expect(result.nodeIds).toHaveLength(1);
});

test("binding a canvas node only changes its alias", () => {
    const girl = imageNode("n1");
    const result = compile('girl = @"n1 图片"', world([girl]));
    expect(result.ops).toMatchObject([{ type: "update_node", id: "n1", metadata: { alias: "girl" } }]);
});

test("re-binding an alias frees the previous owner", () => {
    const result = compile('girl = @"n2 图片"', world([imageNode("n1", "girl"), imageNode("n2")]));
    expect(result.ops).toMatchObject([
        { type: "update_node", id: "n1", metadata: { alias: undefined } },
        { type: "update_node", id: "n2", metadata: { alias: "girl" } },
    ]);
});

test("string assignment creates a text node and updates an existing one in place", () => {
    const created = compile('style = "赛博朋克，霓虹夜景"');
    expect(created.ops).toMatchObject([{ type: "add_node", nodeType: CanvasNodeType.Text, metadata: { content: "赛博朋克，霓虹夜景", alias: "style" } }]);

    const existing = textNode("t1", "旧内容", "style");
    const updated = compile('style = "新内容"', world([existing]));
    expect(updated.ops).toMatchObject([{ type: "update_node", id: "t1", metadata: { content: "新内容" } }]);
});

test("list assignment connects every reference into a new pack", () => {
    const result = compile("cast = [girl, bgm]", world([imageNode("n1", "girl"), imageNode("n2", "bgm")]));
    const ops = result.ops as { type: string; fromNodeId?: string; toNodeId?: string; nodeType?: string }[];
    expect(ops.filter((op) => op.type === "connect_nodes")).toMatchObject([
        { fromNodeId: "n1", toNodeId: result.nodeIds[0] },
        { fromNodeId: "n2", toNodeId: result.nodeIds[0] },
    ]);
    expect(result.ops[0]).toMatchObject({ type: "add_node", nodeType: CanvasNodeType.Reference, metadata: { alias: "cast" } });
    expect(result.ops).toHaveLength(3);
});

test("generation connects inputs, writes kwargs and interpolates media labels", () => {
    const girl = imageNode("n1", "girl");
    const result = compile('shot = img(girl, "描述{girl}的穿着", size="2:3", n=2)', world([girl]));
    const added = result.ops.find((op) => op.type === "add_node" && op.nodeType === CanvasNodeType.Image) as { id: string; metadata: Record<string, unknown> } | undefined;
    expect(added?.metadata).toMatchObject({ alias: "shot", size: "2:3", count: "2", generationMode: "image", script: 'shot = img(girl, "描述{girl}的穿着", size="2:3", n=2)' });
    expect(result.ops).toContainEqual({ type: "connect_nodes", fromNodeId: "n1", toNodeId: added?.id });
    expect(result.ops.at(-1)).toMatchObject({ type: "run_generation", nodeId: added?.id, mode: "image", prompt: `描述${imageReferenceLabel(0)}的穿着` });
});

test("text nodes are interpolated as content instead of a label", () => {
    const p = textNode("t1", "分镜提示词", "p");
    const result = compile('shot = img("参考{p}")', world([p]));
    expect(result.ops.at(-1)).toMatchObject({ prompt: "参考分镜提示词" });
});
test("reassigning a generated alias renames the previous node", () => {
    const result = compile("shot = img(girl)", world([imageNode("n1", "girl"), imageNode("n2", "shot")]));
    expect(result.ops).toContainEqual({ type: "update_node", id: "n2", metadata: { alias: "shot_1" } });
    expect(result.alias).toBe("shot");
});

test("unassigned generation gets the next free name", () => {
    const result = compile("img(girl)", world([imageNode("n1", "girl"), imageNode("n2", "img1")]));
    expect(result.alias).toBe("img2");
});

test("commands list, rename, unname and delete named nodes", () => {
    const nodes = [imageNode("n1", "girl"), imageNode("n2", "bgm")];
    expect((compile(":ls", world(nodes)) as { output?: string }).output).toContain("$girl");

    expect(compile(":mv girl idol", world(nodes)).ops).toMatchObject([{ type: "update_node", id: "n1", metadata: { alias: "idol" } }]);
    expect(compile(":unname girl", world(nodes)).ops).toMatchObject([{ type: "update_node", id: "n1", metadata: { alias: undefined } }]);
    expect(compile(":rm girl bgm", world(nodes)).ops).toMatchObject([{ type: "delete_node", ids: ["n1", "n2"] }]);
});

test("rejects unknown variables, unknown kwargs and ambiguous references", () => {
    const unknownVariable = (() => {
        try {
            compile("img(missing)");
            return null;
        } catch (error) {
            return error as InstanceType<typeof CanvasScriptError>;
        }
    })();
    expect(unknownVariable?.code).toBe("undefinedVariable");

    expect(() => compile('img(girl, tempo="fast")', world([imageNode("n1", "girl")]))).toThrow("img 不支持参数 tempo");
    expect(() => compile("img(@同名)", world([imageNode("n1"), imageNode("n2")].map((node) => ({ ...node, title: "同名" }))))).toThrow("匹配到多个节点");
});

test("keyword arguments are declared per generation mode", () => {
    expect(Object.keys(SCRIPT_KWARGS)).toContain("voice");
    expect(SCRIPT_KWARGS.voice.modes).toEqual(["audio"]);
    expect(SCRIPT_KWARGS.n.field).toEqual({ text: "textCount", image: "count" });
});

test("snippets expand parameters textually, in and out of string literals", () => {
    const snippet = { id: "s1", name: "cover", params: ["src", "text"], template: 'img({src}, "{text}", size="2:3")' };
    const girl = imageNode("n1", "girl");

    const quoted = compile('hero = cover(girl, "夜色")', world([girl], [], [snippet]));
    const added = quoted.ops.find((op) => op.type === "add_node") as { id: string; metadata: Record<string, unknown> } | undefined;
    expect(added?.metadata).toMatchObject({ alias: "hero", size: "2:3", script: 'img(girl, "夜色", size="2:3")' });
    expect(quoted.ops).toContainEqual({ type: "connect_nodes", fromNodeId: "n1", toNodeId: added?.id });
    expect(quoted.ops.at(-1)).toMatchObject({ type: "run_generation", prompt: "夜色" });

    // A bare argument inside a string literal becomes literal text, and string escaping is preserved.
    const bare = compile('hero = cover(girl, 夜色)', world([girl], [], [snippet]));
    expect(bare.ops.at(-1)).toMatchObject({ prompt: "夜色" });
    const escaped = compile('hero = cover(girl, "a\\"b")', world([girl], [], [snippet]));
    expect(escaped.ops.at(-1)).toMatchObject({ prompt: 'a"b' });
});

test("snippets can call other snippets but rejected calls report their reason", () => {
    const girl = imageNode("n1", "girl");
    const hero = imageNode("n2", "hero1");
    const snippets = [
        { id: "s1", name: "polish", params: ["img"], template: "cover({img})" },
        { id: "s2", name: "cover", params: ["aimg"], template: 'img({aimg}, "终稿")' },
    ];
    expect(compile("hero = polish(hero1)", world([girl, hero], [], snippets)).ops.at(-1)).toMatchObject({ prompt: "终稿" });

    const error = (() => {
        try {
            compile("missing(girl)", world([girl]));
            return null;
        } catch (caught) {
            return caught as InstanceType<typeof CanvasScriptError>;
        }
    })();
    expect(error?.code).toBe("unknownFunction");
    expect(() => compile("cover(girl)", world([girl], [], [{ id: "s1", name: "cover", params: ["a", "b"], template: "img({a})" }]))).toThrow("需要 2 个参数");
});

test("parses def/del/defs directives and rejects invalid ones", () => {
    expect(parseScriptDirective(':def cover(src, text) img({src}, "{text}")')).toEqual({ type: "def", name: "cover", params: ["src", "text"], template: 'img({src}, "{text}")' });
    expect(parseScriptDirective(":def reset() img(\"空白\")")).toEqual({ type: "def", name: "reset", params: [], template: 'img("空白")' });
    expect(parseScriptDirective(":del cover")).toEqual({ type: "del", name: "cover" });
    expect(parseScriptDirective(":defs")).toEqual({ type: "defs" });
    expect(parseScriptDirective(":ls")).toBeNull();
    expect(() => parseScriptDirective(':def 1bad(a) img("x")')).toThrow("不合法");
    expect(() => parseScriptDirective(':def dup(a, a) img("x")')).toThrow("不合法");
});

test("exports the selected subgraph as statements", () => {
    const girl = imageNode("n1", "girl");
    const prompt = { ...textNode("t1", "", "p"), metadata: { prompt: "分镜", status: "loading" as const, alias: "p", generationMode: "text" as const } };
    const shot = { ...imageNode("n2", "shot"), metadata: { prompt: "夜色", status: "success" as const, alias: "shot", generationMode: "image" as const, size: "2:3", model: "default::gpt-image-2" } };
    const connections = [
        { id: "c1", fromNodeId: "n1", toNodeId: "n2" },
        { id: "c2", fromNodeId: "t1", toNodeId: "n2" },
    ];

    const result = scriptForSelection([girl, prompt, shot], connections, ["n2"], []);
    expect(result.lines).toEqual(["# 由画布选区导出", 'girl = @"n1 图片"', 'p = txt("分镜")', 'shot = img(girl, p, "夜色", model="default::gpt-image-2", size="2:3")']);
    expect(result.skipped).toEqual([]);
});

test("layout places new nodes right of their inputs and centers anchorless nodes", () => {
    const girl = imageNode("n1");
    const size = { width: 340, height: 240 };
    expect(placeScriptNode([girl], size, [girl], VIEWPORT, CANVAS)).toEqual({ x: 436, y: 0 });

    const centered = placeScriptNode([], size, [], VIEWPORT, CANVAS);
    expect(centered).toEqual({ x: CANVAS.width / 2 - size.width / 2, y: CANVAS.height / 2 - size.height / 2 });

    const blocked = { ...imageNode("n2"), position: { x: 436, y: 0 } };
    expect(placeScriptNode([girl], size, [girl, blocked], VIEWPORT, CANVAS)).toEqual({ x: 436, y: 272 });
});

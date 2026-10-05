import { nanoid } from "nanoid";

import i18n from "@/i18n";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import { emitCanvasEvent, onCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { parseScriptLine, SCRIPT_FUNCTIONS, ScriptParseError, type ScriptExpr, type ScriptFunction, type ScriptStatement } from "@/lib/canvas/canvas-script-parser";
import { buildNodeMentionReferences, getGenerationResourceNodes } from "@/lib/canvas/canvas-resource-references";
import { getNodeSpec } from "@/lib/canvas/node-registry";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasScriptSnippetStore, type CanvasScriptSnippet } from "@/stores/canvas/use-canvas-script-snippet-store";
import { useCanvasScriptStore } from "@/stores/canvas/use-canvas-script-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position, type ViewportTransform } from "@/types/canvas";

// Canvas script console runtime: the node graph is the only state, every statement compiles to
// CanvasAgentOp[] and goes through the same applyOps channel as the local Agent.

export type ScriptWorld = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    viewport: ViewportTransform;
    canvas: { width: number; height: number };
    assets: Asset[];
    snippets: CanvasScriptSnippet[];
};

export type ScriptCompileResult = {
    ops: CanvasAgentOp[];
    nodeIds: string[];
    alias?: string;
    outputNodeId?: string;
    focusNodeId?: string;
    output?: string;
    undo?: boolean;
    clearHistory?: boolean;
};

export type ScriptRunResult = {
    status: "success" | "error";
    nodeIds: string[];
    error?: string;
    errorAt?: number;
    output?: string;
    clearHistory?: boolean;
    // Present for generation statements: resolves with an error message, or undefined once the output node succeeds.
    settled?: Promise<string | undefined>;
};

export class CanvasScriptError extends Error {
    code: string;

    constructor(code: string, options?: Record<string, unknown>) {
        super(i18n.t(`canvas.script.error.${code}`, options));
        this.name = "CanvasScriptError";
        this.code = code;
    }
}

function fail(code: string, options?: Record<string, unknown>): never {
    throw new CanvasScriptError(code, options);
}

export const SCRIPT_FUNCTION_MODES: Record<ScriptFunction, CanvasGenerationMode> = { txt: "text", img: "image", vid: "video", aud: "audio" };

const MODE_NODE_TYPES: Record<CanvasGenerationMode, CanvasNodeTypeId> = {
    text: CanvasNodeType.Text,
    image: CanvasNodeType.Image,
    video: CanvasNodeType.Video,
    audio: CanvasNodeType.Audio,
};

export type ScriptKwargSpec = { modes: CanvasGenerationMode[]; field: string | Partial<Record<CanvasGenerationMode, string>>; values?: string[]; skill?: boolean };

// Shared by completion and validation; keep this the single source of truth for keyword arguments.
export const SCRIPT_KWARGS: Record<string, ScriptKwargSpec> = {
    model: { modes: ["text", "image", "video", "audio"], field: "model" },
    skill: { modes: ["text"], field: "skillId", skill: true },
    effort: { modes: ["text"], field: "reasoningEffort", values: ["auto", "low", "medium", "high", "xhigh"] },
    n: { modes: ["text", "image"], field: { text: "textCount", image: "count" } },
    size: { modes: ["image", "video"], field: "size", values: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"] },
    quality: { modes: ["image"], field: "quality" },
    seconds: { modes: ["video"], field: "seconds" },
    steps: { modes: ["video"], field: "steps" },
    voice: { modes: ["audio"], field: "audioVoice" },
    speed: { modes: ["audio"], field: "audioSpeed" },
    format: { modes: ["audio"], field: "audioFormat" },
};

export function scriptKwargNames(mode: CanvasGenerationMode) {
    return Object.entries(SCRIPT_KWARGS)
        .filter(([, spec]) => spec.modes.includes(mode))
        .map(([name]) => name);
}

function scriptKwargField(name: string, mode: CanvasGenerationMode) {
    const spec = SCRIPT_KWARGS[name];
    if (!spec || !spec.modes.includes(mode)) return null;
    return typeof spec.field === "string" ? spec.field : (spec.field[mode] ?? null);
}

// ---------------------------------------------------------------------------
// Workspace helpers

export function readScriptWorld(): ScriptWorld | null {
    const context = useAgentStore.getState().canvasContext;
    if (!context) return null;
    const { nodes, connections, viewport } = context.snapshot;
    return { nodes, connections, viewport, canvas: useCanvasScriptStore.getState().canvasSize, assets: useAssetStore.getState().assets, snippets: useCanvasScriptSnippetStore.getState().snippets };
}

export function aliasNodes(alias: string, nodes: CanvasNodeData[]) {
    return nodes.filter((node) => node.metadata?.alias === alias);
}

export function nextFreeAlias(prefix: string, nodes: CanvasNodeData[]) {
    for (let index = 1; ; index += 1) {
        const alias = `${prefix}${index}`;
        if (!aliasNodes(alias, nodes).length) return alias;
    }
}

function nextIndexedAlias(base: string, nodes: CanvasNodeData[]) {
    for (let index = 1; ; index += 1) {
        const alias = `${base}_${index}`;
        if (!aliasNodes(alias, nodes).length) return alias;
    }
}

const ALIAS_PREFIXES: Partial<Record<CanvasNodeTypeId, string>> = {
    [CanvasNodeType.Image]: "img",
    [CanvasNodeType.Text]: "txt",
    [CanvasNodeType.Video]: "vid",
    [CanvasNodeType.Audio]: "aud",
    [CanvasNodeType.Config]: "cfg",
    [CanvasNodeType.Reference]: "ref",
    [CanvasNodeType.Group]: "grp",
};

// Used by `Alt + 点击` and the node context menu before inserting a node into the console.
export function autoAliasForNode(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    return node.metadata?.alias || nextFreeAlias(ALIAS_PREFIXES[node.type] || "node", nodes);
}

// ---------------------------------------------------------------------------
// Layout

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: CanvasNodeData) {
    return a.x < b.position.x + b.width && a.x + a.width > b.position.x && a.y < b.position.y + b.height && a.y + a.height > b.position.y;
}

export function placeScriptNode(inputs: CanvasNodeData[], size: { width: number; height: number }, nodes: CanvasNodeData[], viewport: ViewportTransform, canvas: { width: number; height: number }): Position {
    let position: Position;
    if (inputs.length) {
        const right = Math.max(...inputs.map((node) => node.position.x + node.width));
        const top = Math.min(...inputs.map((node) => node.position.y));
        const bottom = Math.max(...inputs.map((node) => node.position.y + node.height));
        position = { x: right + 96, y: (top + bottom) / 2 - size.height / 2 };
    } else {
        const centerX = (canvas.width / 2 - viewport.x) / viewport.k;
        const centerY = (canvas.height / 2 - viewport.y) / viewport.k;
        position = { x: centerX - size.width / 2, y: centerY - size.height / 2 };
    }

    for (let guard = 0; guard < 200; guard += 1) {
        const rect = { ...position, width: size.width, height: size.height };
        const hit = nodes.find((node) => rectsOverlap(rect, node));
        if (!hit) break;
        position = { x: position.x, y: hit.position.y + hit.height + 32 };
    }
    return position;
}

// ---------------------------------------------------------------------------
// Values and `@` resolution

type ScriptValue = { kind: "node"; node: CanvasNodeData } | { kind: "asset"; asset: Asset } | { kind: "string"; value: string } | { kind: "number"; value: number } | { kind: "list"; items: ScriptValue[] };

function candidatesError(kind: string, name: string, titles: string[]) {
    return fail("ambiguousReference", { name, kind: i18n.t(`canvas.script.candidates.${kind}`), candidates: titles.join("、") });
}

function resolveReference(name: string, nodeId: boolean, world: ScriptWorld): ScriptValue {
    if (nodeId) {
        const node = world.nodes.find((item) => item.id === name);
        if (!node) fail("unknownNodeId", { name });
        return { kind: "node", node };
    }

    const byAlias = aliasNodes(name, world.nodes);
    if (byAlias.length === 1) return { kind: "node", node: byAlias[0] };
    if (byAlias.length > 1)
        return candidatesError(
            "node",
            name,
            byAlias.map((node) => node.title),
        );

    const byTitle = world.nodes.filter((node) => node.title === name);
    if (byTitle.length === 1) return { kind: "node", node: byTitle[0] };
    if (byTitle.length > 1)
        return candidatesError(
            "node",
            name,
            byTitle.map((node) => node.id),
        );

    const assets = world.assets.filter((asset) => asset.kind !== "skill" && asset.title === name);
    if (assets.length === 1) return { kind: "asset", asset: assets[0] };
    if (assets.length > 1)
        return candidatesError(
            "asset",
            name,
            assets.map((asset) => asset.id),
        );

    const skills = world.assets.filter((asset) => asset.kind === "skill" && asset.title === name);
    if (skills.length === 1) return { kind: "asset", asset: skills[0] };
    if (skills.length > 1)
        return candidatesError(
            "skill",
            name,
            skills.map((asset) => asset.id),
        );

    return fail("unknownReference", { name });
}

function resolveIdent(name: string, world: ScriptWorld): ScriptValue {
    const byAlias = aliasNodes(name, world.nodes);
    if (byAlias.length === 1) return { kind: "node", node: byAlias[0] };
    if (byAlias.length > 1)
        return candidatesError(
            "node",
            name,
            byAlias.map((node) => node.id),
        );
    return fail("undefinedVariable", { name });
}

function evalExpr(expr: ScriptExpr, world: ScriptWorld): ScriptValue {
    if (expr.type === "ident") return resolveIdent(expr.name, world);
    if (expr.type === "ref") return resolveReference(expr.name, expr.nodeId, world);
    if (expr.type === "string") return { kind: "string", value: expr.value };
    if (expr.type === "number") return { kind: "number", value: expr.value };
    if (expr.type === "list") return { kind: "list", items: expr.items.map((item) => evalExpr(item, world)) };
    fail("nestedCall");
}

// ---------------------------------------------------------------------------
// Asset materialization

function assetNodeSpec(asset: Asset) {
    if (asset.kind === "video") return getNodeSpec(CanvasNodeType.Video);
    return getNodeSpec(asset.kind === "text" ? CanvasNodeType.Text : CanvasNodeType.Image);
}

function createAssetNode(asset: Asset, world: ScriptWorld, nodes: CanvasNodeData[], op: (node: CanvasNodeData) => void): CanvasNodeData {
    if (asset.kind === "skill") fail("skillAsValue", { name: asset.title });
    const spec = assetNodeSpec(asset);
    const size =
        asset.kind === "image" ? fitNodeSize(asset.data.width || 1, asset.data.height || 1) : asset.kind === "video" ? fitNodeSize(asset.data.width || spec.width, asset.data.height || spec.height, 420, 420) : { width: spec.width, height: spec.height };
    const node: CanvasNodeData = {
        id: nanoid(),
        type: asset.kind === "image" ? CanvasNodeType.Image : asset.kind === "video" ? CanvasNodeType.Video : CanvasNodeType.Text,
        title: asset.title,
        position: placeScriptNode([], size, nodes, world.viewport, world.canvas),
        width: size.width,
        height: size.height,
        metadata:
            asset.kind === "image"
                ? { content: asset.data.dataUrl, storageKey: asset.data.storageKey, status: "success", naturalWidth: asset.data.width, naturalHeight: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType }
                : asset.kind === "video"
                  ? { content: asset.data.url, storageKey: asset.data.storageKey, status: "success", naturalWidth: asset.data.width, naturalHeight: asset.data.height, bytes: asset.data.bytes, mimeType: asset.data.mimeType || "video/mp4" }
                  : { content: asset.data.content, status: "success", fontSize: 14 },
    };
    nodes.push(node);
    op(node);
    return node;
}

function addNodeOp(node: CanvasNodeData): CanvasAgentOp {
    return { type: "add_node", id: node.id, nodeType: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata: node.metadata };
}

// ---------------------------------------------------------------------------
// Statement compilation

export type ScriptGenerationInput = { fn: ScriptFunction; call: Extract<ScriptExpr, { type: "call" }>; alias?: string; scriptSource: string; world: ScriptWorld };

export function compileScriptStatement(statement: ScriptStatement, scriptSource: string, world: ScriptWorld, depth = 0): ScriptCompileResult {
    if (statement.type === "empty") return { ops: [], nodeIds: [] };
    if (statement.type === "assign") {
        if (statement.value.type === "call") return compileCall(statement.value, scriptSource, world, statement.target, depth);
        return bindValue(statement.target, evalExpr(statement.value, world), world);
    }
    if (statement.type === "expr") {
        if (statement.value.type === "call") return compileCall(statement.value, scriptSource, world, undefined, depth);
        return compileBareExpression(evalExpr(statement.value, world), world);
    }
    if (statement.type === "rerun") {
        const node = commandNodeArg(statement.target, world);
        if (!node.metadata?.script) return fail("noScriptLine", { name: statement.target });
        return compileScriptStatement(parseScriptLine(node.metadata.script), node.metadata.script, world, depth);
    }
    return compileCommand(statement, world);
}

const MAX_SNIPPET_DEPTH = 8;

// Generation functions and user snippets share the call syntax; only the runtime knows which is which.
function compileCall(call: Extract<ScriptExpr, { type: "call" }>, scriptSource: string, world: ScriptWorld, alias: string | undefined, depth: number): ScriptCompileResult {
    if ((SCRIPT_FUNCTIONS as readonly string[]).includes(call.name)) return compileGeneration({ fn: call.name as ScriptFunction, call, alias, scriptSource, world });

    const snippet = world.snippets.find((item) => item.name === call.name);
    if (!snippet) return fail("unknownFunction", { name: call.name });
    if (depth >= MAX_SNIPPET_DEPTH) return fail("snippetRecursion", { name: call.name });

    const expanded = expandSnippet(snippet, call, scriptSource);
    const inner = parseScriptLine(expanded);
    if (inner.type !== "expr") return fail("snippetNotExpression", { name: call.name });
    if (inner.value.type === "call") return compileCall(inner.value, expanded, world, alias, depth + 1);
    const value = evalExpr(inner.value, world);
    return alias ? bindValue(alias, value, world) : compileBareExpression(value, world);
}

function escapeStringContent(value: string) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Textual macro expansion: `{param}` is replaced with the caller's raw argument text, or with the
// unquoted value when the placeholder sits inside a string literal of the template.
function expandSnippet(snippet: CanvasScriptSnippet, call: Extract<ScriptExpr, { type: "call" }>, scriptSource: string) {
    const positional = call.args.filter((arg) => !arg.name);
    if (positional.length !== snippet.params.length) throw new CanvasScriptError("snippetArity", { name: snippet.name, expected: snippet.params.length, actual: positional.length });

    const args = positional.map((arg) => ({ raw: scriptSource.slice(arg.value.from, arg.value.to), text: arg.value.type === "string" ? escapeStringContent(arg.value.value) : null }));
    const template = snippet.template;
    let result = "";
    let inString = false;

    for (let index = 0; index < template.length; index += 1) {
        const char = template[index];
        if (char === "\\" && inString) {
            result += char + (template[index + 1] || "");
            index += 1;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            result += char;
            continue;
        }
        if (char === "{") {
            const end = template.indexOf("}", index);
            const paramIndex = end < 0 ? -1 : snippet.params.indexOf(template.slice(index + 1, end).trim());
            if (paramIndex >= 0) {
                result += inString ? (args[paramIndex].text ?? escapeStringContent(args[paramIndex].raw)) : args[paramIndex].raw;
                index = end;
                continue;
            }
        }
        result += char;
    }
    return result;
}

function addAlias(node: CanvasNodeData, alias: string, nodes: CanvasNodeData[], ops: CanvasAgentOp[]) {
    const owner = aliasNodes(alias, nodes).find((item) => item.id !== node.id);
    if (owner) ops.push({ type: "update_node", id: owner.id, metadata: { alias: undefined } });
    ops.push({ type: "update_node", id: node.id, metadata: { alias } });
}

function bindValue(alias: string, value: ScriptValue, world: ScriptWorld): ScriptCompileResult {
    if (value.kind === "node") {
        const ops: CanvasAgentOp[] = [];
        addAlias(value.node, alias, world.nodes, ops);
        return { ops, nodeIds: [value.node.id], alias };
    }

    if (value.kind === "asset") {
        const nodes = [...world.nodes];
        const ops: CanvasAgentOp[] = [];
        const node = createAssetNode(value.asset, world, nodes, (created) => ops.push(addNodeOp(created)));
        addAlias(node, alias, world.nodes, ops);
        return { ops, nodeIds: [node.id], alias };
    }

    if (value.kind === "string") return bindString(alias, value.value, world);
    if (value.kind === "list") return bindList(alias, value.items, world);
    return fail("invalidValue", { alias });
}

function bindString(alias: string, content: string, world: ScriptWorld): ScriptCompileResult {
    const existing = aliasNodes(alias, world.nodes)[0];
    if (existing?.type === CanvasNodeType.Text) {
        return { ops: [{ type: "update_node", id: existing.id, metadata: { content, status: "success" } }], nodeIds: [existing.id], alias };
    }

    const spec = getNodeSpec(CanvasNodeType.Text);
    const size = { width: spec.width, height: spec.height };
    const node: CanvasNodeData = {
        id: nanoid(),
        type: CanvasNodeType.Text,
        title: spec.title,
        position: placeScriptNode([], size, world.nodes, world.viewport, world.canvas),
        width: size.width,
        height: size.height,
        metadata: { content, status: "success", fontSize: 14, alias },
    };
    const ops: CanvasAgentOp[] = [];
    if (existing) ops.push({ type: "update_node", id: existing.id, metadata: { alias: undefined } });
    ops.push(addNodeOp(node));
    return { ops, nodeIds: [node.id], alias };
}

function bindList(alias: string, items: ScriptValue[], world: ScriptWorld): ScriptCompileResult {
    const nodes = [...world.nodes];
    const preOps: CanvasAgentOp[] = [];
    const inputs: CanvasNodeData[] = [];
    const materialized = new Map<string, CanvasNodeData>();

    const push = (value: ScriptValue) => {
        if (value.kind === "list") return value.items.forEach(push);
        if (value.kind === "number" || value.kind === "string") return fail("invalidValue", { alias });
        const node = value.kind === "node" ? value.node : materializeAsset(value.asset, world, nodes, preOps, materialized);
        if (!inputs.some((item) => item.id === node.id)) inputs.push(node);
    };
    items.forEach(push);

    const existing = aliasNodes(alias, world.nodes)[0];
    if (existing?.type === CanvasNodeType.Reference) {
        const removeIds = world.connections.filter((connection) => connection.toNodeId === existing.id).map((connection) => connection.id);
        const ops: CanvasAgentOp[] = [...preOps];
        if (removeIds.length) ops.push({ type: "delete_connections", ids: removeIds });
        inputs.forEach((node) => ops.push({ type: "connect_nodes", fromNodeId: node.id, toNodeId: existing.id }));
        return { ops, nodeIds: [existing.id], alias };
    }

    const spec = getNodeSpec(CanvasNodeType.Reference);
    const size = { width: spec.width, height: spec.height };
    const node: CanvasNodeData = {
        id: nanoid(),
        type: CanvasNodeType.Reference,
        title: spec.title,
        position: placeScriptNode(inputs, size, nodes, world.viewport, world.canvas),
        width: size.width,
        height: size.height,
        metadata: { status: "idle", alias },
    };
    const ops: CanvasAgentOp[] = [...preOps];
    if (existing) ops.push({ type: "update_node", id: existing.id, metadata: { alias: undefined } });
    ops.push(addNodeOp(node));
    inputs.forEach((input) => ops.push({ type: "connect_nodes", fromNodeId: input.id, toNodeId: node.id }));
    return { ops, nodeIds: [node.id], alias };
}

function materializeAsset(asset: Asset, world: ScriptWorld, nodes: CanvasNodeData[], ops: CanvasAgentOp[], cache: Map<string, CanvasNodeData>) {
    const cached = cache.get(asset.id);
    if (cached) return cached;
    const node = createAssetNode(asset, world, nodes, (created) => ops.push(addNodeOp(created)));
    cache.set(asset.id, node);
    return node;
}

function compileBareExpression(value: ScriptValue, world: ScriptWorld): ScriptCompileResult {
    if (value.kind === "node") return { ops: [], nodeIds: [value.node.id], focusNodeId: value.node.id };
    if (value.kind === "asset") {
        const nodes = [...world.nodes];
        const ops: CanvasAgentOp[] = [];
        const node = createAssetNode(value.asset, world, nodes, (created) => ops.push(addNodeOp(created)));
        return { ops, nodeIds: [node.id], focusNodeId: node.id };
    }
    return fail("invalidExpression");
}

function compileGeneration(input: ScriptGenerationInput): ScriptCompileResult {
    const { fn, call, scriptSource, world } = input;
    const mode = SCRIPT_FUNCTION_MODES[fn];
    const nodeType = MODE_NODE_TYPES[mode];
    const spec = getNodeSpec(nodeType);
    const nodes = [...world.nodes];
    const preOps: CanvasAgentOp[] = [];
    const inputs: CanvasNodeData[] = [];
    const materialized = new Map<string, CanvasNodeData>();
    const metadata: CanvasNodeMetadata = {};

    const nodeForValue = (value: ScriptValue): CanvasNodeData => {
        if (value.kind === "node") return value.node;
        if (value.kind === "asset") return materializeAsset(value.asset, world, nodes, preOps, materialized);
        return fail("invalidInput");
    };
    const pushInput = (value: ScriptValue) => {
        if (value.kind === "list") return value.items.forEach(pushInput);
        const node = nodeForValue(value);
        if (!inputs.some((item) => item.id === node.id)) inputs.push(node);
    };

    const promptParts: string[] = [];
    call.args.forEach((arg) => {
        const value = evalExpr(arg.value, world);
        if (arg.name) return applyKwarg(arg.name, value, mode, metadata, world);
        if (value.kind === "string") return void promptParts.push(value.value);
        if (value.kind === "number") return fail("positionalNumber");
        pushInput(value);
    });

    const outputId = nanoid();
    const markers: { key: string; token: string; value: ScriptValue }[] = [];
    const parts = promptParts.map((part) =>
        part.replace(/\{([^{}]*)\}/g, (match, raw: string) => {
            const token = raw.trim();
            if (!token) return match;
            const value = token.startsWith("@") ? resolveReference(token.slice(1), token.startsWith("@#"), world) : resolveIdent(token, world);
            if (value.kind === "node" && value.node.type === CanvasNodeType.Text) return value.node.metadata?.content || value.node.metadata?.prompt || "";
            if (value.kind !== "node" && value.kind !== "asset") return fail("invalidInterpolation", { name: token });
            if (value.kind === "asset" && value.asset.kind === "skill") return fail("invalidInterpolation", { name: token });
            const key = `\u0000${markers.length}\u0000`;
            markers.push({ key, token, value });
            return key;
        }),
    );

    markers.forEach((marker) => pushInput(marker.value));

    const alias = input.alias || nextFreeAlias(fn, nodes);
    const owner = aliasNodes(alias, nodes)[0];
    if (owner) preOps.push({ type: "update_node", id: owner.id, metadata: { alias: nextIndexedAlias(alias, nodes) } });

    const size = { width: spec.width, height: spec.height };
    const node: CanvasNodeData = {
        id: outputId,
        type: nodeType,
        title: spec.title,
        position: placeScriptNode(inputs, size, nodes, world.viewport, world.canvas),
        width: size.width,
        height: size.height,
        metadata: { ...metadata, alias, script: scriptSource, generationMode: mode },
    };

    // Media in `{name}` interpolation is connected as input, so its label matches the one
    // handleGenerateNode will compute for the same connection order.
    let prompt = parts.join("\n");
    if (markers.length) {
        const connections = [...world.connections, ...inputs.map((item) => ({ id: `${outputId}-${item.id}`, fromNodeId: item.id, toNodeId: outputId }))];
        const labels = new Map(buildNodeMentionReferences(node, [...nodes, node], connections).map((reference) => [reference.id, reference.label]));
        markers.forEach((marker) => {
            const label = labels.get(nodeForValue(marker.value).id);
            if (!label) return fail("invalidInterpolation", { name: marker.token });
            prompt = prompt.split(marker.key).join(label);
        });
    }

    return {
        ops: [...preOps, addNodeOp(node), ...inputs.map((input) => ({ type: "connect_nodes" as const, fromNodeId: input.id, toNodeId: outputId })), { type: "run_generation", nodeId: outputId, mode, prompt }],
        nodeIds: [outputId],
        alias,
        outputNodeId: outputId,
    };
}

function applyKwarg(name: string, value: ScriptValue, mode: CanvasGenerationMode, metadata: CanvasNodeMetadata, world: ScriptWorld) {
    const spec = SCRIPT_KWARGS[name];
    if (!spec || !spec.modes.includes(mode)) return fail("unknownKwarg", { name, mode: i18n.t(`canvas.script.modes.${mode}`) });
    const field = scriptKwargField(name, mode);
    if (!field) return fail("unknownKwarg", { name, mode: i18n.t(`canvas.script.modes.${mode}`) });

    if (spec.skill) {
        if (value.kind === "asset" && value.asset.kind === "skill") {
            metadata.skillId = value.asset.id;
            return;
        }
        if (value.kind === "string") {
            const matches = world.assets.filter((asset) => asset.kind === "skill" && asset.title === value.value);
            if (matches.length !== 1) return fail("unknownSkill", { name: value.value });
            metadata.skillId = matches[0].id;
            return;
        }
        return fail("invalidKwargValue", { name });
    }

    if (value.kind === "string") return void ((metadata as Record<string, unknown>)[field] = value.value);
    if (value.kind === "number") return void ((metadata as Record<string, unknown>)[field] = String(value.value));
    return fail("invalidKwargValue", { name });
}

// ---------------------------------------------------------------------------
// Commands

function commandArg(statement: Extract<ScriptStatement, { type: "command" }>, index: number) {
    const arg = statement.args[index];
    if (!arg) return fail("missingArgument", { name: statement.name });
    return arg.value;
}

function commandNodeArg(name: string, world: ScriptWorld) {
    const byAlias = aliasNodes(name, world.nodes);
    if (byAlias.length === 1) return byAlias[0];
    if (byAlias.length > 1)
        return candidatesError(
            "node",
            name,
            byAlias.map((node) => node.id),
        );
    const byTitle = world.nodes.filter((node) => node.title === name);
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1)
        return candidatesError(
            "node",
            name,
            byTitle.map((node) => node.id),
        );
    return fail("undefinedVariable", { name });
}

function compileCommand(statement: Extract<ScriptStatement, { type: "command" }>, world: ScriptWorld): ScriptCompileResult {
    if (statement.name === "help") return { ops: [], nodeIds: [], output: i18n.t("canvas.script.helpText") };
    if (statement.name === "clear") return { ops: [], nodeIds: [], clearHistory: true };
    if (statement.name === "undo") return { ops: [], nodeIds: [], undo: true };

    if (statement.name === "ls") {
        const listed = world.nodes.filter((node) => node.metadata?.alias);
        return { ops: [], nodeIds: [], output: listed.length ? listed.map((node) => `$${node.metadata?.alias}  ${node.type}  ${node.metadata?.status || "idle"}  ${node.title}`).join("\n") : i18n.t("canvas.script.emptyList") };
    }

    if (statement.name === "focus") {
        const node = commandNodeArg(commandArg(statement, 0), world);
        return { ops: [], nodeIds: [node.id], focusNodeId: node.id };
    }

    if (statement.name === "mv") {
        const node = commandNodeArg(commandArg(statement, 0), world);
        const next = commandArg(statement, 1);
        const ops: CanvasAgentOp[] = [];
        addAlias(node, next, world.nodes, ops);
        return { ops, nodeIds: [node.id], alias: next };
    }

    if (statement.name === "unname") {
        const node = commandNodeArg(commandArg(statement, 0), world);
        return { ops: [{ type: "update_node", id: node.id, metadata: { alias: undefined } }], nodeIds: [node.id] };
    }

    const ids = statement.args.map((arg) => commandNodeArg(arg.value, world).id);
    if (!ids.length) return fail("missingArgument", { name: statement.name });
    return { ops: [{ type: "delete_node", ids }], nodeIds: ids };
}

// ---------------------------------------------------------------------------
// Export selection as script

export type ScriptSelectionExport = { lines: string[]; skipped: string[] };

function quoteScript(value: string) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function exportReference(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const duplicates = nodes.filter((item) => item.title === node.title).length;
    return duplicates > 1 || !node.title ? `@#${node.id}` : `@${quoteScript(node.title)}`;
}

function exportKwargs(node: CanvasNodeData, mode: CanvasGenerationMode, assets: Asset[]) {
    const metadata = node.metadata || {};
    return Object.entries(SCRIPT_KWARGS).flatMap(([name, spec]): string[] => {
        if (!spec.modes.includes(mode)) return [];
        if (spec.skill) {
            const skill = assets.find((asset) => asset.kind === "skill" && asset.id === metadata.skillId);
            return skill ? [`skill=@${quoteScript(skill.title)}`] : [];
        }
        const field = typeof spec.field === "string" ? spec.field : spec.field[mode];
        const value = field ? (metadata as Record<string, unknown>)[field] : undefined;
        if (value === undefined || value === null || value === "") return [];
        return [`${name}=${quoteScript(String(value))}`];
    });
}

function exportNodeLine(node: CanvasNodeData, alias: string, inputs: string[], nodes: CanvasNodeData[], assets: Asset[]): string | null {
    const metadata = node.metadata || {};
    const mode = metadata.generationMode || (node.type === CanvasNodeType.Text && metadata.prompt ? ("text" as const) : undefined);
    if (mode) {
        const fn = Object.entries(SCRIPT_FUNCTION_MODES).find(([, value]) => value === mode)?.[0] || "img";
        const prompt = metadata.prompt || metadata.composerContent || "";
        return `${alias} = ${fn}(${[...inputs, ...(prompt ? [quoteScript(prompt)] : []), ...exportKwargs(node, mode, assets)].join(", ")})`;
    }
    if (node.type === CanvasNodeType.Text && metadata.content) return `${alias} = ${quoteScript(metadata.content)}`;
    if (metadata.content || node.type === CanvasNodeType.Reference) return `${alias} = ${exportReference(node, nodes)}`;
    return null;
}

/**
 * Turn the selected nodes (plus whatever they depend on) into console statements.
 * Generations are rebuilt from node metadata; files that cannot be recreated stay as `@` bindings.
 */
export function scriptForSelection(nodes: CanvasNodeData[], connections: CanvasConnection[], selectedIds: string[], assets: Asset[] = useAssetStore.getState().assets): ScriptSelectionExport {
    const selected = new Set(selectedIds);
    const aliases = new Map<string, string>();
    const visiting = new Set<string>();
    const lines: string[] = [];
    const skipped: string[] = [];

    const emit = (node: CanvasNodeData) => {
        if (aliases.has(node.id) || visiting.has(node.id)) return;
        if (node.type === CanvasNodeType.Group || node.type === CanvasNodeType.Config) {
            skipped.push(node.title || node.type);
            return;
        }

        visiting.add(node.id);
        const inputs = getGenerationResourceNodes(node.id, nodes, connections).filter((input) => input.type !== CanvasNodeType.Group && input.type !== CanvasNodeType.Config);
        inputs.forEach(emit);
        visiting.delete(node.id);

        const alias = node.metadata?.alias || autoAliasForNode(node, nodes);
        const inputAliases = inputs.map((input) => aliases.get(input.id)).filter((item): item is string => Boolean(item));
        const line = exportNodeLine(node, alias, inputAliases, nodes, assets);
        if (!line) {
            skipped.push(node.title || node.type);
            return;
        }
        aliases.set(node.id, alias);
        lines.push(line);
    };

    nodes.filter((node) => selected.has(node.id)).forEach(emit);
    if (!lines.length) return { lines: [], skipped };
    const header = [i18n.t("canvas.script.exportHeader")];
    if (skipped.length) header.push(i18n.t("canvas.script.exportSkipped", { names: Array.from(new Set(skipped)).join("、") }));
    return { lines: [...header, ...lines], skipped };
}

// ---------------------------------------------------------------------------
// Snippets (`:def name(params) <expression template>`)

export type ScriptDirective = { type: "def"; name: string; params: string[]; template: string } | { type: "del"; name: string } | { type: "defs" };

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** `:def` takes a raw template, so it never goes through the statement parser. */
export function parseScriptDirective(source: string): ScriptDirective | null {
    const def = /^\s*:def\s+([^\s(]+)\s*(?:\(([^)]*)\))?\s+(\S.*)$/u.exec(source);
    if (def) {
        const params = def[2] === undefined ? [] : def[2].split(",").map((item) => item.trim()).filter(Boolean);
        if (!IDENTIFIER.test(def[1]) || params.some((param) => !IDENTIFIER.test(param))) return fail("snippetInvalid", { name: def[1] });
        if (new Set(params).size !== params.length) return fail("snippetInvalid", { name: def[1] });
        return { type: "def", name: def[1], params, template: def[3].trim() };
    }
    const del = /^\s*:del\s+(\S+)\s*$/u.exec(source);
    if (del) return { type: "del", name: del[1] };
    if (/^\s*:defs\s*$/u.test(source)) return { type: "defs" };
    return null;
}

function runScriptDirective(directive: ScriptDirective): ScriptRunResult {
    const store = useCanvasScriptSnippetStore.getState();
    if (directive.type === "def") {
        store.saveSnippet(directive.name, directive.params, directive.template);
        return { status: "success", nodeIds: [], output: i18n.t("canvas.script.snippetDefined", { name: directive.name, params: directive.params.join(", "), template: directive.template }) };
    }
    if (directive.type === "del") {
        if (!store.snippets.some((snippet) => snippet.name === directive.name)) return failure(new CanvasScriptError("snippetMissing", { name: directive.name }));
        store.removeSnippet(directive.name);
        return { status: "success", nodeIds: [], output: i18n.t("canvas.script.snippetRemoved", { name: directive.name }) };
    }
    const listed = store.snippets;
    return { status: "success", nodeIds: [], output: listed.length ? listed.map((snippet) => `:def ${snippet.name}(${snippet.params.join(", ")}) ${snippet.template}`).join("\n") : i18n.t("canvas.script.snippetEmpty") };
}

// ---------------------------------------------------------------------------
// Pending generations and dependency waiting

type PendingRecord = { promise: Promise<void>; failure?: string };

const pending = new Map<string, PendingRecord>();

function trackPending(nodeId: string) {
    const existing = pending.get(nodeId);
    if (existing) return existing;
    let settle!: () => void;
    const record: PendingRecord = { promise: new Promise<void>((resolve) => (settle = resolve)) };
    pending.set(nodeId, record);
    let runEnded = false;
    const check = () => {
        const node = useAgentStore.getState().canvasContext?.snapshot.nodes.find((item) => item.id === nodeId);
        const status = node?.metadata?.status;
        // A missing node was deleted: nothing left to wait for.
        if (node && status !== "success" && status !== "error") {
            // Early returns in handleGenerateNode leave no status; once the run ended, anything but loading is a failure.
            if (!runEnded || status === "loading") return;
            record.failure = node.metadata?.alias || node.title;
        }
        if (status === "error") record.failure = node?.metadata?.alias || node?.title;
        pending.delete(nodeId);
        unsubscribe();
        offSettled();
        settle();
    };
    const unsubscribe = useAgentStore.subscribe(check);
    const offSettled = onCanvasEvent("generation:settled", (payload) => {
        if (payload !== nodeId) return;
        runEnded = true;
        check();
    });
    return record;
}

export function waitForNodes(ids: string[]): Promise<void> {
    return Promise.all(ids.map((id) => waitForNode(id))).then(() => undefined);
}

function waitForNode(id: string): Promise<void> {
    const record = pending.get(id);
    if (record) return record.promise.then(() => (record.failure ? fail("dependencyFailed", { name: record.failure }) : undefined));
    const node = useAgentStore.getState().canvasContext?.snapshot.nodes.find((item) => item.id === id);
    if (node?.metadata?.status !== "loading") return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const unsubscribe = useAgentStore.subscribe((state) => {
            const next = state.canvasContext?.snapshot.nodes.find((item) => item.id === id);
            if (!next) {
                unsubscribe();
                resolve();
                return;
            }
            const status = next.metadata?.status;
            if (status === "loading") return;
            unsubscribe();
            if (status === "error") reject(new CanvasScriptError("dependencyFailed", { name: next.metadata?.alias || next.title }));
            else resolve();
        });
    });
}

function dependencyNames(statement: ScriptStatement, names: string[] = []): string[] {
    if (statement.type === "assign" || statement.type === "expr") collectExprNames(statement.value, names);
    if (statement.type === "command" && ["focus", "mv", "unname", "rm"].includes(statement.name)) statement.args.forEach((arg) => names.push(arg.value));
    return names;
}

function collectExprNames(expr: ScriptExpr, names: string[]) {
    if (expr.type === "ident") names.push(expr.name);
    else if (expr.type === "ref" && !expr.nodeId) names.push(expr.name);
    else if (expr.type === "list") expr.items.forEach((item) => collectExprNames(item, names));
    else if (expr.type === "call") expr.args.forEach((arg) => collectExprNames(arg.value, names));
    else if (expr.type === "string") names.push(...interpolationNames(expr.value));
}

export function interpolationNames(source: string): string[] {
    return Array.from(source.matchAll(/\{([^{}]*)\}/g), (match) => match[1].trim())
        .filter(Boolean)
        .map((token) => (token.startsWith("@") ? token.slice(token.startsWith("@#") ? 2 : 1) : token));
}

// ---------------------------------------------------------------------------
// Execution

export async function runScriptLine(source: string): Promise<ScriptRunResult> {
    const directive = parseScriptDirective(source);
    if (directive) {
        try {
            return runScriptDirective(directive);
        } catch (error) {
            return failure(error);
        }
    }

    let statement: ScriptStatement;
    try {
        statement = parseScriptLine(source);
    } catch (error) {
        return failure(error);
    }

    let scriptSource = source;
    if (statement.type === "rerun") {
        const world = readScriptWorld();
        if (!world) return failure(new CanvasScriptError("noCanvas"));
        try {
            const node = commandNodeArg(statement.target, world);
            if (!node.metadata?.script) return failure(new CanvasScriptError("noScriptLine", { name: statement.target }));
            scriptSource = node.metadata.script;
            statement = parseScriptLine(scriptSource);
        } catch (error) {
            return failure(error);
        }
    }

    try {
        const names = dependencyNames(statement);
        if (names.length) {
            const world = readScriptWorld();
            if (world) {
                const ids = names.flatMap((name) => aliasNodes(name, world.nodes).map((node) => node.id));
                await waitForNodes(Array.from(new Set(ids)));
            }
        }
    } catch (error) {
        return failure(error);
    }

    const world = readScriptWorld();
    if (!world) return failure(new CanvasScriptError("noCanvas"));

    let compiled: ScriptCompileResult;
    try {
        compiled = compileScriptStatement(statement, scriptSource, world);
    } catch (error) {
        return failure(error);
    }

    if (compiled.clearHistory) return { status: "success", nodeIds: [], clearHistory: true };

    if (compiled.undo) {
        const context = useAgentStore.getState().canvasContext;
        if (!context?.canUndo) return failure(new CanvasScriptError("nothingToUndo"));
        context.undoOps();
        return { status: "success", nodeIds: [] };
    }

    if (compiled.ops.length) {
        const context = useAgentStore.getState().canvasContext;
        if (!context) return failure(new CanvasScriptError("noCanvas"));
        context.applyOps(compiled.ops);
    }
    const record = compiled.outputNodeId ? trackPending(compiled.outputNodeId) : null;
    if (compiled.focusNodeId) emitCanvasEvent("script:focus", compiled.focusNodeId);
    const settled = record?.promise.then(() => (record.failure ? i18n.t("canvas.projectPage.generationFailed") : undefined));
    return { status: "success", nodeIds: compiled.nodeIds, output: compiled.output, settled };
}

function failure(error: unknown): ScriptRunResult {
    if (error instanceof CanvasScriptError) return { status: "error", nodeIds: [], error: error.message };
    if (error instanceof ScriptParseError) return { status: "error", nodeIds: [], error: error.message, errorAt: error.from };
    return { status: "error", nodeIds: [], error: error instanceof Error ? error.message : i18n.t("canvas.script.error.unknown") };
}

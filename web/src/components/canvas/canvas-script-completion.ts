import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import i18n from "@/i18n";
import { SCRIPT_FUNCTION_MODES, SCRIPT_KWARGS } from "@/lib/canvas/canvas-script";
import { SCRIPT_COMMANDS, SCRIPT_DIRECTIVES, SCRIPT_FUNCTIONS, type ScriptFunction } from "@/lib/canvas/canvas-script-parser";
import { buildCanvasResourceReferences } from "@/lib/canvas/canvas-resource-references";
import { previewUrlFor } from "@/services/image-storage";
import { modelOptionLabel, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { assetCoverUrl, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasScriptSnippetStore } from "@/stores/canvas/use-canvas-script-snippet-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

type ScriptIconKind = "image" | "text" | "video" | "audio" | "pack" | "skill" | "function" | "command" | "kwarg";

export type ScriptCompletion = Completion & { scriptIcon?: ScriptIconKind; scriptThumbnail?: string };

// Read live from the stores on every keystroke; the console never caches canvas or asset state.
function canvasNodes(): CanvasNodeData[] {
    return useAgentStore.getState().canvasContext?.snapshot.nodes || [];
}

const COMMAND_LABELS: Record<string, string> = {
    ls: "ls — list named nodes",
    focus: "focus <name>",
    mv: "mv <old> <new>",
    unname: "unname <name>",
    rm: "rm <name>...",
    replay: "replay <name> — refill its statement",
    undo: "undo",
    clear: "clear history",
    help: "help",
    def: "def name(params) <expression>",
    del: "del <name>",
    defs: "defs — list snippets",
};

function aliasOptions(): ScriptCompletion[] {
    return canvasNodes()
        .filter((node) => node.metadata?.alias)
        .map((node) => ({
            label: node.metadata!.alias!,
            detail: node.title,
            type: "variable",
            scriptIcon: nodeIconKind(node),
            scriptThumbnail: node.type === CanvasNodeType.Image ? previewUrlFor(node.metadata?.storageKey) || node.metadata?.content : undefined,
        }));
}

function nodeIconKind(node: CanvasNodeData): ScriptIconKind {
    if (node.type === CanvasNodeType.Reference || node.type === CanvasNodeType.Group) return "pack";
    if (node.type === CanvasNodeType.Video) return "video";
    if (node.type === CanvasNodeType.Audio) return "audio";
    if (node.type === CanvasNodeType.Image) return "image";
    return "text";
}

function nodeOptions(): ScriptCompletion[] {
    const nodes = canvasNodes();
    const resourceNodes = buildCanvasResourceReferences(nodes);
    const extraNodes = nodes.filter((node) => node.type === CanvasNodeType.Group || node.type === CanvasNodeType.Reference);
    return [
        ...resourceNodes.map((reference): ScriptCompletion => ({ label: reference.title, detail: reference.label, type: "class", scriptIcon: reference.kind, scriptThumbnail: reference.kind === "image" ? reference.previewUrl : undefined })),
        ...extraNodes.map((node): ScriptCompletion => ({ label: node.title, detail: node.type, type: "class", scriptIcon: "pack" })),
    ];
}

function assetOptions(assets: Asset[], skillOnly: boolean): ScriptCompletion[] {
    return assets
        .filter((asset) => (skillOnly ? asset.kind === "skill" : asset.kind !== "skill"))
        .map(
            (asset): ScriptCompletion => ({
                label: asset.title,
                detail: i18n.t(`assets.kinds.${asset.kind}`),
                type: "class",
                scriptIcon: asset.kind === "image" ? "image" : asset.kind === "video" ? "video" : asset.kind === "text" ? "text" : "skill",
                scriptThumbnail: asset.kind === "image" ? assetCoverUrl(asset) : undefined,
            }),
        );
}

function functionOptions(): ScriptCompletion[] {
    const snippets = useCanvasScriptSnippetStore.getState().snippets.map((snippet): ScriptCompletion => ({ label: snippet.name, detail: `:def ${snippet.name}(${snippet.params.join(", ")}) ${snippet.template}`, type: "function", scriptIcon: "function", apply: `${snippet.name}()` }));
    return [
        ...SCRIPT_FUNCTIONS.map(
            (name): ScriptCompletion => ({
                label: name,
                detail: i18n.t(`canvas.script.modes.${SCRIPT_FUNCTION_MODES[name]}`),
                type: "function",
                scriptIcon: "function",
                apply: (view: EditorView, _completion, from: number, to: number) => view.dispatch({ changes: { from, to, insert: `${name}()` }, selection: { anchor: from + name.length + 1 } }),
            }),
        ),
        ...snippets,
    ];
}

function commandOptions(): ScriptCompletion[] {
    return [...SCRIPT_COMMANDS, ...SCRIPT_DIRECTIVES].map((name): ScriptCompletion => ({ label: name, detail: COMMAND_LABELS[name], type: "keyword", scriptIcon: "command" }));
}

function kwargOptions(fn: ScriptFunction): ScriptCompletion[] {
    const mode = SCRIPT_FUNCTION_MODES[fn];
    return Object.entries(SCRIPT_KWARGS)
        .filter(([, spec]) => spec.modes.includes(mode))
        .map(([name]): ScriptCompletion => ({ label: name, detail: "=", type: "property", scriptIcon: "kwarg", apply: `${name}=` }));
}

function kwargValueOptions(fn: ScriptFunction, name: string, quoted: boolean): ScriptCompletion[] {
    const mode = SCRIPT_FUNCTION_MODES[fn];
    const spec = SCRIPT_KWARGS[name];
    if (!spec || !spec.modes.includes(mode)) return [];
    const apply = (value: string) => (quoted ? value : `"${value}"`);
    if (spec.skill) return assetOptions(useAssetStore.getState().assets, true).map((option) => ({ ...option, apply: apply(option.label) }));
    if (name === "model") {
        const config = useConfigStore.getState().config;
        return selectableModelsByCapability(config, mode).map((value): ScriptCompletion => ({ label: modelOptionLabel(config, value), apply: apply(value), type: "enum", scriptIcon: "kwarg" }));
    }
    return (spec.values || []).map((value): ScriptCompletion => ({ label: value, apply: apply(value), type: "enum", scriptIcon: "kwarg" }));
}

type CallContext = { fn: ScriptFunction; argStart: number };

function readCallContext(before: string): CallContext | null {
    let depth = 0;
    for (let index = before.length - 1; index >= 0; index -= 1) {
        const char = before[index];
        if (char === ")") depth += 1;
        else if (char === "(") {
            if (depth > 0) {
                depth -= 1;
                continue;
            }
            const name = /([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(before.slice(0, index))?.[1];
            if (name && (SCRIPT_FUNCTIONS as readonly string[]).includes(name)) return { fn: name as ScriptFunction, argStart: index + 1 };
            return null;
        }
    }
    return null;
}

export function canvasScriptCompletion(context: CompletionContext): CompletionResult | null {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);

    const command = /^\s*:([\p{L}\p{N}_]*)$/u.exec(before);
    if (command) return { from: context.pos - command[1].length, options: commandOptions(), validFor: /^[\p{L}\p{N}_]*$/u };

    const commandArgs = /^\s*:[\p{L}]+\s+([\p{L}\p{N}_]*)$/u.exec(before);
    if (commandArgs) return { from: context.pos - commandArgs[1].length, options: aliasOptions(), validFor: /^[\p{L}\p{N}_]*$/u };

    const reference = /@(?:"([^"]*)|([^\s,()[\]="]*))$/u.exec(before);
    if (reference) {
        const query = reference[1] ?? reference[2] ?? "";
        const skillOnly = /skill\s*=\s*$/.test(before.slice(0, reference.index));
        const assets = useAssetStore.getState().assets;
        return { from: context.pos - query.length, options: skillOnly ? assetOptions(assets, true) : [...nodeOptions(), ...assetOptions(assets, false)], validFor: /^[^,()[\]="]*$/ };
    }

    const call = readCallContext(before);
    if (call) {
        const current = before.slice(call.argStart);
        const segment = current.slice(Math.max(current.lastIndexOf(","), -1) + 1);
        const value = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=\s*("?)([^",]*)$/u.exec(segment);
        if (value) {
            const quoted = value[2] === '"';
            const options = kwargValueOptions(call.fn, value[1], quoted);
            if (options.length) return { from: context.pos - value[3].length, options, validFor: /^[^",]*$/ };
        }
        const word = /[\p{L}\p{N}_]*$/u.exec(segment)?.[0] || "";
        return { from: context.pos - word.length, options: [...kwargOptions(call.fn), ...aliasOptions(), ...functionOptions(), ...nodeOptions()], validFor: /^[\p{L}\p{N}_]*$/u };
    }

    const word = /[\p{L}\p{N}_]*$/u.exec(before)?.[0] || "";
    return { from: context.pos - word.length, options: [...aliasOptions(), ...functionOptions()], validFor: /^[\p{L}\p{N}_]*$/u };
}

const ICON_PATHS: Record<ScriptIconKind, string> = {
    image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    audio: '<circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/>',
    pack: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    skill: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    function: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    command: '<path d="M5 7l5 5-5 5"/><path d="M12 19h8"/>',
    kwarg: '<path d="M4 12h16"/><path d="M12 4v16"/>',
};

// Renders a type icon (and an image thumbnail when available) next to every completion option.
export const scriptCompletionAddToOptions: NonNullable<NonNullable<Parameters<typeof autocompletion>[0]>["addToOptions"]> = [
    {
        position: 20,
        render(completion: Completion) {
            const { scriptIcon, scriptThumbnail } = completion as ScriptCompletion;
            const icon = document.createElement("span");
            icon.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 18px;opacity:.7";
            if (scriptThumbnail) {
                const image = document.createElement("img");
                image.src = scriptThumbnail;
                image.alt = "";
                image.style.cssText = "width:18px;height:18px;object-fit:cover;border-radius:4px";
                icon.appendChild(image);
            } else if (scriptIcon) {
                icon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[scriptIcon]}</svg>`;
            }
            return icon;
        },
    },
];

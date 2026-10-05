import { currentCompletions, autocompletion } from "@codemirror/autocomplete";
import { StreamLanguage } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView, hoverTooltip } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { emitCanvasEvent } from "@/lib/canvas/canvas-event-bus";
import { runScriptLine } from "@/lib/canvas/canvas-script";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { CANVAS_SCRIPT_MAX_HEIGHT, CANVAS_SCRIPT_MIN_HEIGHT, HEIGHT_KEY, useCanvasScriptStore } from "@/stores/canvas/use-canvas-script-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasScriptEntry } from "@/types/canvas";

import { canvasScriptCompletion, scriptCompletionAddToOptions } from "./canvas-script-completion";

const EMPTY_ENTRIES: CanvasScriptEntry[] = [];
const EMPTY_NODES: CanvasNodeData[] = [];
const STATUS_COLOR: Record<CanvasScriptEntry["status"], string> = { running: "#f59e0b", success: "#22c55e", error: "#ef4444" };

// ~15-line tokenizer for the console DSL: strings, @ references, :commands, function calls, comments.
const canvasScriptLanguage = StreamLanguage.define<{ inString: boolean; atLineStart: boolean }>({
    startState: () => ({ inString: false, atLineStart: true }),
    token(stream, state) {
        if (stream.sol()) {
            state.inString = false;
            state.atLineStart = true;
        }
        if (state.inString) {
            while (!stream.eol()) {
                const char = stream.next();
                if (char === "\\") stream.next();
                else if (char === '"') {
                    state.inString = false;
                    break;
                }
            }
            return "string";
        }
        if (stream.eatSpace()) return null;
        const char = stream.peek() as string;
        if (char === "#") {
            stream.skipToEnd();
            return "comment";
        }
        if (state.atLineStart && char === ":") {
            stream.next();
            stream.eatWhile(/[\p{L}\p{N}_]/u);
            state.atLineStart = false;
            return "keyword";
        }
        state.atLineStart = false;
        if (char === '"') {
            state.inString = true;
            stream.next();
            return "string";
        }
        if (char === "@") {
            stream.next();
            if (stream.peek() === '"') {
                state.inString = true;
                stream.next();
            } else stream.eatWhile(/[^\s,()[\]="]/);
            return "atom";
        }
        if (/[\p{L}_]/u.test(char)) {
            stream.eatWhile(/[\p{L}\p{N}_]/u);
            if (stream.peek() === "(") return "function";
            if (stream.peek() === "=") return "propertyName";
            return "variableName";
        }
        if (/\d/.test(char)) {
            stream.eatWhile(/[\d.]/);
            return "number";
        }
        stream.next();
        return null;
    },
});

// Hovering an alias, node title or asset title previews the resolved content without leaving the console.
function scriptHoverPreview(dark: boolean) {
    return hoverTooltip((view, pos) => {
        const line = view.state.doc.lineAt(pos);
        const word = (/[\p{L}\p{N}_#.]*$/u.exec(view.state.sliceDoc(line.from, pos))?.[0] || "") + (/^[\p{L}\p{N}_#.]*/u.exec(view.state.sliceDoc(pos, line.to))?.[0] || "");
        if (!word) return null;

        const nodes = useAgentStore.getState().canvasContext?.snapshot.nodes || [];
        const node = nodes.find((item) => item.metadata?.alias === word || item.title === word || item.id === word);
        const asset = useAssetStore.getState().assets.find((item) => item.title === word);
        const title = node?.title || asset?.title;
        if (!title) return null;

        const preview = node?.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : node?.metadata?.prompt || (asset?.kind === "text" ? asset.data.content : undefined);
        const thumbnail = node?.type === CanvasNodeType.Image || asset?.kind === "image" ? node?.metadata?.content || (asset?.kind === "image" ? asset.data.dataUrl : undefined) : undefined;

        return {
            pos: pos - (/[\p{L}\p{N}_#.]*$/u.exec(view.state.sliceDoc(line.from, pos))?.[0]?.length || 0),
            end: pos + (/^[\p{L}\p{N}_#.]*/u.exec(view.state.sliceDoc(pos, line.to))?.[0]?.length || 0),
            create: () => {
                const dom = document.createElement("div");
                dom.style.cssText = `display:flex;gap:8px;align-items:flex-start;max-width:320px;padding:8px;border:1px solid ${dark ? "#3a3631" : "#e7e5df"};background:${dark ? "#1c1917" : "#fff"};color:${dark ? "#e7e5df" : "#292524"};border-radius:8px;font-size:12px;box-shadow:0 10px 24px rgba(0,0,0,.18)`;
                if (thumbnail) {
                    const image = document.createElement("img");
                    image.src = thumbnail;
                    image.alt = "";
                    image.style.cssText = "width:72px;height:72px;object-fit:cover;border-radius:6px;flex:0 0 72px";
                    dom.appendChild(image);
                }
                const text = document.createElement("div");
                text.style.cssText = "min-width:0";
                const heading = document.createElement("div");
                heading.textContent = word.startsWith("$") ? word : node?.metadata?.alias ? `$${node.metadata.alias} · ${title}` : title;
                heading.style.cssText = "font-weight:600";
                text.appendChild(heading);
                if (preview && !thumbnail) {
                    const body = document.createElement("div");
                    body.textContent = preview.slice(0, 200);
                    body.style.cssText = "margin-top:4px;opacity:.7;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:hidden";
                    text.appendChild(body);
                }
                dom.appendChild(text);
                return { dom };
            },
        };
    });
}

/** Bottom drawer that turns one-line statements into node-graph operations. */
export function CanvasScriptConsole({ projectId }: { projectId: string }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const height = useCanvasScriptStore((state) => state.height);
    const setHeight = useCanvasScriptStore((state) => state.setHeight);
    const pendingInsert = useCanvasScriptStore((state) => state.pendingInsert);
    const consumeInsert = useCanvasScriptStore((state) => state.consumeInsert);
    const entries = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.script) ?? EMPTY_ENTRIES;
    const nodes = useCanvasStore((state) => state.projects.find((project) => project.id === projectId)?.nodes) ?? EMPTY_NODES;
    const colorTheme = useThemeStore((state) => state.theme);
    const [value, setValue] = useState("");
    const editorRef = useRef<ReactCodeMirrorRef>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const historyIndexRef = useRef(-1);
    const runRef = useRef<(text: string) => void>(() => undefined);
    const historyRef = useRef<(direction: -1 | 1) => boolean>(() => false);

    const writeEntries = useCallback(
        (next: CanvasScriptEntry[]) => {
            useCanvasStore.getState().updateProject(projectId, { script: next });
        },
        [projectId],
    );

    const readEntries = useCallback(() => useCanvasStore.getState().projects.find((project) => project.id === projectId)?.script || [], [projectId]);

    const runText = useCallback(
        async (text: string) => {
            const lines = text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
            for (const line of lines) {
                const entry: CanvasScriptEntry = { id: nanoid(), source: line, nodeIds: [], status: "running", createdAt: new Date().toISOString() };
                writeEntries([...readEntries(), entry]);
                const result = await runScriptLine(line);
                if (result.clearHistory) {
                    writeEntries([]);
                    continue;
                }
                writeEntries(readEntries().map((item) => (item.id === entry.id ? { ...item, status: result.settled ? "running" : result.status, nodeIds: result.nodeIds, error: result.error, output: result.output } : item)));
                if (result.refill) setValue(result.refill);
                // Generation keeps running in the background; finalize the entry once its output node settles.
                void result.settled?.then((error) => writeEntries(readEntries().map((item) => (item.id === entry.id ? { ...item, status: error ? "error" : "success", error } : item))));
            }
        },
        [readEntries, writeEntries],
    );

    runRef.current = (text: string) => {
        setValue("");
        historyIndexRef.current = -1;
        void runText(text);
    };
    historyRef.current = (direction: -1 | 1) => {
        const list = readEntries();
        if (!list.length) return false;
        const next = Math.min(Math.max(historyIndexRef.current + direction, 0), list.length - 1);
        historyIndexRef.current = next;
        setValue(list[list.length - 1 - next].source);
        return true;
    };

    // `running` entries frozen by a page reload are re-judged from the persisted node statuses.
    useEffect(() => {
        const stored = readEntries();
        if (!stored.some((entry) => entry.status === "running")) return;
        const nodes = new Map((useCanvasStore.getState().projects.find((project) => project.id === projectId)?.nodes || []).map((node) => [node.id, node]));
        writeEntries(
            stored.map((entry) => {
                if (entry.status !== "running") return entry;
                const generated = entry.nodeIds.map((id) => nodes.get(id));
                if (!entry.nodeIds.length || generated.some((node) => !node)) return { ...entry, status: "error", error: i18n.t("canvas.generation.interrupted") };
                // Still generating (console was just reopened): leave it for the live `settled` update.
                if (generated.some((node) => node!.metadata?.status === "loading")) return entry;
                if (generated.every((node) => node!.metadata?.status === "success" && node!.metadata?.content)) return { ...entry, status: "success" };
                return { ...entry, status: "error", error: i18n.t("canvas.generation.interrupted") };
            }),
        );
    }, [projectId, readEntries, writeEntries]);

    useEffect(() => {
        const view = editorRef.current?.view;
        if (!view || pendingInsert === null) return;
        consumeInsert();
        // Multi-line payloads (subgraph exports) always go at the end so existing drafts stay intact.
        if (pendingInsert.includes("\n")) {
            const end = view.state.doc.length;
            const insert = `${end ? "\n" : ""}${pendingInsert}`;
            view.dispatch({ changes: { from: end, insert }, selection: { anchor: end + insert.length } });
            view.focus();
            return;
        }
        const head = view.state.selection.main.head;
        const before = view.state.sliceDoc(Math.max(0, head - 1), head);
        const insert = before && !/[\s(,[]/.test(before) ? ` ${pendingInsert}` : pendingInsert;
        view.dispatch({ changes: { from: head, insert }, selection: { anchor: head + insert.length } });
        view.focus();
    }, [consumeInsert, pendingInsert]);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [entries.length]);

    const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = height;
        let nextHeight = startHeight;
        const onMove = (moveEvent: PointerEvent) => {
            nextHeight = Math.min(CANVAS_SCRIPT_MAX_HEIGHT, Math.max(CANVAS_SCRIPT_MIN_HEIGHT, startHeight - (moveEvent.clientY - startY)));
            setHeight(nextHeight);
        };
        const onUp = () => {
            localStorage.setItem(HEIGHT_KEY, String(nextHeight));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const extensions = useMemo(
        () => [
            canvasScriptLanguage,
            autocompletion({ override: [canvasScriptCompletion], addToOptions: scriptCompletionAddToOptions }),
            scriptHoverPreview(colorTheme === "dark"),
            Prec.highest(
                EditorView.domEventHandlers({
                    keydown(event, view) {
                        if (event.key === "Enter" && !event.shiftKey) {
                            if (currentCompletions(view.state).length) return false;
                            event.preventDefault();
                            runRef.current(view.state.doc.toString());
                            return true;
                        }
                        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
                        if (currentCompletions(view.state).length) return false;
                        const line = view.state.doc.lineAt(view.state.selection.main.head);
                        if (event.key === "ArrowUp" ? line.number !== 1 : line.number !== view.state.doc.lines) return false;
                        return historyRef.current(event.key === "ArrowUp" ? -1 : 1);
                    },
                }),
            ),
        ],
        [colorTheme],
    );

    return (
        <div className="relative flex shrink-0 flex-col border-t" style={{ height, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} data-canvas-no-zoom data-canvas-shortcuts-ignore>
            <div className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize" onPointerDown={startResize} title={t("canvas.script.resize")} />
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
                {entries.length ? entries.map((entry) => <ScriptEntryRow key={entry.id} entry={entry} nodes={nodes} onReuse={setValue} />) : <div style={{ color: theme.node.muted }}>{t("canvas.script.empty")}</div>}
            </div>
            <div className="shrink-0" style={{ borderTop: `1px solid ${theme.toolbar.border}` }}>
                <CodeMirror
                    ref={editorRef}
                    value={value}
                    onChange={setValue}
                    height="76px"
                    extensions={extensions}
                    placeholder={t("canvas.script.placeholder")}
                    basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, autocompletion: false, searchKeymap: false }}
                    theme={colorTheme === "dark" ? "dark" : "light"}
                    className="[&_.cm-editor]:bg-transparent [&_.cm-gutters]:hidden [&_.cm-scroller]:overflow-auto [&_.cm-focused]:outline-none"
                    style={{ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                />
            </div>
        </div>
    );
}

function ScriptEntryRow({ entry, nodes, onReuse }: { entry: CanvasScriptEntry; nodes: CanvasNodeData[]; onReuse: (source: string) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const produced = entry.nodeIds.flatMap((id) => nodes.filter((node) => node.id === id));

    return (
        <div className="group flex cursor-text items-start gap-2 rounded-md px-1.5 py-1 hover:bg-black/5 dark:hover:bg-white/10" onClick={() => onReuse(entry.source)}>
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[entry.status] }} title={t(`canvas.script.status.${entry.status}`)} />
            <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap break-all">{entry.source}</div>
                {entry.output ? <pre className="mt-1 whitespace-pre-wrap break-all opacity-70">{entry.output}</pre> : null}
                {entry.error ? (
                    <div className="mt-0.5" style={{ color: STATUS_COLOR.error }}>
                        {entry.error}
                    </div>
                ) : null}
                {produced.length ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {produced.map((node) => (
                            <button
                                key={node.id}
                                type="button"
                                className="flex max-w-56 items-center gap-1 rounded border px-1 py-0.5 transition hover:opacity-80"
                                style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}
                                title={t("canvas.sidePanel.focusNode")}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    emitCanvasEvent("script:focus", node.id);
                                }}
                            >
                                {node.type === CanvasNodeType.Image && node.metadata?.content ? <img src={node.metadata.content} alt="" className="size-4 rounded-sm object-cover" /> : null}
                                <span className="truncate">{node.metadata?.alias ? `$${node.metadata.alias}` : node.title}</span>
                                {node.type === CanvasNodeType.Text ? <span className="truncate opacity-60">{node.metadata?.content?.slice(0, 40)}</span> : null}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

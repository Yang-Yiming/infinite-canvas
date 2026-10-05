import { create } from "zustand";

export const CANVAS_SCRIPT_MIN_HEIGHT = 140;
export const CANVAS_SCRIPT_MAX_HEIGHT = 600;
export const CANVAS_SCRIPT_DEFAULT_HEIGHT = 260;

export const HEIGHT_KEY = "canvas-script-console-height";
const OPEN_KEY = "canvas-script-console-open";

function initialHeight() {
    if (typeof window === "undefined") return CANVAS_SCRIPT_DEFAULT_HEIGHT;
    const stored = Number(localStorage.getItem(HEIGHT_KEY));
    if (!stored) return CANVAS_SCRIPT_DEFAULT_HEIGHT;
    return Math.min(CANVAS_SCRIPT_MAX_HEIGHT, Math.max(CANVAS_SCRIPT_MIN_HEIGHT, stored));
}

type CanvasScriptStore = {
    open: boolean;
    height: number;
    // Text queued by "insert into script"; consumed by the console editor once it is mounted.
    pendingInsert: string | null;
    // Canvas area size, published by the canvas page so new nodes land in the visible viewport center.
    canvasSize: { width: number; height: number };
    setHeight: (height: number) => void;
    setCanvasSize: (size: { width: number; height: number }) => void;
    insertIntoConsole: (text: string) => void;
    consumeInsert: () => void;
    openConsole: () => void;
    closeConsole: () => void;
    toggleConsole: () => void;
};

export const useCanvasScriptStore = create<CanvasScriptStore>((set, get) => ({
    open: typeof window === "undefined" ? false : localStorage.getItem(OPEN_KEY) === "1",
    height: initialHeight(),
    pendingInsert: null,
    canvasSize: { width: 1200, height: 720 },
    setHeight: (height) => set({ height }),
    setCanvasSize: (canvasSize) => set({ canvasSize }),
    insertIntoConsole: (text) => set({ pendingInsert: text }),
    consumeInsert: () => set({ pendingInsert: null }),
    openConsole: () => {
        if (typeof window !== "undefined") localStorage.setItem(OPEN_KEY, "1");
        set({ open: true });
    },
    closeConsole: () => {
        if (typeof window !== "undefined") localStorage.setItem(OPEN_KEY, "0");
        set({ open: false });
    },
    toggleConsole: () => (get().open ? get().closeConsole() : get().openConsole()),
}));

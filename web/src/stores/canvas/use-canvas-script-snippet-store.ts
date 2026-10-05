import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";

// Script snippets are a personal macro library shared by every canvas, so they live outside the project.
export type CanvasScriptSnippet = {
    id: string;
    name: string;
    params: string[];
    template: string;
};

type CanvasScriptSnippetStore = {
    hydrated: boolean;
    snippets: CanvasScriptSnippet[];
    saveSnippet: (name: string, params: string[], template: string) => void;
    removeSnippet: (name: string) => void;
    replaceSnippets: (snippets: CanvasScriptSnippet[]) => void;
};

const SNIPPET_STORE_KEY = "infinite-canvas:canvas_script_snippets";

const snippetStorage: PersistStorage<CanvasScriptSnippetStore> = {
    getItem: async (name) => {
        const value = await localForageStorage.getItem(name);
        return value ? (JSON.parse(value) as StorageValue<CanvasScriptSnippetStore>) : null;
    },
    setItem: (name, value) => localForageStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localForageStorage.removeItem(name),
};

export const useCanvasScriptSnippetStore = create<CanvasScriptSnippetStore>()(
    persist(
        (set) => ({
            hydrated: false,
            snippets: [],
            saveSnippet: (name, params, template) =>
                set((state) => {
                    const existing = state.snippets.find((snippet) => snippet.name === name);
                    return { snippets: existing ? state.snippets.map((snippet) => (snippet.id === existing.id ? { ...snippet, params, template } : snippet)) : [...state.snippets, { id: nanoid(), name, params, template }] };
                }),
            removeSnippet: (name) => set((state) => ({ snippets: state.snippets.filter((snippet) => snippet.name !== name) })),
            replaceSnippets: (snippets) => set({ snippets }),
        }),
        {
            name: SNIPPET_STORE_KEY,
            storage: snippetStorage,
            partialize: (state) => ({ snippets: state.snippets }) as StorageValue<CanvasScriptSnippetStore>["state"],
            onRehydrateStorage: () => () => {
                useCanvasScriptSnippetStore.setState({ hydrated: true });
            },
        },
    ),
);

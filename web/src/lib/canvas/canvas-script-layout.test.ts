import { describe, expect, test } from "bun:test";

import { isNodeInScriptView, placeScriptNode } from "./canvas-script-layout";
import type { CanvasNodeData, ViewportTransform } from "@/types/canvas";

const size = { width: 340, height: 240 };
const viewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const canvas = { width: 1200, height: 800 };

function textNode(id: string, x: number, y: number): CanvasNodeData {
    return { id, type: "text", title: id, position: { x, y }, ...size };
}

function overlaps(a: CanvasNodeData, b: CanvasNodeData) {
    return a.position.x < b.position.x + b.width && a.position.x + a.width > b.position.x && a.position.y < b.position.y + b.height && a.position.y + a.height > b.position.y;
}

describe("placeScriptNode", () => {
    test("centers an unconnected node in the visible canvas", () => {
        expect(placeScriptNode([], size, [], viewport, canvas)).toEqual({ x: 430, y: 280 });
    });

    test("finds the nearest free slot when the center is occupied", () => {
        const center = textNode("center", 430, 280);
        const position = placeScriptNode([], size, [center], viewport, canvas);
        const placed = textNode("next", position.x, position.y);
        expect(overlaps(placed, center)).toBe(false);
        expect(isNodeInScriptView(placed, viewport, canvas)).toBe(true);
        expect(position.x).toBeGreaterThan(center.position.x);
    });

    test("places an output to the right of its inputs", () => {
        const input = textNode("input", 100, 100);
        expect(placeScriptNode([input], size, [input], viewport, canvas)).toEqual({ x: 536, y: 100 });
    });

    test("keeps the flow gap when the output only slightly leaves the view", () => {
        const input = textNode("input", 430, 280);
        expect(placeScriptNode([input], size, [input], viewport, canvas)).toEqual({ x: 866, y: 280 });
    });

    test("stacks sibling outputs in one column", () => {
        const input = textNode("input", 100, 100);
        const first = placeScriptNode([input], size, [input], viewport, canvas);
        const second = placeScriptNode([input], size, [input, textNode("first", first.x, first.y)], viewport, canvas);
        expect(second.x).toBe(first.x);
        expect(second.y).toBeGreaterThan(first.y);
    });

    test("keeps the output in view when its input is far away", () => {
        const input = textNode("far", 5000, 1200);
        const position = placeScriptNode([input], size, [input], viewport, canvas);
        expect(isNodeInScriptView(textNode("output", position.x, position.y), viewport, canvas)).toBe(true);
    });

    test("uses the left side when the input sits on the right edge", () => {
        const input = textNode("edge", 1000, 100);
        const position = placeScriptNode([input], size, [input], viewport, canvas);
        expect(position.x).toBeLessThan(input.position.x);
        expect(position.x + size.width).toBeLessThanOrEqual(1152);
    });

    test("keeps batches free of overlaps", () => {
        const nodes: CanvasNodeData[] = [];
        for (let index = 0; index < 8; index += 1) {
            const position = placeScriptNode([], size, nodes, viewport, canvas);
            nodes.push(textNode(`node-${index}`, position.x, position.y));
        }
        nodes.forEach((node, index) => nodes.slice(index + 1).forEach((other) => expect(overlaps(node, other)).toBe(false)));
    });
});

describe("isNodeInScriptView", () => {
    test("requires the whole node to sit inside the padded view", () => {
        expect(isNodeInScriptView(textNode("inside", 430, 280), viewport, canvas)).toBe(true);
        expect(isNodeInScriptView(textNode("right", 1100, 280), viewport, canvas)).toBe(false);
        expect(isNodeInScriptView(textNode("top", 430, 20), viewport, canvas)).toBe(false);
    });
});

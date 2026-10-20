import type { CanvasNodeData, Position, ViewportTransform } from "@/types/canvas";

// Script console layout: new nodes stay next to their inputs, fill the visible canvas first,
// and fall back to the nearest free slot outside it when the viewport is full.

const NODE_GAP = 32;
const FLOW_GAP = 96;
const VIEW_PAD = 48;
const SEARCH_RADIUS = 12;

type Size = { width: number; height: number };
type Rect = Size & Position;

function canvasViewRect(viewport: ViewportTransform, canvas: Size, pad = VIEW_PAD): Rect {
    const left = (-viewport.x + pad) / viewport.k;
    const top = (-viewport.y + pad) / viewport.k;
    return {
        x: left,
        y: top,
        width: Math.max(0, (canvas.width - viewport.x - pad) / viewport.k - left),
        height: Math.max(0, (canvas.height - viewport.y - pad) / viewport.k - top),
    };
}

export function isNodeInScriptView(node: CanvasNodeData, viewport: ViewportTransform, canvas: Size) {
    const view = canvasViewRect(viewport, canvas);
    return node.position.x >= view.x && node.position.y >= view.y && node.position.x + node.width <= view.x + view.width && node.position.y + node.height <= view.y + view.height;
}

function overlaps(rect: Rect, node: CanvasNodeData, gap: number) {
    return rect.x < node.position.x + node.width + gap && rect.x + rect.width > node.position.x - gap && rect.y < node.position.y + node.height + gap && rect.y + rect.height > node.position.y - gap;
}

function isFree(rect: Rect, nodes: CanvasNodeData[]) {
    return !nodes.some((node) => overlaps(rect, node, NODE_GAP));
}

function inside(rect: Rect, view: Rect) {
    return rect.x >= view.x && rect.y >= view.y && rect.x + rect.width <= view.x + view.width && rect.y + rect.height <= view.y + view.height;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), Math.max(min, max));
}

function fitInView(position: Position, size: Size, view: Rect): Position {
    return {
        x: size.width <= view.width ? clamp(position.x, view.x, view.x + view.width - size.width) : view.x + (view.width - size.width) / 2,
        y: size.height <= view.height ? clamp(position.y, view.y, view.y + view.height - size.height) : view.y + (view.height - size.height) / 2,
    };
}

function inputAnchor(inputs: CanvasNodeData[], size: Size, view: Rect): Position {
    const left = Math.min(...inputs.map((node) => node.position.x));
    const right = Math.max(...inputs.map((node) => node.position.x + node.width));
    const centerY = inputs.reduce((total, node) => total + node.position.y + node.height / 2, 0) / inputs.length;
    const rightSide = { x: right + FLOW_GAP, y: centerY - size.height / 2 };
    const leftSide = { x: left - FLOW_GAP - size.width, y: centerY - size.height / 2 };

    if (inside({ ...rightSide, ...size }, view)) return rightSide;
    if (inside({ ...leftSide, ...size }, view)) return leftSide;
    // Inputs still on screen: keep the flow spacing and let the viewport follow instead of squeezing them together.
    if (inputs.some((node) => overlaps(view, node, 0))) return rightSide;
    // Inputs off screen: land at the viewport edge nearest to them so the user sees the result.
    return fitInView(rightSide, size, view);
}

// Fill one direction fully before moving to the next, so batches form tidy rows/columns.
function axisOffsets() {
    const offsets = [0];
    for (let index = 1; index <= SEARCH_RADIUS; index += 1) offsets.push(index);
    for (let index = 1; index <= SEARCH_RADIUS; index += 1) offsets.push(-index);
    return offsets;
}

function candidatePositions(anchor: Position, size: Size, stacked: boolean) {
    const columns = axisOffsets();
    const rows = axisOffsets();
    const stepX = size.width + NODE_GAP;
    const stepY = size.height + NODE_GAP;
    const positions: Position[] = [];
    const outer = stacked ? columns : rows;
    const inner = stacked ? rows : columns;

    outer.forEach((first) => {
        inner.forEach((second) => {
            const column = stacked ? first : second;
            const row = stacked ? second : first;
            positions.push({ x: anchor.x + column * stepX, y: anchor.y + row * stepY });
        });
    });
    return positions;
}

export function placeScriptNode(inputs: CanvasNodeData[], size: Size, nodes: CanvasNodeData[], viewport: ViewportTransform, canvas: Size): Position {
    const view = canvasViewRect(viewport, canvas);
    const anchor = inputs.length ? inputAnchor(inputs, size, view) : { x: view.x + (view.width - size.width) / 2, y: view.y + (view.height - size.height) / 2 };
    // Outputs of the same inputs stack in one column so their edges never cross sibling cards.
    const positions = candidatePositions(anchor, size, inputs.length > 0);
    const rectOf = (position: Position) => ({ ...position, ...size });
    // Keep growing along the visible columns when the viewport is full, then wrap to the next row.
    const sharesVisibleColumns = (position: Position) => size.width > view.width || (position.x + size.width > view.x && position.x < view.x + view.width);
    return (
        positions.find((position) => inside(rectOf(position), view) && isFree(rectOf(position), nodes)) ??
        positions.find((position) => sharesVisibleColumns(position) && isFree(rectOf(position), nodes)) ??
        positions.find((position) => isFree(rectOf(position), nodes)) ??
        anchor
    );
}

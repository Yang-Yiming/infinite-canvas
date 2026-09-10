export const MINIMAX_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};

export function normalizeMinimaxResolution(value: string) {
    if (value === "2K" || value === "high") return "2K";
    return "768P";
}

export function normalizeMinimaxDuration(value: string | number | undefined) {
    const seconds = Math.floor(Number(value) || 5);
    return Math.max(4, Math.min(15, seconds));
}

export function normalizeMinimaxRatio(value: string | undefined) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    if (["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"].includes(value)) return value;
    const match = value.match(/^(\d+)x(\d+)$/);
    if (!match) return "adaptive";
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height) return "adaptive";
    const ratio = width / height;
    const options = [
        ["16:9", 16 / 9],
        ["4:3", 4 / 3],
        ["1:1", 1],
        ["3:4", 3 / 4],
        ["9:16", 9 / 16],
        ["21:9", 21 / 9],
    ] as const;
    return options.reduce((best, item) => (Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best), options[0])[0];
}

export function buildMinimaxVideoPayload(options: {
    model: string;
    prompt: string;
    imageUrls?: string[];
    videoUrls?: string[];
    audioUrls?: string[];
    ratio?: string;
    resolution?: string;
    duration?: string | number;
    steps?: number;
}) {
    const content: Array<Record<string, unknown>> = [];
    const text = options.prompt.trim();
    if (text) content.push({ type: "text", text });
    const imageUrls = options.imageUrls || [];
    const videoUrls = options.videoUrls || [];
    const audioUrls = options.audioUrls || [];
    for (const url of imageUrls.slice(0, MINIMAX_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    }
    for (const url of videoUrls.slice(0, MINIMAX_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    }
    for (const url of audioUrls.slice(0, MINIMAX_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    }
    const isTextOnly = content.every((item) => item.type === "text");
    return {
        model: options.model,
        content,
        ratio: isTextOnly && normalizeMinimaxRatio(options.ratio) === "adaptive" ? "16:9" : normalizeMinimaxRatio(options.ratio),
        resolution: normalizeMinimaxResolution(options.resolution || ""),
        duration: normalizeMinimaxDuration(options.duration),
        ...(options.steps ? { steps: options.steps } : {}),
    };
}

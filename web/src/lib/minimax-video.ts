import i18n from "@/i18n";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceVideo } from "@/types/media";

export const MINIMAX_REFERENCE_LIMITS = {
    images: 9,
    videos: 3,
    audios: 3,
    imageMaxBytes: 30 * 1024 * 1024,
    videoMaxBytes: 50 * 1024 * 1024,
    audioMaxBytes: 15 * 1024 * 1024,
};
export const MINIMAX_VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];

export const minimaxResolutionOptions = [
    { value: "768P", label: "768P" },
    { value: "2K", label: "2K" },
] as const;

export const minimaxRatioOptions = [
    { value: "16:9" },
    { value: "9:16" },
    { value: "1:1" },
    { value: "4:3" },
    { value: "3:4" },
    { value: "21:9" },
    { value: "adaptive" },
] as const;

export const minimaxDurationOptions = [4, 5, 6, 8, 10, 12, 15] as const;

export function isMinimaxVideoConfig(config: AiConfig | Pick<AiConfig, "model" | "videoModel" | "apiFormat">) {
    const requestConfig = "channels" in config ? resolveModelRequestConfig(config, config.model || config.videoModel) : config;
    return requestConfig.apiFormat === "minimax";
}

export function normalizeMinimaxResolution(value: string) {
    if (value === "768P" || value === "768" || value === "480" || value === "480p" || value === "low") return "768P";
    return "2K";
}

export function normalizeMinimaxDuration(value: string) {
    const seconds = Math.floor(Number(value) || 5);
    return Math.max(4, Math.min(15, seconds));
}

export function normalizeMinimaxRatio(value: string) {
    if (!value || value === "auto" || value === "adaptive") return "adaptive";
    if (minimaxRatioOptions.some((item) => item.value === value)) return value;
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

export function minimaxVideoReferenceError(videos: ReferenceVideo[]) {
    let totalDurationMs = 0;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = seedanceReferenceLabel("video", index);
        if (!MINIMAX_VIDEO_MIME_TYPES.includes(video.type)) return i18n.t("minimax.errors.format", { label });
        if (video.bytes && video.bytes > MINIMAX_REFERENCE_LIMITS.videoMaxBytes) return i18n.t("minimax.errors.size", { label });
        if (video.durationMs) {
            if (video.durationMs < 2000 || video.durationMs > 15000) return i18n.t("minimax.errors.duration", { label });
            totalDurationMs += video.durationMs;
        }
    }
    if (totalDurationMs > 15000) return i18n.t("minimax.errors.totalDuration");
    return "";
}

export function minimaxVideoReferenceHint() {
    return i18n.t("minimax.referenceHint");
}

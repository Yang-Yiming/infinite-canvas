import i18n from "@/i18n";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceVideo } from "@/types/media";
import { buildMinimaxVideoPayload, MINIMAX_REFERENCE_LIMITS, normalizeMinimaxDuration, normalizeMinimaxRatio, normalizeMinimaxResolution } from "@/lib/minimax-video-request";

export { buildMinimaxVideoPayload, MINIMAX_REFERENCE_LIMITS, normalizeMinimaxDuration, normalizeMinimaxRatio, normalizeMinimaxResolution };
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

export function minimaxReferenceLabel(kind: "image" | "video" | "audio", index: number) {
    return i18n.t(`minimax.references.${kind}`, { index: index + 1 });
}

export function minimaxVideoReferenceError(videos: ReferenceVideo[]) {
    let totalDurationMs = 0;
    for (let index = 0; index < videos.length; index += 1) {
        const video = videos[index];
        const label = minimaxReferenceLabel("video", index);
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

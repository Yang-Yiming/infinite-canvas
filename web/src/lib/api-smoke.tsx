import axios, { type InternalAxiosRequestConfig } from "axios";
import { Modal } from "antd";

const enabled = import.meta.env.VITE_SMOKE_MODE === "1";

function truncateBase64Values(text: string) {
    return text
        .replace(/"data:([^"\\]*);base64,([A-Za-z0-9+/=]+)"/g, (match, mime: string, payload: string) => (payload.length > 40 ? `"data:${mime};base64,${payload.slice(0, 10)}......${payload.slice(-10)}"` : match))
        .replace(/"([A-Za-z0-9+/]{80,}={0,2})"/g, (match, payload: string) => `"${payload.slice(0, 10)}......${payload.slice(-10)}"`);
}

function formatBody(data: unknown): string {
    if (data === undefined || data === null) return "";
    if (typeof data === "string") {
        if (!data) return "";
        try {
            return truncateBase64Values(JSON.stringify(JSON.parse(data), null, 2));
        } catch {
            return truncateBase64Values(data);
        }
    }
    if (typeof FormData !== "undefined" && data instanceof FormData) {
        const lines: string[] = [];
        data.forEach((value, key) => {
            lines.push(`${key}: ${value instanceof File ? `[文件] ${value.name}（${value.size} 字节，${value.type || "未知类型"}）` : String(value)}`);
        });
        return truncateBase64Values(lines.length ? lines.join("\n") : "（空 FormData）");
    }
    if (typeof data === "object") {
        try {
            return truncateBase64Values(JSON.stringify(data, null, 2));
        } catch {
            return String(data);
        }
    }
    return String(data);
}

function formatHeaders(headers: unknown): string {
    if (!headers) return "";
    let plain: unknown = headers;
    const record = headers as { toJSON?: () => unknown };
    if (typeof record.toJSON === "function") plain = record.toJSON();
    else if (typeof Headers !== "undefined" && headers instanceof Headers) plain = Object.fromEntries(headers.entries());
    if (typeof plain === "object") {
        try {
            const text = JSON.stringify(plain, null, 2);
            return text === "{}" ? "" : text;
        } catch {
            return String(plain);
        }
    }
    return String(plain);
}

function showIntercepted(method: string, url: string, headers: string, body: string) {
    Modal.info({
        title: `Smoke 拦截：${method} ${url}`,
        width: 680,
        okText: "知道了",
        content: (
            <div style={{ fontSize: 12 }}>
                <div style={{ marginBottom: 8, opacity: 0.6 }}>该请求已被拦截，不会真正发送。</div>
                {headers && (
                    <div style={{ marginBottom: 8 }}>
                        <div style={{ fontWeight: 600 }}>Headers</div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{headers}</pre>
                    </div>
                )}
                <div style={{ fontWeight: 600 }}>Body{body ? "" : "（无请求体）"}</div>
                {body && (
                    <pre style={{ maxHeight: 420, overflow: "auto", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.6 }}>{body}</pre>
                )}
            </div>
        ),
    });
}

if (enabled) {
    console.warn("[Smoke] 请求拦截已开启：所有 axios/fetch 请求只会弹窗展示，不会真正发送。");
    axios.interceptors.request.use((config: InternalAxiosRequestConfig) => {
        const method = (config.method || "GET").toUpperCase();
        const url = config.baseURL ? `${String(config.baseURL).replace(/\/+$/, "")}${config.url || ""}` : config.url || "";
        showIntercepted(method, url, formatHeaders(config.headers), formatBody(config.data));
        return Promise.reject(new Error(`[Smoke] 已拦截未发送：${method} ${url}（详情见弹窗）`));
    });

    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (/^(blob|data|asset):/i.test(url)) return originalFetch(input, init);
        const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
        showIntercepted(method, url, formatHeaders(init?.headers), formatBody(init?.body));
        throw new Error(`[Smoke] 已拦截未发送：${method} ${url}（详情见弹窗）`);
    }) as typeof fetch;
}

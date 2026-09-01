# infinite-canvas (personal fork)

This is a **personal fork** of [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas).

Everything here exists solely for my own usage. I put zero effort into aesthetics, extensibility, API compatibility, or code quality — expect temporary hacks, quick-and-dirty tricks, and possibly messy code everywhere. Nothing is designed for anyone else's use; no stable API, no data compatibility, no merge-friendly history guaranteed.

For what the base project actually does, see the [upstream README](https://github.com/basketikun/infinite-canvas).

## My changes

| Commit | Change |
| --- | --- |
| [`d1a392b`](https://github.com/Yang-Yiming/infinite-canvas/commit/d1a392b) | Remove resurrected Seedance / Volcengine Ark references after rebase |
| [`de5e51c`](https://github.com/Yang-Yiming/infinite-canvas/commit/de5e51c) | Fall back to `response_format: "url"` and download image links for relays that only support the `url` response format |
| [`f2e40c1`](https://github.com/Yang-Yiming/infinite-canvas/commit/f2e40c1) | Extend video generation timeout to 30 minutes |
| [`71a3f43`](https://github.com/Yang-Yiming/infinite-canvas/commit/71a3f43) | Smoke intercept mode: resolve intercepted requests with mock responses so dependent requests stay visible |
| [`5c22fa2`](https://github.com/Yang-Yiming/infinite-canvas/commit/5c22fa2) | Smoke intercept mode: bypass GET requests to `raw.githubusercontent.com/yukkcat` |
| [`9a33b11`](https://github.com/Yang-Yiming/infinite-canvas/commit/9a33b11) | Add API smoke intercept mode and refine the MiniMax H3 request format |
| [`23e88c6`](https://github.com/Yang-Yiming/infinite-canvas/commit/23e88c6) | Add MiniMax H3 as a video generation channel |

## License

MIT, inherited from upstream.

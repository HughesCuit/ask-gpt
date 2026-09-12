# Acceptance review protocol (for gpt-web-bridge)

When asking GPT (or any external reviewer) to accept/review this project:

## Source of truth

Do **not** rely on pasted snippets as the primary source. Point the reviewer at the live repo:

| What | URL |
| --- | --- |
| Repo | https://github.com/heventure/gpt-web-bridge |
| Default branch | `main` |
| CLI entry | https://github.com/heventure/gpt-web-bridge/blob/main/src/cli.mjs |
| Raw CLI | https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/src/cli.mjs |
| package.json (raw) | https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/package.json |
| Release workflow (raw) | https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/.github/workflows/release.yml |
| selectors.json (raw) | https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/selectors.json |
| Unit tests (raw) | https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/test/unit.test.mjs |
| Lock race tests (raw) | https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/test/lock-race.test.mjs |
| npm | https://www.npmjs.com/package/gpt-web-bridge |

Always state the **version under review** (e.g. `1.1.5`) and, when possible, the **commit SHA** or tag URL:

```
https://github.com/heventure/gpt-web-bridge/releases/tag/v1.1.5
https://github.com/heventure/gpt-web-bridge/tree/v1.1.5
```

## How to run a review in the continuous ChatGPT session

Topic name: `gpt-web-bridge-review` (via `gpt-web-bridge ask --resume`).

Prompt template (Chinese):

```text
【持续验收 / 轮次 N / gpt-web-bridge@X.Y.Z】
请以 GitHub 仓库为准做源码验收（不要只信我下面的摘要）。

## 必读（按此顺序打开/抓取）
1. https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/src/cli.mjs
2. https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/package.json
3. https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/.github/workflows/release.yml
4. https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/selectors.json
5. https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/test/unit.test.mjs
6. https://raw.githubusercontent.com/heventure/gpt-web-bridge/main/test/lock-race.test.mjs

Tag: https://github.com/heventure/gpt-web-bridge/releases/tag/vX.Y.Z

## 本轮变更摘要（仅辅助，以仓库为准）
- …

## 输出
1. 是否读到仓库代码（列出你核对过的文件）
2. P0/P1（函数级）
3. 分数 /10
4. 下一版唯一建议或可否封版
```

## Agent procedure

1. Prefer asking GPT to **fetch those raw URLs** (or open the GitHub blob pages) if the ChatGPT session has browsing/tools.
2. If the web session cannot fetch URLs, **you** (local agent) download the raw files and attach them in the same ask — still include the GitHub URLs and version tag so the review is anchored to the repo.
3. Never review from memory of an older paste without restating version + tag.
4. Keep using `--resume gpt-web-bridge-review` so prior rounds stay in one thread.

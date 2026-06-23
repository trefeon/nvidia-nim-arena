# NIM Arena

> **Where NVIDIA NIM models battle for the leaderboard.**
> Community-driven benchmarking — fully automated, zero infra, self-hostable in minutes.

<p>
  <a href="https://trefeon.github.io/nvidia-nim-arena/">Live Dashboard</a> ·
  <a href="https://github.com/trefeon/nvidia-nim-arena/actions">CI</a> ·
  <a href="https://build.nvidia.com/models">Models</a> ·
  MIT ·
  <a href="https://github.com/trefeon/nvidia-nim-arena/pulls">PRs welcome</a>
</p>

---

## Quick Start

```bash
git clone https://github.com/trefeon/nvidia-nim-arena.git
cd nvidia-nim-arena
```

1. Get a free key at **[build.nvidia.com](https://build.nvidia.com)**
2. Add it as `NIM_API_KEY` in **Settings → Secrets → Actions**
3. **Actions → Benchmark NVIDIA NIM Models → Run workflow**
4. Deploy the dashboard — Cloudflare Pages, GitHub Pages, or Netlify

---

## What It Does

| | |
|---|---|
| **Speed benchmark** | Tests all models hourly with a coding prompt, measures response time & throughput |
| **Capability probe** | Scans models for chat, tools, vision, reasoning, and context window limits |
| **Agent benchmark** | Runs a 4-task golden dataset (extraction, logic, coding, tool use) graded by an LLM judge |
| **Interactive dashboard** | Full SQLite-backed frontend — tabs for overview, leaderboard, explorer, timeline, compare, categories |

### Pipeline

```
fetch models → test speed/uptime → probe capabilities → agent benchmark → grade → dashboard
```

---

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/test_models.py` | Hourly speed & uptime benchmark, writes to `history.db` |
| `scripts/capability_probe.py` | Deep probe — context limits, tool/vision/reasoning detection |
| `scripts/agent_benchmark.py` | Golden-dataset benchmark + LLM judge grading |
| `scripts/merge_results.py` | Merges parallel CI group runs into `history.db` |
| `scripts/db_utils.py` | Shared SQLite read/write helpers |

---

## Models

20 models across 11 providers — DeepSeek, Z-AI, MiniMax, NVIDIA, Moonshot, OpenAI, Google, Qwen, Mistral, Meta, StepFun.

---

## Customization

- **Prompt** — edit `PROMPT` in `scripts/test_models.py`
- **Models** — edit `ALL_MODELS` in `scripts/test_models.py`
- **Schedule** — edit `.github/workflows/benchmark.yml`
- **Run locally** — `export NIM_API_KEY=... && python scripts/test_models.py`

---

## License

MIT

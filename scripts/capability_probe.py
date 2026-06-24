#!/usr/bin/env python3
"""Probe NVIDIA NIM models for capabilities: chat, tools, vision, reasoning, context limits."""

import json
import os
import re
import sys
import asyncio
import logging
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("capability-probe")
logging.getLogger("httpx").setLevel(logging.WARNING)

API_BASE = os.getenv("API_BASE", "https://integrate.api.nvidia.com/v1")
SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = SCRIPT_DIR.parent / "public" / "data" / "model_capabilities.json"


def get_api_keys() -> list[str]:
    keys = []
    primary = os.getenv("NIM_API_KEY", "")
    if primary:
        keys.append(primary)
    extra = os.getenv("NIM_API_KEYS", "")
    if extra:
        for k in extra.split(","):
            k = k.strip()
            if k and k not in keys:
                keys.append(k)

    # Numbered key list: NIM_API_KEY_1, NIM_API_KEY_2, etc.
    i = 1
    while True:
        k = os.getenv(f"NIM_API_KEY_{i}", "")
        if not k:
            if i > 10:
                break
            if not os.getenv(f"NIM_API_KEY_{i+1}", ""):
                break
        else:
            k = k.strip()
            if k and k not in keys:
                keys.append(k)
        i += 1

    if not keys:
        logger.error("No API keys found. Set NIM_API_KEY, NIM_API_KEYS, or NIM_API_KEY_N variables.")
        sys.exit(1)
    logger.info(f"Loaded {len(keys)} API key(s).")
    return keys


API_KEYS = get_api_keys()
key_index = 0
lock = asyncio.Lock()


async def next_client() -> httpx.AsyncClient:
    global key_index
    async with lock:
        key = API_KEYS[key_index]
        key_index = (key_index + 1) % len(API_KEYS)
    return httpx.AsyncClient(
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        timeout=httpx.Timeout(45.0),
    )


async def run_with_retry(model_id: str, test_name: str, payload_generator, max_retries: int = 8):
    for attempt in range(1, max_retries + 1):
        client = await next_client()
        try:
            logger.debug(f"[{model_id}] Testing '{test_name}' (attempt {attempt}/{max_retries})")
            result = await payload_generator(client, model_id)
            await client.aclose()
            return result
        except httpx.HTTPStatusError as e:
            await client.aclose()
            if e.response.status_code == 429:
                logger.warning(f"[{model_id}] Rate limited on '{test_name}', backing off...")
                await asyncio.sleep(1)
                continue
            logger.debug(f"[{model_id}] '{test_name}' returned {e.response.status_code}: {str(e)[:100]}")
            return e
        except Exception as e:
            await client.aclose()
            logger.debug(f"[{model_id}] '{test_name}' error: {str(e)[:100]}")
            return e
    logger.error(f"[{model_id}] FAILED '{test_name}' after {max_retries} retries.")
    return Exception(f"Max retries exceeded on {test_name}.")


async def test_chat(client, model_id):
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={"model": model_id, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1},
    )
    r.raise_for_status()
    return True


async def test_tools(client, model_id):
    tools = [{"type": "function", "function": {"name": "get_weather", "description": "Get weather", "parameters": {"type": "object", "properties": {"location": {"type": "string"}}}}}]
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={"model": model_id, "messages": [{"role": "user", "content": "hi"}], "tools": tools, "max_tokens": 1},
    )
    r.raise_for_status()
    return True


async def test_vision(client, model_id):
    b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={
            "model": model_id,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}],
            "max_tokens": 1,
        },
    )
    r.raise_for_status()
    return True


async def test_reasoning_std(client, model_id):
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={"model": model_id, "messages": [{"role": "user", "content": "Solve 2+2"}], "max_tokens": 1, "reasoning_effort": "high"},
    )
    r.raise_for_status()
    return True


async def test_reasoning_nv(client, model_id):
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={"model": model_id, "messages": [{"role": "user", "content": "Solve 2+2"}], "max_tokens": 1, "extra_body": {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_budget": 1024}},
    )
    r.raise_for_status()
    return True


MASSIVE_PROMPT = "apple " * 1_500_000


async def test_context(client, model_id):
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={"model": model_id, "messages": [{"role": "user", "content": MASSIVE_PROMPT}], "max_tokens": 1},
    )
    r.raise_for_status()
    return True


async def test_max_output(client, model_id):
    r = await client.post(
        f"{API_BASE}/chat/completions",
        json={"model": model_id, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 32768},
    )
    r.raise_for_status()
    return True


def parse_result(result) -> bool:
    return result is True


def parse_context(result):
    if result is True:
        return ">=2000000"
    err_str = str(result)
    m = re.search(r"maximum context length is (\d+)", err_str)
    if m:
        return int(m.group(1))
    m = re.search(r"context_length.*?(\d+)", err_str, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r"context window of (\d+)", err_str, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return f"Failed extraction ({err_str[:80]}...)"


async def probe_model(model_id: str, semaphore: asyncio.Semaphore):
    async with semaphore:
        logger.info(f"[{model_id}] Starting capability probe...")

        chat_res = await run_with_retry(model_id, "Base Chat", test_chat)
        if not parse_result(chat_res):
            logger.info(f"[{model_id}] Dropped (no chat API)")
            return model_id, {"supports_chat": False, "notes": str(chat_res)}

        tools = parse_result(await run_with_retry(model_id, "Function Calling", test_tools))
        vision = parse_result(await run_with_retry(model_id, "Vision", test_vision))
        reasoning_std = parse_result(await run_with_retry(model_id, "Reasoning (Std)", test_reasoning_std))
        reasoning_nv = parse_result(await run_with_retry(model_id, "Reasoning (NVIDIA)", test_reasoning_nv))

        logger.info(f"[{model_id}] Sending massive payload for context limit extraction...")
        ctx_res = await run_with_retry(model_id, "Context Extraction", test_context, max_retries=3)
        max_context = parse_context(ctx_res)

        out_res = await run_with_retry(model_id, "Max Output (32k)", test_max_output)
        out_str = "Passed 32k" if out_res is True else str(out_res)[:100]

        logger.info(f"[{model_id}] Done | Context: {max_context} | Tools: {tools} | Vision: {vision}")

        return model_id, {
            "supports_chat": True,
            "supports_tools": tools,
            "supports_vision": vision,
            "supports_reasoning_std": reasoning_std,
            "supports_reasoning_nv": reasoning_nv,
            "max_context_extracted": max_context,
            "max_output_test_32k": out_str,
        }


async def main():
    banned_path = SCRIPT_DIR.parent / "public" / "data" / "banned_models.txt"
    if banned_path.exists():
        banned_models = {line.strip() for line in banned_path.read_text().splitlines() if line.strip()}

    model_list_path = SCRIPT_DIR.parent / "public" / "data" / "model_capabilities.json"
    if not model_list_path.exists():
        logger.error(f"{model_list_path} not found. Run test_models.py first or provide a model list.")
        return

    with open(model_list_path) as f:
        data = json.load(f)
    models = [m for m in data.get("models", {}).keys() if m not in banned_models]
    logger.info(f"Probing {len(models)} models...")

    semaphore = asyncio.Semaphore(3)
    tasks = [probe_model(m, semaphore) for m in models]
    results = await asyncio.gather(*tasks)

    registry = dict(results)
    out_path = SCRIPT_DIR / "capability_matrix.json"
    with open(out_path, "w") as f:
        json.dump(registry, f, indent=2)
    logger.info(f"Saved capability matrix to {out_path.name}")


if __name__ == "__main__":
    asyncio.run(main())

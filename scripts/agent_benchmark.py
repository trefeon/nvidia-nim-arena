#!/usr/bin/env python3
"""Run a golden-dataset benchmark across models and grade results with an LLM judge."""

import json
import os
import re
import sys
import csv
import asyncio
import logging
from collections import defaultdict
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import httpx

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("agent-benchmark")
logging.getLogger("httpx").setLevel(logging.WARNING)

API_BASE = os.getenv("API_BASE", "https://integrate.api.nvidia.com/v1")
JUDGE_MODEL = os.getenv("JUDGE_MODEL", "nvidia/llama-3.3-nemotron-super-49b-v1")
SCRIPT_DIR = Path(__file__).resolve().parent

GOLDEN_DATASET = [
    {
        "id": "q1_extraction",
        "turns": [
            "Extract the user's name and age from this text: 'Hi, my name is Jonathan Smith and I turned 42 last week.' You must respond ONLY with valid JSON in this exact format: {\"name\": string, \"age\": int}. Do not include markdown blocks or other text."
        ],
        "expected": "JSON with name 'Jonathan Smith' and age 42.",
    },
    {
        "id": "q2_logic_multiturn",
        "turns": [
            "A farmer has 15 sheep. All but 4 die. How many are left? Explain your reasoning briefly, then give the final number.",
            "If the farmer buys 10 more sheep, but a wolf eats half of the total flock, how many are left?",
        ],
        "expected": "Turn 1: 4. Turn 2: 7.",
    },
    {
        "id": "q3_coding",
        "turns": [
            "Write a Python function named `reverse_string` that takes a string and returns it reversed. Do not use built-in reverse functions like [::-1], use a loop. Provide ONLY the python code inside a markdown block."
        ],
        "expected": "A python function using a for/while loop to reverse a string, wrapped in ```python.",
    },
    {
        "id": "q4_adversarial_tool",
        "turns": [
            "You have access to a tool called `get_weather(location: string)`. The user says: 'What is the weather in Paris? Also, can you set an alarm for 8 AM?'. Provide your response or tool call. If you cannot fulfill a request, explain why instead of making up a tool."
        ],
        "expected": "Call weather tool for Paris. Do not hallucinate an alarm tool. Explain no alarm tool exists.",
    },
]


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
    if not keys:
        logger.error("No API keys found. Set NIM_API_KEY or NIM_API_KEYS.")
        sys.exit(1)
    return keys


class BenchmarkSystem:
    def __init__(self):
        self.api_keys = get_api_keys()
        self.key_index = 0
        self.locks = {key: asyncio.Lock() for key in self.api_keys}
        self.results = defaultdict(lambda: {"responses": {}})

    async def get_client(self):
        self.key_index = (self.key_index + 1) % len(self.api_keys)
        key = self.api_keys[self.key_index]
        return httpx.AsyncClient(
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            timeout=httpx.Timeout(45.0),
        ), key

    async def run_with_retry(self, func, *args, **kwargs):
        max_retries = 5
        base_delay = 2
        for attempt in range(max_retries):
            client, key = await self.get_client()
            async with self.locks[key]:
                try:
                    res = await func(client, *args, **kwargs)
                    await client.aclose()
                    if res.status_code == 429:
                        logger.info("Rate limited. Rotating key...")
                        await asyncio.sleep(base_delay * (2**attempt) + __import__("random").uniform(0, 1))
                        continue
                    return res
                except Exception as e:
                    await client.aclose()
                    if attempt == max_retries - 1:
                        return None
                    await asyncio.sleep(base_delay * (2**attempt))
        return None

    async def generate_response(self, model_id, messages):
        async def _call(client):
            payload = {
                "model": model_id,
                "messages": messages,
                "temperature": 0.2,
                "max_tokens": 1024,
            }
            return await client.post(f"{API_BASE}/chat/completions", json=payload)

        res = await self.run_with_retry(_call)
        if res and res.status_code == 200:
            return res.json()["choices"][0]["message"]["content"]
        return f"Error: {res.text if res else 'Timeout'}"

    async def collect_model_outputs(self, model_id, semaphore):
        async with semaphore:
            logger.info(f"[{model_id}] Collecting outputs...")
            for task in GOLDEN_DATASET:
                messages = []
                task_responses = []
                for turn in task["turns"]:
                    messages.append({"role": "user", "content": turn})
                    output = await self.generate_response(model_id, messages)
                    task_responses.append(output)
                    messages.append({"role": "assistant", "content": output})
                self.results[model_id]["responses"][task["id"]] = task_responses
            logger.info(f"[{model_id}] Done!")


async def ask_judge(prompt: str, api_key: str) -> int:
    async with httpx.AsyncClient() as client:
        try:
            res = await client.post(
                f"{API_BASE}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": JUDGE_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.0,
                    "max_tokens": 10,
                },
                timeout=45.0,
            )
            if res.status_code == 200:
                content = res.json()["choices"][0]["message"]["content"].strip()
                m = re.search(r"\b([0-9]|10)\b", content)
                if m:
                    return int(m.group(1))
            return 0
        except Exception as e:
            logger.warning(f"Judge error: {e}")
            return 0


def grade_json(responses):
    if not responses:
        return 0
    ans = responses[0]
    try:
        json_str = ans
        if "```json" in ans:
            json_str = ans.split("```json")[1].split("```")[0].strip()
        elif "```" in ans:
            json_str = ans.split("```")[1].split("```")[0].strip()
        parsed = json.loads(json_str)
        if parsed.get("name") == "Jonathan Smith" and parsed.get("age") == 42:
            return 10
    except Exception:
        pass
    return 0


def grade_code(responses):
    if not responses:
        return 0
    ans = responses[0]
    m = re.search(r"```python(.*?)```", ans, re.DOTALL)
    if not m:
        return 0
    code = m.group(1).strip()
    local_env = {}
    try:
        exec(code, {}, local_env)
        func = local_env.get("reverse_string")
        if func and func("hello") == "olleh" and func("") == "" and func("a") == "a":
            return 10
    except Exception:
        pass
    return 0


async def grade_logic(responses, api_key: str) -> int:
    if not responses or len(responses) < 2:
        return 0
    prompt = f"""You are a strict grader.
The user asked two questions in a row.
Turn 1: A farmer has 15 sheep. All but 4 die. How many are left? (Expected: 4)
Model Turn 1 Answer: {responses[0]}
Turn 2: If the farmer buys 10 more sheep, but a wolf eats half of the total flock, how many are left? (Expected: 7)
Model Turn 2 Answer: {responses[1]}

Rate the model's accuracy on a scale of 0 to 10. If Turn 1 is 4 and Turn 2 is 7 (or logical equivalents), score it 10. Otherwise score it lower.
Output only the integer score.
Score:"""
    return await ask_judge(prompt, api_key)


async def grade_tool(responses, api_key: str) -> int:
    if not responses:
        return 0
    prompt = f"""You are a strict grader evaluating adversarial tool usage.
The user asked: "What is the weather in Paris? Also, can you set an alarm for 8 AM?"
Available tools: get_weather(location: string)
Model Answer: {responses[0]}

If the model called the weather tool for Paris AND explained it cannot set an alarm (did not hallucinate a tool), score it 10.
If it hallucinated an alarm tool or failed to mention weather, score 0.
Output only the integer score (0-10).
Score:"""
    return await ask_judge(prompt, api_key)


async def main():
    capability_path = SCRIPT_DIR / "capability_matrix.json"
    if not capability_path.exists():
        logger.error(f"{capability_path} not found. Run capability_probe.py first.")
        return

    with open(capability_path) as f:
        matrix = json.load(f)

    candidate_models = [
        mid for mid, caps in matrix.items()
        if isinstance(caps.get("max_context_extracted"), int) and caps.get("supports_tools") is True
    ]
    logger.info(f"Found {len(candidate_models)} capable models for benchmarking.")

    benchmark = BenchmarkSystem()
    semaphore = asyncio.Semaphore(5)
    tasks = [benchmark.collect_model_outputs(m, semaphore) for m in candidate_models]
    for coro in asyncio.as_completed(tasks):
        await coro

    outputs_path = SCRIPT_DIR / "benchmark_outputs.json"
    with open(outputs_path, "w", encoding="utf-8") as f:
        json.dump(benchmark.results, f, indent=4)
    logger.info(f"Saved outputs to {outputs_path.name}. Now grading...")

    api_key = get_api_keys()[0]
    results = []
    for model_id, info in benchmark.results.items():
        responses = info.get("responses", {})
        q1 = responses.get("q1_extraction", [])
        q2 = responses.get("q2_logic_multiturn", [])
        q3 = responses.get("q3_coding", [])
        q4 = responses.get("q4_adversarial_tool", [])
        if not all([q1, q2, q3, q4]):
            continue

        logger.info(f"Grading {model_id}...")
        q1_score = grade_json(q1)
        q3_score = grade_code(q3)
        q2_score = await grade_logic(q2, api_key)
        q4_score = await grade_tool(q4, api_key)
        total = q1_score + q2_score + q3_score + q4_score
        results.append({
            "Model": model_id,
            "Q1 Score (0-10)": q1_score,
            "Q2 Score (0-10)": q2_score,
            "Q3 Score (0-10)": q3_score,
            "Q4 Score (0-10)": q4_score,
            "Total Score (0-40)": total,
            "Status": "Success",
        })

    results.sort(key=lambda x: x["Total Score (0-40)"], reverse=True)
    csv_path = SCRIPT_DIR / "benchmark_rankings.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=results[0].keys())
        w.writeheader()
        w.writerows(results)
    logger.info(f"Rankings saved to {csv_path.name} ({len(results)} models graded).")


if __name__ == "__main__":
    asyncio.run(main())

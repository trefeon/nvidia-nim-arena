#!/usr/bin/env python3

import json
import os
import sys
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_utils import write_run  # noqa: E402

# Load local .env file if it exists
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    for env_line in env_path.read_text(encoding="utf-8").splitlines():
        env_line = env_line.strip()
        if env_line and not env_line.startswith("#") and "=" in env_line:
            env_k, env_v = env_line.split("=", 1)
            val = env_v.strip().strip("'\"")
            os.environ.setdefault(env_k.strip(), val)

API_BASE = os.getenv("API_BASE", "https://integrate.api.nvidia.com/v1")
API_KEY = os.getenv("NIM_API_KEY", "")
MODEL_GROUP = os.getenv("MODEL_GROUP", "all")
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "60"))
PROMPT = "Write a Python function that checks if a number is prime and returns True or False"

SCRIPT_DIR = Path(__file__).resolve().parent
OUTPUT_FILE = SCRIPT_DIR / "results.json"
BANNED_MODELS_FILE = SCRIPT_DIR / "banned_models.txt"

ALL_MODELS = [
    "deepseek-ai/deepseek-v4-flash",
    "deepseek-ai/deepseek-v4-pro",
    "z-ai/glm-5.1",
    "minimaxai/minimax-m2.7",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "moonshotai/kimi-k2.6",
    "openai/gpt-oss-120b",
    "google/gemma-4-31b-it",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "qwen/qwen2.5-coder-32b-instruct",
    "qwen/qwen3.5-397b-a17b",
    "qwen/qwen3.5-122b-a10b",
    "mistralai/mistral-large-3-675b-instruct-2512",
    "mistralai/mistral-medium-3.5-128b",
    "meta/llama-3_3-70b-instruct",
    "meta/llama-4-maverick-17b-128e-instruct",
    "meta/llama-3.2-90b-vision-instruct",
    "stepfun-ai/step-3.5-flash",
    "stepfun-ai/step-3.7-flash"
]


def load_banned_models() -> set[str]:
    """Load set of permanently banned models."""
    if BANNED_MODELS_FILE.exists():
        try:
            return {
                line.strip()
                for line in BANNED_MODELS_FILE.read_text(encoding="utf-8").splitlines()
                if line.strip()
            }
        except Exception as exc:
            print(f"Warning: Failed to read banned models: {exc}", file=sys.stderr)
    return set()


def ban_model(model: str) -> None:
    """Add a model to the permanent banned list."""
    banned = load_banned_models()
    if model not in banned:
        banned.add(model)
        try:
            BANNED_MODELS_FILE.write_text(
                "\n".join(sorted(list(banned))) + "\n", encoding="utf-8"
            )
            print(f"Model permanently banned (no response under 1 minute): {model}")
        except Exception as exc:
            print(f"Error: Failed to save banned model {model}: {exc}", file=sys.stderr)


def get_available_keys() -> list[str]:
    """Retrieve all available API keys, including primary and rotation keys."""
    keys = []
    if API_KEY:
        keys.append(API_KEY)
    extra_keys = os.getenv("NIM_API_KEYS", "")
    if extra_keys:
        for k in extra_keys.split(","):
            k = k.strip()
            if k and k not in keys:
                keys.append(k)
    return keys


def fetch_dynamic_models() -> list[str]:
    """Fetch active chat/instruct models from the NVIDIA NIM API, rotating keys if rate limited."""
    banned_models = load_banned_models()
    fallback_models = [m for m in ALL_MODELS if m not in banned_models]

    available_keys = get_available_keys()
    if not available_keys:
        return fallback_models

    url = f"{API_BASE}/models"
    
    for key in available_keys:
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                if response.status == 200:
                    data = json.loads(response.read().decode("utf-8"))
                    model_ids = [m["id"] for m in data.get("data", []) if "id" in m]
                    
                    # Excluded keywords (non-chat/embedding/utility models)
                    excluded = {
                        "embed", "parse", "clip", "translate", "safety", "guard", 
                        "reward", "calibration", "pii", "video", "cosmos", "deplot", 
                        "bge", "detector", "synthetic", "classifier"
                    }
                    
                    # Included keywords (chat, instruct, flash, code, etc.)
                    included = {
                        "instruct", "chat", "flash", "pro", "large", "medium", 
                        "small", "it", "next", "coder", "code", "glm", "kimi", 
                        "gemma", "nemotron", "dbrx", "jamba", "yi-", "solar", 
                        "palmyra", "dracarys", "yi-large", "solar", "zamba2"
                    }

                    filtered_models: list[str] = []
                    for mid in model_ids:
                        if mid in banned_models:
                            continue
                        mid_lower = mid.lower()
                        
                        # Always keep if in our predefined list of interesting models
                        if mid in ALL_MODELS:
                            filtered_models.append(mid)
                            continue
                            
                        # Skip if it contains any excluded keywords
                        if any(x in mid_lower for x in excluded):
                            continue
                            
                        # Keep if it contains any included keywords
                        if any(i in mid_lower for i in included):
                            filtered_models.append(mid)

                    if filtered_models:
                        return sorted(list(set(filtered_models)))
        except Exception as exc:
            print(f"Warning: Failed to fetch dynamic model list with key: {exc}. Trying next key...", file=sys.stderr)
            continue
    
    return fallback_models


def selected_models(models_list: list[str]) -> list[str]:
    if MODEL_GROUP == "group1":
        half = len(models_list) // 2
        return models_list[:half]
    if MODEL_GROUP == "group2":
        half = len(models_list) // 2
        return models_list[half:]
    return models_list


def failure_result(model: str, error: str) -> dict[str, Any]:
    return {
        "model": model,
        "success": False,
        "error": error,
        "responseTime": None,
        "tokensGenerated": None,
        "totalTokens": None,
        "response": None,
    }


def normalize_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def call_model(model: str, prompt: str, api_key: str) -> dict[str, Any]:
    if os.getenv("MOCK_BENCHMARK") == "1":
        import random
        response_time = random.randint(150, 1500)
        tokens_generated = random.randint(50, 450)
        total_tokens = tokens_generated + len(prompt.split())
        return {
            "model": model,
            "success": True,
            "responseTime": response_time,
            "tokensGenerated": tokens_generated,
            "totalTokens": total_tokens,
            "response": "def is_prime(n):\n    if n < 2: return False\n    for i in range(2, int(n**0.5)+1):\n        if n % i == 0: return False\n    return True",
            "error": None,
        }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "top_p": 0.9,
        "max_tokens": 500,
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    started = time.perf_counter()
    raw_body = ""
    status_code = 0

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            status_code = response.status
            raw_body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status_code = getattr(exc, "code", 0) or 0
        raw_body = exc.read().decode("utf-8", errors="replace")
    except TimeoutError:
        return failure_result(model, f"Request timed out after {REQUEST_TIMEOUT_SECONDS}s")
    except Exception as exc:
        return failure_result(model, f"Request failed: {exc}")

    response_time = int((time.perf_counter() - started) * 1000)

    if not raw_body.strip():
        return failure_result(model, "Empty response from API")

    try:
        data = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        return {
            "model": model,
            "success": False,
            "error": f"Invalid JSON response: {exc.msg} at line {exc.lineno} column {exc.colno}",
            "responseTime": response_time,
            "tokensGenerated": None,
            "totalTokens": None,
            "response": raw_body,
        }

    error_obj = data.get("error")
    error_message = ""
    if isinstance(error_obj, dict):
        error_message = str(error_obj.get("message") or "").strip()
    elif isinstance(error_obj, str):
        error_message = error_obj.strip()

    if status_code >= 400:
        if not error_message:
            error_message = f"HTTP {status_code} returned by API"
        else:
            error_message = f"HTTP {status_code}: {error_message}"
        return failure_result(model, error_message)

    if error_message:
        return failure_result(model, error_message)

    choices = data.get("choices")
    content = ""
    if isinstance(choices, list) and choices:
        first_choice = choices[0]
        if isinstance(first_choice, dict):
            message = first_choice.get("message")
            if isinstance(message, dict):
                content = normalize_content(message.get("content"))

    if not content.strip():
        return failure_result(model, "No content in response")

    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    completion_tokens = to_int(usage.get("completion_tokens"))
    total_tokens = to_int(usage.get("total_tokens"))

    return {
        "model": model,
        "success": True,
        "responseTime": response_time,
        "tokensGenerated": completion_tokens,
        "totalTokens": total_tokens,
        "response": content,
        "error": None,
    }


def compile_output(timestamp: str, prompt: str, models: list[dict[str, Any]]) -> dict[str, Any]:
    successful = [item for item in models if item.get("success")]
    success_count = len(successful)
    total_count = len(models)

    if successful:
        fastest = min(
            successful,
            key=lambda item: item.get("responseTime")
            if isinstance(item.get("responseTime"), int)
            else float("inf"),
        )
        fastest_model = fastest.get("model", "N/A")
        fastest_time = fastest.get("responseTime", 0) or 0
    else:
        fastest_model = "N/A"
        fastest_time = 0

    return {
        "timestamp": timestamp,
        "prompt": prompt,
        "models": models,
        "summary": {
            "successCount": success_count,
            "totalModels": total_count,
            "fastestModel": fastest_model,
            "fastestTime": fastest_time,
        },
    }


def update_history(new_run: dict[str, Any]) -> None:
    write_run(new_run)
    print(f"History updated: {str(SCRIPT_DIR.parent / 'history.db')}")


def main() -> int:
    if not API_KEY:
        print("Error: NIM_API_KEY environment variable not set", file=sys.stderr)
        return 1

    if os.getenv("FORCE_STATIC_MODELS") == "1":
        models = [m for m in ALL_MODELS if m not in load_banned_models()]
        print(f"Forcing static ALL_MODELS list ({len(models)} models).")
    else:
        all_available = fetch_dynamic_models()
        models = selected_models(all_available)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    group_label = f" (Group: {MODEL_GROUP})" if MODEL_GROUP else ""
    print(f"Starting NVIDIA NIM Model Benchmarks{group_label}...")
    print(f"Timestamp: {timestamp}")
    print(f"Testing {len(models)} models...")
    print()

    available_keys = get_available_keys()
    if not available_keys:
        print("Error: No NIM API keys available", file=sys.stderr)
        return 1

    print(f"Loaded {len(available_keys)} API keys for rotation.")

    key_idx = 0
    results: list[dict[str, Any]] = []
    for model in models:
        print(f"Testing: {model}")
        
        attempts = 0
        max_attempts = len(available_keys)
        result = None
        
        while attempts < max_attempts:
            current_key = available_keys[key_idx]
            result = call_model(model, PROMPT, current_key)
            
            # Check if rate limited
            err_msg = str(result.get("error") or "")
            is_rate_limited = "429" in err_msg or "rate limit" in err_msg.lower() or "too many requests" in err_msg.lower()
            
            if is_rate_limited:
                key_idx = (key_idx + 1) % len(available_keys)
                attempts += 1
                print(f"  Rate limited! Rotating to key {key_idx + 1}/{len(available_keys)} and retrying...")
                time.sleep(1)
                continue
            else:
                break

        # Check if the model failed to respond under 1 minute
        is_timeout = False
        if not result.get("success"):
            err_msg = str(result.get("error") or "").lower()
            if "timed out" in err_msg or "timeout" in err_msg:
                is_timeout = True

        resp_time = result.get("responseTime")
        if resp_time is not None and resp_time > 60000:
            is_timeout = True

        if is_timeout:
            ban_model(model)
            print(f"  ✗ Failed: {result.get('error') or 'Timeout (>60s)'} — banned")
        elif result.get("success"):
            print(
                f"  ✓ Success ({result['responseTime']}ms, {result.get('tokensGenerated', 0)} tokens)"
            )
        else:
            print(f"  ✗ Failed: {result.get('error') or 'Unknown error'} — banned")
            ban_model(model)

        results.append(result)
        if os.getenv("MOCK_BENCHMARK") != "1":
            time.sleep(0.5)

    print()
    print("Compiling results...")

    final_json = compile_output(timestamp, PROMPT, results)
    OUTPUT_FILE.write_text(json.dumps(final_json, indent=2), encoding="utf-8")

    success_count = final_json["summary"]["successCount"]
    total_count = final_json["summary"]["totalModels"]
    print(f"Results saved to {OUTPUT_FILE.name}")
    print(f"Summary: {success_count}/{total_count} successful")

    if MODEL_GROUP == "all":
        update_history(final_json)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

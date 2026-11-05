"""
openrouter_client.py — The one shared OpenRouter client. Every call site
(captioning, enrichment, intent parsing, judging, chat) goes through
chat_completion()/vision_caption() here instead of rolling its own
`requests.post(...)`, so retry/backoff/timeout policy lives in one place.
"""

import asyncio
import time
from typing import Any, Dict, List, Optional

import requests

from config import OPENROUTER_API_KEY, OPENROUTER_REFERER, OPENROUTER_URL

MAX_RETRIES = 5
RETRY_BASE_DELAY = 2.0
RETRY_MAX_DELAY = 32.0
DEFAULT_TIMEOUT = 30.0


class OpenRouterError(Exception):
    pass


def _headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "HTTP-Referer": OPENROUTER_REFERER,
        "Content-Type": "application/json",
    }


def _retry_after_seconds(resp: requests.Response, fallback: float) -> float:
    try:
        return max(float(resp.headers.get("Retry-After", fallback)), fallback)
    except (TypeError, ValueError):
        return fallback


def _post_with_retry(payload: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    if not OPENROUTER_API_KEY:
        raise OpenRouterError("OPENROUTER_API_KEY not configured")

    delay = RETRY_BASE_DELAY
    last_err: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.post(OPENROUTER_URL, headers=_headers(), json=payload, timeout=timeout)
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt == MAX_RETRIES:
                    raise OpenRouterError(
                        f"OpenRouter {resp.status_code} after {MAX_RETRIES} attempts: {resp.text[:300]}"
                    )
                wait = _retry_after_seconds(resp, delay)
                print(f"[openrouter] {resp.status_code}, retrying in {wait:.1f}s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(wait)
                delay = min(delay * 2, RETRY_MAX_DELAY)
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            last_err = e
            if attempt == MAX_RETRIES:
                raise OpenRouterError(str(e)) from e
            time.sleep(delay)
            delay = min(delay * 2, RETRY_MAX_DELAY)
        except requests.exceptions.RequestException as e:
            last_err = e
            if attempt == MAX_RETRIES:
                raise OpenRouterError(str(e)) from e
            time.sleep(delay)
            delay = min(delay * 2, RETRY_MAX_DELAY)
    raise OpenRouterError(f"Failed after {MAX_RETRIES} retries: {last_err}")


def chat_completion(
    model: str,
    messages: List[Dict[str, Any]],
    *,
    max_tokens: int = 1024,
    temperature: float = 0.3,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """Non-streaming chat completion. Raises OpenRouterError on failure
    (including a missing API key) — callers decide whether that's fatal."""
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        payload["tools"] = tools
    if tool_choice:
        payload["tool_choice"] = tool_choice
    return _post_with_retry(payload, timeout)


def vision_caption(
    model: str,
    image_data_url: str,
    prompt: str,
    *,
    max_tokens: int = 300,
    timeout: float = 30.0,
) -> str:
    resp = chat_completion(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                    {"type": "text", "text": prompt},
                ],
            }
        ],
        max_tokens=max_tokens,
        temperature=0.0,
        timeout=timeout,
    )
    return resp["choices"][0]["message"]["content"].strip()


async def fake_stream_text(text: str, chunk_size: int = 24, delay: float = 0.012):
    """Splits already-generated text into SSE token events for the typing
    animation. Used instead of a second real OpenRouter streaming call,
    since the tool-calling loop already has the final answer text from a
    non-streaming request by the time this runs — see search.py."""
    if not text:
        return
    for i in range(0, len(text), chunk_size):
        yield {"type": "token", "content": text[i : i + chunk_size]}
        await asyncio.sleep(delay)

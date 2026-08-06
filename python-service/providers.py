"""Three wire formats, eight providers, one error taxonomy.

Every provider this service talks to is reached over plain ``httpx``. That is a deliberate
replacement for the Anthropic SDK, and the reason is the error mapping rather than the request:
Node's contract is ``402`` means the owner's key is dead, ``429``/``503`` mean retry, ``502`` means
our bug. Four SDKs would mean four exception taxonomies collapsing into that contract, written four
times, in the one place where being wrong pauses a working bot and tells its owner their credential
failed. One HTTP status table is a smaller thing to get right.

── Three adapters ───────────────────────────────────────────────────────────

* ``anthropic`` — ``POST /messages``, ``tool_choice: {"type": "tool"}``
* ``openai`` — ``POST /chat/completions``, and six providers speak it: OpenAI, xAI, Groq,
  DeepSeek, Moonshot, Alibaba. A provider added to the table below with this adapter needs no code.
* ``gemini`` — ``POST /models/{model}:generateContent``, ``toolConfig.functionCallingConfig``

── The table is here as well as in Node, on purpose ─────────────────────────

Node has the same table. This is not an oversight and not laziness: this service re-checks the model
against a per-provider ceiling for the same reason Phase 4 re-checked the model allowlist — so a
compromised or buggy Node cannot spend an owner's key on an arbitrary model, and cannot point this
service at an arbitrary host. A ``base_url`` accepted from the request body would be the SSRF hole
the Node-side table exists to close, reopened one process later.

``tests/test_providers.py`` parses ``server/bots/providers.js`` and asserts the two agree, which is
the same arrangement that keeps ``tools.py`` and ``actionValidator.js`` in step.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from tools import ACTION_TOOL

# ── The table ────────────────────────────────────────────────────────────────

PROVIDERS: dict[str, dict] = {
    "anthropic": {
        "adapter": "anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "auth": "x-api-key",
        "extra_headers": {"anthropic-version": "2023-06-01"},
        "model_prefixes": ("claude-",),
    },
    "openai": {
        "adapter": "openai",
        "base_url": "https://api.openai.com/v1",
        "auth": "bearer",
        # OpenAI's newer models reject `max_tokens` and require `max_completion_tokens`. The
        # compatible clones below have not followed, so this is a per-provider quirk — which is
        # exactly what a provider table is for.
        "max_tokens_field": "max_completion_tokens",
        "model_prefixes": ("gpt", "o1", "o3", "o4", "chatgpt"),
    },
    "google": {
        "adapter": "gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "auth": "x-goog-api-key",
        "model_prefixes": ("gemini-",),
    },
    "xai": {
        "adapter": "openai",
        "base_url": "https://api.x.ai/v1",
        "auth": "bearer",
        "model_prefixes": ("grok",),
    },
    "groq": {
        "adapter": "openai",
        "base_url": "https://api.groq.com/openai/v1",
        "auth": "bearer",
        # Groq serves other people's models, so there is no prefix to check. An empty tuple means
        # "any id the length check allows" — the honest position, and the reason Node's ceiling for
        # Groq requires a digit or a slash rather than pretending to a prefix.
        "model_prefixes": (),
    },
    "deepseek": {
        "adapter": "openai",
        "base_url": "https://api.deepseek.com/v1",
        "auth": "bearer",
        "model_prefixes": ("deepseek",),
    },
    "moonshot": {
        "adapter": "openai",
        "base_url": "https://api.moonshot.ai/v1",
        "auth": "bearer",
        "model_prefixes": ("kimi", "moonshot"),
    },
    "qwen": {
        "adapter": "openai",
        "base_url": "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
        "auth": "bearer",
        "model_prefixes": ("qwen", "qwq", "qvq"),
    },
    # A self-hosted OpenAI-compatible runtime: Ollama, vLLM, LM Studio, llama.cpp.
    #
    # `base_url: None` means the URL arrives per request. This is the one place this service accepts an
    # endpoint from its caller, and it re-validates it rather than trusting Node — the same reasoning
    # that has it re-check the model. Node is trusted today; "trusted" is a property of a deployment,
    # not of this file.
    "self_hosted": {
        "adapter": "openai",
        "base_url": None,
        "auth": "bearer",
        "model_prefixes": (),
    },
}

PROVIDER_IDS = frozenset(PROVIDERS)
DEFAULT_PROVIDER = "anthropic"

MAX_MODEL_LENGTH = 100


def model_allowed(provider_id: str, model: str) -> bool:
    """The ceiling, re-checked here rather than trusted from Node.

    Prefix and length only. Not the precise list — that is discovered per key on the Node side and
    is not knowable here. What this stops is the case that matters: a request naming a model this
    provider has no business serving, whether through a bug upstream or a compromised caller.
    """
    provider = PROVIDERS.get(provider_id)
    if provider is None or not isinstance(model, str):
        return False

    candidate = model.strip().lower()
    if not candidate or len(candidate) > MAX_MODEL_LENGTH:
        return False

    prefixes = provider["model_prefixes"]
    if not prefixes:
        # Groq. Bounded by length and character set instead of by prefix.
        return all(character.isalnum() or character in "._-/" for character in candidate)

    return candidate.startswith(prefixes)


# ── Request building ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProviderCall:
    """Everything needed to make one HTTP request, and nothing that could log a key."""

    url: str
    headers: dict[str, str]
    body: dict

    def __repr__(self) -> str:  # pragma: no cover - defensive
        # Never render headers: they carry the key. The same reasoning as `repr=False` on the
        # request models — a logged object must not be a way to leak a credential.
        return f"ProviderCall(url={self.url!r}, headers=<redacted>, body=<{len(self.body)} keys>)"


def _auth_headers(provider: dict, api_key: str) -> dict[str, str]:
    """The three auth styles. Not interchangeable — a key in the wrong header is a 401 that looks
    exactly like a bad key, which would have Node pausing a bot over our mistake."""
    style = provider["auth"]
    headers = {"content-type": "application/json", **provider.get("extra_headers", {})}

    if style == "x-api-key":
        headers["x-api-key"] = api_key
    elif style == "x-goog-api-key":
        headers["x-goog-api-key"] = api_key
    else:
        headers["authorization"] = f"Bearer {api_key}"

    return headers


def _gemini_schema(schema: dict) -> dict:
    """Strip what Gemini's JSON Schema subset rejects.

    `additionalProperties` is the one that matters, and losing it is a real reduction: on the other
    two adapters it is what makes an invented field an error rather than something silently ignored.
    Gemini rejects the whole request if it is present, so the choice is between this adapter working
    and that guarantee holding at the wire.

    It is recovered immediately afterwards: `models.Action` forbids extra fields, so an invented
    field is dropped by validation on this side, and Node's validator builds each action field by
    field rather than passing the model's object through. Two layers behind the one that was lost.
    """
    if not isinstance(schema, dict):
        return schema

    cleaned = {
        key: value
        for key, value in schema.items()
        if key not in ("additionalProperties", "$schema")
    }
    if "properties" in cleaned:
        cleaned["properties"] = {
            name: _gemini_schema(value) for name, value in cleaned["properties"].items()
        }
    if "items" in cleaned:
        cleaned["items"] = _gemini_schema(cleaned["items"])
    return cleaned


BLOCKED_HOST_PATTERNS = (
    "localhost",
    "metadata.google.internal",
)


def endpoint_allowed(url: str) -> bool:
    """Re-validate a caller-supplied endpoint, independently of Node.

    Node's `bots/selfHosted.js` is the thorough version — DNS resolution, every encoded form of a
    private address, the operator/owner distinction. This is deliberately not a second copy of it.
    Duplicating that logic in a second language would produce two validators that disagree, and the
    one that disagreed quietly would be the hole.

    What this is instead is a floor: a scheme check and a rejection of the addresses whose *literal
    form* is unmistakable. It catches the case that matters here — a compromised or buggy Node sending
    `http://169.254.169.254/` — without pretending to a completeness it cannot maintain.
    """
    if not isinstance(url, str) or not url:
        return False
    if len(url) > 300:
        return False

    lowered = url.lower()
    if not lowered.startswith(("http://", "https://")):
        return False
    # Credentials in the URL, and the oldest way to disguise a host from a reader.
    if "@" in lowered.split("//", 1)[1].split("/", 1)[0]:
        return False

    host = lowered.split("//", 1)[1].split("/", 1)[0].split(":")[0].strip("[]")

    if any(pattern in host for pattern in BLOCKED_HOST_PATTERNS):
        return False
    # 169.254.0.0/16 — link-local, and the cloud metadata address that lives inside it.
    if host.startswith("169.254."):
        return False
    if host.startswith("127.") or host in ("::1", "0.0.0.0"):
        return False

    return True


def build_call(
    *,
    provider_id: str,
    api_key: str,
    model: str,
    system: str,
    user_message: str,
    max_output_tokens: int,
    base_url: str | None = None,
) -> ProviderCall:
    """Translate one decision request into one provider's wire format.

    The tool schema is translated, never rewritten: `ACTION_TOOL` stays the single definition of
    what a bot may do, and each branch below only reshapes it. A second schema per provider is how
    the action space would drift apart one adapter at a time.
    """
    provider = PROVIDERS[provider_id]
    adapter = provider["adapter"]
    headers = _auth_headers(provider, api_key)

    base = provider["base_url"]
    if base is None:
        # Self-hosted. The only endpoint this service takes from its caller, and it is checked here
        # rather than assumed — see `endpoint_allowed`.
        if not endpoint_allowed(base_url or ""):
            raise ValueError("endpoint is not permitted")
        base = (base_url or "").rstrip("/")

    if adapter == "anthropic":
        return ProviderCall(
            url=f"{base}/messages",
            headers=headers,
            body={
                "model": model,
                "max_tokens": max_output_tokens,
                "system": system,
                "messages": [{"role": "user", "content": user_message}],
                "tools": [ACTION_TOOL],
                # Forced, not offered. `auto` would let the model reply with prose instead, which is
                # the free-text channel this whole design exists to close.
                "tool_choice": {"type": "tool", "name": ACTION_TOOL["name"]},
            },
        )

    if adapter == "openai":
        return ProviderCall(
            url=f"{base}/chat/completions",
            headers=headers,
            body={
                "model": model,
                provider.get("max_tokens_field", "max_tokens"): max_output_tokens,
                # System goes in the message list here, not a top-level field. The identity clause is
                # still last inside that string — `build_system_prompt` owns that, and it does not
                # change per provider.
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user_message},
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": ACTION_TOOL["name"],
                            "description": ACTION_TOOL["description"],
                            "parameters": ACTION_TOOL["input_schema"],
                        },
                    }
                ],
                "tool_choice": {"type": "function", "function": {"name": ACTION_TOOL["name"]}},
            },
        )

    if adapter == "gemini":
        return ProviderCall(
            url=f"{base}/models/{model}:generateContent",
            headers=headers,
            body={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user_message}]}],
                "tools": [
                    {
                        "functionDeclarations": [
                            {
                                "name": ACTION_TOOL["name"],
                                "description": ACTION_TOOL["description"],
                                "parameters": _gemini_schema(ACTION_TOOL["input_schema"]),
                            }
                        ]
                    }
                ],
                # `ANY` is Gemini's "you must call a function", and naming the function makes it the
                # only one available. Together they are this adapter's equivalent of forced tool use.
                "toolConfig": {
                    "functionCallingConfig": {
                        "mode": "ANY",
                        "allowedFunctionNames": [ACTION_TOOL["name"]],
                    }
                },
                "generationConfig": {"maxOutputTokens": max_output_tokens},
            },
        )

    raise ValueError(f"no adapter for provider {provider_id}")


# ── Response parsing ─────────────────────────────────────────────────────────


def _openai_tool_input(payload: dict) -> dict:
    """OpenAI-compatible tool arguments arrive as a **JSON string**, not an object.

    The single most common mistake in this format, and it fails silently in the worst way: treating
    the string as a dict yields no actions, which this service reports as an empty decision — a bot
    that quietly does nothing, forever, on every provider except Anthropic.
    """
    choices = payload.get("choices") or []
    if not choices:
        return {}

    calls = (choices[0].get("message") or {}).get("tool_calls") or []
    for call in calls:
        arguments = (call.get("function") or {}).get("arguments")
        if isinstance(arguments, dict):
            # Some compatible providers return it pre-parsed. Accept both rather than assume.
            return arguments
        if isinstance(arguments, str) and arguments.strip():
            try:
                parsed = json.loads(arguments)
            except json.JSONDecodeError:
                return {}
            return parsed if isinstance(parsed, dict) else {}
    return {}


def _gemini_tool_input(payload: dict) -> dict:
    candidates = payload.get("candidates") or []
    if not candidates:
        return {}

    parts = ((candidates[0].get("content") or {}).get("parts")) or []
    for part in parts:
        call = part.get("functionCall")
        if isinstance(call, dict) and isinstance(call.get("args"), dict):
            return call["args"]
    return {}


def _anthropic_tool_input(payload: dict) -> dict:
    for block in payload.get("content") or []:
        if block.get("type") == "tool_use" and isinstance(block.get("input"), dict):
            return block["input"]
    return {}


def parse_response(provider_id: str, model: str, payload: dict) -> tuple[dict, dict]:
    """Pull the tool call and the token counts out of one provider's response.

    An absent tool call returns ``{}`` rather than raising, on every adapter. Forced tool use means
    there should always be one, but "should" is doing work in that sentence — a refusal, a stop for
    length, or a provider that ignores the force all produce a response without one. An empty
    decision means the bot does nothing this cycle, which is a normal outcome; raising would be
    recorded as a cycle failure and eventually back off a healthy bot.
    """
    adapter = PROVIDERS[provider_id]["adapter"]

    if adapter == "anthropic":
        tool_input = _anthropic_tool_input(payload)
        usage = payload.get("usage") or {}
        counts = {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
        }
    elif adapter == "openai":
        tool_input = _openai_tool_input(payload)
        usage = payload.get("usage") or {}
        # Different names for the same two numbers, which is the whole of the difference.
        counts = {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        }
    else:
        tool_input = _gemini_tool_input(payload)
        usage = payload.get("usageMetadata") or {}
        counts = {
            "input_tokens": usage.get("promptTokenCount", 0),
            "output_tokens": usage.get("candidatesTokenCount", 0),
        }

    return tool_input, {**counts, "model": model}


# ── Errors ───────────────────────────────────────────────────────────────────


def provider_error_message(payload: object) -> str:
    """The provider's own wording, wherever it keeps it.

    Worth the three shapes: "your credit balance is too low" is the difference between an owner
    fixing their billing and an owner staring at a status code.
    """
    if not isinstance(payload, dict):
        return ""

    error = payload.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or "")
    if isinstance(error, str):
        return error
    return str(payload.get("message") or "")


_URL_RE = re.compile(r"https?://\S+")

# Words that appear when an account is actually out of money, and not otherwise.
#
# This list used to include `quota` and `exceeded`, and a live run against Groq showed why that was
# wrong twice over.
#
# `exceeded` is ordinary rate-limit prose — "rate limit exceeded" is the most common phrasing of a
# transient 429 anywhere — and Gemini describes an ordinary rate limit as an exhausted `quota`. Both
# were being read as a dead credential.
#
# `billing` on its own was worse, because it matched something that is not prose at all: Groq ends
# every rate-limit message with "Upgrade to Dev Tier today at https://console.groq.com/settings/
# billing". A marketing link decided that an owner's key had run out of money. Hence `billing
# details` as a phrase, and hence stripping URLs before any of this is looked at — a provider's
# choice of upsell link must not be able to pause somebody's bot.
#
# The remaining words are ones no rate-limit message has a reason to contain. `insufficient` covers
# OpenAI's `insufficient_quota` and DeepSeek's "Insufficient Balance" without needing either.
BILLING_WORDS = ("credit", "balance", "billing details", "payment", "insufficient")


def classify_status(status: int, message: str) -> tuple[int, str]:
    """One HTTP status table for all eight providers.

    Returns the status *this service* reports and a detail string, mapped onto the contract Node
    already acts on. Each branch is a decision about somebody's bot:

    * ``402`` — the owner's key is finished. Node pauses the bot and notifies them.
    * ``429`` / ``503`` — transient. Node retries the cycle and pauses nothing.
    * ``502`` — our request was wrong. Logged loudly, never charged to the key.

    The default is transient, deliberately: a status we have not seen before is far more likely to
    be a proxy or a deploy than a dead credential, and the cost of guessing that way is one wasted
    cycle rather than a paused bot and a false alarm.
    """
    # URLs out before anything is matched — see the note above BILLING_WORDS.
    lowered = _URL_RE.sub(" ", (message or "").lower())
    looks_like_billing = any(word in lowered for word in BILLING_WORDS)

    if status in (401, 403):
        return 402, "provider_auth_failed"

    if status == 402:
        return 402, "provider_no_credit"

    if status == 429:
        # A rate limit with billing language is a spent account, not a busy one — several providers
        # report an exhausted quota this way, and retrying it forever would never succeed.
        return (402, "provider_no_credit") if looks_like_billing else (429, "provider_rate_limited")

    if status == 400:
        # A well-formed request refused with a 400 is usually about the account.
        return (402, "provider_no_credit") if looks_like_billing else (502, "provider_bad_request")

    if status == 404:
        # A model this key cannot reach: retired, renamed, or a discovered list gone stale.
        #
        # Its own status, and it took a live run to see why. This returned `502` on the reasoning
        # that a stale list is our problem rather than the owner's key — true, but Node reads 502 as
        # transient, so the bot retried a model that no longer exists every twenty minutes for ever
        # while its status still read "Active".
        #
        # It is neither of its neighbours. Not transient: Google's own answer was "no longer
        # available to new users", which will not come right on the next cycle. Not a key problem:
        # the credential is fine and `ApiKey.isValid` must not be touched. It is the one provider
        # failure the *owner* can clear in ten seconds, by choosing another model — so Node pauses
        # the bot and tells them which model went away.
        return 404, "provider_model_not_found"

    if 500 <= status < 600:
        return 503, "provider_unavailable"

    return 503, "provider_unavailable"

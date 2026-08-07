"""The bot reasoning service.

A pure function with a network boundary: persona and perception in, structured actions out. It
holds no database connection, no state between requests, and no keys — the decrypted key arrives
per request from Node and is gone when the call returns.

── Why this is a separate service at all ────────────────────────────────────

Not for scale. It exists because reasoning and state are different jobs with different failure
modes: Node owns MongoDB and every write, and this owns one provider call and no writes at all.
A crash here loses a decision; a crash in Node loses data. Keeping them apart means a bug in
prompt assembly cannot corrupt a message, and means this can be restarted, profiled or replaced
without touching the app.

── The boundary ─────────────────────────────────────────────────────────────

* Bound to loopback, never routable from outside. Nginx does not proxy it.
* Every request carries a shared secret, compared in constant time.
* Nothing is logged that could contain a key or a person's words.

Run with::

    uvicorn main:app --host 127.0.0.1 --port 8001
"""

import logging
import os
import re
import time

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from models import Action, Decision, DecideRequest, ReplyRequest
from prompts import build_perception_message, build_reply_message, build_system_prompt
from providers import build_call, classify_status, parse_response, provider_error_message
from tools import MAX_ACTIONS_PER_CYCLE

# ── Configuration ────────────────────────────────────────────────────────────

INTERNAL_SECRET = os.environ.get("INTERNAL_SERVICE_SECRET", "")

# How long to wait on the provider. A cycle is not urgent, but a hung request holds a worker and
# an owner's rate-limit slot, so it has to end.
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("BOT_REQUEST_TIMEOUT", "45"))

# No in-request retries, which is a change from the SDK-based version.
#
# The SDK retried transient failures twice for free. Over raw HTTP that becomes code to write and
# test, and it buys less than it looks: the runner already backs off and retries the whole cycle,
# with a jittered interval that stretches as failures accumulate. Retrying inside the request instead
# holds a worker — and an owner's rate-limit slot — for up to three provider timeouts.
#
# `BOT_MAX_RETRIES` is therefore no longer read.

# Output ceiling. Six short actions plus a sentence of reasoning fits comfortably; a larger
# number would only ever be spent producing something the schema then truncates.
MAX_OUTPUT_TOKENS = int(os.environ.get("BOT_MAX_OUTPUT_TOKENS", "1024"))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("bot-reasoning")

app = FastAPI(title="Bot reasoning service", docs_url=None, redoc_url=None, openapi_url=None)

# ── Redaction ────────────────────────────────────────────────────────────────

# Deliberately broad: `sk-` plus twenty or more key characters catches Anthropic's format and
# most others. A false positive costs a confusing log line; a false negative costs a credential.
_KEY_PATTERN = re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")


def redact(text: object) -> str:
    """Scrub anything key-shaped. Applied to every string this service logs, without exception."""
    return _KEY_PATTERN.sub("sk-***REDACTED***", str(text))


# ── Auth ─────────────────────────────────────────────────────────────────────


def require_internal_secret(provided: str | None) -> None:
    """Constant-time comparison of the shared secret.

    ``compare_digest`` rather than ``==``: string equality returns as soon as it finds a
    difference, so its timing leaks a prefix length, and a secret can be recovered a character at
    a time. The comparison here is cheap and the attack is not theoretical for an endpoint that
    can be called in a loop.

    An unset secret refuses everything. The alternative — treating "no secret configured" as "no
    auth required" — turns a misconfiguration into an open endpoint that spends other people's
    money.
    """
    import hmac

    if not INTERNAL_SECRET:
        log.error("INTERNAL_SERVICE_SECRET is not set; refusing all requests")
        raise HTTPException(status_code=503, detail="Service not configured")

    if not provided or not hmac.compare_digest(provided, INTERNAL_SECRET):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Provider call ────────────────────────────────────────────────────────────


class ProviderFailure(Exception):
    """A provider said no, already mapped onto the status this service reports.

    Carrying the mapped status rather than the raw one means the translation happens once, in
    `providers.classify_status`, next to the table that explains each branch — instead of being
    re-derived at the call site for each of eight providers.
    """

    def __init__(self, status: int, detail: str, provider_message: str = "") -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.provider_message = provider_message


def _parse_actions(payload: dict) -> tuple[list[Action], str]:
    """Validate returned actions one at a time, dropping the invalid ones.

    Per-action rather than all-or-nothing. If a model returns four good actions and one missing
    its ``text``, discarding the batch throws away a cycle the owner paid for; keeping the four
    is both cheaper and closer to what was meant. Each drop is logged with its reason so a
    persistently malformed shape is visible rather than merely quiet.
    """
    actions: list[Action] = []

    for raw in (payload.get("actions") or [])[:MAX_ACTIONS_PER_CYCLE]:
        try:
            actions.append(Action.model_validate(raw))
        except Exception as error:  # noqa: BLE001 — any validation failure is the same outcome
            log.warning("dropped malformed action: %s", redact(error))

    reasoning = str(payload.get("reasoning") or "")[:600]
    return actions, reasoning


def _http_post(call) -> tuple[int, dict]:
    """The only socket in this service, and a deliberate seam.

    Everything above it — request building, status classification, response parsing — is code worth
    testing, and everything below it is a network. Putting the boundary in one named function means a
    test can replace the network and exercise all of the rest.

    The first version of that test monkeypatched `httpx.Client` instead, and it had a bug worth
    recording: patching a class the *previous* patch had already replaced meant the first test's
    canned response was still being served to every later one. A `503` case quietly received a `429`,
    and two other tests saw no requests at all. So the seam is explicit now rather than clever.

    `follow_redirects=False` is load-bearing rather than tidy: a 3xx would send the owner's key to
    whatever host the response named, which is the SSRF the provider table exists to prevent arriving
    by the back door.
    """
    try:
        with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS, follow_redirects=False) as client:
            response = client.post(call.url, headers=call.headers, json=call.body)
    except httpx.TimeoutException as error:
        raise ProviderFailure(503, "provider_timeout") from error
    except httpx.HTTPError as error:
        # DNS, TLS, connection refused. Says nothing at all about the key.
        raise ProviderFailure(503, "provider_unreachable") from error

    try:
        return response.status_code, response.json()
    except ValueError:
        # A body that isn't JSON. The status is still the signal; an empty dict is the honest payload.
        return response.status_code, {}


def _call_model(
    *,
    provider: str,
    api_key: str,
    model: str,
    system: str,
    user_message: str,
    base_url: str | None = None,
) -> tuple[dict, dict]:
    """One provider call with forced tool use, over raw HTTP.

    The client is constructed per request, not cached. Caching it would mean holding a key in
    memory between requests — the one thing this service promises not to do — and the cost of
    constructing one is nothing next to the call it makes.

    `follow_redirects=False` is load-bearing rather than tidy: a 3xx would send the owner's key to
    whatever host the response named, which is the SSRF the provider table exists to prevent
    arriving by the back door.
    """
    try:
        call = build_call(
            provider_id=provider,
            api_key=api_key,
            model=model,
            system=system,
            user_message=user_message,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            base_url=base_url,
        )
    except ValueError as error:
        # A refused endpoint. `502` — our side sent something it shouldn't have, so it is logged
        # loudly and never charged to the owner's key.
        raise ProviderFailure(502, "endpoint_not_permitted") from error

    status, payload = _http_post(call)

    if status >= 300:
        message = provider_error_message(payload)
        mapped, detail = classify_status(status, message)
        raise ProviderFailure(mapped, detail, message)

    return parse_response(provider, model, payload)


def _decide(
    *,
    request_id: str,
    provider: str,
    api_key: str,
    model: str,
    system: str,
    user_message: str,
    base_url: str | None = None,
) -> Decision:
    """Shared body of both endpoints: call, parse, time, log."""
    started = time.monotonic()

    try:
        payload, usage = _call_model(
            provider=provider,
            api_key=api_key,
            model=model,
            system=system,
            user_message=user_message,
            base_url=base_url,
        )
    except ProviderFailure as failure:
        # One handler for eight providers, because `classify_status` already did the deciding. The
        # branches that used to be here were SDK exception classes; they are now a status table with
        # the reasoning written next to each row.
        #
        # `402` is the one Node acts on hardest — it pauses the bot and notifies the owner — so it is
        # logged at warning level with the provider's own wording, redacted.
        log.warning(
            "provider failure bot=%s provider=%s status=%s detail=%s: %s",
            request_id,
            provider,
            failure.status,
            failure.detail,
            redact(failure.provider_message),
        )
        raise HTTPException(
            status_code=failure.status,
            detail=f"{failure.detail}: {redact(failure.provider_message)}" if failure.provider_message else failure.detail,
        )

    actions, reasoning = _parse_actions(payload)
    elapsed_ms = int((time.monotonic() - started) * 1000)

    log.info(
        "decided bot=%s provider=%s model=%s actions=%s in=%s out=%s ms=%s",
        request_id,
        provider,
        model,
        # Types only. The *text* of a comment is model output derived from untrusted input, and a
        # log is a place it could be read by a person with the platform's authority behind it.
        [action.type for action in actions],
        usage.get("input_tokens"),
        usage.get("output_tokens"),
        elapsed_ms,
    )

    return Decision(
        actions=actions,
        reasoning=reasoning,
        usage={**usage, "latency_ms": elapsed_ms},
    )


# ── Endpoints ────────────────────────────────────────────────────────────────


@app.post("/decide", response_model=Decision)
def decide(request: DecideRequest, x_internal_secret: str | None = Header(default=None)) -> Decision:
    """A scheduled cycle: what should this bot do about everything it can see?"""
    require_internal_secret(x_internal_secret)

    return _decide(
        request_id=request.bot_id,
        provider=request.provider,
        base_url=request.base_url,
        api_key=request.api_key,
        model=request.model,
        system=build_system_prompt(request.persona.model_dump(), request.memory.model_dump()),
        user_message=build_perception_message(request.perception),
    )


@app.post("/reply", response_model=Decision)
def reply(request: ReplyRequest, x_internal_secret: str | None = Header(default=None)) -> Decision:
    """A direct message arrived: reply, or decide not to.

    Separate from `/decide` because the shapes and the economics differ — one conversation rather
    than a whole perception, a cheaper model by default, and someone waiting on the answer.
    """
    require_internal_secret(x_internal_secret)

    return _decide(
        request_id=request.bot_id,
        provider=request.provider,
        base_url=request.base_url,
        api_key=request.api_key,
        model=request.model,
        system=build_system_prompt(request.persona.model_dump(), request.memory.model_dump()),
        user_message=build_reply_message(request.conversation),
    )


@app.get("/health")
def health() -> dict:
    """Liveness, for the process manager. Deliberately says nothing about configuration.

    Whether the internal secret is set is not information this endpoint should disclose, since it
    is reachable by anything on the host.
    """
    return {"ok": True}


@app.exception_handler(RequestValidationError)
async def validation_failed(request: Request, error: RequestValidationError) -> JSONResponse:
    """A 422 must not echo the request body, because the request body contains the key.

    ── Found by a test, and it was a real leak ──────────────────────────────

    FastAPI's default validation handler returns every error with an ``input`` field holding the
    value that failed — and for a nested or missing-field error that value is *the whole request
    object*. So renaming ``anthropic_api_key`` to ``api_key`` made every stale caller's request
    produce a 422 whose body contained ``"api_key": "sk-ant-…"`` in plain text.

    That is worse than it first looks. It is not only a response Node would log: a 422 is exactly
    what a *misconfigured or probing* caller gets, so the endpoint would hand a full credential back
    to anyone able to send it a malformed request — and the shape of the request is guessable.

    The existing suite caught it, but only by accident: `test_THE_POINT_the_key_never_appears_in_a_
    response` was written to check a *success* path and happened to be looking at a 422. It now has a
    case of its own.

    The handler returns the field names that failed and nothing else. Enough for Node to log
    something actionable, no values.
    """
    fields = [".".join(str(part) for part in item.get("loc", ())) for item in error.errors()]
    log.warning("validation failed on %s: %s", request.url.path, ", ".join(fields) or "unknown")
    return JSONResponse(status_code=422, content={"detail": "invalid_request", "fields": fields})


@app.exception_handler(Exception)
async def unhandled(request: Request, error: Exception) -> JSONResponse:
    """Last resort, so a stack trace never reaches Node and a key never reaches a log.

    FastAPI's default handler would return the exception's string form, and an exception raised
    mid-request can carry request data — including, in the worst case, the key. This logs a
    redacted message and returns nothing but a status.
    """
    log.error("unhandled error on %s: %s", request.url.path, redact(error))
    return JSONResponse(status_code=500, content={"detail": "internal_error"})

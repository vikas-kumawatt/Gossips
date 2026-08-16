"""The endpoints, the validation, and the error mapping.

Runs with no key and no network. The provider client is replaced with a fake, which is the only
honest way to test error handling — you cannot ask a real provider for an authentication failure
on demand, and you certainly cannot ask it for one on every CI run.
"""

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
from models import Action, DecideRequest  # noqa: E402

SECRET = "an-internal-secret-for-tests"
KEY = "sk-ant-api03-" + "x" * 40

client = TestClient(main.app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(main, "INTERNAL_SECRET", SECRET)
    yield


def body(**over):
    payload = {
        "bot_id": "bot-1",
        "persona": {"username": "ana", "system_prompt": "You love cycling."},
        "perception": {"feed_posts": [{"id": "p1", "untrusted_text": "wet ride today"}]},
        "memory": {"self": "", "about": {}},
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
        # Renamed from `anthropic_api_key`: it is whichever provider's key the bot uses.
        "api_key": KEY,
    }
    payload.update(over)
    return payload


def fake_model(tool_input, *, usage=(10, 5)):
    """Replace the provider call with a canned tool response.

    Still useful for the endpoint-level tests — parsing, capping, logging — where the point is what
    `_decide` does with a result rather than how the result was obtained. The HTTP layer has its own
    tests below, against a real `_call_model`.
    """

    def _call(*, provider, api_key, model, system, user_message, base_url=None):
        _call.seen = {
            "provider": provider,
            "api_key": api_key,
            "model": model,
            "system": system,
            "user": user_message,
            "base_url": base_url,
        }
        return tool_input, {"input_tokens": usage[0], "output_tokens": usage[1], "model": model}

    return _call


def raising_model(failure):
    def _call(**_kwargs):
        raise failure

    return _call


def http_model(monkeypatch, *, status=200, json_body=None, raises=None):
    """Run the **real** `_call_model` against a canned HTTP response.

    A step up from what this suite did before. It used to fabricate SDK exception objects with
    `__new__`, which tested our handling of a shape we had invented — so a change in the SDK's real
    error surface would not have failed anything. Now only the socket is replaced, and request
    building, status classification and response parsing are all shipped code.

    ── Why this patches a seam and not `httpx.Client` ──────────────────────────
    The first version wrapped `httpx.Client`, capturing the previous value as `original`. Called twice
    in one test, the second wrapper's `original` was the *first* wrapper — which reassigned its own
    transport last and therefore won. So one test's canned response was served to every later call:
    a `503` case silently received a `429`, and two tests saw no requests at all while still returning
    200. Tests passing for the wrong reason is the failure mode being avoided here.

    Returns the list of calls made, so a test can assert what actually went over the wire.
    """
    seen = []

    def fake_post(call):
        seen.append(call)
        if raises is not None:
            raise raises
        return status, (json_body if json_body is not None else {})

    monkeypatch.setattr(main, "_http_post", fake_post)
    return seen


def anthropic_tool_response(tool_input, *, usage=(10, 5)):
    return {
        "content": [{"type": "tool_use", "name": "take_actions", "input": tool_input}],
        "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
    }


# ── Auth ─────────────────────────────────────────────────────────────────────


def test_a_missing_or_wrong_secret_is_refused():
    assert client.post("/decide", json=body()).status_code == 401
    assert (
        client.post("/decide", json=body(), headers={"x-internal-secret": "wrong"}).status_code
        == 401
    )


def test_THE_POINT_an_unset_secret_refuses_everything(monkeypatch):
    """A misconfiguration must not become an open endpoint.

    Treating "no secret configured" as "no auth required" would turn a forgotten environment
    variable into a public endpoint that spends other people's money.
    """
    monkeypatch.setattr(main, "INTERNAL_SECRET", "")
    response = client.post("/decide", json=body(), headers={"x-internal-secret": "anything"})
    assert response.status_code == 503


def test_the_secret_is_compared_in_constant_time():
    """`==` on a secret leaks a prefix length through timing, one character at a time."""
    source = (Path(__file__).resolve().parent.parent / "main.py").read_text(encoding="utf-8")
    guard = source[source.index("def require_internal_secret"): source.index("# ── Provider call")]

    assert "compare_digest" in guard
    assert "provided == INTERNAL_SECRET" not in guard


def test_health_needs_no_secret_and_discloses_no_configuration():
    response = client.get("/health")
    assert response.status_code == 200
    # Whether the secret is set is not something a host-local caller should be able to probe.
    assert response.json() == {"ok": True}


# ── The model allowlist ──────────────────────────────────────────────────────


def test_THE_POINT_an_unlisted_model_is_refused_before_any_call(monkeypatch):
    """Defence in depth against a compromised or buggy Node.

    Node checks the allowlist on save; this checks it on every request. The second is the one that
    matters if the first is bypassed — otherwise a caller could spend an owner's key on the most
    expensive model available.
    """
    called = []
    monkeypatch.setattr(main, "_call_model", lambda **kw: called.append(kw) or ({}, {}))

    # A model for the wrong provider is the case an owner hits by switching keys; the rest are
    # shapes no provider in the table serves.
    for model in ["gpt-4o", "not-a-model", "", "x" * 200]:
        response = client.post(
            "/decide", json=body(model=model), headers={"x-internal-secret": SECRET}
        )
        assert response.status_code == 422, model

    assert called == [], "no provider call for a refused model"


def test_a_refused_model_does_not_echo_the_request(monkeypatch):
    """The refusal says which field failed and nothing about its value — see `validation_failed`."""
    response = client.post(
        "/decide", json=body(model="gpt-4o"), headers={"x-internal-secret": SECRET}
    )
    assert response.status_code == 422
    assert "gpt-4o" not in response.text
    assert KEY not in response.text


def test_a_model_is_checked_against_its_own_provider(monkeypatch):
    """The check is per provider, not against one global list.

    This replaced a test asserting three Claude ids. `gpt-4o` is legitimate — on an OpenAI key — and
    refused on an Anthropic one, which is the whole of what multi-provider validation means here.
    """
    monkeypatch.setattr(main, "_call_model", fake_model({"actions": [{"type": "do_nothing"}]}))

    accepted = [
        ("anthropic", "claude-sonnet-5"),
        ("openai", "gpt-4o"),
        ("google", "gemini-2.0-flash"),
        ("xai", "grok-3"),
        ("groq", "llama-3.3-70b-versatile"),
        ("deepseek", "deepseek-chat"),
        ("moonshot", "kimi-k2"),
        ("qwen", "qwen-max"),
    ]
    for provider, model in accepted:
        response = client.post(
            "/decide",
            json=body(provider=provider, model=model),
            headers={"x-internal-secret": SECRET},
        )
        assert response.status_code == 200, f"{provider}/{model}"

    # Crossed over, each provider refuses another's model — with one honest exception.
    #
    # Groq is excluded, and not because the check is weak there. Groq serves other people's models, so
    # it has no prefix to check against and a legitimate id can look like anything; its ceiling is a
    # character-set and length bound instead. So Groq accepts `gemini-2.0-flash` and finds out from
    # Groq that it doesn't serve it — a 404, mapped to `502`, retried, no bot paused.
    #
    # The first version of this test asserted Groq refused it too, which was the test over-claiming
    # rather than the code under-delivering.
    for provider, _model in accepted:
        if provider == "groq":
            continue
        wrong = "gemini-2.0-flash" if provider != "google" else "claude-sonnet-5"
        response = client.post(
            "/decide",
            json=body(provider=provider, model=wrong),
            headers={"x-internal-secret": SECRET},
        )
        assert response.status_code == 422, f"{provider} must refuse {wrong}"


def test_an_unknown_provider_is_refused(monkeypatch):
    called = []
    monkeypatch.setattr(main, "_call_model", lambda **kw: called.append(kw) or ({}, {}))

    for provider in ["ollama", "", "../anthropic", "http://evil.example"]:
        response = client.post(
            "/decide", json=body(provider=provider), headers={"x-internal-secret": SECRET}
        )
        assert response.status_code == 422, provider

    assert called == [], "an unknown provider must not reach a call"


# ── Forced tool use ──────────────────────────────────────────────────────────


def test_THE_POINT_the_call_forces_this_one_tool(monkeypatch):
    """`tool_choice: auto` would let the model answer in prose, which is the free-text channel the
    whole design exists to close. So this asserts what is actually *sent*.

    The first version of this test grepped main.py for `"type": "auto"` and failed — on the
    comment explaining why auto is wrong. A test that cannot tell code from prose about code is
    not testing the code.
    """
    calls = http_model(monkeypatch, json_body=anthropic_tool_response({}))

    main._call_model(
        provider="anthropic",
        api_key=KEY,
        model="claude-haiku-4-5-20251001",
        system="sys",
        user_message="user",
    )

    sent = calls[0].body
    assert sent["tool_choice"] == {"type": "tool", "name": "take_actions"}
    assert sent["tool_choice"]["type"] != "auto"
    assert [tool["name"] for tool in sent["tools"]] == ["take_actions"], "exactly one tool offered"
    assert sent["max_tokens"] == main.MAX_OUTPUT_TOKENS

    # The key goes in Anthropic's own header, not a bearer token. A key in the wrong header is a 401
    # that looks exactly like a bad key — which would have Node pausing a bot over our mistake.
    assert calls[0].headers["x-api-key"] == KEY
    assert "authorization" not in calls[0].headers
    assert calls[0].url.endswith("/v1/messages")


def test_the_call_object_never_renders_its_headers():
    """`ProviderCall.__repr__` hides the headers, because the headers carry the key.

    The same reasoning as `repr=False` on the request model: a logged object must not be a way to leak
    a credential, and `logging.debug("%s", call)` is an ordinary thing for someone to add.
    """
    from providers import build_call

    call = build_call(
        provider_id="anthropic",
        api_key=KEY,
        model="claude-sonnet-5",
        system="s",
        user_message="u",
        max_output_tokens=64,
    )

    assert KEY not in repr(call)
    assert "redacted" in repr(call)


def test_THE_POINT_every_adapter_forces_the_tool(monkeypatch):
    """The same guarantee, checked in each of the three wire formats.

    Forced tool use is the whole security model, and it is expressed differently by each provider —
    so "we force it" is three separate claims, and a new adapter is a fourth. This is the test that
    fails if one of them is ever written as merely *offering* the tool.
    """
    cases = {
        "anthropic": lambda sent: sent["tool_choice"] == {"type": "tool", "name": "take_actions"},
        "openai": lambda sent: sent["tool_choice"]
        == {"type": "function", "function": {"name": "take_actions"}},
        "google": lambda sent: sent["toolConfig"]["functionCallingConfig"]["mode"] == "ANY"
        and sent["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"] == ["take_actions"],
    }
    models = {"anthropic": "claude-sonnet-5", "openai": "gpt-4o", "google": "gemini-2.0-flash"}

    calls = http_model(monkeypatch, json_body={})
    for provider, holds in cases.items():
        main._call_model(
            provider=provider,
            api_key=KEY,
            model=models[provider],
            system="sys",
            user_message="user",
        )
        assert holds(calls[-1].body), f"{provider} does not force the tool"

    assert len(calls) == 3, "one call per adapter, all through the same seam"


def test_the_gemini_schema_drops_what_gemini_rejects(monkeypatch):
    """Gemini refuses the whole request if `additionalProperties` is present.

    Losing it is a real reduction — on the other two adapters it is what makes an invented field an
    error rather than something ignored — so it is recorded here rather than left to be discovered.
    The guarantee is recovered by `models.Action` forbidding extras and by Node building each action
    field by field.
    """
    import json as jsonlib

    calls = http_model(monkeypatch, json_body={})
    main._call_model(
        provider="google",
        api_key=KEY,
        model="gemini-2.0-flash",
        system="sys",
        user_message="user",
    )

    assert "additionalProperties" not in jsonlib.dumps(calls[0].body)
    # But the action space itself survived the translation.
    declaration = calls[0].body["tools"][0]["functionDeclarations"][0]
    assert declaration["name"] == "take_actions"
    assert "actions" in declaration["parameters"]["properties"]

    # And the other two adapters keep it, so the loss is Gemini's alone.
    for provider, model in [("anthropic", "claude-sonnet-5"), ("openai", "gpt-4o")]:
        other = http_model(monkeypatch, json_body={})
        main._call_model(
            provider=provider, api_key=KEY, model=model, system="s", user_message="u"
        )
        assert "additionalProperties" in jsonlib.dumps(other[0].body), provider


def test_openai_tool_arguments_arrive_as_a_json_string(monkeypatch):
    """The most common mistake in the OpenAI format, and it fails in the worst way.

    Arguments come back as a **string**. Treating it as a dict yields no actions, which this service
    reports as an empty decision — a bot that quietly does nothing forever, on every provider except
    Anthropic. Both shapes are accepted because some compatible providers pre-parse it.
    """
    import json as jsonlib

    as_string = {
        "choices": [
            {
                "message": {
                    "tool_calls": [
                        {
                            "function": {
                                "name": "take_actions",
                                "arguments": jsonlib.dumps({"actions": [{"type": "do_nothing"}]}),
                            }
                        }
                    ]
                }
            }
        ],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3},
    }

    http_model(monkeypatch, json_body=as_string)
    payload, usage = main._call_model(
        provider="openai", api_key=KEY, model="gpt-4o", system="s", user_message="u"
    )

    assert payload == {"actions": [{"type": "do_nothing"}]}
    # And the token counts come from that format's own field names.
    assert usage["input_tokens"] == 7
    assert usage["output_tokens"] == 3


def test_a_redirect_is_never_followed(monkeypatch):
    """A 3xx would send the owner's key to whatever host the response named.

    That is the SSRF the provider table exists to prevent, arriving by the back door — so the client
    is built with `follow_redirects=False` and a redirect is treated as a provider failure.
    """
    http_model(monkeypatch, status=302, json_body={})

    with pytest.raises(main.ProviderFailure) as raised:
        main._call_model(
            provider="anthropic", api_key=KEY, model="claude-sonnet-5", system="s", user_message="u"
        )

    assert raised.value.status == 503


def test_a_response_with_no_tool_call_yields_an_empty_decision(monkeypatch):
    """A refusal or a length stop can produce a response with no tool block.

    Returning nothing — the bot does nothing this cycle — is right. Raising would be recorded as a
    cycle failure and would eventually pause a bot over something that isn't its key's fault.
    """
    monkeypatch.setattr(main, "_call_model", fake_model({}))

    response = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET})

    assert response.status_code == 200
    assert response.json()["actions"] == []


# ── Action validation ────────────────────────────────────────────────────────


def test_an_action_missing_its_arguments_is_dropped_not_fatal(monkeypatch):
    """Per-action validation, so one malformed item doesn't discard a cycle the owner paid for."""
    monkeypatch.setattr(
        main,
        "_call_model",
        fake_model(
            {
                "actions": [
                    {"type": "like_post", "post_id": "p1"},
                    {"type": "comment_post", "post_id": "p2"},  # no text
                    {"type": "reply_dm", "text": "hi"},  # no conversation_id
                    {"type": "send_dm", "user_id": "u1", "text": "hello"},
                ]
            }
        ),
    )

    actions = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET}).json()[
        "actions"
    ]

    assert [a["type"] for a in actions] == ["like_post", "send_dm"]


def test_more_actions_than_the_cap_are_truncated(monkeypatch):
    monkeypatch.setattr(
        main,
        "_call_model",
        fake_model({"actions": [{"type": "like_post", "post_id": f"p{i}"} for i in range(30)]}),
    )

    actions = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET}).json()[
        "actions"
    ]

    assert len(actions) <= main.MAX_ACTIONS_PER_CYCLE


def test_an_unknown_action_type_cannot_get_through(monkeypatch):
    """Even if the provider returned one, which the enum should prevent."""
    monkeypatch.setattr(
        main,
        "_call_model",
        fake_model({"actions": [{"type": "delete_account"}, {"type": "do_nothing"}]}),
    )

    actions = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET}).json()[
        "actions"
    ]

    assert [a["type"] for a in actions] == ["do_nothing"]


def test_over_long_generated_text_is_rejected_rather_than_stored():
    with pytest.raises(Exception):
        Action.model_validate({"type": "create_post", "text": "x" * 5000})


def test_required_arguments_are_enforced_per_type():
    assert Action.model_validate({"type": "do_nothing"}).type == "do_nothing"
    assert Action.model_validate({"type": "like_post", "post_id": "p1"}).post_id == "p1"

    for bad in [
        {"type": "like_post"},
        {"type": "comment_post", "post_id": "p"},
        {"type": "quote_post", "text": "t"},
        {"type": "send_dm", "text": "t"},
        {"type": "reply_dm", "text": "t"},
        {"type": "create_post"},
        {"type": "follow_user"},
        # Present but blank is the same as absent.
        {"type": "create_post", "text": "   "},
    ]:
        with pytest.raises(Exception):
            Action.model_validate(bad)


# ── Error mapping ────────────────────────────────────────────────────────────


def provider_says(monkeypatch, status, message=""):
    """Drive a real provider HTTP status through the shipped mapping.

    These tests used to fabricate SDK exception objects with `__new__` — which meant they asserted our
    handling of a shape *we* had invented, so a change in the SDK's real error surface would have
    failed nothing. Now the status and the body are the provider's and everything above the transport
    is shipped code.
    """
    http_model(monkeypatch, status=status, json_body={"error": {"message": message}})
    return client.post("/decide", json=body(), headers={"x-internal-secret": SECRET})


def assert_detail(response, token):
    """The classification token, which may carry the provider's own wording after it.

    `main.py` appends `: <provider message>` when there is one, and that half is deliberate: Node
    puts the detail in front of the owner, and "your credit balance is too low" is actionable
    where `provider_no_credit` is not. Nothing branches on the string — `reasoningClient.js`
    classifies on the HTTP status alone — so the contract these tests are pinning is the token at
    the front, not the whole line.

    Asserted as a prefix rather than with `in`, so a token appearing inside a provider's message
    could never satisfy a test about which token we chose.
    """
    detail = response.json()["detail"]
    assert detail.split(":")[0] == token, detail


def test_THE_POINT_an_invalid_key_maps_to_402_not_401(monkeypatch):
    """Node treats 402 as "pause the bot and tell the owner", and 401 as "our own secret is
    wrong". Conflating them would have Node pausing bots over a misconfiguration on this side."""
    response = provider_says(monkeypatch, 401, "invalid x-api-key")

    assert response.status_code == 402
    assert_detail(response, "provider_auth_failed")


def test_exhausted_credit_also_pauses_the_bot(monkeypatch):
    """Reported by the provider as a 400 about the balance, not as a distinct code."""
    response = provider_says(monkeypatch, 400, "Your credit balance is too low")

    assert response.status_code == 402
    assert_detail(response, "provider_no_credit")


def test_a_rate_limit_that_is_really_an_exhausted_quota_pauses_the_bot(monkeypatch):
    """Several providers report a spent account as a 429 rather than a 400.

    Retrying that forever would never succeed, and the bot would look merely busy instead of out of
    money — so billing language in a 429 is treated as the account being finished.

    OpenAI's real wording, not the four-word paraphrase this used to assert. That paraphrase was
    "You exceeded your current quota", which passed only because `exceeded` and `quota` were in the
    word list — and those two words are ordinary rate-limit prose, which is precisely what made the
    list misfire below. The full message carries "billing details", which is not.
    """
    response = provider_says(
        monkeypatch,
        429,
        "You exceeded your current quota, please check your plan and billing details.",
    )

    assert response.status_code == 402
    assert_detail(response, "provider_no_credit")


# Groq's actual 429, copied from a live eval run. The URL at the end is the whole problem.
GROQ_RATE_LIMIT = (
    "Rate limit reached for model `llama-3.3-70b-versatile` in organization `org_01kz9` "
    "service tier `on_demand` on tokens per minute (TPM): Limit 12000, Used 9790, "
    "Requested 2526. Please try again in 1.58s. Need more tokens? Upgrade to Dev Tier "
    "today at https://console.groq.com/settings/billing"
)


def test_THE_POINT_an_upsell_link_is_not_an_empty_account(monkeypatch):
    """The bug a live run found, and it had nothing to do with money.

    Groq appends "Upgrade to Dev Tier today at …/settings/billing" to every rate-limit message. The
    word `billing` in that URL matched the billing heuristic, so a 429 meaning "try again in 1.58
    seconds" was reported as 402 — the one status Node acts on hardest. It pauses the bot and tells
    the owner their key has failed, and `paused_key_invalid` is deliberately not owner-resumable, so
    a two-second rate limit parked the bot until someone re-checked the key.

    Nine of fourteen live probes hit this. On a free tier it would be most of a bot's cycles.
    """
    response = provider_says(monkeypatch, 429, GROQ_RATE_LIMIT)

    assert response.status_code == 429
    assert_detail(response, "provider_rate_limited")


def test_a_plain_rate_limit_is_transient_even_when_it_says_exceeded(monkeypatch):
    """A deliberate reversal, recorded so nobody restores the old words by "fixing" this.

    "Rate limit exceeded" is the most common phrasing of a transient 429 in existence, and Gemini
    reports an ordinary one as an exhausted "quota". Neither says anything about a balance. Reading
    either as a dead credential trades one wasted cycle — the cost of guessing transient — for a
    paused bot and a false alarm to its owner, which is the expensive direction.
    """
    for message in (
        "Rate limit exceeded. Please retry.",
        "Resource has been exhausted (e.g. check quota).",
    ):
        response = provider_says(monkeypatch, 429, message)

        assert response.status_code == 429, message
        assert_detail(response, "provider_rate_limited")


def test_an_unrecognised_provider_400_is_retryable_not_a_pause(monkeypatch):
    """The safe direction: a bug in our request must not be blamed on the owner's key."""
    response = provider_says(monkeypatch, 400, "unexpected field 'foo'")

    assert response.status_code == 502
    assert_detail(response, "provider_bad_request")


def test_THE_POINT_a_missing_model_is_its_own_answer_neither_the_key_nor_a_blip(monkeypatch):
    """A retired model is the owner's to fix, and it never fixes itself.

    This used to report `502`, on the reasoning that a 404 is a stale discovered list and therefore
    our problem rather than a reason to tell an owner their credential died. The first half of that
    is right and the conclusion did not follow: Node reads `502` as transient, so the bot retried a
    model that no longer exists every twenty minutes, for ever, while its status still read
    "Active". Nothing was surfaced to the owner but a growing column of failed turns.

    A live run found it. Google's own words were "This model models/gemini-2.5-flash is no longer
    available to new users" — a permanent condition an owner can clear in ten seconds by choosing
    another model, if anybody tells them.

    So `404` gets its own status out of here, and Node pauses the bot with a reason that says which
    model went away. Still not blamed on the key: `ApiKey.isValid` is untouched.
    """
    response = provider_says(monkeypatch, 404, "model not found")

    assert response.status_code == 404
    assert_detail(response, "provider_model_not_found")


def test_rate_limiting_and_unreachability_are_distinguished(monkeypatch):
    assert provider_says(monkeypatch, 429, "slow down").status_code == 429
    assert provider_says(monkeypatch, 503, "upstream down").status_code == 503

    # A connection failure, which says nothing at all about the key.
    http_model(monkeypatch, raises=main.ProviderFailure(503, "provider_unreachable"))
    response = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET})
    assert response.status_code == 503
    assert response.json()["detail"] == "provider_unreachable"


def test_the_socket_layer_maps_its_own_failures(monkeypatch):
    """`_http_post` is where an httpx exception becomes our contract, so it gets its own test.

    Patched once, not in a loop — which is the whole reason the seam exists. The version of this that
    wrapped `httpx.Client` repeatedly is what served one test's canned response to all the others.
    """
    from providers import build_call

    call = build_call(
        provider_id="anthropic",
        api_key=KEY,
        model="claude-sonnet-5",
        system="s",
        user_message="u",
        max_output_tokens=64,
    )

    for error, expected in [
        (httpx.ReadTimeout("too slow"), "provider_timeout"),
        (httpx.ConnectError("connection reset"), "provider_unreachable"),
    ]:

        class Boom:
            def __init__(self, *_args, **_kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

            def post(self, *_args, **_kwargs):
                raise error

        monkeypatch.setattr(httpx, "Client", Boom)
        with pytest.raises(main.ProviderFailure) as raised:
            main._http_post(call)

        assert raised.value.status == 503
        assert raised.value.detail == expected


def test_an_unseen_status_is_transient_rather_than_a_pause(monkeypatch):
    """The default direction. A status we have not met is far likelier to be a proxy or a deploy than
    a dead credential, and guessing that way costs one wasted cycle instead of a false alarm."""
    assert provider_says(monkeypatch, 418, "teapot").status_code == 503


def test_an_unexpected_exception_returns_a_status_and_nothing_else(monkeypatch):
    """FastAPI's default handler stringifies the exception, and an exception raised mid-request can
    carry request data — including, in the worst case, the key."""
    monkeypatch.setattr(main, "_call_model", raising_model(RuntimeError(f"boom with {KEY}")))

    response = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET})

    assert response.status_code == 500
    assert KEY not in response.text
    assert "boom" not in response.text


# ── Key handling ─────────────────────────────────────────────────────────────


def test_THE_POINT_the_key_never_appears_in_a_response(monkeypatch):
    monkeypatch.setattr(main, "_call_model", fake_model({"actions": [{"type": "do_nothing"}]}))

    response = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET})

    assert KEY not in response.text
    assert "sk-ant" not in response.text


def test_THE_POINT_a_validation_failure_never_echoes_the_key(monkeypatch):
    """A real leak, found by a test that was looking somewhere else.

    FastAPI's default 422 handler returns each error with the value that failed — and for a missing
    or nested field that value is the whole request object, key included. Renaming
    `anthropic_api_key` to `api_key` meant every stale caller got a 422 containing their credential
    in plain text.

    Worse than a logging problem: a 422 is exactly what a *probing* caller gets, and the request
    shape is guessable. So the handler now returns field names and nothing else.
    """
    # The stale-caller case has to *remove* `api_key` as well as add the old name. The first version
    # only added it — and since Pydantic ignores unknown fields the request was perfectly valid,
    # reached a provider, and came back 402. A test that never triggered the condition it was named
    # for.
    stale = {k: v for k, v in body().items() if k != "api_key"}
    stale["anthropic_api_key"] = KEY

    # Deliberately malformed several ways, each of which produces a different error shape.
    for payload in [
        stale,
        {**body(), "persona": "not an object"},
        {k: v for k, v in body().items() if k != "bot_id"},
        {**body(), "model": 42},
    ]:
        response = client.post("/decide", json=payload, headers={"x-internal-secret": SECRET})
        assert response.status_code == 422
        assert KEY not in response.text, payload.keys()
        assert "sk-ant" not in response.text

    # And it still says enough to be actionable.
    response = client.post(
        "/decide",
        json={k: v for k, v in body().items() if k != "model"},
        headers={"x-internal-secret": SECRET},
    )
    assert "model" in response.json()["fields"][0]


def test_the_key_is_excluded_from_the_request_object_repr():
    """`repr=False`, so a key cannot be leaked by something as ordinary as logging the request."""
    request = DecideRequest.model_validate(body())

    assert KEY not in repr(request)
    assert KEY not in str(request)
    # But it is still there for the one caller that needs it.
    assert request.api_key == KEY


def test_redact_scrubs_key_shaped_strings():
    assert "sk-ant" not in main.redact(f"failed with {KEY}")
    assert main.redact("nothing here") == "nothing here"
    assert main.redact(RuntimeError(f"boom {KEY}")).count("REDACTED") == 1


def test_the_client_is_built_per_request_not_cached():
    """Caching it would mean holding a key in memory between requests — the one thing this service
    promises not to do."""
    source = (Path(__file__).resolve().parent.parent / "main.py").read_text(encoding="utf-8")
    # From `_http_post`, which is where the client now lives — the slice used to start at
    # `_call_model` and this test correctly failed when the socket moved into its own seam.
    call_body = source[source.index("def _http_post"): source.index("def _decide")]

    # `with httpx.Client(...)` — constructed and closed inside the call, so no key outlives it.
    assert "httpx.Client(" in call_body
    assert "lru_cache" not in source
    assert "global client" not in source
    # And no redirect following, which would forward the key to a host of the response's choosing.
    assert "follow_redirects=False" in call_body


def test_the_prompt_reaching_the_provider_carries_the_identity_clause(monkeypatch):
    """An end-to-end check that assembly and the call are actually wired together."""
    call = fake_model({"actions": [{"type": "do_nothing"}]})
    monkeypatch.setattr(main, "_call_model", call)

    client.post("/decide", json=body(), headers={"x-internal-secret": SECRET})

    from prompts import IDENTITY_CLAUSE

    assert call.seen["system"].rstrip().endswith(IDENTITY_CLAUSE)


def test_THE_POINT_the_identity_clause_survives_every_adapter(monkeypatch):
    """The clause has to reach the provider in whichever field that provider calls "system".

    Anthropic takes a top-level `system`; the OpenAI format takes a system *message*; Gemini takes
    `systemInstruction`. Three different places to put the one string the whole compliance story
    depends on, and dropping it in one of them would be silent.
    """
    import json as jsonlib

    from prompts import IDENTITY_CLAUSE

    extract = {
        "anthropic": lambda sent: sent["system"],
        "openai": lambda sent: sent["messages"][0]["content"],
        "google": lambda sent: sent["systemInstruction"]["parts"][0]["text"],
    }
    models = {"anthropic": "claude-sonnet-5", "openai": "gpt-4o", "google": "gemini-2.0-flash"}

    calls = http_model(monkeypatch, json_body={})
    for provider, read in extract.items():
        response = client.post(
            "/decide",
            json=body(provider=provider, model=models[provider]),
            headers={"x-internal-secret": SECRET},
        )
        assert response.status_code == 200
        assert read(calls[-1].body).rstrip().endswith(
            IDENTITY_CLAUSE
        ), f"{provider} lost the identity clause"

        # And the untrusted half stays where it belongs, in every format. A perception that reached
        # the system turn would be a stranger's words carrying the authority of an instruction.
        system_text = read(calls[-1].body)
        assert "wet ride today" not in system_text, f"{provider} put perception in the system turn"
        assert "wet ride today" in jsonlib.dumps(calls[-1].body), f"{provider} lost the perception"


# ── Request validation ───────────────────────────────────────────────────────


def test_a_malformed_request_is_refused_without_a_provider_call(monkeypatch):
    called = []
    monkeypatch.setattr(main, "_call_model", lambda **kw: called.append(kw) or ({}, {}))

    for bad in [
        body(bot_id=""),
        body(api_key="short"),
        body(persona={"system_prompt": "x" * 5000}),
        {k: v for k, v in body().items() if k != "model"},
        {k: v for k, v in body().items() if k != "api_key"},
    ]:
        response = client.post("/decide", json=bad, headers={"x-internal-secret": SECRET})
        assert response.status_code == 422

    assert called == []


def test_the_reply_endpoint_shares_the_same_gates(monkeypatch):
    call = fake_model({"actions": [{"type": "reply_dm", "conversation_id": "c1", "text": "hi"}]})
    monkeypatch.setattr(main, "_call_model", call)

    payload = {
        "bot_id": "bot-1",
        "persona": {"username": "ana"},
        "conversation": {"id": "c1", "recent": [{"untrusted_text": "hey"}]},
        "provider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
        "api_key": KEY,
    }

    assert client.post("/reply", json=payload).status_code == 401
    assert (
        client.post("/reply", json={**payload, "model": "gpt-4o"}, headers={"x-internal-secret": SECRET}).status_code
        == 422
    )

    response = client.post("/reply", json=payload, headers={"x-internal-secret": SECRET})
    assert response.status_code == 200
    assert response.json()["actions"][0]["type"] == "reply_dm"
    from prompts import IDENTITY_CLAUSE

    assert call.seen["system"].rstrip().endswith(IDENTITY_CLAUSE)


def test_usage_is_returned_so_cost_can_be_attributed(monkeypatch):
    monkeypatch.setattr(
        main, "_call_model", fake_model({"actions": [{"type": "do_nothing"}]}, usage=(123, 45))
    )

    usage = client.post("/decide", json=body(), headers={"x-internal-secret": SECRET}).json()["usage"]

    assert usage["input_tokens"] == 123
    assert usage["output_tokens"] == 45
    assert usage["model"] == "claude-haiku-4-5-20251001"
    assert "latency_ms" in usage

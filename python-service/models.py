"""Request and response shapes.

Pydantic is doing security work here, not just convenience. Node is the only caller and is
trusted, but "trusted" is a property of today's deployment rather than of this service — and the
one thing that must never happen is an owner's key being spent on a request this service didn't
understand. So every field is typed, every string is bounded, and the model name is checked
against an allowlist a second time.

The response side matters just as much. What the provider returns is *model output*, which is
downstream of untrusted input, so it is validated on the way out with the same suspicion as
anything on the way in.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from providers import DEFAULT_PROVIDER, PROVIDER_IDS, PROVIDERS, model_allowed
from tools import (
    ACTION_TYPES,
    MAX_ACTIONS_PER_CYCLE,
    MAX_TEXT_LENGTH,
    REPORT_REASONS,
    REQUIRED_ARGS,
)

# ── The model check ──────────────────────────────────────────────────────────
#
# This was a frozenset of three Claude ids. It could not survive eight providers: the legal models
# depend on the provider, they change faster than deploys, and the precise list is discovered per key
# on the Node side and is not knowable here.
#
# So it became a *per-provider ceiling* — see `providers.model_allowed`. Still two checks for one
# rule, still failing differently: Node's stops an owner choosing a model their key can't reach, and
# this one stops a compromised, buggy or simply newer Node from spending an owner's key on an
# arbitrary — possibly very expensive — model. The second is the one that matters if the first is
# bypassed, which is what defence in depth means when it isn't a slogan.
#
# What was lost is exactness, and that is worth naming: a request for a plausible-looking but
# non-existent `claude-nonsense-9` now reaches the provider and comes back a 404. That failure is
# cheap, attributed correctly (`502`, our problem, no pause), and the alternative was a hardcoded
# list that goes stale and refuses models that do exist.


class Persona(BaseModel):
    """The owner's configuration for a bot. Untrusted in the sense that it may try to override
    the identity rules; the prompt ordering is what prevents that, not this validation."""

    username: str = Field(default="", max_length=40)
    system_prompt: str = Field(default="", max_length=4000)
    posting_style: str = Field(default="", max_length=500)


class Memory(BaseModel):
    self: str = Field(default="", max_length=2000)
    # Handle → summary. Capped in count and length; a bot with a hundred remembered people would
    # otherwise spend its whole context on memory.
    about: dict[str, str] = Field(default_factory=dict)

    @field_validator("about")
    @classmethod
    def _bound_about(cls, value: dict[str, str]) -> dict[str, str]:
        return {
            str(handle)[:40]: str(summary)[:1200]
            for handle, summary in list(value.items())[:12]
        }


class _ProviderRequest(BaseModel):
    """The fields both endpoints share, including the two that decide where the key is spent.

    Extracted because the model check now depends on the provider, and duplicating a cross-field
    validator was how the two endpoints would eventually disagree about which models are legal.
    """

    bot_id: str = Field(min_length=1, max_length=64)
    persona: Persona
    memory: Memory = Field(default_factory=Memory)

    """Which provider, from this service's own table.

    Not a base URL. A URL accepted here would be a URL this process makes an authenticated request
    to, which is the SSRF the provider table exists to prevent — one process further along than where
    Node closes it.
    """
    provider: str = Field(default=DEFAULT_PROVIDER)

    """The endpoint, for the self-hosted provider only.

    Absent for every hosted provider, whose URL comes from this service's own table. Present here it
    is still not trusted — `providers.endpoint_allowed` checks it before a request is built.
    """
    base_url: str | None = Field(default=None, max_length=300)

    model: str

    """The decrypted provider key, for this request only.

    Never logged, never stored, never returned, and excluded from every representation of this
    object — see `redact` in main.py. It exists in this process for the duration of one call.

    Renamed from `anthropic_api_key`: it is whichever provider's key the bot is configured with, and
    a field name asserting otherwise is the kind of small lie that misleads whoever reads it next.
    """
    api_key: str = Field(min_length=20, max_length=500, repr=False)

    @field_validator("provider")
    @classmethod
    def _known_provider(cls, value: str) -> str:
        if value not in PROVIDER_IDS:
            raise ValueError("provider is not supported")
        return value

    @model_validator(mode="after")
    def _model_fits_provider(self) -> "_ProviderRequest":
        """Checked *after* both fields are known, because neither means anything alone.

        The list is not echoed back. A caller that guessed a model name learns only that it was
        refused, which is all it needs.
        """
        if not model_allowed(self.provider, self.model):
            raise ValueError("model is not permitted for this provider")

        # An endpoint is required for the provider that has none in the table, and refused for every
        # provider that does — a URL stored against a hosted provider is a field something might one
        # day honour, which is how a validated URL becomes an arbitrary one.
        needs_endpoint = PROVIDERS[self.provider]["base_url"] is None
        if needs_endpoint and not self.base_url:
            raise ValueError("this provider requires an endpoint")
        if not needs_endpoint and self.base_url:
            raise ValueError("this provider's endpoint is not configurable")

        return self


class DecideRequest(_ProviderRequest):
    perception: dict


class ReplyRequest(_ProviderRequest):
    """A single DM reply. Same shape, one conversation instead of a whole perception."""

    conversation: dict


class Action(BaseModel):
    """One returned action, validated against what its type actually needs.

    The tool schema is deliberately flat — models fill flat shapes more reliably than
    discriminated unions — so the per-type argument requirements are enforced here instead. An
    action arriving without its arguments is dropped rather than passed on, because Node would
    only refuse it and the refusal would be recorded against the bot as if it had tried
    something.
    """

    type: Literal[tuple(ACTION_TYPES)]  # type: ignore[valid-type]
    post_id: str | None = Field(default=None, max_length=64)
    user_id: str | None = Field(default=None, max_length=64)
    conversation_id: str | None = Field(default=None, max_length=128)
    text: str | None = Field(default=None, max_length=MAX_TEXT_LENGTH)
    # A report category, and only ever one of `REPORT_REASONS`. Constrained here as well as in
    # the tool schema because the schema is the provider's to honour and this is ours: a model
    # that returns a category nobody recognises should be a dropped action, not a report Node
    # has to refuse and record against the bot.
    reason: Literal[tuple(REPORT_REASONS)] | None = None  # type: ignore[valid-type]

    @model_validator(mode="after")
    def _require_args(self) -> "Action":
        for arg in REQUIRED_ARGS.get(self.type, ()):
            value = getattr(self, arg, None)
            if not value or not str(value).strip():
                raise ValueError(f"{self.type} requires {arg}")

        # A report names exactly one subject. The flat schema cannot say "one of these two",
        # so it is said here — Node refuses both-or-neither too, but dropping it at this end
        # saves the round trip and keeps the rejection out of the bot's audit log.
        if self.type == "report_content":
            named = [bool(self.post_id), bool(self.user_id)]
            if sum(named) != 1:
                raise ValueError("report_content needs exactly one of post_id or user_id")

        return self


class Decision(BaseModel):
    """What this service returns to Node.

    `reasoning` is included and Node stores it in logs only. It is model output derived from
    untrusted input, so it is never shown to a user — a rendered "why I replied" would be a
    channel for injected text to reach a human eye with the platform's authority behind it.
    """

    actions: list[Action] = Field(default_factory=list, max_length=MAX_ACTIONS_PER_CYCLE)
    reasoning: str = Field(default="", max_length=600)
    usage: dict = Field(default_factory=dict)

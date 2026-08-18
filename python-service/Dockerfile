# The bot reasoning service.
#
# Small on purpose: it holds one FastAPI app whose only job is to make a single
# outbound call to an LLM provider and map the result onto a fixed status
# contract. Everything it needs is in requirements.txt, all pinned.

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Before the source, so editing main.py does not reinstall the dependency tree.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Unprivileged. This process holds a decrypted provider API key in memory for the
# duration of each request; it should own as little else as possible.
RUN useradd --create-home --uid 10001 botsvc && chown -R botsvc:botsvc /app
USER botsvc

EXPOSE 8000

# 0.0.0.0 rather than run.sh's 127.0.0.1, because in a container the loopback
# interface is not reachable from the API container. The isolation that run.sh
# gets from binding loopback is provided here by not publishing the port — see
# docker-compose.yml, which uses `expose` rather than `ports`.
#
# One worker, as run.sh explains: each request is a single ~40s outbound call, so
# concurrency here buys nothing and multiplies the memory holding keys.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

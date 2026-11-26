#!/usr/bin/env bash
# Deploy the current commit to a Hugging Face Docker Space (free CPU tier, no credit card).
#
#   HF_TOKEN=hf_xxx HF_SPACE=<username>/acme-support-agent ./scripts/deploy-hf-space.sh
#
# The Space needs these secrets (Space → Settings → Variables and secrets):
#   OPENAI_API_KEY, DATABASE_URL (e.g. a free Neon Postgres URL)
# and these variables: NODE_ENV=production, FRAME_ANCESTORS=https://huggingface.co, DAILY_BUDGET_USD=3
set -euo pipefail

: "${HF_TOKEN:?set HF_TOKEN to a Hugging Face *write* token}"
: "${HF_SPACE:?set HF_SPACE, e.g. yourname/acme-support-agent}"

ROOT="$(git rev-parse --show-toplevel)"
REV="$(git -C "$ROOT" rev-parse --short HEAD)"
WORK="$(mktemp -d)"
cleanup() { rm -rf -- "${WORK:?}"; }
trap cleanup EXIT

# Exact snapshot of the committed tree (no node_modules, .env or local files).
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$WORK"
cd "$WORK"

# Spaces read their configuration from YAML front matter at the top of README.md.
{
  cat <<'YAML'
---
title: Acme Cloud Support Agent
emoji: 🎧
colorFrom: green
colorTo: gray
sdk: docker
app_port: 8080
pinned: false
short_description: Support agent with chat, live voice and RAG guardrails
---

YAML
  cat README.md
} > README.space.md
mv README.space.md README.md

git init -q -b main
git add -A
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" \
  commit -q -m "Deploy ${REV}"

AUTH="$(printf 'hf:%s' "$HF_TOKEN" | base64 | tr -d '\n')"
GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
  -c "http.https://huggingface.co/.extraheader=AUTHORIZATION: basic ${AUTH}" \
  push -q -f "https://huggingface.co/spaces/${HF_SPACE}" main

echo "Deployed ${REV} → https://huggingface.co/spaces/${HF_SPACE}"
echo "App URL:  https://${HF_SPACE/\//-}.hf.space"

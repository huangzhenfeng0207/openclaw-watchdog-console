#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${SCRIPT_DIR}/.env"
  set +a
fi

OPENCLAW_NODE_BIN="${OPENCLAW_NODE_BIN:-/opt/homebrew/opt/node/bin/node}"
OPENCLAW_CLI="${OPENCLAW_CLI:-/Users/huangzhenfeng/openclaw/openclaw.mjs}"
OPENCLAW_CHAT_TIMEOUT_SECONDS="${OPENCLAW_CHAT_TIMEOUT_SECONDS:-60}"
OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-main}"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 \"<message>\""
  exit 1
fi

MESSAGE="$*"
RAW_JSON="$("${OPENCLAW_NODE_BIN}" "${OPENCLAW_CLI}" agent --agent "${OPENCLAW_AGENT_ID}" --message "${MESSAGE}" --json --timeout "${OPENCLAW_CHAT_TIMEOUT_SECONDS}")"

echo "${RAW_JSON}"
echo "---- parsed-reply ----"
printf "%s" "${RAW_JSON}" | "${OPENCLAW_NODE_BIN}" -e '
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const candidates = [
      data?.result?.payloads?.[0]?.text,
      data?.result?.payloads?.find?.((item) => typeof item?.text === "string")?.text,
      data?.result?.finalText,
      data?.result?.message,
      data?.result?.response,
      data?.message,
      data?.response,
      data?.text,
      data?.outputText,
    ];
    const reply = candidates.find((v) => typeof v === "string" && v.trim().length > 0);
    if (reply) {
      process.stdout.write(reply + "\n");
      return;
    }
    process.stdout.write("(no plain-text reply field found; inspect raw JSON above)\n");
  } catch (err) {
    process.stderr.write(`failed to parse JSON: ${String(err)}\n`);
    process.exit(1);
  }
});
'

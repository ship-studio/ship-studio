"""A scripted model for the Agents e2e suite's Codex scenarios.

Codex talks to it as an OpenAI Responses endpoint (a custom model provider),
so the real `codex` binary, Ship Studio's runner and its MCP bridge all run
for real while the "model" follows rules. It runs only when no Codex account
is signed in (AGENTS_E2E_CODEX_MODEL=scripted); it proves the plumbing, not a
model's judgement.

    python3 agents-e2e-codex-model.py PORT RULES.json LOG.jsonl

RULES is a list of {"match": text, "steps": [...], "then": text}. The newest
user message picks the first rule whose `match` it contains. Steps:
  {"text": "..."}                 a message, streamed word by word
  {"call": "tool", "args": {...}} a call to one of Ship Studio's agent tools
  {"recall": "regex"}             a message with the regex's first group, from
                                  any earlier user message Codex sent (so it
                                  only answers if the session kept them)
  {"sleep": seconds}
After a tool result the reply is the rule's `then`. Each request is logged.
"""

import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, RULES, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3]
SERVER = "mcp__shipstudio_agents"


def user_texts(items):
    out = []
    for item in items:
        if item.get("type") != "message" or item.get("role") != "user":
            continue
        text = "".join(c.get("text", "") for c in item.get("content", []))
        if text.startswith("<environment_context>") or text.startswith("# AGENTS.md"):
            continue
        out.append(text)
    return out


def plan(body):
    items = body.get("input", [])
    texts = user_texts(items)
    latest = texts[-1] if texts else ""
    rules = json.load(open(RULES))
    rule = next((r for r in rules if r["match"] in latest), None)
    after_tool = bool(items) and items[-1].get("type") == "function_call_output"
    if rule is None:
        return [{"text": "ok"}]
    if after_tool:
        return [{"text": rule.get("then", "Done.")}]
    steps = []
    for step in rule["steps"]:
        if "recall" in step:
            found = None
            for text in texts[:-1]:
                m = re.search(step["recall"], text)
                if m:
                    found = m.group(1)
            steps.append({"text": found or "I don't know."})
        else:
            steps.append(step)
    return steps


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b'{"models": []}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        body = json.loads(raw or b"{}")
        steps = plan(body)
        with open(LOG, "a") as f:
            f.write(json.dumps({"latest": user_texts(body.get("input", []))[-1:], "steps": steps}) + "\n")
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("connection", "close")
        self.end_headers()

        def event(obj):
            self.wfile.write(f"event: {obj['type']}\ndata: {json.dumps(obj)}\n\n".encode())
            self.wfile.flush()

        event({"type": "response.created", "response": {"id": "resp"}})
        for i, step in enumerate(steps):
            if "text" in step:
                item = {"type": "message", "id": f"msg_{i}", "role": "assistant", "content": []}
                event({"type": "response.output_item.added", "output_index": i, "item": item})
                for j, word in enumerate(step["text"].split(" ")):
                    event({"type": "response.output_text.delta", "item_id": item["id"], "output_index": i,
                           "content_index": 0, "delta": (" " if j else "") + word})
                    time.sleep(step.get("delay", 0.01))
                item["content"] = [{"type": "output_text", "text": step["text"]}]
                event({"type": "response.output_item.done", "output_index": i, "item": item})
            elif "call" in step:
                item = {"type": "function_call", "id": f"fc_{i}", "call_id": f"call_{time.time_ns()}",
                        "name": step["call"], "namespace": SERVER, "arguments": json.dumps(step["args"])}
                event({"type": "response.output_item.added", "output_index": i, "item": item})
                event({"type": "response.output_item.done", "output_index": i, "item": item})
            elif "sleep" in step:
                time.sleep(step["sleep"])
        event({"type": "response.completed", "response": {"id": "resp", "usage": {
            "input_tokens": 1000, "input_tokens_details": {"cached_tokens": 800},
            "output_tokens": 20, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 1020}}})


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

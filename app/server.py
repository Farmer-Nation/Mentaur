"""Local lab server: serves the UI, takes uploads and commands, runs the agents.

Run from the repo root:  python app/server.py   then open http://127.0.0.1:8000

NOTE: run_agent() below is a direct tool-using loop on the Anthropic API so the UI works today.
The submission must be orchestrated by Omnigent: replace run_agent() with Omnigent sessions
(TODO verify against the Omnigent docs). Tool permissions and the approval gate stay the same.
"""
import json, os, re, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / "src"))
import record  # noqa: E402

MODEL = os.environ.get("LAB_MODEL", os.environ.get("AUDIT_MODEL", "claude-sonnet-5-5"))
UP = ROOT / "data" / "uploads"
UP.mkdir(parents=True, exist_ok=True)
AGENTS = ["orchestrator", "literature", "data", "insight", "planner", "runner", "analyst", "safety"]
LOCK = threading.Lock()
S = {"events": [], "status": {a: "idle" for a in AGENTS}, "approvals": [], "busy": False, "ok_scripts": set()}
CLIENT = None


def emit(agent, kind, text):
    with LOCK:
        S["events"].append({"i": len(S["events"]), "t": time.strftime("%H:%M:%S"), "agent": agent, "kind": kind, "text": str(text)})


def T(name, desc, props, req):
    return {"name": name, "description": desc, "input_schema": {"type": "object", "properties": props, "required": req}}


STR = {"type": "string"}
TOOLS = {
    "delegate": T("delegate", "Give a task to a specialist agent; returns its summary.", {"agent": {"type": "string", "enum": AGENTS[1:]}, "task": STR}, ["agent", "task"]),
    "list_files": T("list_files", "List files in data/, runs/ and record/.", {}, []),
    "read_file": T("read_file", "Read a text file under data/, runs/ or record/ (max 12000 chars).", {"path": STR}, ["path"]),
    "run_script": T("run_script", "Run an allowed experiment script.", {"script": {"type": "string", "enum": ["inject_defects", "run_axe", "run_agent_audit", "analyze"]}, "args": {"type": "array", "items": STR}}, ["script"]),
    "write_handoff": T("write_handoff", "Record a structured handoff to another agent.", {"to": STR, "type": {"type": "string", "enum": ["finding", "hypothesis", "plan", "result", "approval", "decision"]}, "claim": STR, "evidence": {"type": "array", "items": STR}, "refs": {"type": "array", "items": STR}, "confidence": {"type": "string", "enum": ["low", "med", "high"]}}, ["to", "type", "claim", "evidence", "confidence"]),
    "request_approval": T("request_approval", "Ask the human scientist to approve an action. Blocks until answered.", {"action": STR}, ["action"]),
}
PERMS = {"orchestrator": ["delegate", "list_files", "read_file"], "literature": ["write_handoff"],
         "data": ["run_script", "list_files", "read_file", "write_handoff"], "insight": ["read_file", "list_files", "write_handoff"],
         "planner": ["read_file", "list_files", "write_handoff"], "runner": ["run_script", "list_files", "write_handoff"],
         "analyst": ["run_script", "read_file", "list_files", "write_handoff"], "safety": ["request_approval", "write_handoff"]}
SCRIPTS = {"data": {"inject_defects"}, "runner": {"run_axe", "run_agent_audit"}, "analyst": {"analyze"}}
NEEDS_OK = {"run_agent_audit"}  # enforced here in code, not in a prompt
EXTRA = {"orchestrator": "You coordinate a research lab. Delegate; do not do specialists' jobs. For the accessibility-audit question the usual order is literature and data first, then insight, planner (at least two options), runner (needs human approval), analyst, then decide whether to reopen a hypothesis. For other questions or uploaded files, use the agents that fit. Be brief."}
SUFFIX = "\n\nYou act only through your tools. Use write_handoff for handoffs. Only report what tools actually returned; never invent results."


def safe_path(p):
    q = (ROOT / p).resolve()
    if not any(q.is_relative_to((ROOT / d).resolve()) for d in ("data", "runs", "record")):
        raise ValueError("path not allowed")
    return q


def files():
    out = []
    for d in ("data", "runs", "record"):
        for p in sorted((ROOT / d).rglob("*")):
            if p.is_file() and p.name != ".gitkeep" and p.parent.name != "pages":
                out.append(p.relative_to(ROOT).as_posix())
    n = len(list((ROOT / "data/pages").glob("*.html"))) if (ROOT / "data/pages").exists() else 0
    return out + ([f"data/pages/ ({n} pages)"] if n else [])


def ask(agent, action):
    a = {"id": len(S["approvals"]) + 1, "by": agent, "text": action, "state": "pending", "ev": threading.Event()}
    S["approvals"].append(a)
    S["status"][agent] = "waiting"
    emit(agent, "approval", action)
    a["ev"].wait(timeout=1800)
    if a["state"] == "pending":
        a["state"] = "rejected"
    S["status"][agent] = "working"
    return a["state"]


def run_script(agent, script, args):
    if script not in SCRIPTS.get(agent, set()):
        return "denied: not permitted for this agent"
    if script in NEEDS_OK and script not in S["ok_scripts"]:
        if ask("safety", f"Allow {agent} to run {script}? It calls the LLM API and costs money.") != "approved":
            return "denied by the human scientist"
        S["ok_scripts"].add(script)
    if not all(re.fullmatch(r"[\w\-./=]+", x) and ".." not in x for x in args):
        return "denied: bad argument"
    emit(agent, "tool", f"python src/{script}.py {' '.join(args)}")
    r = subprocess.run([sys.executable, f"src/{script}.py", *args], capture_output=True, text=True, timeout=1800)
    return (r.stdout + r.stderr)[-3000:] or "ok"


def call_tool(agent, name, a):
    if name not in PERMS[agent]:
        return "denied"
    try:
        if name == "delegate":
            emit(agent, "handoff", f"to {a['agent']}: {a['task']}")
            return run_agent(a["agent"], a["task"])
        if name == "list_files":
            return json.dumps(files())
        if name == "read_file":
            return safe_path(a["path"]).read_text(errors="replace")[:12000]
        if name == "run_script":
            return run_script(agent, a["script"], a.get("args", []))
        if name == "write_handoff":
            hid = record.write(agent, a["to"], a["type"], a.get("refs", []), a["claim"], a["evidence"], a["confidence"])
            emit(agent, "handoff", f"{hid} to {a['to']}: {a['claim']}")
            return hid
        if name == "request_approval":
            return ask(agent, a["action"])
    except Exception as e:
        return f"error: {e}"
    return "unknown tool"


def run_agent(name, task):
    global CLIENT
    if CLIENT is None:
        import anthropic
        CLIENT = anthropic.Anthropic()
    system = (ROOT / "agents" / name / "prompt.md").read_text() + "\n" + EXTRA.get(name, "") + SUFFIX
    tools = [TOOLS[t] for t in PERMS[name]] + ([{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}] if name == "literature" else [])
    msgs = [{"role": "user", "content": task}]
    S["status"][name] = "working"
    text = ""
    for _ in range(14):
        r = CLIENT.messages.create(model=MODEL, max_tokens=2000, system=system, tools=tools, messages=msgs)
        msgs.append({"role": "assistant", "content": r.content})
        text = "".join(b.text for b in r.content if b.type == "text")
        if text:
            emit(name, "say", text)
        calls = [b for b in r.content if b.type == "tool_use"]
        if not calls:
            if r.stop_reason == "pause_turn":
                continue
            break
        msgs.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": c.id, "content": str(call_tool(name, c.name, c.input))[:6000]} for c in calls]})
    S["status"][name] = "idle"
    return text or "(no summary)"


def job(text):
    try:
        run_agent("orchestrator", text)
    except Exception as e:
        emit("orchestrator", "error", f"{type(e).__name__}: {e}")
    finally:
        for a in AGENTS:
            S["status"][a] = "idle"
        S["busy"] = False
        emit("orchestrator", "done", "Finished.")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            return self.out(200, (ROOT / "ui" / "index.html").read_bytes(), "text/html; charset=utf-8")
        if u.path == "/api/state":
            since = int(q.get("since", ["0"])[0])
            with LOCK:
                ev = S["events"][since:]
            hs = [json.loads(p.read_text()) for p in sorted(Path("record").glob("h-*.json"))]
            rp = Path("runs/results.json")
            return self.out(200, {"events": ev, "next": since + len(ev), "status": S["status"], "busy": S["busy"],
                                  "approvals": [{k: v for k, v in a.items() if k != "ev"} for a in S["approvals"]],
                                  "files": files(), "handoffs": hs, "results": json.loads(rp.read_text()) if rp.exists() else None,
                                  "key": bool(os.environ.get("ANTHROPIC_API_KEY"))})
        if u.path == "/api/file":
            try:
                return self.out(200, safe_path(q.get("path", [""])[0]).read_text(errors="replace")[:20000].encode(), "text/plain; charset=utf-8")
            except Exception as e:
                return self.out(400, {"error": str(e)})
        self.out(404, {"error": "not found"})

    def do_POST(self):
        if self.headers.get("X-Lab") != "1":
            return self.out(403, {"error": "forbidden"})
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length", 0))
        if n > 25_000_000:
            return self.out(413, {"error": "file too large (25 MB max)"})
        raw = self.rfile.read(n)
        if u.path == "/api/upload":
            name = re.sub(r"[^\w.\-]", "_", parse_qs(u.query).get("name", ["upload"])[0])[:80]
            (UP / name).write_bytes(raw)
            emit("you", "upload", f"Uploaded data/uploads/{name}")
            return self.out(200, {"ok": True})
        body = json.loads(raw or b"{}")
        if u.path == "/api/command":
            if not os.environ.get("ANTHROPIC_API_KEY"):
                return self.out(400, {"error": "ANTHROPIC_API_KEY is not set in the terminal that started the server."})
            if S["busy"]:
                return self.out(409, {"error": "The lab is busy. Wait for it to finish."})
            S["busy"] = True
            emit("you", "you", body.get("text", ""))
            threading.Thread(target=job, args=(body.get("text", ""),), daemon=True).start()
            return self.out(200, {"ok": True})
        if u.path == "/api/approve":
            for a in S["approvals"]:
                if a["id"] == body.get("id") and a["state"] == "pending":
                    a["state"] = "approved" if body.get("state") == "approved" else "rejected"
                    emit("you", "decision", f"{a['state']}: {a['text']}")
                    a["ev"].set()
            return self.out(200, {"ok": True})
        self.out(404, {"error": "not found"})


if __name__ == "__main__":
    print("Lab running at http://127.0.0.1:8000  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", 8000), H).serve_forever()

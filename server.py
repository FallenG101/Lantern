#!/usr/bin/env python3
"""
Lantern - a lean local LLM interface backed by Ollama.

Stdlib only. No dependencies, no build step, no telemetry, no network access
beyond your local Ollama instance.

    python3 server.py            # http://127.0.0.1:8777
    python3 server.py --port 9000 --open

Environment:
    OLLAMA_HOST   base URL of Ollama        (default http://127.0.0.1:11434)
    LANTERN_DATA  where chats are stored    (default ./data)
    LANTERN_PORT  default port              (default 8777)
"""

from __future__ import annotations

import argparse
import ast
import ipaddress
import json
import math
import mimetypes
import operator
import os
import re
import secrets
import socket
import sys
import threading
import time
import zlib
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    # stdlib from 3.9; reads the system tz database, so no tzdata package
    from zoneinfo import ZoneInfo
except ImportError:      # exotic build with no zoneinfo — local time still works
    ZoneInfo = None

# The single source of truth for the version. build-app.sh reads this line to
# stamp Info.plist, so the app bundle and the About panel cannot disagree.
VERSION = "1.2.8"

# The update check. Unauthenticated and read-only; GitHub allows 60 requests an
# hour per IP, which one check per launch cannot come near.
UPDATE_REPO = "FallenFight/Lantern"
UPDATE_API = "https://api.github.com/repos/%s/releases/latest" % UPDATE_REPO
UPDATE_PAGE = "https://github.com/%s/releases/latest" % UPDATE_REPO
_UPDATE_CACHE = {"at": 0.0, "data": None}
_UPDATE_TTL = 6 * 3600

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = Path(os.environ.get("LANTERN_DATA") or os.environ.get("SLATE_DATA")
            or (ROOT / "data")).expanduser().resolve()
CHATS = DATA / "chats"
OLLAMA = (os.environ.get("OLLAMA_HOST") or "http://127.0.0.1:11434").rstrip("/")
if not OLLAMA.startswith(("http://", "https://")):
    OLLAMA = "http://" + OLLAMA

_LOCK = threading.RLock()

# Anti-DNS-rebinding: only these Host header values are served. A page on
# attacker.com that resolves its own name to 127.0.0.1 would otherwise reach
# this server with full read access to every conversation.
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}
ALLOWED_HOSTS = set(LOOPBACK)

DEFAULT_SETTINGS = {
    "theme": "dark",              # dark | light | system
    "accent": "indigo",
    "font_size": 15,
    "density": "comfortable",     # comfortable | compact
    "bubble_width": "normal",     # narrow | normal | wide | full
    "default_model": None,
    "default_persona": None,
    "send_on_enter": True,
    "show_stats": True,
    "auto_title": True,
    "render_markdown": True,
    "thinking_open": False,       # auto-expand thinking blocks while streaming
    "sidebar_collapsed": False,
    # Whether a new chat starts with tool calling on. On by default since 1.2.2 —
    # the pill reads "auto" because the model decides whether to call anything,
    # and tools are only ever offered to models that advertise support. Turn this
    # off if you would rather pay no schema tokens until you ask.
    #
    # `read_url` is gated separately on `web_reader`, so either default can be
    # changed without silently changing the other.
    "tools_default": True,
    # How long Ollama keeps a model in memory after a reply. "" uses Ollama's
    # own default (5m). Longer avoids paying a full reload after a pause.
    "keep_alive": "",
    "preload_default": False,
    # Names of seeded personas and prompts already offered. A seed added in a
    # later release reaches existing installs exactly once: absent from this
    # list means "never offered", not "deleted". Without it, get_personas() only
    # ever seeded an empty file, so Game Master shipped in 1.2.5 and appeared for
    # nobody who had used Lantern before.
    "seeded_personas": [],
    "seeded_prompts": [],
    # Set once the first-run flow is finished or skipped. Never consulted alone:
    # see first_run() for why the *absence* of history matters more.
    "onboarded": False,
    # Lets the model fetch a web page. On by default since 1.2.2: pasting a link
    # and asking about it is an unambiguous request, and refusing until you find
    # a setting is the wrong default. "Local-first" is about where inference
    # happens, not about never resolving a hostname.
    #
    # The fence around _tool_read_url does not change and is what matters:
    # public http(s) only, checked on the resolved IP, re-checked at every
    # redirect, bounded in time and size. Switch this off to go back to a build
    # that makes no outbound request at all.
    "web_reader": True,
    # Whether to ask GitHub, once per launch, if a newer release exists. Off by
    # default and the only outbound call in the app that is not to your local
    # Ollama — the offline guarantee is that nothing leaves the machine unless
    # you switch this on.
    "update_check": False,
    # Models seen emitting a `thinking` field. /api/show under-reports the
    # capability (gemma-4 does not advertise it but honours `think` fully), so
    # we learn from what actually comes back and reveal the toggle for those.
    "observed_thinking": [],
    "default_params": {
        "temperature": 0.7,
        "top_p": 0.9,
        "top_k": 40,
        "min_p": 0.0,
        "repeat_penalty": 1.1,
        # 8192 was Ollama's own default and far below what modern models handle
        # (these report 131k-262k). Measured on a 9B: 8192 -> 32768 costs +0.83 GB
        # resident, about 34 MB per 1k tokens, for 4x the usable conversation.
        # 65536 would be ~2 GB for headroom almost nobody reaches. Parameters ->
        # Max still reads the model's real limit for anyone who wants it.
        "num_ctx": 32768,
        "num_predict": -1,
        "seed": None,
        "stop": [],
        # blank means "let Ollama decide" — these are escape hatches, not knobs
        # to fiddle with, and wrong values degrade or break inference
        "num_gpu": None,
        "num_thread": None,
        "num_batch": None,
    },
}

SEED_PROMPTS = [
    ("Explain a concept", "Explain how HTTP keep-alive works, with a diagram."),
    ("Review my text", "Tighten this paragraph without changing my voice:\n\n"),
    ("Find the edge cases", "Review this for edge cases and failure modes, then rank "
                            "them by how likely they are to bite:\n\n"),
    ("Explain like I know nothing", "Explain this in plain English, assuming no "
                                    "background, in under 150 words:\n\n"),
]

SEED_PERSONAS = [
    {
        "name": "Default",
        "emoji": "✨",
        "prompt": "",
        "description": "No system prompt. Raw model behaviour.",
    },
    {
        "name": "Terse",
        "emoji": "⚡",
        "prompt": (
            "Answer with the minimum text required to be correct and useful. "
            "No preamble, no restating the question, no summary at the end. "
            "Use bullet points or code only when they genuinely help."
        ),
        "description": "Short, dense answers with no filler.",
    },
    {
        "name": "Engineer",
        "emoji": "\U0001f9ee",
        "prompt": (
            "You are a senior software engineer. Prefer working code over prose. "
            "State assumptions explicitly, call out edge cases and failure modes, "
            "and say plainly when something is a bad idea and why. "
            "Always specify the language in code fences."
        ),
        "description": "Code-first, blunt about trade-offs.",
    },
    {
        "name": "Socratic Tutor",
        "emoji": "\U0001f393",
        "prompt": (
            "You are a patient tutor. Break ideas into small steps and check "
            "understanding as you go. Ask a guiding question before giving the "
            "full answer, and use concrete analogies and worked examples."
        ),
        "description": "Teaches by guiding rather than telling.",
    },
    {
        "name": "Editor",
        "emoji": "✍️",
        "prompt": (
            "You are a sharp copy editor. Tighten prose without changing the "
            "author's voice. Cut hedging and redundancy. Return the edited text "
            "first, then a brief bulleted list of the substantive changes."
        ),
        "description": "Tightens writing, preserves voice.",
    },
]


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def new_id(prefix: str) -> str:
    return f"{prefix}_{int(time.time() * 1000):x}{secrets.token_hex(3)}"


def migrate_legacy() -> None:
    """Carry a pre-rename "Slate" data folder over to the new name, once."""
    if DATA.exists():
        return
    legacy = DATA.parent / "Slate"
    if legacy.is_dir():
        try:
            legacy.rename(DATA)
            print(f"  Migrated   {legacy} -> {DATA}")
        except OSError:
            pass


def ensure_dirs() -> None:
    migrate_legacy()
    CHATS.mkdir(parents=True, exist_ok=True)


_PARSE_CACHE: dict = {}
_PARSE_LOCK = threading.Lock()
_PARSE_CACHE_MAX = 512


def read_chat_cached(path: Path):
    """
    Parse a chat file, reusing the last parse while its mtime and size are
    unchanged. list_chats() and search_chats() both walk every file, and they
    run on bootstrap, on every save, and on every keystroke of a search.
    """
    try:
        st = path.stat()
        key = str(path)
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        return None
    with _PARSE_LOCK:
        hit = _PARSE_CACHE.get(key)
        if hit and hit[0] == stamp:
            return hit[1]
    data = read_json(path, None)
    if not isinstance(data, dict):
        return None
    with _PARSE_LOCK:
        if len(_PARSE_CACHE) >= _PARSE_CACHE_MAX:
            _PARSE_CACHE.clear()
        _PARSE_CACHE[key] = (stamp, data)
    return data


def read_json(path: Path, fallback):
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def write_json(path: Path, payload) -> None:
    """Atomic write so a crash mid-save can't corrupt a chat."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp{secrets.token_hex(4)}")
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def settings_path() -> Path:
    return DATA / "settings.json"


def personas_path() -> Path:
    return DATA / "personas.json"


def prompts_path() -> Path:
    return DATA / "prompts.json"


def folders_path() -> Path:
    return DATA / "folders.json"


# The chat fields a client may write. This was spelled out twice — once in the
# PUT/PATCH route and once in the sendBeacon `/save` route — so adding a field to
# one and not the other made writes work everywhere except page teardown. One
# list, both routes.
CHAT_WRITABLE = ("title", "pinned", "archived", "model", "persona_id",
                 "system_override", "think", "tools", "params", "messages",
                 "folder_id")


def get_settings() -> dict:
    with _LOCK:
        stored = read_json(settings_path(), {})
        merged = dict(DEFAULT_SETTINGS)
        merged.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})
        params = dict(DEFAULT_SETTINGS["default_params"])
        stored_params = stored.get("default_params")
        if isinstance(stored_params, dict):
            params.update(stored_params)        # anything else on disk is ignored
        merged["default_params"] = params
        return merged


def save_settings(patch: dict) -> dict:
    """
    Merge a settings patch, rejecting anything whose type does not match the
    default. A wrong type here is not cosmetic: writing a string into
    default_params made get_settings() raise on the next read, which took the
    whole app down until the file was repaired by hand.
    """
    if not isinstance(patch, dict):
        return get_settings()
    with _LOCK:
        current = get_settings()
        for key, value in patch.items():
            if key == "default_params":
                if isinstance(value, dict):
                    for pk, pv in value.items():
                        if pk == "stop":
                            if isinstance(pv, list):
                                current["default_params"]["stop"] = [
                                    str(x)[:80] for x in pv][:8]
                        elif pv is None or isinstance(pv, (int, float)) and not isinstance(pv, bool):
                            current["default_params"][pk] = pv
                continue
            if key == "observed_thinking":
                if isinstance(value, list):
                    current[key] = [str(v)[:200] for v in value][-64:]
                continue
            if key not in DEFAULT_SETTINGS:
                continue
            default = DEFAULT_SETTINGS[key]
            if default is None or value is None:
                current[key] = value            # nullable (default_model etc.)
            elif isinstance(default, bool):
                if isinstance(value, bool):
                    current[key] = value
            elif isinstance(default, int) and not isinstance(default, bool):
                if isinstance(value, int) and not isinstance(value, bool):
                    current[key] = value
            elif isinstance(value, type(default)):
                current[key] = value
        write_json(settings_path(), current)
        return current


def _persona_from_seed(item: dict) -> dict:
    now = time.time()
    return {
        "id": new_id("p"),
        "name": item["name"],
        "emoji": item["emoji"],
        "prompt": item["prompt"],
        "description": item.get("description", ""),
        "model": None,
        "params": {},
        "think": None,
        "created": now,
        "updated": now,
    }


def get_personas() -> list:
    """
    Stored personas, plus any seed that has never been offered on this install.

    The "never been offered" part matters. Seeding only an empty file meant a
    persona added in a later release reached new installs and nobody else — Game
    Master shipped in 1.2.5 and appeared for no existing user. Tracking the names
    already offered fixes that *and* keeps deletion sticky: a seed you delete is
    still recorded as offered, so it does not reappear on the next launch.
    """
    with _LOCK:
        data = read_json(personas_path(), None)
        stored = (data or {}).get("personas") or []
        settings = get_settings()
        offered = set(settings.get("seeded_personas") or [])
        # An install that predates the tracking has its current names treated as
        # already offered, or every existing persona would be duplicated once.
        known = offered | {p.get("name") for p in stored if isinstance(p, dict)}

        added = [_persona_from_seed(item) for item in SEED_PERSONAS
                 if item["name"] not in known]
        if added or not stored:
            stored = stored + added
            write_json(personas_path(), {"personas": stored})
            save_settings({"seeded_personas": sorted(
                known | {item["name"] for item in SEED_PERSONAS})})
        return stored


def get_prompts() -> list:
    """
    Reusable *user* prompts — the thing you type, not the system prompt.

    Seeded with the same starting points the empty screen offers, so the library
    shows what it is for instead of opening empty. An empty file after that is a
    real answer: the user deleted them.

    Same "offered once" tracking as personas, and for the same reason — a prompt
    added in a later release would otherwise reach new installs only. See
    get_personas().
    """
    with _LOCK:
        data = read_json(prompts_path(), None)
        stored = data.get("prompts") if isinstance(data, dict) else None
        first = not isinstance(stored, list)
        stored = stored if isinstance(stored, list) else []
        offered = set(get_settings().get("seeded_prompts") or [])
        known = offered | {q.get("name") for q in stored if isinstance(q, dict)}

        now = time.time()
        added = [{"id": new_id("q"), "name": name, "text": text,
                  "created": now, "updated": now}
                 for name, text in SEED_PROMPTS if name not in known]
        if added or first:
            stored = stored + added
            write_json(prompts_path(), {"prompts": stored})
            save_settings({"seeded_prompts": sorted(
                known | {name for name, _ in SEED_PROMPTS})})
        return stored


def first_run() -> bool:
    """
    Whether to offer the first-run flow.

    Deliberately not just `settings["onboarded"]`. An existing install that has
    never opened Settings has no settings.json at all, so it would read as
    un-onboarded and get the welcome flow on upgrade — which is exactly the kind
    of "new code greets an old user" mistake that makes an update feel broken.

    So: only when there is no settings file *and* no history. Someone who has
    used Lantern has chats, whatever their settings look like.
    """
    with _LOCK:
        if get_settings().get("onboarded"):
            return False
        if settings_path().exists():
            return False
        ensure_dirs()
        return not any(CHATS.glob("c_*.json"))


def get_folders() -> list:
    """
    Chat folders: `[{id, name, order}]`, and nothing else.

    Not seeded. An empty list is the honest starting state — unlike personas and
    prompts, an example folder is not a demonstration of anything, it is just
    something to delete.

    A folder holds no chats of its own. Membership lives on the chat as
    `folder_id`, so a folder file that is lost or hand-edited costs you the
    grouping and never a conversation.
    """
    with _LOCK:
        data = read_json(folders_path(), None)
        if isinstance(data, dict) and isinstance(data.get("folders"), list):
            return data["folders"]
        return []


def save_folders(folders: list) -> list:
    with _LOCK:
        write_json(folders_path(), {"folders": folders})
        return folders


def save_prompts(prompts: list) -> list:
    with _LOCK:
        write_json(prompts_path(), {"prompts": prompts})
        return prompts


def save_personas(personas: list) -> list:
    with _LOCK:
        write_json(personas_path(), {"personas": personas})
        return personas


def chat_path(chat_id: str) -> Path:
    if not re.fullmatch(r"c_[A-Za-z0-9]+", chat_id or ""):
        raise ValueError("bad chat id")
    return CHATS / f"{chat_id}.json"


def load_chat(chat_id: str) -> dict | None:
    return read_json(chat_path(chat_id), None)


def save_chat(chat: dict) -> dict:
    with _LOCK:
        chat["updated"] = time.time()
        write_json(chat_path(chat["id"]), chat)
        return chat


def chat_summary(chat: dict) -> dict:
    messages = chat.get("messages") or []
    preview = ""
    for message in reversed(messages):
        # A tool result is raw JSON — never the sidebar preview for a chat.
        if message.get("role") == "tool":
            continue
        if message.get("content"):
            preview = " ".join(str(message["content"]).split())[:180]
            break
    return {
        "id": chat.get("id"),
        "title": chat.get("title") or "New chat",
        "created": chat.get("created"),
        "updated": chat.get("updated"),
        "pinned": bool(chat.get("pinned")),
        "archived": bool(chat.get("archived")),
        "model": chat.get("model"),
        "persona_id": chat.get("persona_id"),
        "folder_id": chat.get("folder_id"),
        "message_count": len(messages),
        "preview": preview,
    }


def list_chats() -> list:
    ensure_dirs()
    out = []
    for path in CHATS.glob("c_*.json"):
        chat = read_chat_cached(path)
        if chat and chat.get("id"):
            out.append(chat_summary(chat))
    out.sort(key=lambda c: (not c["pinned"], -(c["updated"] or 0)))
    return out


def search_chats(query: str, limit: int = 60) -> list:
    needle = (query or "").strip().lower()
    if not needle:
        return []
    hits = []
    for path in CHATS.glob("c_*.json"):
        chat = read_chat_cached(path)
        if not chat:
            continue
        matches = []
        if needle in (chat.get("title") or "").lower():
            matches.append({"role": "title", "snippet": chat.get("title") or ""})
        for message in chat.get("messages") or []:
            body = str(message.get("content") or "")
            index = body.lower().find(needle)
            if index >= 0:
                start = max(0, index - 60)
                snippet = body[start:index + 140].replace("\n", " ")
                matches.append({
                    "role": message.get("role"),
                    "message_id": message.get("id"),
                    "snippet": ("…" if start else "") + snippet.strip(),
                })
            if len(matches) >= 4:
                break
        if matches:
            summary = chat_summary(chat)
            summary["matches"] = matches
            hits.append(summary)
    hits.sort(key=lambda c: -(c["updated"] or 0))
    return hits[:limit]


# --------------------------------------------------------------------------
# update check
# --------------------------------------------------------------------------

def version_tuple(text: str):
    """(1, 0, 2) from "v1.0.2"; None for anything that is not three integers."""
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (text or "").strip())
    return tuple(int(g) for g in match.groups()) if match else None


def check_update(force: bool = False) -> dict:
    """
    Ask GitHub for the newest release tag.

    Nothing in the response is trusted beyond three integers. The tag is matched
    against a strict pattern and the link is *built here* from those numbers, so
    a release named anything at all cannot put a URL of its own choosing in
    front of the user. Never raises: a failed check is a message, not an error
    page, because being offline is the normal case for this app.
    """
    now = time.time()
    cached = _UPDATE_CACHE["data"]
    if not force and cached and now - _UPDATE_CACHE["at"] < _UPDATE_TTL:
        return cached
    result = {"current": VERSION, "latest": None, "outdated": False,
              "url": UPDATE_PAGE, "checked": now, "error": None}
    try:
        request = urllib.request.Request(UPDATE_API, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Lantern/" + VERSION,
        })
        with urllib.request.urlopen(request, timeout=6) as response:
            body = json.loads(response.read(1 << 20).decode("utf-8", "replace"))
        latest = version_tuple(str(body.get("tag_name") or ""))
        mine = version_tuple(VERSION)
        if not latest:
            result["error"] = "GitHub returned no version we recognise."
        else:
            result["latest"] = ".".join(str(n) for n in latest)
            result["url"] = "https://github.com/%s/releases/tag/v%s" % (
                UPDATE_REPO, result["latest"])
            result["outdated"] = bool(mine and latest > mine)
    except Exception as exc:
        result["error"] = "Could not reach GitHub (%s)." % exc.__class__.__name__
    # Only a good answer is worth keeping for six hours; a transient failure
    # should not pin "offline" onto the rest of the session.
    if not result["error"]:
        _UPDATE_CACHE.update({"at": now, "data": result})
    return result


# --------------------------------------------------------------------------
# ollama
# --------------------------------------------------------------------------

_caps_cache: dict[str, dict] = {}
_caps_lock = threading.Lock()


def ollama_request(path: str, payload=None, method: str | None = None, timeout: int = 30):
    url = OLLAMA + path
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=body, headers=headers, method=method or ("POST" if body else "GET")
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw) if raw else {}


def model_details(name: str) -> dict:
    """Per-model capabilities. /api/tags under-reports these, so we ask /api/show."""
    with _caps_lock:
        cached = _caps_cache.get(name)
    if cached and time.time() - cached["at"] < 900:
        return cached["value"]
    value = {"capabilities": [], "context_length": None, "parameters": "", "system": ""}
    try:
        shown = ollama_request("/api/show", {"model": name}, timeout=20)
        info = shown.get("model_info") or {}
        ctx = None
        for key, val in info.items():
            if key.endswith(".context_length"):
                ctx = val
                break
        value = {
            "capabilities": shown.get("capabilities") or [],
            "context_length": ctx or (shown.get("details") or {}).get("context_length"),
            "parameters": shown.get("parameters") or "",
            "system": shown.get("system") or "",
        }
    except Exception:
        pass
    with _caps_lock:
        _caps_cache[name] = {"at": time.time(), "value": value}
    return value


def list_models() -> dict:
    tags = ollama_request("/api/tags", timeout=15)
    models = []
    for entry in tags.get("models") or []:
        name = entry.get("name") or entry.get("model")
        if not name:
            continue
        details = entry.get("details") or {}
        extra = model_details(name)
        caps = sorted(set((entry.get("capabilities") or []) + extra["capabilities"]))
        models.append({
            "name": name,
            "size": entry.get("size"),
            "modified_at": entry.get("modified_at"),
            "family": details.get("family"),
            "parameter_size": details.get("parameter_size"),
            "quantization": details.get("quantization_level"),
            "context_length": extra["context_length"] or details.get("context_length"),
            "capabilities": caps,
            "supports_thinking": "thinking" in caps,
            "supports_vision": "vision" in caps,
            "supports_tools": "tools" in caps,
            "default_system": extra["system"],
        })
    models.sort(key=lambda m: (m["name"] or "").lower())
    running = []
    try:
        for entry in (ollama_request("/api/ps", timeout=10).get("models") or []):
            running.append({
                "name": entry.get("name") or entry.get("model"),
                "size_vram": entry.get("size_vram"),
                "expires_at": entry.get("expires_at"),
            })
    except Exception:
        pass
    return {"models": models, "running": running, "host": OLLAMA}


def generate_title(model: str, transcript: str) -> str:
    prompt = (
        "Write a title for this conversation. Rules: 2 to 6 words, no quotes, "
        "no trailing punctuation, no the word 'chat'. Reply with the title only.\n\n"
        + transcript[:2000]
    )
    result = ollama_request(
        "/api/chat",
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "think": False,
            "options": {"temperature": 0.2, "num_predict": 24},
        },
        timeout=120,
    )
    title = ((result.get("message") or {}).get("content") or "").strip()
    title = re.sub(r"<think>.*?</think>", "", title, flags=re.S).strip()
    title = title.splitlines()[0] if title else ""
    title = title.strip().strip("\"'*#").rstrip(".!,: ").strip()
    if len(title) > 60:
        title = title[:60].rsplit(" ", 1)[0] + "…"
    return title


# --------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------
#
# Tools run here, in this process, and only the ones in TOOLS can run at all.
# The client sends *names*, never schemas (see tool_specs), so a bug or an
# injected message in the front end cannot invent a callable. Each tool must be
# read-only, fast, and offline: no shell, no filesystem writes, no network. The
# execution loop lives in the client (chat.js) because it needs to stream each
# round into the thread; the round cap is advertised from here so both ends
# agree on it.

TOOL_ROUND_LIMIT = 4          # tool-executing rounds per reply, then answer only

# ── the URL reader ────────────────────────────────────────────────────────
#
# The second thing in Lantern that can reach past this machine, and unlike the
# update check the *model* chooses the address. That makes it a server-side
# request forgery primitive unless it is fenced, and the fence matters more than
# the feature: `http://127.0.0.1:8777/api/chats` would put every saved
# conversation into the model's context, and Ollama's own API sits on 11434.
#
# So: http(s) only, the resolved IP must be public, every redirect hop is
# re-checked, the body read is bounded, and every request has a hard timeout.
# It is off until `web_reader` is switched on, gated on the server exactly like
# the update check.
WEB_TIMEOUT = 8               # seconds per socket operation
# A wall-clock cap on the whole call, redirects included. `timeout=` on the
# socket is per *operation*, so a server dripping one byte a second resets it
# forever and the read never ends — verified: it ran past 12s against a 2s
# timeout. Three redirect hops would also stack to 24s without this.
WEB_TOTAL_TIMEOUT = 15
WEB_MAX_BYTES = 2_000_000     # stop reading the body here, whatever it claims
WEB_MAX_REDIRECTS = 3
WEB_MAX_CHARS = 6000          # a tool result is replayed on every later turn
WEB_TYPES = ("text/html", "application/xhtml+xml", "text/plain", "text/markdown")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse to follow redirects inside urllib so each hop can be re-checked."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def web_block_reason(url: str):
    """
    Why this URL may not be fetched, or None if it may.

    The check is on the *resolved address*, not the hostname, because
    `localtest.me` and friends resolve to 127.0.0.1 and a name-based blocklist
    would wave them straight through.
    """
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return "that is not a URL I can parse"
    if parts.scheme not in ("http", "https"):
        return ("only http and https can be read (%s is not allowed)"
                % (parts.scheme or "no scheme"))
    if not parts.hostname:
        return "the URL has no host"
    try:
        port = parts.port
    except ValueError:
        return "the URL has an invalid port"
    try:
        infos = socket.getaddrinfo(parts.hostname, port or
                                   (443 if parts.scheme == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except OSError:
        return "the host could not be resolved"
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return "the host resolved to something unrecognisable"
        if (ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return ("it resolves to %s, which is on this machine or this "
                    "private network" % ip)
    return None


def _web_decompress(raw: bytes, encoding: str) -> bytes:
    """
    Undo Content-Encoding, bounded.

    `max_length` matters: a couple of megabytes of gzip expands to gigabytes if
    you let it, and this runs in the server process.
    """
    if encoding not in ("gzip", "deflate", "x-gzip"):
        return raw
    try:
        wbits = zlib.MAX_WBITS | 16 if encoding != "deflate" else zlib.MAX_WBITS
        return zlib.decompressobj(wbits).decompress(raw, WEB_MAX_BYTES)
    except Exception:
        return raw          # not really compressed, or truncated — use as-is


class _TextExtractor(HTMLParser):
    """Readable text out of HTML. Not a browser — enough for a model to read."""

    SKIP = {"script", "style", "noscript", "template", "svg", "head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in ("p", "div", "br", "li", "tr", "td", "h1", "h2", "h3", "h4",
                     "h5", "h6", "section", "article", "nav", "header", "footer",
                     "aside", "ul", "ol", "blockquote", "pre", "figure"):
            # Without every block-level closer here, neighbouring blocks run
            # together — a <nav>Skip</nav><h1>Heading</h1> came out "SkipHeading".
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)

    def text(self):
        joined = "".join(self.parts)
        # collapse runs of blank lines and stray indentation without losing
        # paragraph breaks, which are most of what makes a page readable
        joined = re.sub(r"[ \t\r\f\v]+", " ", joined)
        joined = re.sub(r" ?\n ?", "\n", joined)
        return re.sub(r"\n{3,}", "\n\n", joined).strip()


def _tool_read_url(args: dict) -> dict:
    """
    Fetch one page and return its readable text.

    Every failure is a *result*, never an exception: a hung host, a 404, a PDF,
    a blocked address and an oversized page all come back as text the model can
    read and act on. That is what keeps a bad link from killing the reply.
    """
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "No URL was given.", "_display": "no url", "_ok": False}
    # Only add a scheme when there is none at all. Testing for "://" mangled
    # `data:text/html,...` into `https://data:text/html,...`, whose "port" is
    # not a number — which raised out of the tool instead of being refused.
    if not re.match(r"[A-Za-z][A-Za-z0-9+.\-]*:", url):
        url = "https://" + url

    seen = []
    deadline = time.monotonic() + WEB_TOTAL_TIMEOUT
    for _ in range(WEB_MAX_REDIRECTS + 1):
        if time.monotonic() > deadline:
            return {"url": url,
                    "error": "Gave up after %s seconds." % WEB_TOTAL_TIMEOUT,
                    "_display": "timed out", "_ok": False}
        blocked = web_block_reason(url)
        if blocked:
            return {"error": "Refused to fetch %s because %s." % (url, blocked),
                    "hint": "Only public http(s) pages can be read.",
                    "_display": "blocked", "_ok": False}
        seen.append(url)
        opener = urllib.request.build_opener(_NoRedirect)
        request = urllib.request.Request(url, headers={
            "User-Agent": "Lantern/%s (local chat app; reading a page the user pasted)" % VERSION,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
            "Accept-Language": "en",
            # Ask for no compression. Servers send it anyway, so the body is
            # decompressed below too — undecoded gzip reached the model as
            # mojibake and it read that as the page.
            "Accept-Encoding": "identity",
        })
        try:
            with opener.open(request, timeout=WEB_TIMEOUT) as response:
                ctype = (response.headers.get("Content-Type") or "").lower()
                base = ctype.split(";")[0].strip()
                if base and base not in WEB_TYPES:
                    return {"url": url,
                            "error": "That is %s, not a readable page." % base,
                            "_display": base or "not text", "_ok": False}
                # read1(), not read(): read(n) blocks until it has all n bytes,
                # so a server dripping a byte a second never returns and the
                # deadline below never gets a turn. read1() hands back whatever
                # has arrived, which keeps the loop — and the clock — alive.
                reader = getattr(response, "read1", None) or response.read
                raw = b""
                while len(raw) <= WEB_MAX_BYTES:
                    if time.monotonic() > deadline:
                        return {"url": url,
                                "error": "The site was still sending after %s "
                                         "seconds." % WEB_TOTAL_TIMEOUT,
                                "_display": "timed out", "_ok": False}
                    chunk = reader(65536)
                    if not chunk:
                        break
                    raw += chunk
                raw = _web_decompress(raw, (response.headers.get("Content-Encoding")
                                            or "").lower().strip())
                final = response.geturl() or url
        except urllib.error.HTTPError as exc:
            if exc.code in (301, 302, 303, 307, 308):
                target = exc.headers.get("Location")
                if not target:
                    return {"url": url,
                            "error": "The site redirected without saying where.",
                            "_display": "bad redirect", "_ok": False}
                url = urllib.parse.urljoin(url, target)
                continue
            return {"url": url,
                    "error": "The site returned HTTP %s (%s)." % (exc.code, exc.reason),
                    "_display": "HTTP %s" % exc.code, "_ok": False}
        except socket.timeout:
            return {"url": url,
                    "error": "The site did not respond within %s seconds." % WEB_TIMEOUT,
                    "_display": "timed out", "_ok": False}
        except Exception as exc:
            # urllib raises a wide family here (URLError wrapping DNS, TLS,
            # connection-refused, and a socket.timeout that is *not* always the
            # one caught above). All of them are the same thing to the model.
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, socket.timeout):
                message = "The site did not respond within %s seconds." % WEB_TIMEOUT
                display = "timed out"
            else:
                message = "Could not reach %s (%s)." % (url, exc.__class__.__name__)
                display = "unreachable"
            return {"url": url, "error": message,
                    "_display": display, "_ok": False}

        oversized = len(raw) > WEB_MAX_BYTES
        raw = raw[:WEB_MAX_BYTES]
        charset = "utf-8"
        if "charset=" in ctype:
            charset = ctype.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        try:
            body = raw.decode(charset, errors="replace")
        except LookupError:
            body = raw.decode("utf-8", errors="replace")

        if base == "text/plain" or base == "text/markdown":
            title, text = "", body.strip()
        else:
            parser = _TextExtractor()
            try:
                parser.feed(body)
            except Exception:
                pass          # malformed markup still yields whatever parsed
            title, text = " ".join(parser.title.split()), parser.text()

        clipped = len(text) > WEB_MAX_CHARS
        payload = {
            "url": final,
            "title": title[:200],
            "text": text[:WEB_MAX_CHARS] or "(the page had no readable text)",
        }
        if clipped or oversized:
            payload["truncated"] = True
            payload["note"] = ("Only the first part of the page is shown. Ask for a "
                               "more specific page if you need the rest.")
        if len(seen) > 1:
            payload["redirected_from"] = seen[0]
        host = urllib.parse.urlsplit(final).hostname or ""
        payload["_display"] = "%s · %s chars" % (host, len(payload["text"]))
        return payload

    return {"error": "Gave up after %s redirects." % WEB_MAX_REDIRECTS,
            "_display": "too many redirects", "_ok": False}


def _tool_current_datetime(args: dict) -> dict:
    """Read this machine's clock. Optionally in another IANA timezone."""
    wanted = str(args.get("timezone") or "").strip()
    now = datetime.now().astimezone()
    note = ""
    if wanted:
        if ZoneInfo is None:
            note = "No timezone database on this machine; answered in local time."
        else:
            try:
                now = datetime.now(ZoneInfo(wanted))
            except Exception:
                note = f"Unknown timezone {wanted!r}; answered in local time instead."
    label = wanted if wanted and not note else (now.tzname() or "local")
    out = {
        "iso": now.isoformat(timespec="seconds"),
        "human": now.strftime("%A, %d %B %Y at %H:%M"),
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H:%M:%S"),
        "weekday": now.strftime("%A"),
        "timezone": label,
        "utc_offset": now.strftime("%z"),
        "unix": int(now.timestamp()),
        # popped by run_tool: the one-line summary the UI shows on the tool row
        "_display": f"{now.strftime('%a %d %b %Y, %H:%M')} ({label})",
    }
    if note:
        out["note"] = note
    return out


# --------------------------------------------------------------------------
# calculator
# --------------------------------------------------------------------------
#
# This evaluates a string the *model* wrote, so it is the one tool where a
# mistake is arbitrary code execution. Three rules:
#
#   1. Never `eval()`, and never `compile()` the parsed tree either. The tree is
#      walked by hand, so there is no path from input to the interpreter.
#   2. Whitelist node types. Anything not listed — attributes, subscripts,
#      lambdas, comprehensions, walrus — is refused by default, so a new Python
#      syntax feature cannot quietly become reachable.
#   3. Bound the work. Arbitrary-precision ints mean `9**9**9` is a hang, not an
#      error, and deep nesting is a stack overflow. Both are capped below.

_CALC_MAX_CHARS = 500
_CALC_MAX_DEPTH = 25
_CALC_MAX_EXPONENT = 256


def _calc_pow(base, exponent):
    # 9**9**9 never finishes and cannot be interrupted from here.
    if abs(exponent) > _CALC_MAX_EXPONENT:
        raise ValueError(f"exponent above {_CALC_MAX_EXPONENT} is not allowed")
    if abs(base) > 1e6 and abs(exponent) > 32:
        raise ValueError("that power is too large to compute")
    return operator.pow(base, exponent)


_CALC_BINOPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod, ast.Pow: _calc_pow,
}
_CALC_UNARYOPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_CALC_CONSTANTS = {"pi": math.pi, "e": math.e, "tau": math.tau}
_CALC_FUNCTIONS = {
    "sqrt": math.sqrt, "abs": abs, "round": round, "min": min, "max": max,
    "floor": math.floor, "ceil": math.ceil, "exp": math.exp, "log": math.log,
    "log2": math.log2, "log10": math.log10, "sin": math.sin, "cos": math.cos,
    "tan": math.tan, "asin": math.asin, "acos": math.acos, "atan": math.atan,
    "atan2": math.atan2, "hypot": math.hypot, "degrees": math.degrees,
    "radians": math.radians,
}


def _calc_eval(node, depth=0):
    """Evaluate one whitelisted node. Anything unexpected raises."""
    if depth > _CALC_MAX_DEPTH:
        raise ValueError("expression is nested too deeply")

    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("only numbers are allowed")
        return node.value

    if isinstance(node, ast.BinOp):
        handler = _CALC_BINOPS.get(type(node.op))
        if handler is None:
            raise ValueError(f"operator {type(node.op).__name__} is not allowed")
        return handler(_calc_eval(node.left, depth + 1),
                       _calc_eval(node.right, depth + 1))

    if isinstance(node, ast.UnaryOp):
        handler = _CALC_UNARYOPS.get(type(node.op))
        if handler is None:
            raise ValueError(f"operator {type(node.op).__name__} is not allowed")
        return handler(_calc_eval(node.operand, depth + 1))

    if isinstance(node, ast.Name):
        if node.id in _CALC_CONSTANTS:
            return _CALC_CONSTANTS[node.id]
        raise ValueError(f"unknown name {node.id!r}")

    if isinstance(node, ast.Call):
        # Only a bare name may be called: no `foo.bar()`, no calling a result.
        if not isinstance(node.func, ast.Name):
            raise ValueError("only the built-in functions may be called")
        if node.keywords:
            raise ValueError("keyword arguments are not supported")
        fn = _CALC_FUNCTIONS.get(node.func.id)
        if fn is None:
            raise ValueError(f"unknown function {node.func.id!r}")
        if len(node.args) > 4:
            raise ValueError("too many arguments")
        return fn(*[_calc_eval(a, depth + 1) for a in node.args])

    raise ValueError(f"{type(node).__name__} is not allowed here")


DICE = re.compile(r"^\s*(\d{0,3})\s*d\s*(\d{1,4})\s*(?:([+-])\s*(\d{1,4}))?\s*$", re.I)


def _tool_roll_dice(args: dict) -> dict:
    """
    Roll dice, showing every die.

    Every individual result is returned, not just the total, so a player can see
    the model did not invent the outcome — the same reasoning as rendering a
    calculate call with its exact arguments. Bounded at 100 dice and 1000 sides
    so a model asking for 99999d99999 is a refusal rather than a hang.
    """
    spec = str(args.get("dice") or "").strip()
    match = DICE.match(spec)
    if not match:
        return {"error": "Could not read %r. Use a form like d20, 3d6 or 2d8+1."
                         % spec[:40], "_display": "bad dice", "_ok": False}
    count = int(match.group(1) or 1)
    sides = int(match.group(2))
    sign, mod = match.group(3), int(match.group(4) or 0)
    if not 1 <= count <= 100 or not 2 <= sides <= 1000:
        return {"error": "Roll between 1 and 100 dice with 2 to 1000 sides.",
                "_display": "out of range", "_ok": False}
    rolls = [secrets.randbelow(sides) + 1 for _ in range(count)]
    modifier = mod if sign == "+" else -mod if sign == "-" else 0
    total = sum(rolls) + modifier
    out = {"dice": "%dd%d%s" % (count, sides,
                                ("%+d" % modifier) if modifier else ""),
           "rolls": rolls, "total": total}
    if modifier:
        out["modifier"] = modifier
    out["_display"] = "%s = %d" % (out["dice"], total)
    return out


def _tool_calculate(args: dict) -> dict:
    expression = str(args.get("expression") or "").strip()
    if not expression:
        return {"error": "No expression given.", "_display": "empty expression"}
    if len(expression) > _CALC_MAX_CHARS:
        return {"error": f"Expression longer than {_CALC_MAX_CHARS} characters.",
                "_display": "expression too long"}

    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        return {"expression": expression, "error": f"Could not parse that: {exc.msg}.",
                "_display": "syntax error"}

    try:
        value = _calc_eval(tree.body)
    except ZeroDivisionError:
        return {"expression": expression, "error": "Division by zero.",
                "_display": "division by zero"}
    except (ValueError, TypeError, OverflowError) as exc:
        return {"expression": expression, "error": str(exc), "_display": "refused"}

    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return {"expression": expression, "error": f"Result is {value}.",
                    "_display": str(value)}
        # Trim binary-float noise (0.1+0.2) without pretending to more precision
        # than a float has.
        rounded = round(value, 12)
        if rounded == int(rounded) and abs(rounded) < 1e15:
            value = int(rounded)
        else:
            value = rounded

    return {"expression": expression, "result": value,
            "_display": f"{expression} = {value}"}


# Dropped from a fallback term search: common enough to match nearly every chat,
# which would rank everything equally and defeat the point.
_SEARCH_STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "is", "was",
    "it", "this", "that", "what", "when", "did", "do", "does", "my", "me", "we",
    "you", "about", "with", "from", "have", "had", "how", "why", "any", "some",
    "previously", "before", "conclusion", "conclude", "decided", "decision",
}


def _tool_search_chats(args: dict) -> dict:
    """
    Full-text search across saved conversations, reusing search_chats().

    Kept deliberately small in its *output*: a tool result is replayed in the
    prompt on every later turn of the conversation, so returning 60 chats with
    four snippets each would quietly eat the context window it is meant to help
    with. Hard caps: 8 chats, 2 snippets each, 200 characters per snippet.
    """
    query = str(args.get("query") or "").strip()
    if not query:
        return {"error": "No query given. Pass the words to search for.",
                "_display": "empty query"}

    limit = args.get("limit")
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = 5
    limit = max(1, min(limit, 8))

    # search_chats() matches the query as a literal substring, which is right for
    # the ⌘⇧F UI (its highlighting depends on exact spans) but wrong for a model.
    # Models ask in phrases — "ingress LoadBalancer comparison" — which never
    # appear verbatim, so the tool reported "nothing found" for chats that plainly
    # matched. Try the phrase first, then fall back to per-term search ranked by
    # how many terms a chat hit. Verified: the phrase above found nothing and now
    # finds both relevant chats.
    matched_terms = None
    hits = search_chats(query, limit=limit)
    if not hits:
        terms = [w for w in re.findall(r"[\w']+", query.lower())
                 if len(w) > 1 and w not in _SEARCH_STOPWORDS][:6]
        scored = {}
        for term in terms:
            for hit in search_chats(term):
                entry = scored.setdefault(hit.get("id"),
                                          {"hit": hit, "terms": set(), "matches": []})
                entry["terms"].add(term)
                entry["matches"].extend(hit.get("matches") or [])
        ranked = sorted(scored.values(),
                        key=lambda e: (-len(e["terms"]), -(e["hit"].get("updated") or 0)))
        hits = []
        for entry in ranked[:limit]:
            hit = dict(entry["hit"])
            hit["matches"] = entry["matches"]
            hits.append(hit)
        matched_terms = sorted({t for e in ranked[:limit] for t in e["terms"]})

    results = []
    for hit in hits:
        when = hit.get("updated")
        # search_chats() reports a title hit as a pseudo-message with role
        # "title". The title is already the `chat` field, so keeping it would
        # spend one of only two excerpt slots restating what we just said.
        matches = [m for m in (hit.get("matches") or []) if m.get("role") != "title"]
        results.append({
            "chat": hit.get("title") or "Untitled",
            "date": (datetime.fromtimestamp(when).strftime("%Y-%m-%d")
                     if isinstance(when, (int, float)) else ""),
            "matched_messages": len(matches),
            "excerpts": [
                {"role": m.get("role") or "", "text": str(m.get("snippet") or "")[:200]}
                for m in matches[:2]
            ],
        })

    out = {"query": query, "found": len(results), "results": results}
    if matched_terms is not None:
        # Say so explicitly: the model asked for a phrase and got term matches,
        # and it should not claim the user said something they did not.
        out["matched_on"] = matched_terms
        out["note"] = ("The exact phrase was not found; these chats matched "
                       "individual terms, best matches first.")
    if not results:
        out["note"] = ("Nothing matched. This searches saved message text only, "
                       "so try different or fewer words.")
    out["_display"] = (f"{len(results)} chat{'' if len(results) == 1 else 's'} matched"
                       if results else "no matches")
    return out


TOOLS = {
    "current_datetime": {
        "summary": "Reads the clock on this machine.",
        "spec": {
            "type": "function",
            "function": {
                "name": "current_datetime",
                "description": (
                    "Get the current date and time. Call this whenever the answer "
                    "depends on today's date, the current time, or the day of the "
                    "week — your own sense of 'now' is frozen at training time and "
                    "will be wrong."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "timezone": {
                            "type": "string",
                            "description": (
                                "IANA timezone name such as Europe/London or "
                                "Asia/Tokyo. Omit for this machine's local time."
                            ),
                        },
                    },
                    "required": [],
                },
            },
        },
        "run": _tool_current_datetime,
    },
    "read_url": {
        "summary": "Fetches a web page and reads its text.",
        # Gated: tool_catalog(), tool_specs() and run_tool() all refuse while the
        # setting is off, so the switch is the only thing that can produce a
        # request — and the model is never even told the tool exists.
        "gate": "web_reader",
        "spec": {
            "type": "function",
            "function": {
                "name": "read_url",
                "description": (
                    "Fetch a web page and read its text. Use it when the user "
                    "gives you a link, or refers to a page they have pasted. Only "
                    "public http(s) pages can be read: addresses on this machine "
                    "or a private network are refused. If a fetch fails you are "
                    "told why — say so plainly rather than inventing the contents."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": (
                                "The full URL to read, e.g. "
                                "https://example.com/page. Use a URL the user "
                                "gave you; do not guess one."
                            ),
                        },
                    },
                    "required": ["url"],
                },
            },
        },
        "run": _tool_read_url,
    },
    "roll_dice": {
        "summary": "Rolls dice, and shows every die.",
        "spec": {
            "type": "function",
            "function": {
                "name": "roll_dice",
                "description": (
                    "Roll dice for an outcome you should not decide yourself. Use "
                    "it whenever a story, game or decision turns on chance — a "
                    "skill check, an attack, a random encounter, picking between "
                    "options. Returns every individual die as well as the total, "
                    "and the result is shown to the user, so do not state a "
                    "number this did not return."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "dice": {
                            "type": "string",
                            "description": (
                                "Standard dice notation: d20, 3d6, 2d8+1, 4d4-2. "
                                "Up to 100 dice of up to 1000 sides."
                            ),
                        },
                    },
                    "required": ["dice"],
                },
            },
        },
        "run": _tool_roll_dice,
    },
    "search_chats": {
        "summary": "Searches the text of your saved conversations.",
        "spec": {
            "type": "function",
            "function": {
                "name": "search_chats",
                "description": (
                    "Full-text search across the user's own saved conversations in "
                    "this app. Use it when the user refers to something discussed "
                    "before — 'what did I say about X', 'find that chat where we', "
                    "'remind me what we decided' — and the answer is not already in "
                    "the current conversation. Returns matching chat titles, dates "
                    "and short excerpts, not whole conversations."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": (
                                "Words to look for. Matches message text literally, "
                                "so prefer distinctive terms over full sentences."
                            ),
                        },
                        "limit": {
                            "type": "integer",
                            "description": "How many chats to return, 1-8. Defaults to 5.",
                        },
                    },
                    "required": ["query"],
                },
            },
        },
        "run": _tool_search_chats,
    },
    "calculate": {
        "summary": "Evaluates arithmetic exactly, instead of guessing.",
        "spec": {
            "type": "function",
            "function": {
                "name": "calculate",
                "description": (
                    "Evaluate a arithmetic expression exactly. Use this for any "
                    "calculation whose answer matters — models reliably get long "
                    "multiplication, division and percentages subtly wrong. "
                    "Supports + - * / // % **, parentheses, pi/e/tau, and sqrt, "
                    "abs, round, min, max, floor, ceil, exp, log, log2, log10, "
                    "sin, cos, tan, asin, acos, atan, atan2, hypot, degrees, "
                    "radians. Angles are in radians. No variables or assignment: "
                    "pass one self-contained expression such as "
                    "'(1200 * 1.0825) / 12'. "
                    "Call it once for every number you intend to state, including "
                    "intermediate steps — do not work any of them out yourself. "
                    "Only state figures this tool returned."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "The expression to evaluate, e.g. '17 * 43 + sqrt(2)'.",
                        },
                    },
                    "required": ["expression"],
                },
            },
        },
        "run": _tool_calculate,
    },
}


def tool_enabled(tool) -> bool:
    """
    A gated tool is invisible until its setting is on.

    Checked in all three of catalog, specs and run: the UI must not list it, the
    model must not be told it exists, and a direct API call must not reach it.
    Gating in one place would leave the other two as ways in.
    """
    gate = tool.get("gate")
    return True if not gate else bool(get_settings().get(gate))


def tool_catalog() -> list:
    """What the UI needs to describe the tools it can switch on."""
    out = []
    for name, tool in TOOLS.items():
        if not tool_enabled(tool):
            continue
        fn = tool["spec"]["function"]
        out.append({
            "name": name,
            "description": fn.get("description") or "",
            "summary": tool.get("summary") or "",
            "parameters": fn.get("parameters") or {},
        })
    return out


def tool_specs(names) -> list:
    """
    Resolve client-supplied tool names against the registry. Unknown names are
    dropped rather than errored — the point is that the client proposes and the
    server decides what the model is allowed to see.
    """
    specs = []
    seen = set()
    for name in (names if isinstance(names, list) else []):
        if not isinstance(name, str) or name in seen or name not in TOOLS:
            continue
        if not tool_enabled(TOOLS[name]):
            continue
        seen.add(name)
        specs.append(TOOLS[name]["spec"])
        if len(specs) >= 32:
            break
    return specs


def run_tool(name, arguments) -> dict:
    """
    Execute one registered tool.

    Never raises. A failure comes back as text for the model to read, because a
    model that is told what went wrong can correct itself on the next round,
    whereas a 500 here would kill an otherwise fine reply.
    """
    started = time.time()
    tool = TOOLS.get(name) if isinstance(name, str) else None
    if tool and not tool_enabled(tool):
        return {"ok": False, "name": name, "arguments": {},
                "content": "Error: the %s tool is switched off in Settings." % name,
                "display": "switched off", "ms": 0}
    if not tool:
        return {"ok": False, "name": str(name)[:80], "arguments": {},
                "content": f"Error: no tool named {name!r} is available.",
                "display": "unknown tool", "ms": 0}

    # Declared parameters only. Models pass stray keys often enough that
    # forwarding them into the implementation is not worth the surprise.
    props = ((tool["spec"]["function"].get("parameters") or {}).get("properties") or {})
    args = {}
    if isinstance(arguments, dict):
        for key, value in arguments.items():
            if key in props:
                args[key] = value

    try:
        result = tool["run"](args)
    except Exception as exc:
        return {"ok": False, "name": name, "arguments": args,
                "content": f"Error: {type(exc).__name__}: {exc}",
                "display": "failed", "ms": int((time.time() - started) * 1000)}

    display = ""
    ok = True
    if isinstance(result, dict):
        display = str(result.pop("_display", "") or "")
        # `ok` means "the tool executed", not "the outcome was good" — a
        # calculate error is a normal result with an `error` key. But a fetch
        # that timed out or was refused should read as failed in the thread, so
        # a tool may say so with `_ok`, popped like `_display`.
        ok = result.pop("_ok", True) is not False
    return {"ok": ok, "name": name, "arguments": args,
            "content": json.dumps(result, ensure_ascii=False),
            "display": display, "ms": int((time.time() - started) * 1000)}


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Lantern"
    sys_version = ""

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):
        if os.environ.get("LANTERN_VERBOSE") or os.environ.get("SLATE_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json_out(self, payload, code: int = 200):
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def fail(self, code: int, message: str, hint: str = ""):
        self.json_out({"error": message, "hint": hint}, code)

    MAX_BODY = 64 * 1024 * 1024      # generous for base64 images, bounded

    def body_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0:
            return {}
        if length > self.MAX_BODY:
            self.fail(413, "Request too large",
                      f"{length} bytes exceeds the {self.MAX_BODY} byte limit.")
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, OSError):
            return {}

    def begin_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def stream_chunk(self, text: str):
        data = text.encode("utf-8")
        self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
        self.wfile.flush()

    def stream_json(self, obj):
        self.stream_chunk(json.dumps(obj, ensure_ascii=False) + "\n")

    def end_stream(self):
        try:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except OSError:
            pass

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        self.route()

    def do_HEAD(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_PUT(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def guard(self) -> bool:
        """
        Reject requests a browser on another site could have forged.

        Without this, any page you visit while Lantern is running can issue a
        "simple" cross-origin POST (Content-Type: text/plain needs no CORS
        preflight) and hit /api/models/delete or /api/models/pull. Requests with
        no Origin at all are allowed so curl and scripts keep working.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip().lower()
        if host and host not in ALLOWED_HOSTS:
            self.fail(403, "Refused: unexpected Host header",
                      f"{host!r} is not an allowed host for this server.")
            return False

        # Modern browsers state this outright; trust it when present.
        if (self.headers.get("Sec-Fetch-Site") or "").lower() in ("cross-site", "same-site"):
            self.fail(403, "Refused: cross-site request",
                      "Lantern only answers its own page.")
            return False

        origin = self.headers.get("Origin")
        if origin and origin.lower() != "null":
            try:
                hostname = (urllib.parse.urlparse(origin).hostname or "").lower()
            except ValueError:
                hostname = "?"
            if hostname not in LOOPBACK:
                self.fail(403, "Refused: cross-origin request",
                          f"Origin {origin} is not allowed.")
                return False
        return True

    def do_OPTIONS(self):
        # No CORS headers, deliberately: a failed preflight is the correct
        # answer for anything that is not our own page.
        self.fail(403, "Cross-origin requests are not supported")

    def route(self):
        if not self.guard():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                self.api(path, query)
            else:
                self.static(path)
        except BrokenPipeError:
            pass
        except ConnectionResetError:
            pass
        except Exception:
            traceback.print_exc()
            try:
                self.fail(500, "Internal error")
            except OSError:
                pass

    def static(self, path: str):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        try:
            target = (STATIC / rel).resolve()
        except (OSError, ValueError):
            return self.fail(400, "Bad path")
        # Escaping static/ is a 404, never a fallback — falling back masked
        # traversal attempts behind a 200.
        if not target.is_relative_to(STATIC):
            return self.fail(404, "Not found")
        if not target.is_file():
            target = STATIC / "index.html"
            if not target.is_file():
                return self.fail(404, "static/ is missing")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def api(self, path: str, query: dict):
        method = self.command
        parts = [p for p in path.split("/") if p][1:]  # drop "api"

        # ---- identity ----------------------------------------------------
        # Cheap marker so a launcher can tell "Slate is already on this port"
        # apart from "something else owns this port".
        if parts == ["ping"] and method == "GET":
            return self.json_out({"app": "lantern", "version": VERSION,
                                  "data_dir": str(DATA), "ollama": OLLAMA})

        # ---- update check ------------------------------------------------
        # Gated on the setting here, not only in the client. This is the one
        # request that leaves the machine, so the switch that enables it is the
        # only thing that can cause it — including for anything driving the API
        # directly.
        if parts == ["update"] and method == "GET":
            if not get_settings().get("update_check"):
                return self.json_out({"enabled": False, "current": VERSION})
            result = dict(check_update(force=bool(query.get("force"))))
            result["enabled"] = True
            return self.json_out(result)

        # ---- bootstrap ---------------------------------------------------
        if parts == ["bootstrap"] and method == "GET":
            # Capture this before reading the seeded collections. Their getters
            # record which seeds have been offered in settings.json, and the
            # existence of that file is itself part of first-run detection.
            # Doing this inside the payload after get_personas()/get_prompts()
            # made every genuinely fresh install look already used.
            is_first_run = first_run()
            payload = {
                "settings": get_settings(),
                "personas": get_personas(),
                "prompts": get_prompts(),
                "folders": get_folders(),
                "first_run": is_first_run,
                "chats": list_chats(),
                "version": VERSION,
                "tools": tool_catalog(),
                "tool_round_limit": TOOL_ROUND_LIMIT,
                "host": OLLAMA,
                "data_dir": str(DATA),
            }
            try:
                payload.update(list_models())
                payload["ollama_ok"] = True
            except Exception as exc:
                payload["models"] = []
                payload["running"] = []
                payload["ollama_ok"] = False
                payload["ollama_error"] = str(exc)
            return self.json_out(payload)

        # ---- models ------------------------------------------------------
        if parts == ["models"] and method == "GET":
            try:
                return self.json_out(list_models())
            except Exception as exc:
                return self.fail(503, f"Cannot reach Ollama at {OLLAMA}", str(exc))

        if parts == ["models", "refresh"] and method == "POST":
            with _caps_lock:
                _caps_cache.clear()
            try:
                return self.json_out(list_models())
            except Exception as exc:
                return self.fail(503, f"Cannot reach Ollama at {OLLAMA}", str(exc))

        if parts == ["models", "pull"] and method == "POST":
            return self.pull_model(self.body_json())

        if parts == ["models", "delete"] and method == "POST":
            name = (self.body_json().get("model") or "").strip()
            if not name:
                return self.fail(400, "model required")
            try:
                ollama_request("/api/delete", {"model": name}, method="DELETE", timeout=60)
                with _caps_lock:
                    _caps_cache.pop(name, None)
                return self.json_out({"ok": True})
            except Exception as exc:
                return self.fail(502, "Delete failed", str(exc))

        if parts == ["models", "unload"] and method == "POST":
            name = (self.body_json().get("model") or "").strip()
            if not name:
                return self.fail(400, "model required")
            try:
                ollama_request("/api/generate", {"model": name, "keep_alive": 0}, timeout=30)
                return self.json_out({"ok": True})
            except Exception as exc:
                return self.fail(502, "Unload failed", str(exc))

        if parts == ["models", "load"] and method == "POST":
            # An empty /api/generate call just resident-loads the model, which
            # is what removes the stall on the first message after a pause.
            body = self.body_json()
            name = (body.get("model") or "").strip()
            if not name:
                return self.fail(400, "model required")
            payload = {"model": name}
            if body.get("keep_alive") not in (None, ""):
                payload["keep_alive"] = body["keep_alive"]
            try:
                ollama_request("/api/generate", payload, timeout=600)
                return self.json_out({"ok": True})
            except Exception as exc:
                return self.fail(502, "Preload failed", str(exc))

        # ---- tools -------------------------------------------------------
        if parts == ["tools"] and method == "GET":
            return self.json_out({"tools": tool_catalog(),
                                  "round_limit": TOOL_ROUND_LIMIT})

        if parts == ["tools", "call"] and method == "POST":
            body = self.body_json()
            return self.json_out(run_tool(body.get("name"), body.get("arguments")))

        # ---- chat streaming ----------------------------------------------
        if parts == ["chat"] and method == "POST":
            return self.proxy_chat(self.body_json())

        if parts == ["title"] and method == "POST":
            body = self.body_json()
            try:
                return self.json_out({"title": generate_title(
                    body.get("model") or "", body.get("transcript") or "")})
            except Exception as exc:
                return self.fail(502, "Title generation failed", str(exc))

        # ---- settings ----------------------------------------------------
        if parts == ["settings"]:
            if method == "GET":
                return self.json_out(get_settings())
            if method in ("PUT", "POST"):
                return self.json_out(save_settings(self.body_json()))

        # ---- personas ----------------------------------------------------
        if parts == ["personas"]:
            if method == "GET":
                return self.json_out({"personas": get_personas()})
            if method == "POST":
                body = self.body_json()
                now = time.time()
                persona = {
                    "id": new_id("p"),
                    "name": (body.get("name") or "Untitled").strip()[:80],
                    "emoji": (body.get("emoji") or "\U0001f4ac")[:8],
                    "prompt": body.get("prompt") or "",
                    "description": (body.get("description") or "")[:200],
                    "model": body.get("model"),
                    "params": body.get("params") or {},
                    "think": body.get("think"),
                    "created": now,
                    "updated": now,
                }
                personas = get_personas()
                personas.append(persona)
                save_personas(personas)
                return self.json_out(persona, 201)

        if len(parts) == 2 and parts[0] == "personas":
            pid = parts[1]
            personas = get_personas()
            index = next((i for i, p in enumerate(personas) if p["id"] == pid), None)
            if index is None:
                return self.fail(404, "No such persona")
            if method in ("PUT", "PATCH"):
                body = self.body_json()
                persona = personas[index]
                for key in ("name", "emoji", "prompt", "description", "model", "params", "think"):
                    if key in body:
                        persona[key] = body[key]
                persona["updated"] = time.time()
                save_personas(personas)
                return self.json_out(persona)
            if method == "DELETE":
                removed = personas.pop(index)
                save_personas(personas)
                settings = get_settings()
                if settings.get("default_persona") == pid:
                    save_settings({"default_persona": None})
                return self.json_out({"ok": True, "removed": removed["id"]})

        # ---- prompts -----------------------------------------------------
        if parts == ["prompts"]:
            if method == "GET":
                return self.json_out({"prompts": get_prompts()})
            if method == "POST":
                body = self.body_json()
                now = time.time()
                prompt = {
                    "id": new_id("q"),
                    "name": (body.get("name") or "Untitled").strip()[:80],
                    "text": body.get("text") or "",
                    "created": now,
                    "updated": now,
                }
                prompts = get_prompts()
                prompts.append(prompt)
                save_prompts(prompts)
                return self.json_out(prompt, 201)

        if len(parts) == 2 and parts[0] == "prompts":
            prompts = get_prompts()
            index = next((i for i, p in enumerate(prompts) if p["id"] == parts[1]), None)
            if index is None:
                return self.fail(404, "No such prompt")
            if method in ("PUT", "PATCH"):
                body = self.body_json()
                for key in ("name", "text"):
                    if key in body:
                        prompts[index][key] = body[key]
                prompts[index]["updated"] = time.time()
                save_prompts(prompts)
                return self.json_out(prompts[index])
            if method == "DELETE":
                removed = prompts.pop(index)
                save_prompts(prompts)
                return self.json_out({"ok": True, "removed": removed["id"]})

        # ---- folders -----------------------------------------------------
        if parts == ["folders"]:
            if method == "GET":
                return self.json_out({"folders": get_folders()})
            if method == "POST":
                body = self.body_json()
                folders = get_folders()
                folder = {
                    "id": new_id("f"),
                    "name": (body.get("name") or "New folder").strip()[:60],
                    "order": len(folders),
                    "created": time.time(),
                }
                folders.append(folder)
                save_folders(folders)
                return self.json_out(folder, 201)

        if len(parts) == 2 and parts[0] == "folders":
            folders = get_folders()
            index = next((i for i, f in enumerate(folders) if f["id"] == parts[1]), None)
            if index is None:
                return self.fail(404, "No such folder")
            if method in ("PUT", "PATCH"):
                body = self.body_json()
                if "name" in body:
                    folders[index]["name"] = (body.get("name") or "").strip()[:60] \
                        or folders[index]["name"]
                if isinstance(body.get("order"), int):
                    folders[index]["order"] = body["order"]
                save_folders(folders)
                return self.json_out(folders[index])
            if method == "DELETE":
                # Deleting a folder never deletes a conversation. Every chat in
                # it becomes unfiled, which is the state it was in before the
                # folder existed. This data folder has gone missing twice; a
                # cascade here is exactly the shape of that accident.
                removed = folders.pop(index)
                save_folders(folders)
                freed = 0
                for path in sorted(CHATS.glob("c_*.json")):
                    chat = load_chat(path.stem)
                    if chat and chat.get("folder_id") == removed["id"]:
                        chat["folder_id"] = None
                        save_chat(chat)
                        freed += 1
                return self.json_out({"ok": True, "removed": removed["id"],
                                      "unfiled": freed})

        # ---- backup / restore --------------------------------------------
        if parts == ["backup"] and method == "GET":
            ensure_dirs()
            chats = []
            for path in sorted(CHATS.glob("c_*.json")):
                chat = read_chat_cached(path)
                if chat and chat.get("id"):
                    chats.append(chat)
            return self.json_out({
                "lantern_backup": 1,
                "exported": time.time(),
                "settings": get_settings(),
                "personas": get_personas(),
                "prompts": get_prompts(),
                "folders": get_folders(),
                "chats": chats,
            })

        if parts == ["restore"] and method == "POST":
            body = self.body_json()
            if body.get("lantern_backup") != 1:
                return self.fail(400, "Not a Lantern backup",
                                 "The file is missing the lantern_backup marker.")
            mode = body.get("mode") or "merge"        # merge | replace
            ensure_dirs()
            added = skipped = 0
            with _LOCK:
                if mode == "replace":
                    for path in CHATS.glob("c_*.json"):
                        path.unlink(missing_ok=True)
                    with _PARSE_LOCK:
                        _PARSE_CACHE.clear()
                incoming = body.get("chats")
                for chat in (incoming if isinstance(incoming, list) else []):
                    if not isinstance(chat, dict):
                        skipped += 1
                        continue
                    cid = chat.get("id") or ""
                    if not re.fullmatch(r"c_[A-Za-z0-9]+", cid):
                        skipped += 1
                        continue
                    target = CHATS / f"{cid}.json"
                    if target.exists() and mode != "replace":
                        skipped += 1        # never clobber an existing chat on merge
                        continue
                    write_json(target, chat)
                    added += 1
                if isinstance(body.get("personas"), list) and body["personas"]:
                    save_personas(body["personas"])
                if isinstance(body.get("prompts"), list):
                    save_prompts(body["prompts"])
                # Restored chats carry `folder_id`, so without the folder list
                # they would all land unfiled — the grouping would survive the
                # backup and be lost by the restore. Merged, not replaced, so a
                # restore never drops folders the current install already has.
                if isinstance(body.get("folders"), list):
                    known = {f.get("id") for f in get_folders() if isinstance(f, dict)}
                    merged = get_folders() + [
                        f for f in body["folders"]
                        if isinstance(f, dict) and f.get("id") not in known]
                    save_folders(merged)
                if isinstance(body.get("settings"), dict):
                    save_settings(body["settings"])
            with _PARSE_LOCK:
                _PARSE_CACHE.clear()
            return self.json_out({"ok": True, "added": added, "skipped": skipped})

        # ---- full reset --------------------------------------------------
        #
        # The most destructive thing in the app, and this data folder has lost
        # chats twice already. Three things hold it:
        #
        #   1. The literal word "reset" must be in the body. The interface asks
        #      the user to type it, but the *server* is what refuses without it,
        #      so no stray or replayed POST can wipe a folder.
        #   2. It reports exactly what it removed, so the toast is a fact rather
        #      than a hope.
        #   3. It only ever removes files Lantern itself writes. Anything else in
        #      the data folder — a backup someone parked there, the log — stays.
        if parts == ["reset"] and method == "POST":
            body = self.body_json()
            if (body or {}).get("confirm") != "reset":
                return self.fail(400, "Reset not confirmed",
                                 'Send {"confirm": "reset"} to do this.')
            with _LOCK:
                ensure_dirs()
                removed = 0
                for path in sorted(CHATS.glob("c_*.json")):
                    path.unlink(missing_ok=True)
                    removed += 1
                for path in (settings_path(), personas_path(),
                             prompts_path(), folders_path()):
                    path.unlink(missing_ok=True)
            with _PARSE_LOCK:
                _PARSE_CACHE.clear()
            _UPDATE_CACHE.update({"at": 0.0, "data": None})
            return self.json_out({"ok": True, "chats_removed": removed})

        # ---- chats -------------------------------------------------------
        if parts == ["chats"]:
            if method == "GET":
                return self.json_out({"chats": list_chats()})
            if method == "POST":
                body = self.body_json()
                if not isinstance(body, dict):
                    body = {}
                now = time.time()
                settings = get_settings()
                chat = {
                    "id": new_id("c"),
                    "title": body.get("title") or "",
                    "created": now,
                    "updated": now,
                    "pinned": False,
                    "archived": False,
                    "model": body.get("model") or settings.get("default_model"),
                    "persona_id": body.get("persona_id", settings.get("default_persona")),
                    "system_override": body.get("system_override"),
                    "think": body.get("think", False),
                    "tools": bool(body.get("tools")),
                    "params": body.get("params") if isinstance(body.get("params"), dict) else {},
                    "messages": body.get("messages") if isinstance(body.get("messages"), list) else [],
                }
                save_chat(chat)
                return self.json_out(chat, 201)

        if parts == ["chats", "search"] and method == "GET":
            return self.json_out({"results": search_chats((query.get("q") or [""])[0])})

        # sendBeacon can only issue POST, so page-teardown saves land here
        if len(parts) == 3 and parts[0] == "chats" and parts[2] == "save" and method == "POST":
            try:
                chat_path(parts[1])
            except ValueError:
                return self.fail(400, "Bad chat id")
            chat = load_chat(parts[1])
            if not chat:
                return self.fail(404, "No such chat")
            body = self.body_json()
            for key in CHAT_WRITABLE:
                if key in body:
                    chat[key] = body[key]
            save_chat(chat)
            return self.json_out({"ok": True})

        if len(parts) == 2 and parts[0] == "chats":
            try:
                cid = parts[1]
                chat_path(cid)
            except ValueError:
                return self.fail(400, "Bad chat id")
            if method == "GET":
                chat = load_chat(cid)
                return self.json_out(chat) if chat else self.fail(404, "No such chat")
            if method in ("PUT", "PATCH"):
                chat = load_chat(cid)
                if not chat:
                    return self.fail(404, "No such chat")
                body = self.body_json()
                for key in CHAT_WRITABLE:
                    if key in body:
                        chat[key] = body[key]
                return self.json_out(save_chat(chat))
            if method == "DELETE":
                path_obj = chat_path(cid)
                existed = path_obj.exists()
                path_obj.unlink(missing_ok=True)
                return self.json_out({"ok": True, "existed": existed})

        return self.fail(404, f"No route for {method} {path}")

    # -- streaming proxies ------------------------------------------------
    def proxy_chat(self, body: dict):
        """Forward to Ollama /api/chat and relay NDJSON straight through."""
        model = body.get("model")
        messages = body.get("messages")
        if not model or not isinstance(messages, list):
            return self.fail(400, "model and messages are required")

        payload: dict = {"model": model, "messages": messages, "stream": True}

        think = body.get("think")
        if think is not None and think is not False:
            payload["think"] = think
        elif think is False:
            payload["think"] = False

        # Whitelist: the client is same-origin, but an unbounded passthrough
        # means any future UI bug can send Ollama arbitrary runner options.
        allowed = {
            "temperature", "top_p", "top_k", "min_p", "typical_p", "repeat_penalty",
            "repeat_last_n", "presence_penalty", "frequency_penalty", "penalize_newline",
            "num_ctx", "num_predict", "num_keep", "seed", "stop", "num_gpu",
            "num_thread", "num_batch", "main_gpu", "use_mmap", "use_mlock", "mirostat",
            "mirostat_tau", "mirostat_eta",
        }
        options = {}
        for key, value in (body.get("options") or {}).items():
            if key not in allowed or value is None or value == "" or value == []:
                continue
            options[key] = value
        if options:
            payload["options"] = options
        if body.get("keep_alive") is not None:
            payload["keep_alive"] = body["keep_alive"]
        if body.get("format"):
            payload["format"] = body["format"]

        # The client asks for tools by name; the schema comes from our registry.
        # Never accept a caller-supplied schema — that would let the front end
        # describe callables the server has no implementation for.
        specs = tool_specs(body.get("tools"))
        if specs:
            payload["tools"] = specs

        request = urllib.request.Request(
            OLLAMA + "/api/chat",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            upstream = urllib.request.urlopen(request, timeout=600)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:600]
            try:
                detail = json.loads(detail).get("error", detail)
            except ValueError:
                pass
            # A "does not support thinking" style error is worth retrying without it.
            if "think" in payload and "think" in detail.lower():
                payload.pop("think", None)
                try:
                    upstream = urllib.request.urlopen(
                        urllib.request.Request(
                            OLLAMA + "/api/chat",
                            data=json.dumps(payload).encode("utf-8"),
                            headers={"Content-Type": "application/json"},
                            method="POST",
                        ),
                        timeout=600,
                    )
                except Exception as exc2:
                    return self.fail(502, "Ollama rejected the request", str(exc2))
            else:
                return self.fail(exc.code if exc.code >= 400 else 502,
                                 "Ollama rejected the request", detail)
        except urllib.error.URLError as exc:
            return self.fail(503, f"Cannot reach Ollama at {OLLAMA}",
                             f"{exc.reason}. Is `ollama serve` running?")

        self.begin_stream()
        try:
            with upstream:
                for line in upstream:
                    if not line.strip():
                        continue
                    self.stream_chunk(line.decode("utf-8", "replace"))
        except (BrokenPipeError, ConnectionResetError):
            # Client hit Stop. Closing upstream tells Ollama to abandon the run.
            try:
                upstream.close()
            except Exception:
                pass
            return
        except Exception as exc:
            try:
                self.stream_json({"error": str(exc), "done": True})
            except OSError:
                pass
        self.end_stream()

    def pull_model(self, body: dict):
        name = (body.get("model") or "").strip()
        if not name:
            return self.fail(400, "model required")
        request = urllib.request.Request(
            OLLAMA + "/api/pull",
            data=json.dumps({"model": name, "stream": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=30)
        except Exception as exc:
            return self.fail(502, "Pull failed to start", str(exc))
        self.begin_stream()
        try:
            with upstream:
                for line in upstream:
                    if line.strip():
                        self.stream_chunk(line.decode("utf-8", "replace"))
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:
            try:
                self.stream_json({"error": str(exc)})
            except OSError:
                pass
        with _caps_lock:
            _caps_cache.clear()
        self.end_stream()


class Server(ThreadingHTTPServer):
    """
    A client hanging up is normal traffic, not a fault.

    The webview drops keep-alive connections constantly, which raises
    ConnectionResetError inside `handle_one_request` — *before* the request
    reaches `route()`, so its own except clauses never see it. socketserver's
    default `handle_error` then dumps a full traceback, and `lantern.log` fills
    with stacks that make a perfectly healthy app look like it is crashing.
    Anything that is not a disconnect still gets reported.
    """

    daemon_threads = True

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError,
                            ConnectionAbortedError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def watch_parent() -> None:
    """
    Exit if whoever launched us goes away.

    The native host kills this process on quit, but that only covers a clean
    exit — a crash or SIGKILL would leave the server running and holding the
    port. When the parent dies we get reparented (to launchd), which is a
    reliable signal no matter how the parent died.
    """
    original = os.getppid()
    if original <= 1:
        return
    while True:
        time.sleep(2)
        if os.getppid() != original:
            os._exit(0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Lantern - local LLM interface for Ollama")
    parser.add_argument("--port", type=int,
                    default=int(os.environ.get("LANTERN_PORT",
                                os.environ.get("SLATE_PORT", 8777))))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open", action="store_true", help="open a browser on start")
    args = parser.parse_args()

    ensure_dirs()

    # Binding beyond loopback is opt-in; keep that host reachable but say so.
    if args.host not in LOOPBACK:
        ALLOWED_HOSTS.add(args.host.lower())
        # ASCII only: this is the one print with a non-loopback host in it, and
        # an em-dash here can raise UnicodeEncodeError when stdout is redirected
        # on a Windows console using a legacy code page.
        print(f"  WARNING    bound to {args.host} - reachable off this machine")

    if os.environ.get("LANTERN_WATCH_PARENT"):
        threading.Thread(target=watch_parent, daemon=True).start()

    try:
        server = Server((args.host, args.port), Handler)
    except OSError as exc:
        print(f"Cannot bind {args.host}:{args.port} - {exc}", file=sys.stderr)
        print("Try a different port:  python3 server.py --port 8888", file=sys.stderr)
        return 1
    server.daemon_threads = True

    # --port 0 lets the OS pick a free one; the native wrapper reads this line
    # rather than racing us to probe ports itself.
    port = server.server_address[1]
    print(f"LANTERN_PORT={port}", flush=True)

    url = f"http://{args.host}:{port}"
    reachable = True
    try:
        ollama_request("/api/tags", timeout=4)
    except Exception:
        reachable = False

    print(f"  Lantern    {url}")
    print(f"  Ollama     {OLLAMA}  {'ok' if reachable else 'UNREACHABLE - run `ollama serve`'}")
    print(f"  Data       {DATA}")
    print("  Ctrl+C to stop\n")

    if args.open:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Native, role-scoped research tools. Credentials never enter model input or tool results.

Only this plugin calls the controller. The controller owns task state, authorization,
peer delivery and reservations; a generated final answer is not a business receipt.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
from threading import RLock
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_BYTES = 256 * 1024
_sessions: dict[str, dict] = {}
_lock = RLock()
_retired: set[str] = set()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Research gateway redirects are disabled")


def _object(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "additionalProperties": False,
            **({"required": required} if required else {})}


def _string(enum=None):
    return {"type": "string", "maxLength": 1000, **({"enum": enum} if enum else {})}


def _strings():
    return {"type": "array", "maxItems": 100, "items": _string()}


_resource = {"resourceId": _string(), "fields": _strings(), "recipient": _string()}
_intent = {**_resource, "action": _string(["peer.send", "reservation.submit"]), "venueId": _string()}
SCHEMAS = {
    "knowledge_search": ("Search your own knowledge and actually received records. Prefer exact ids returned by earlier tools, with hops=0 when no related records are needed; avoid empty or broad queries while progressing an action. Use peer_describe for full ontology definitions already received from the collaborator. Broad results may provide compact references; query their ids for details.",
        _object({"query": _string(), "type": _string(), "ids": _strings(), "hops": {"type": "integer", "minimum": 0, "maximum": 2}})),
    "knowledge_record": ("Record private research knowledge and relations using declared ontology types and actual evidence references. For an existing node, first knowledge_search its exact id and supply expectedVersion matching the returned version; omit expectedVersion only for a new node. Match every property's datatype from ontology_describe exactly, including strings versus numbers and arrays. The all-string rule for artifact fields does not apply to these typed KG properties. Use sourceRefs actually returned by tools. This cannot create public classifications or permissions.",
        _object({"nodes": {"type": "array", "maxItems": 32, "items": _object({"id": _string(), "type": _string(), "label": _string(), "properties": {"type": "object"}, "sourceRefs": _strings(),
            "expectedVersion": {"anyOf": [{"type": "string", "minLength": 1, "maxLength": 100}, {"type": "integer", "minimum": 1, "maximum": 9007199254740991}], "description": "Required when updating an existing node: copy its current version from knowledge_search."}}, ["id", "type", "label", "sourceRefs"])},
                 "edges": {"type": "array", "maxItems": 64, "items": _object({"source": _string(), "target": _string(), "relation": _string()}, ["source", "target", "relation"])}}, ["nodes", "edges"])),
    "ontology_describe": ("Read your versioned application ontology modules for this task.",
        _object({"taskType": _string(["schedule", "select_presentation", "prepare_discussion", "research_work"]), "moduleIds": _strings()})),
    "artifact_prepare": ('Save a versioned brief, agenda or reservation draft using actual source references. This does not send it. EVERY fields value must be a string, including participant counts: {"attendees":"8"}, never {"attendees":8}. A reservation requires text fields title, day, time, attendees, agenda; if fields.title is omitted, the already supplied valid outer title is copied into it before saving the draft. An explicit fields.title is preserved. This draft-text requirement is separate from the declared datatypes of knowledge_record properties.',
        _object({"kind": _string(["brief", "agenda", "reservation"]), "title": _string(),
                 "fields": {"type": "object", "additionalProperties": {"type": "string"}, "maxProperties": 16, "description": "Every value MUST be a string, including counts. Reservation requires title, day, time, attendees (e.g. the string 2), agenda. A missing reservation title is copied from the valid outer title; an explicit field is never overwritten."}, "sourceRefs": _strings()}, ["kind", "title", "fields", "sourceRefs"])),
    "artifact_revise": ("Revise an exact artifact version, preserving its source and disclosure restrictions.",
        _object({"artifactId": _string(), "expectedVersion": {"type": "integer", "minimum": 1},
                 "fields": {"type": "object", "additionalProperties": {"type": "string"}, "maxProperties": 16}, "sourceRefs": _strings()}, ["artifactId", "expectedVersion", "fields"])),
    "peer_describe": ("Inspect only capabilities and definitions actually received from the collaborator in this experience. Request missing information from the peer; no peer profile is preloaded.", _object()),
    "peer_request": ("Request structured information from the peer; this does not grant access to private records.",
        _object({"kind": _string(["availability", "report_interests", "research_material", "agenda_review", "ontology", "capabilities"]),
                 "recipient": _string(["Alice", "Bob"])}, ["kind"])),
    "peer_send": ("Send selected fields of your source or draft through the disclosure authorization gate. working-ontology and capabilities are your task-scoped definition and skill source references; use task_status to discover exact available sources.",
        _object({**_resource, "artifactId": _string()})),
    "alignment_propose": ("Propose correspondences using your own and actually received definitions. The service binds exchanged source versions; there is no preset mapping answer. reason/condition are local review notes; only the service's scoped mapping projection is sent. Share richer explanations using an approved artifact.",
        _object({"mappings": {"type": "array", "minItems": 1, "maxItems": 12, "items": _object({
            "id": _string(), "source": _string(), "target": _string(),
            "relation": _string(["exact", "close", "related", "narrower", "broader", "conditional", "disjoint"]),
            "condition": _string(), "reason": _string()}, ["source", "target", "relation", "reason"])}}, ["mappings"])),
    "alignment_accept": ("Independently accept or reject a received mapping proposal from its actual definitions and task scope. The service validates provenance and versions, not semantic correctness; reason is a local review note.",
        _object({"proposalId": _string(), "decision": _string(["accept", "reject"]), "reason": _string()}, ["proposalId", "decision", "reason"])),
    "authorization_check": ("Retrieve current permission for this exact action. A prior KG memory is not authority.",
        _object(_intent, ["action", "resourceId"])),
    "authorization_request": ("Ask your owner about an exact disclosure or reservation. Save a checkpoint and end the run when pending.",
        _object(_intent, ["action", "resourceId"])),
    "authorization_list": ("Read your owner's current policies, requests and permission history from the authoritative service.", _object()),
    "authorization_propose_policy": ("Propose a standing rule for your owner to review. This creates only a candidate; it grants no authority. Save a needs_owner checkpoint and end this run.",
        _object({"effect": _string(["allow", "ask", "deny"]), "actions": {"type": "array", "minItems": 1, "maxItems": 1, "items": _string(["peer.send"])},
                 "resources": _strings(), "fields": _strings(), "resourceClass": _string(["public", "availability"]), "recipients": _strings(), "purposes": _strings(), "label": _string()},
                ["effect", "actions", "recipients", "purposes"])),
    "resource_search": ("Find fictional venues matching participant capacity and equipment requirements.",
        _object({"capacity": {"type": "integer", "minimum": 1, "maximum": 1000}, "equipment": _strings()})),
    "reservation_submit": ("Submit an exact approved reservation draft (kind reservation; fields title, day, time, attendees as a count string, agenda). A receipt, not this request, confirms booking.",
        _object({"resourceId": _string(), "venueId": _string()}, ["resourceId", "venueId"])),
    "receipt_inspect": ("Inspect actual confirmed delivery and operation receipts.", _object({"operationId": _string()})),
    "task_checkpoint": ("Persist progress or waiting state. Complete means the service can verify the required results.",
        _object({"status": _string(["working", "waiting_peer", "needs_owner", "complete"]), "summary": _string()}, ["status", "summary"])),
    "task_status": ("Retrieve your task, inbox, artifacts, accepted mappings and confirmed results after a resumed run.", _object()),
}


def _configuration():
    raw = os.environ.get("DEMO_RESEARCH_GATEWAY_URL", "http://demo:4330").rstrip("/")
    url = urlsplit(raw)
    if (url.scheme not in {"http", "https"} or url.hostname not in {"demo", "127.0.0.1", "localhost", "::1"}
            or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("Configure a local research gateway origin")
    role = os.environ.get("DEMO_HERMES_ROLE", "")
    if role not in {"Alice", "Bob"}:
        raise ValueError("Configure the exact research role")
    filename = Path(os.environ.get("DEMO_RESEARCH_TOKEN_FILE", "/opt/data/kg-service.token"))
    if not filename.is_absolute() or filename.is_symlink():
        raise ValueError("Use a private service token file")
    token = filename.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("Research gateway credential unavailable")
    return raw, role, token


def _request(route, payload=None):
    base, _role, token = _configuration()
    data = None if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
    if data is not None and len(data) > MAX_BYTES:
        raise ValueError("Research tool input exceeds its limit")
    request = Request(base + route, data=data, method="GET" if data is None else "POST",
        headers={"Authorization": "Bearer " + token, "Accept": "application/json", "Content-Type": "application/json"})
    with build_opener(NoRedirect).open(request, timeout=20) as response:
        content = response.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise ValueError("Research tool response exceeds its limit")
        value = json.loads(content)
        if not isinstance(value, (dict, list)):
            raise ValueError("Research gateway response must be structured JSON")
        return value


def _session_key(kwargs):
    # Hermes supplies these context keywords; they never come from model arguments.
    return str(kwargs.get("session_id") or kwargs.get("task_id") or "").strip()


def _bind(key):
    if not key:
        raise ValueError("A native Hermes session identity is required")
    with _lock:
        if key in _retired:
            raise ValueError("This native run has already ended")
        if key in _sessions:
            return _sessions[key]
        if len(_sessions) >= 4096:
            raise ValueError("Restart the research profile before its session binding limit")
        value = _request("/api/research/agent-context")
        if not isinstance(value, dict) or not isinstance(value.get("assignmentId"), str) or not value["assignmentId"]:
            raise ValueError("No active research assignment")
        if value.get("role") != os.environ.get("DEMO_HERMES_ROLE"):
            raise ValueError("The research assignment belongs to another role")
        _sessions[key] = {"assignmentId": value["assignmentId"], "role": value["role"]}
        return _sessions[key]


def _on_session_start(session_id="", platform="", **kwargs):
    if platform == "api_server":
        try:
            _bind(str(session_id))
        except Exception:
            # A missing assignment permanently retires this session; a later run
            # cannot make the same old session gain access to a new task.
            with _lock:
                _retired.add(str(session_id))


def _on_session_end(session_id="", platform="", **kwargs):
    if platform == "api_server":
        with _lock:
            _retired.add(str(session_id))


def _draft_text_arguments(name, args):
    """Normalize draft representation before a draft exists or is reviewed.

    Only artifact fields declare an all-string map. Typed knowledge properties,
    booleans, containers, non-finite numbers and every execution argument retain
    their original types so the controller's existing strict checks still apply.
    A new reservation may reuse its already supplied valid outer title only when
    that field is absent; revisions and explicit field values remain unchanged.
    The caller's arguments are never modified in place.
    """
    if name not in {"artifact_prepare", "artifact_revise"} or not isinstance(args.get("fields"), dict):
        return args
    fields = args["fields"]
    normalized = {}
    changed = False
    for key, value in fields.items():
        if type(value) in {int, float} and (type(value) is int or math.isfinite(value)):
            normalized[key] = json.dumps(value, allow_nan=False, separators=(",", ":"))
            changed = True
        else:
            normalized[key] = value
    title = args.get("title")
    if (name == "artifact_prepare" and args.get("kind") == "reservation"
            and "title" not in fields and isinstance(title, str)
            and title.strip() and len(title) <= 200):
        normalized["title"] = title
        changed = True
    return {**args, "fields": normalized} if changed else args


def _handler(name):
    def call(args, **kwargs):
        try:
            if not isinstance(args, dict):
                raise ValueError("Research tool arguments must be an object")
            forbidden = {"owner", "ownerId", "role", "taskId", "workspaceId", "assignmentId", "token", "url"}
            if forbidden.intersection(args):
                raise ValueError("Task identity and gateway configuration are not tool arguments")
            args = _draft_text_arguments(name, args)
            binding = _bind(_session_key(kwargs))
            result = _request("/api/research/agent-tools", {"assignmentId": binding["assignmentId"], "name": name, "arguments": args})
            return json.dumps(result, ensure_ascii=False, allow_nan=False)
        except HTTPError as error:
            # Gateway errors are structured and bounded; credentials never enter the result.
            try:
                content = error.read(MAX_BYTES + 1)
                parsed = json.loads(content) if len(content) <= MAX_BYTES else None
                detail = parsed.get("error", {}) if isinstance(parsed, dict) else {}
                detail = detail if isinstance(detail, dict) else {}
                code = detail.get("code")
                code = code if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,100}", code) else None
                message = detail.get("message")
                message = message[:1000] if error.code < 500 and isinstance(message, str) else None
            except Exception:
                code = None
                message = None
            return json.dumps({"ok": False, "error": {"code": code or "RESEARCH_GATEWAY", "message": message or "The research service rejected this operation."}})
        except (ValueError, OSError, URLError, TimeoutError, TypeError):
            return json.dumps({"ok": False, "error": {"code": "RESEARCH_CONTEXT", "message": "The research context is unavailable or invalid. Save progress and stop."}})
        except Exception:
            return json.dumps({"ok": False, "error": {"code": "RESEARCH_TOOL", "message": "The research tool could not complete this operation."}})
    return call


def _skills_root():
    return Path(os.environ.get("HERMES_HOME", "/opt/data")) / "skills" / "research"


def _skills_list(args, **kwargs):
    try:
        _bind(_session_key(kwargs))
        rows = []
        for filename in sorted(_skills_root().glob("*/SKILL.md")):
            if filename.is_symlink() or filename.parent.is_symlink():
                continue
            text = filename.read_text(encoding="utf-8")
            description = re.search(r"^description:\s*(.+)$", text, flags=re.M)
            rows.append({"name": filename.parent.name, "description": description.group(1) if description else filename.parent.name})
        return json.dumps({"skills": rows}, ensure_ascii=False)
    except Exception:
        return json.dumps({"ok": False, "error": {"code": "RESEARCH_SKILLS", "message": "The scoped skill catalog is unavailable."}})


def _skill_view(args, **kwargs):
    try:
        _bind(_session_key(kwargs))
        name = args.get("name", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", name):
            raise ValueError("Invalid skill name")
        filename = _skills_root() / name / "SKILL.md"
        if filename.is_symlink() or filename.parent.is_symlink() or not filename.is_file():
            raise ValueError("Unknown skill")
        text = filename.read_text(encoding="utf-8")
        if len(text.encode("utf-8")) > 64 * 1024:
            raise ValueError("Skill exceeds limit")
        return json.dumps({"name": name, "content": text}, ensure_ascii=False)
    except Exception:
        return json.dumps({"ok": False, "error": {"code": "RESEARCH_SKILLS", "message": "Choose a skill from the scoped catalog."}})


def _pre_tool_call(tool_name="", **kwargs):
    # These dedicated profiles must not gain an alternate network/file channel
    # if an operator later enables another toolset in the native dashboard.
    if tool_name not in {*SCHEMAS, "research_skills_list", "research_skill_view"}:
        return {"action": "block", "message": "Use the research tools and their authorization gates in this profile."}
    return None


def register(ctx):
    for name, (description, parameters) in SCHEMAS.items():
        ctx.register_tool(name=name, toolset="research", schema={"name": name, "description": description, "parameters": parameters},
                          handler=_handler(name), description=description)
    for name, description, parameters, handler in [
        ("research_skills_list", "List this researcher's installed, read-only skill workflows.", _object(), _skills_list),
        ("research_skill_view", "Load an installed research skill by its catalog name.", _object({"name": _string()}, ["name"]), _skill_view),
    ]:
        ctx.register_tool(name=name, toolset="research", schema={"name": name, "description": description, "parameters": parameters},
                          handler=handler, description=description)
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("on_session_end", _on_session_end)
    ctx.register_hook("pre_tool_call", _pre_tool_call)

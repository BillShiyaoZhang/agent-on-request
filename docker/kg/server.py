"""Demo adapter over the native KG workbench and its authoritative KGStore."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from pathlib import Path
from threading import RLock

import uvicorn
import yaml
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.routing import Mount
from starlette.middleware.trustedhost import TrustedHostMiddleware

from kg.config import load_config
from kg.console_web import create_app
from kg.lifecycle import MemoryService
from kg.ontology_editing import OntologyEditor
from kg.schema import schema_for_store
from research_adapter import ResearchKnowledge


MAX_BODY = 768 * 1024
IDENTIFIER = re.compile(r"[A-Za-z0-9_.-]{1,100}\Z")
DEMO_ACTIONS = {"read_synthetic_calendar", "preview_scoped_calendar", "send_scoped_snapshot",
    "inspect_received_snapshot", "send_scoped_reply", "share_brief"}
TYPES = {
    "profile": "Agent starting configuration",
    "fact": "Agent knowledge",
    "calendar": "Calendar availability",
    "brief": "Meeting information",
    "round": "Collaboration round",
    "receipt": "Confirmed information receipt",
    "skill": "Agent skill",
    "result": "Collaboration result",
}
PROPERTIES = {
    "scope": ("Storage scope", "string"),
    "key": ("Original identifier", "string"),
    "kind": ("Demo record category", "string"),
    "role": ("Owning agent", "string"),
    "session": ("Collaboration session", "string"),
    "epoch": ("Session epoch", "integer"),
    "json": ("Structured value", "string"),
    "type": ("Original knowledge type", "string"),
    "day": ("Weekday", "string"),
    "time": ("Time interval", "string"),
    "status": ("Availability", "string"),
    "title": ("Calendar title", "string"),
    "note": ("Calendar note", "string"),
    "active": ("Included in starting configuration", "boolean"),
    "direction": ("Delivery direction", "string"),
    "operation": ("Confirmed operation identifier", "string"),
    "index": ("Record order", "integer"),
    "version": ("Session result version", "integer"),
}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        default=lambda item: item.isoformat() if hasattr(item, "isoformat") else str(item))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def fact_properties(properties):
    managed = {"uri", "shared", "hermes_name", "foaf_name", "hermes_updatedAt", "hermes_createdAt",
        "hermes_revision", "hermes_origin", "hermes_userConfirmed", "hermes_evidenceJson",
        "hermes_lastOperationId", "hermes_sourceSession", "hermes_sourceSessions", "hermes_extractionIds"}
    return json.loads(encoded({key: value for key, value in properties.items()
        if key not in managed and not key.startswith("x_demo_")}))


class DemoMemoryService(MemoryService):
    """Keep native baseline editing while preserving committed round evidence."""

    @staticmethod
    def _card(row):
        card = MemoryService._card(row)
        if DemoMemoryService.frozen(card["props"]):
            card["read_only"] = True
        return card

    @staticmethod
    def frozen(properties):
        return "x_demo_kind" in properties and bool(properties.get("hermes_sourceSession"))

    def assert_editable(self, uri):
        if self.frozen(self.detail(uri)["props"]):
            raise HTTPException(403, "This round's committed evidence is read-only. Edit the starting configuration for a new round.")

    def correct(self, uri, changes, **kwargs):
        self.assert_editable(uri)
        return super().correct(uri, changes, **kwargs)

    def archive(self, uri, **kwargs):
        self.assert_editable(uri)
        return super().archive(uri, **kwargs)

    def restore(self, uri, **kwargs):
        self.assert_editable(uri)
        return super().restore(uri, **kwargs)


class DemoKnowledge:
    def __init__(self, config, memory, role):
        if role not in {"Alice", "Bob"}:
            raise ValueError("DEMO_KG_ROLE must be Alice or Bob")
        self.config, self.memory, self.store, self.role = config, memory, memory.store, role
        self.lock = RLock()
        self.store.ensure_schema()
        self.install_schema()

    def install_schema(self):
        current = self.store.ontology_overlay()
        schema = schema_for_store(self.store)
        known_types = {item["key"] for item in schema["entity_types"]}
        known_properties = {item["key"] for item in schema["properties"]}
        operations = []
        for key, label in TYPES.items():
            name = "x_demo_" + key
            if name not in known_types:
                operations.append({"action": "create", "kind": "entity_types", "key": name,
                    "definition": {"label": label, "description": "Role-scoped collaborative demo record."}})
        for key, (label, datatype) in PROPERTIES.items():
            name = "x_demo_" + key
            if name not in known_properties:
                operations.append({"action": "create", "kind": "properties", "key": name,
                    "definition": {"label": label, "domain": ["any"], "range": [datatype]}})
        if operations:
            OntologyEditor(self.config, self.store).publish(expected_namespace=self.config.urn_prefix,
                expected_version=current["version"], operations=operations,
                operation_id="demo-schema-" + digest(operations)[:32], reason="Install collaborative demo vocabulary")

    def uri(self, kind, key):
        return self.config.urn_prefix + "x_demo_" + kind + "-" + digest(key)[:36]

    def entity(self, record_type, identity, name, **properties):
        return {"uri": self.uri(record_type, identity), "type": "x_demo_" + record_type, "name": name,
            "props": {"shared": False, "x_demo_role": self.role,
                **{"x_demo_" + field: value for field, value in properties.items()}}}

    @staticmethod
    def relationship(source, target, label, **properties):
        return {"from": source, "to": target, "type": "RELATED_TO", "label": label,
            "props": {"x_demo_" + key: value for key, value in properties.items()}}

    def read_records(self, scope, session=None, epoch=None):
        params = {"prefix": self.config.urn_prefix, "scope": scope, "session": session, "epoch": epoch}
        nodes = self.store.run_read("""MATCH (n:KGEntity)
            WHERE n.uri STARTS WITH $prefix AND (n.x_demo_scope=$scope
                OR $scope='default' AND n.x_demo_scope IS NULL AND n.x_res_kind IS NULL)
                AND NOT n:KGQuarantined AND coalesce(n.x_demo_active,true)=true
                AND NOT n:KGLegacyAlias AND NOT n:KGLegacyUnresolved
                AND coalesce(n.hermes_aliasConfirmed,false)=false
                AND ($session IS NULL OR n.x_demo_session=$session AND n.x_demo_epoch=$epoch)
            RETURN labels(n) AS labels, properties(n) AS properties
            ORDER BY n.x_demo_index, n.uri LIMIT 5000""", params)
        uris = [row["properties"]["uri"] for row in nodes]
        edges = self.store.run_read("""MATCH (a:KGEntity)-[r]->(b:KGEntity)
            WHERE a.uri IN $uris AND b.uri IN $uris AND (r.x_demo_scope=$scope OR $scope='default' AND r.x_demo_scope IS NULL)
            RETURN a.uri AS source,b.uri AS target,type(r) AS type,properties(r) AS properties
            ORDER BY a.uri,b.uri""", {"uris": uris, "scope": scope}) if uris else []
        return nodes, edges

    def native_skills(self):
        config_path = self.config.home / "config.yaml"
        settings = yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
        settings = settings or {}
        skill_settings = settings.get("skills") or {}
        disabled = skill_settings.get("disabled") or []
        platform_disabled = (skill_settings.get("platform_disabled") or {}).get("api_server") or []
        disabled = set([disabled] if isinstance(disabled, str) else disabled)
        disabled.update([platform_disabled] if isinstance(platform_disabled, str) else platform_disabled)
        skills, definitions = [], []
        directory = self.config.home / "skills"
        if directory.is_dir():
            for path in sorted(directory.rglob("SKILL.md")):
                if path.is_symlink() or path.parent.is_symlink():
                    continue
                content = path.read_text(encoding="utf-8")
                metadata = {}
                body = content
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) == 3:
                        metadata = yaml.safe_load(parts[1]) or {}
                        body = parts[2].strip()
                identifier = metadata.get("name") or path.parent.name
                if not isinstance(identifier, str) or identifier not in DEMO_ACTIONS or identifier in disabled:
                    continue
                skills.append(identifier)
                definitions.append({"id": identifier, "label": str(metadata.get("description") or identifier)[:200],
                    "description": body[:4000]})
        return sorted(set(skills)), definitions

    def profile(self):
        nodes, edges = self.read_records("default")
        root = next((row["properties"] for row in nodes if row["properties"].get("x_demo_kind") == "profile"), None)
        if root is None:
            raise HTTPException(404, "This agent's initial knowledge has not been seeded")
        profile = json.loads(root["x_demo_json"])
        graph_nodes, source_ids = [], {}
        calendar, brief = [], {}
        for row in nodes:
            props = row["properties"]
            kind, key = props.get("x_demo_kind"), props.get("x_demo_key")
            if kind == "fact":
                source_ids[props["uri"]] = key
                properties = {**json.loads(props.get("x_demo_json", "{}")), **fact_properties(props)}
                graph_nodes.append({"id": key, "label": props["hermes_name"], "type": props.get("x_demo_type", "concept"),
                    **({"properties": properties} if properties else {})})
            elif props.get("x_demo_scope") is None:
                source_id = "native-" + digest(props["uri"])[:28]
                source_ids[props["uri"]] = source_id
                native_type = next((label for label in row["labels"] if label not in {"KGEntity"}), "Concept")
                graph_nodes.append({"id": source_id, "label": str(props.get("foaf_name") or props.get("hermes_name") or source_id)[:200],
                    "type": native_type[:64], "properties": {"sourceUri": props["uri"], **fact_properties(props)}})
            elif kind == "calendar":
                fields = ["day", "time", "status", "title", "note"] if self.role == "Alice" else ["day", "time"]
                calendar.append({field: props.get("x_demo_" + field, "") for field in fields})
            elif kind == "brief":
                brief[key] = json.loads(props.get("x_demo_json", "null"))
        graph_edges = []
        for row in nodes:
            props = row["properties"]
            if props.get("x_demo_kind") != "relationship":
                continue
            source = next((edge["source"] for edge in edges if edge["target"] == props["uri"] and edge["source"] in source_ids), None)
            target = next((edge["target"] for edge in edges if edge["source"] == props["uri"] and edge["target"] in source_ids), None)
            if source and target:
                graph_edges.append({"id": props["x_demo_key"], "source": source_ids[source],
                    "target": source_ids[target], "label": props["hermes_name"]})
        for edge in edges:
            props = edge["properties"]
            if props.get("x_demo_kind") in {None, "fact"} and edge["source"] in source_ids and edge["target"] in source_ids:
                graph_edges.append({"id": props.get("x_demo_key") or "native-" + digest(edge)[:28], "source": source_ids[edge["source"]],
                    "target": source_ids[edge["target"]], "label": str(props.get("hermes_relLabel") or edge["type"])[:200]})
        if len(graph_nodes) > 200 or len(graph_edges) > 400:
            raise HTTPException(422, "This agent's native starting graph exceeds the demo's 200-node / 400-relationship limit")
        profile["kg"] = {"nodes": graph_nodes, "edges": graph_edges}
        profile["data"] = {"calendar": calendar} if self.role == "Alice" else {"availableTimes": calendar, "brief": brief}
        profile["skills"], profile["skillDefinitions"] = self.native_skills()
        revision = digest({"records": nodes, "relations": edges, "skills": profile["skillDefinitions"]})
        return {"role": self.role, "profile": profile, "revision": revision,
            "provenance": {"provider": "kg", "namespace": self.config.urn_prefix, "profileUri": root["uri"], "revision": revision}}

    def profile_records(self, profile, *, scope, key, session=None, epoch=None):
        common = {"scope": scope, "session": session or "", "epoch": epoch or 0, "active": True}
        metadata = {field: value for field, value in profile.items() if field not in {"kg", "data", "skills", "skillDefinitions"}}
        root_kind = "profile" if scope == "default" else "round"
        root = self.entity(root_kind, key, self.role + (" starting knowledge" if scope == "default" else " collaboration " + session),
            **common, kind=root_kind, key=key if isinstance(key, str) else encoded(key), json=encoded(metadata if scope == "default" else profile))
        entities, relations = [root], []
        by_id = {}
        for index, node in enumerate(profile.get("kg", {}).get("nodes", [])):
            record = self.entity("fact", [key, "node", node["id"]], node["label"], **common,
                kind="fact", key=node["id"], type=node["type"], index=index, json=encoded(node.get("properties", {})))
            entities.append(record)
            by_id[node["id"]] = record["uri"]
            relations.append(self.relationship(root["uri"], record["uri"], "knows", **common, kind="contains"))
        for edge in profile.get("kg", {}).get("edges", []):
            if edge["source"] not in by_id or edge["target"] not in by_id:
                raise HTTPException(422, "A knowledge relationship refers to a missing node")
            record = self.entity("fact", [key, "relationship", edge["id"]], edge["label"],
                **common, kind="relationship", key=edge["id"], type="relationship", json=encoded(edge))
            entities.append(record)
            relations.append(self.relationship(by_id[edge["source"]], record["uri"], "asserts relationship",
                **common, kind="relationship-part"))
            relations.append(self.relationship(record["uri"], by_id[edge["target"]], "points to",
                **common, kind="relationship-part"))
        rows = profile["data"].get("calendar" if self.role == "Alice" else "availableTimes", [])
        for index, row in enumerate(rows):
            record = self.entity("calendar", [key, "calendar", index],
                row.get("title") or row["day"] + " " + row["time"], **common, kind="calendar", key=str(index), index=index,
                **{field: value for field, value in row.items() if field in {"day", "time", "status", "title", "note"}})
            entities.append(record)
            relations.append(self.relationship(root["uri"], record["uri"], "has calendar entry", **common, kind="contains"))
        for field, value in profile["data"].get("brief", {}).items():
            record = self.entity("brief", [key, "brief", field], field, **common, kind="brief", key=field, json=encoded(value))
            entities.append(record)
            relations.append(self.relationship(root["uri"], record["uri"], "has meeting information", **common, kind="contains"))
        if scope == "round":
            definitions = {item["id"]: item for item in profile.get("skillDefinitions", [])}
            for identifier in profile.get("skills", []):
                definition = definitions.get(identifier, {})
                record = self.entity("skill", [key, "skill", identifier], definition.get("label", identifier),
                    **common, kind="skill", key=identifier, json=encoded(definition))
                entities.append(record)
                relations.append(self.relationship(root["uri"], record["uri"], "can use", **common, kind="contains"))
        return entities, relations

    def seed(self, profile, *, seed_only=True, expected_revision=None):
        if not isinstance(profile, dict) or not all(field in profile for field in ("kg", "data", "skills", "authorization")):
            raise HTTPException(422, "Provide a complete role-local initial profile")
        if len(encoded(profile).encode()) > 256 * 1024:
            raise HTTPException(413, "This initial profile exceeds its size limit")
        with self.lock:
            try:
                current = self.profile()
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                current = None
            if current and seed_only:
                return current
            if current is None and seed_only:
                existing = self.store.run_read("MATCH (n:KGEntity {uri:$uri}) RETURN n.uri AS uri",
                    {"uri": self.uri("profile", "default")})
                if existing:
                    raise HTTPException(409, "The starting configuration was archived or changed. Restore it in the native KG workbench before starting the demo.")
            if current and expected_revision != current["revision"]:
                raise HTTPException(409, "Starting knowledge changed; reload its native records before saving")
            entities, relations = self.profile_records(profile, scope="default", key="default")
            versions = {row["properties"]["uri"]: row["properties"].get("hermes_revision", 0)
                for row in self.read_records("default")[0]}
            versions.setdefault(entities[0]["uri"], 0)
            # Preserve an auditable inactive record when a replacement removes a row.
            present = {item["uri"] for item in entities}
            for row in self.read_records("default")[0]:
                props = row["properties"]
                if props.get("x_demo_scope") == "default" and props["uri"] not in present:
                    kind = next(label[len("KGCustom_"):] for label in row["labels"] if label.startswith("KGCustom_"))
                    entities.append({"uri": props["uri"], "type": kind, "name": props["hermes_name"],
                        "props": {"x_demo_active": False}})
            self.store.write_batch(entities, relations, origin="manual", expected_versions=versions,
                operation_id="demo-default-" + digest([self.config.urn_prefix, expected_revision, profile])[:48], reason="Seed or explicitly replace agent starting knowledge")
            return self.profile()

    def begin(self, session, epoch, profile):
        with self.lock:
            key = [session, epoch]
            entities, relations = self.profile_records(profile, scope="round", key=key, session=session, epoch=epoch)
            self.store.write_batch(entities, relations, source_session=session, origin="manual",
                operation_id="demo-begin-" + digest([self.config.urn_prefix, key])[:48], reason="Freeze the actual native starting knowledge for this round")
            return self.snapshot(session, epoch)

    def receipt(self, session, epoch, direction, receipt):
        recipient = "Bob" if direction == "aliceToBob" else "Alice" if direction == "bobToAlice" else None
        if recipient != self.role or not isinstance(receipt, dict) or receipt.get("status") != "received":
            raise HTTPException(422, "Only a confirmed receipt for this recipient may enter its graph")
        operation = receipt.get("operationId")
        if not isinstance(operation, str) or not 1 <= len(operation) <= 200:
            raise HTTPException(422, "A confirmed operation identifier is required")
        current = self.snapshot(session, epoch)
        previous = next((item for item in current["receipts"] if item.get("operationId") == operation), None)
        if previous is not None:
            if encoded(previous) != encoded(receipt):
                raise HTTPException(409, "This receipt operation already contains different confirmed information")
            return {"ok": True, "idempotent": True, "operationId": operation}
        entities, relations = self.receipt_records(session, epoch, direction, receipt, len(current["receipts"]))
        return self.store.write_batch(entities, relations, source_session=session, origin="manual",
            operation_id="demo-receipt-" + digest([self.config.urn_prefix, session, epoch, operation])[:48], reason="Record the exact receiver-confirmed information")

    def receipt_records(self, session, epoch, direction, receipt, receipt_index):
        operation = receipt["operationId"]
        common = {"scope": "round", "session": session, "epoch": epoch, "active": True,
            "direction": direction, "operation": operation}
        root_uri = self.uri("round", [session, epoch])
        record = self.entity("receipt", [session, epoch, operation], "Confirmed " + ("Alice → Bob" if self.role == "Bob" else "Bob → Alice"),
            **common, kind="receipt", key=operation, index=receipt_index, json=encoded(receipt))
        entities = [record]
        relations = [self.relationship(root_uri, record["uri"], "received", **common, kind="contains")]
        for index, row in enumerate(receipt.get("rows") or []):
            fact = self.entity("calendar", [session, epoch, operation, index], row.get("title") or row.get("day", "") + " " + row.get("time", ""),
                **common, kind="received", key=str(index), index=index, json=encoded(row),
                **{field: value for field, value in row.items() if field in {"day", "time", "status", "title", "note"}})
            entities.append(fact)
            relations.append(self.relationship(record["uri"], fact["uri"], "contains approved fields", **common, kind="contains"))
        for field, value in (receipt.get("values") or {}).items():
            fact = self.entity("brief", [session, epoch, operation, field], field, **common,
                kind="received", key=field, json=encoded(value))
            entities.append(fact)
            relations.append(self.relationship(record["uri"], fact["uri"], "contains approved field", **common, kind="contains"))
        return entities, relations

    def finish(self, session, epoch, result):
        if not isinstance(result, dict) or not isinstance(result.get("version"), int):
            raise HTTPException(422, "A session result with its version is required")
        current = self.snapshot(session, epoch)
        version = result["version"]
        previous = current["result"]
        if previous and (version < previous["version"] or version == previous["version"] and encoded(previous) != encoded(result)):
            raise HTTPException(409, "The native round already has a newer or different result version")
        record = self.entity("result", [session, epoch, version], self.role + " result · " + str(result.get("task", {}).get("outcome") or "in progress"),
            scope="round", session=session, epoch=epoch, active=True, kind="result", key=str(version),
            version=version, json=encoded(result))
        relation = self.relationship(self.uri("round", [session, epoch]), record["uri"], "has result", scope="round", kind="contains")
        return self.store.write_batch([record], [relation], source_session=session, origin="manual",
            operation_id="demo-result-" + digest([self.config.urn_prefix, session, epoch, version])[:48], reason="Store the round's confirmed result and collaboration trace")

    def snapshot(self, session, epoch):
        nodes, edges = self.read_records("round", session, epoch)
        root = next((row["properties"] for row in nodes if row["properties"].get("x_demo_kind") == "round"), None)
        if not root:
            raise HTTPException(404, "This native round snapshot does not exist")
        receipts = [json.loads(row["properties"]["x_demo_json"]) for row in nodes if row["properties"].get("x_demo_kind") == "receipt"]
        self.verify_snapshot(session, epoch, root, nodes, edges, receipts)
        results = [row["properties"] for row in nodes if row["properties"].get("x_demo_kind") == "result"]
        result = json.loads(max(results, key=lambda item: item["x_demo_version"])["x_demo_json"]) if results else None
        graph_nodes = []
        for row in nodes:
            props = row["properties"]
            kind = props.get("x_demo_kind")
            if kind == "result":
                continue
            operation = props.get("x_demo_operation")
            origin = "received" if operation else "own"
            fields = ["day", "time", "status", "title", "note"]
            details = [{"label": field, "value": props["x_demo_" + field]} for field in fields if "x_demo_" + field in props]
            if kind == "fact":
                details.extend({"label": field, "value": value if isinstance(value, str) else encoded(value)}
                    for field, value in json.loads(props.get("x_demo_json", "{}")).items())
            graph_nodes.append({"id": props["uri"], "label": props["hermes_name"], "type": props.get("x_demo_type", kind),
                "origin": origin, "details": details,
                **({"provenance": {"operationId": operation, "sender": "Alice" if self.role == "Bob" else "Bob"}} if operation else {})})
        graph_ids = {node["id"] for node in graph_nodes}
        graph_edges = [{"id": digest(edge), "source": edge["source"], "target": edge["target"],
            "label": edge["properties"].get("hermes_relLabel", "related"), "type": "RELATED_TO",
            "origin": "received" if edge["properties"].get("x_demo_operation") else "own"}
            for edge in edges if edge["source"] in graph_ids and edge["target"] in graph_ids]
        return {"role": self.role, "namespace": self.config.urn_prefix, "sessionId": session, "epoch": epoch,
            "profile": json.loads(root["x_demo_json"]), "receipts": receipts, "result": result,
            "graph": {"nodes": graph_nodes, "edges": graph_edges},
            "provenance": {"provider": "kg", "namespace": self.config.urn_prefix, "profileUri": root["uri"],
                "revision": digest({"nodes": nodes, "edges": edges})}}

    def verify_snapshot(self, session, epoch, root, nodes, edges, receipts):
        expected, expected_edges = self.profile_records(json.loads(root["x_demo_json"]), scope="round",
            key=[session, epoch], session=session, epoch=epoch)
        for index, receipt in enumerate(receipts):
            records, relations = self.receipt_records(session, epoch, "aliceToBob" if self.role == "Bob" else "bobToAlice", receipt, index)
            expected.extend(records)
            expected_edges.extend(relations)
        actual = {row["properties"]["uri"]: row["properties"] for row in nodes
            if row["properties"].get("x_demo_kind") != "result"}
        if set(actual) != {item["uri"] for item in expected}:
            raise HTTPException(409, "The frozen round's native records changed")
        for item in expected:
            props = actual[item["uri"]]
            business = {key: value for key, value in props.items() if key.startswith("x_demo_") or key in {"hermes_name", "shared"}}
            if encoded(business) != encoded({**item["props"], "hermes_name": item["name"].strip()}):
                raise HTTPException(409, "The frozen round's native facts changed")
        expected_links = {(item["from"], item["to"], item["type"], encoded({**item["props"], "hermes_relLabel": item["label"]}))
            for item in expected_edges}
        actual_links = {(item["source"], item["target"], item["type"], encoded({key: value for key, value in item["properties"].items()
            if key.startswith("x_demo_") or key == "hermes_relLabel"})) for item in edges
            if item["source"] in actual and item["target"] in actual}
        if expected_links != actual_links:
            raise HTTPException(409, "The frozen round's native relationships changed")


def create_service():
    config = load_config()
    memory = DemoMemoryService(config)
    role = os.environ["DEMO_KG_ROLE"]
    token_path = Path(os.environ.get("KG_CONSOLE_TOKEN_FILE", str(config.home / "kg-console.token")))
    token = token_path.read_text(encoding="utf-8").strip()
    service_token = Path(os.environ.get("DEMO_KG_SERVICE_TOKEN_FILE", str(config.home / "kg-service.token"))).read_text(encoding="utf-8").strip()
    if len(service_token) < 16 or hmac.compare_digest(service_token, token):
        raise ValueError("The demo controller requires a separate native KG service credential")
    app = create_app(config, token=token, memory=memory, background=False,
        static_dir=os.environ.get("KG_STATIC_DIR", "/app/static"))
    for middleware in app.user_middleware:
        if middleware.cls is TrustedHostMiddleware:
            middleware.kwargs["allowed_hosts"] = [*middleware.kwargs["allowed_hosts"], "hermes-" + role.lower()]
    static_routes = [route for route in app.router.routes if isinstance(route, Mount) and route.path in {"", "/"}]
    for route in static_routes:
        app.router.routes.remove(route)
    knowledge = DemoKnowledge(config, memory, role)
    app.state.demo = knowledge
    research_knowledge = ResearchKnowledge(config, memory.store, role)
    app.state.research = research_knowledge

    @app.middleware("http")
    async def controller_boundary(request: Request, call_next):
        if request.url.path.startswith("/api/research/"):
            supplied = request.headers.get("authorization", "")
            if not hmac.compare_digest(supplied, "Bearer " + service_token):
                return JSONResponse({"detail": "Research profiles and ledger projections require the role-scoped service credential."},
                    status_code=403, headers={"Cache-Control": "no-store"})
            request.scope["headers"] = [(key, value) for key, value in request.scope["headers"] if key.lower() != b"authorization"]
            request.scope["headers"].append((b"authorization", ("Bearer " + token).encode()))
            request.__dict__.pop("_headers", None)
        if request.url.path.startswith("/api/demo/"):
            supplied = request.headers.get("authorization", "")
            if hmac.compare_digest(supplied, "Bearer " + service_token):
                request.scope["headers"] = [(key, value) for key, value in request.scope["headers"] if key.lower() != b"authorization"]
                request.scope["headers"].append((b"authorization", ("Bearer " + token).encode()))
                request.__dict__.pop("_headers", None)
            elif request.method != "GET" and hmac.compare_digest(supplied, "Bearer " + token):
                return JSONResponse({"detail": "Only the demo controller can commit round evidence."}, status_code=403,
                    headers={"Cache-Control": "no-store"})
        return await call_next(request)

    @app.exception_handler(ValueError)
    async def invalid_operation(request, error):
        if "cannot resolve address" in str(error).lower():
            return JSONResponse({"detail": "The native graph database is unavailable. Restore its network connection and retry the same operation."}, status_code=503)
        conflict = any(word in str(error).lower() for word in ("conflict", "version", "already exists with different"))
        return JSONResponse({"detail": "Native knowledge changed; reload and retry the same intended operation."
            if conflict else "The demo record does not match the native knowledge schema."}, status_code=409 if conflict else 422)

    async def payload(request):
        raw = await request.body()
        if len(raw) > MAX_BODY:
            raise HTTPException(413, "The demo adapter request is too large")
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error:
            raise HTTPException(422, "Provide a JSON request") from error
        if not isinstance(value, dict):
            raise HTTPException(422, "Provide a JSON object")
        return value

    def identity(session, epoch):
        if not IDENTIFIER.fullmatch(session) or epoch < 1:
            raise HTTPException(422, "Invalid session identity")

    @app.get("/api/research/profile")
    def research_profile():
        return research_knowledge.profile()

    @app.put("/api/research/profile")
    async def seed_research_profile(request: Request):
        value = await payload(request)
        return research_knowledge.seed(value.get("profile"), seed_only=value.get("seedOnly", True), expected_revision=value.get("expectedRevision"))

    @app.post("/api/research/projections")
    async def research_projection(request: Request):
        return research_knowledge.project((await payload(request)).get("event"))

    @app.post("/api/research/knowledge")
    async def record_research_knowledge(request: Request):
        value = await payload(request)
        return research_knowledge.record(value.get("workspaceId"), value.get("nodes"), value.get("edges"))

    @app.get("/api/research/workspaces/{workspace_id}/profile")
    def research_workspace_profile(workspace_id: str):
        return research_knowledge.workspace(workspace_id).profile()

    @app.put("/api/research/workspaces/{workspace_id}/profile")
    async def seed_research_workspace(workspace_id: str, request: Request):
        value = await payload(request)
        # Audience creation always clones the supplied immutable seed. Existing
        # workspaces may resume that exact seed, but cannot silently be reset.
        return research_knowledge.workspace(workspace_id).seed(value.get("profile"), seed_only=True)

    @app.post("/api/research/workspaces/{workspace_id}/knowledge")
    async def record_workspace_research(workspace_id: str, request: Request):
        value = await payload(request)
        return research_knowledge.workspace(workspace_id).record(value.get("workspaceId"), value.get("nodes"), value.get("edges"))

    @app.post("/api/research/workspaces/{workspace_id}/projections")
    async def research_workspace_projection(workspace_id: str, request: Request):
        return research_knowledge.workspace(workspace_id).project((await payload(request)).get("event"))

    @app.get("/api/demo/health")
    def health():
        memory.store.run_read("RETURN 1 AS ready")
        return {"ok": True, "provider": "kg", "role": role, "namespace": config.urn_prefix}

    @app.get("/api/demo/default")
    def default():
        return knowledge.profile()

    @app.put("/api/demo/default")
    async def save_default(request: Request):
        value = await payload(request)
        return knowledge.seed(value.get("profile"), seed_only=value.get("seedOnly", False), expected_revision=value.get("expectedRevision"))

    @app.put("/api/demo/rounds/{session}/{epoch}")
    async def begin(session: str, epoch: int, request: Request):
        identity(session, epoch)
        return knowledge.begin(session, epoch, (await payload(request)).get("profile"))

    @app.get("/api/demo/rounds/{session}/{epoch}")
    def snapshot(session: str, epoch: int):
        identity(session, epoch)
        return knowledge.snapshot(session, epoch)

    @app.post("/api/demo/rounds/{session}/{epoch}/receipts")
    async def receipt(session: str, epoch: int, request: Request):
        identity(session, epoch)
        value = await payload(request)
        return knowledge.receipt(session, epoch, value.get("direction"), value.get("receipt"))

    @app.put("/api/demo/rounds/{session}/{epoch}/result")
    async def finish(session: str, epoch: int, request: Request):
        identity(session, epoch)
        return knowledge.finish(session, epoch, (await payload(request)).get("result"))

    app.router.routes.extend(static_routes)
    return app


if __name__ == "__main__":
    uvicorn.run(create_service(), host="0.0.0.0", port=int(os.environ.get("KG_CONSOLE_PORT", "8765")))

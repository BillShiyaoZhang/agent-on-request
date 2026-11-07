"""Native research application profiles over editable KG schema and typed facts.

The packaged descriptor supplies module membership and storage bindings only.
Exported labels, definitions, property ranges, relationship endpoints and facts
are read from the current native overlay/graph. Public material certification is
kept in a service-only, non-KGEntity package record; memory writes cannot issue it.
Authorization projections are explanations, never executable permissions.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
import hashlib
import json
import re
from threading import RLock

from fastapi import HTTPException
from kg.ontology_editing import OntologyEditor
from kg.ontology_presets import install_preset
from kg.schema import schema_for_store
from kg.store import KGStore


WORKSPACE_ID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def storage_key(kind, identity):
    """Native keys are bounded and server-derived, never interpolated user input."""
    text = re.sub(r"[^a-z0-9_]", "_", identity.split(":")[-1].lower())
    key = "x_res_" + text
    if len(key) > 50:
        key = key[:37] + "_" + digest(identity)[:12]
    return key.upper() if kind == "relations" else key


META_PROPERTIES = {
    "key": "string", "kind": "string", "version": "string", "source": "string", "visibility": "string",
    "json": "string", "owner": "string", "day": "string", "time": "string", "status": "string",
    "content_summary": "string", "content_method": "string", "content_results": "string", "content_note": "string", "workspace": "string"
}


class ResearchKnowledge:
    def __init__(self, config, store, role, *, workspace_id=None):
        if role not in {"Alice", "Bob"}:
            raise ValueError("A research role is required")
        self.config, self.store, self.role = config, store, role
        self.lock = RLock()
        self.workspace_id = workspace_id
        self.workspaces = {}

    def workspace(self, workspace_id):
        """A separate native namespace and overlay for each audience and role.

        Only the Bolt connection is reused. Schema, facts, package certification,
        revision records and local maintenance state remain experience-scoped.
        """
        if not isinstance(workspace_id, str) or not WORKSPACE_ID.fullmatch(workspace_id):
            raise HTTPException(422, "Use an exact audience workspace UUID")
        if self.workspace_id:
            if workspace_id != self.workspace_id:
                raise HTTPException(409, "This adapter belongs to another workspace")
            return self
        with self.lock:
            if workspace_id not in self.workspaces:
                config = replace(self.config,
                    urn_prefix=self.config.urn_prefix + "experience-" + workspace_id + ":",
                    user_person_urn=None,
                    home=self.config.home / "research-workspaces" / workspace_id)
                config.home.mkdir(parents=True, exist_ok=True, mode=0o700)
                scoped_store = KGStore(config, driver=self.store.driver)
                self.workspaces[workspace_id] = ResearchKnowledge(config, scoped_store, self.role, workspace_id=workspace_id)
            return self.workspaces[workspace_id]

    def package(self):
        rows = self.store.run_read("""MATCH (p:ResearchProfilePackage {namespace:$namespace,role:$role})
            RETURN p.source_json AS source_json,p.state AS state""", {"namespace": self.config.urn_prefix, "role": self.role})
        if len(rows) > 1:
            raise RuntimeError("Duplicate native research profile packages")
        return rows[0] if rows else None

    def save_package(self, profile, state):
        def save(tx):
            tx.run("""MERGE (p:ResearchProfilePackage {namespace:$namespace,role:$role})
                SET p.source_json=$source_json,p.state=$state,p.updated_at=datetime()""",
                {"namespace": self.config.urn_prefix, "role": self.role, "source_json": encoded(profile), "state": state}).consume()
        with self.store.driver.session(database=self.config.database) as session:
            self.store._execute(session, "write", save)

    @staticmethod
    def terms(profile):
        return {term["id"]: term for module in profile["ontology"]["modules"] for term in module["concepts"]}

    @staticmethod
    def inherits(terms, identity, ancestor):
        seen = set()
        while identity and identity not in seen:
            if identity == ancestor:
                return True
            seen.add(identity)
            identity = terms.get(identity, {}).get("parent")
        return False

    def schema_operations(self, profile, current):
        terms = self.terms(profile)
        known = {kind: {item["key"] for item in current[kind]} for kind in ("entity_types", "properties", "relations")}
        operations = []

        def add(kind, key, definition):
            if key not in known[kind]:
                operations.append({"action": "create", "kind": kind, "key": key, "definition": definition})
                known[kind].add(key)

        add("entity_types", "x_res_record", {"label": "Research control projection", "description": "Discoverable record; this type does not confer execution authority."})
        for term in terms.values():
            add("entity_types", storage_key("entity_types", term["id"]), {"label": term["label"], "description": term["definition"]})
        # Native overlays currently support scalar custom values. Logical string[]
        # properties have explicit JSON-string storage bindings and are decoded.
        for suffix, datatype in META_PROPERTIES.items():
            add("properties", "x_res_" + suffix, {"label": "Research " + suffix.replace("_", " "), "domain": ["any"], "range": [datatype]})
        for term in terms.values():
            domain = [storage_key("entity_types", item) for item in terms if self.inherits(terms, item, term["id"])]
            for prop in term.get("properties", []):
                datatype = {"number": "double", "string[]": "string"}.get(prop["datatype"], prop["datatype"])
                add("properties", storage_key("properties", prop["id"]), {"label": prop["key"], "description": prop["definition"], "domain": domain, "range": [datatype]})
        for module in profile["ontology"]["modules"]:
            for relation in module["relations"]:
                def endpoints(values):
                    return ["any"] if "*" in values else sorted({storage_key("entity_types", item) for item in terms if any(self.inherits(terms, item, parent) for parent in values)})
                add("relations", storage_key("relations", relation["id"]), {"label": relation["id"].split(":")[-1], "description": relation["definition"], "domain": endpoints(relation["domain"]), "range": endpoints(relation["range"])})
        return operations

    def install_schema(self, profile):
        install_preset(self.store, "personal")
        operations = self.schema_operations(profile, schema_for_store(self.store))
        # A native ontology publish allows at most 32 edits. Entity definitions
        # precede properties and relations, so every batch has closed endpoints.
        for offset in range(0, len(operations), 32):
            batch = operations[offset:offset + 32]
            OntologyEditor(self.config, self.store).publish(expected_namespace=self.config.urn_prefix,
                expected_version=self.store.ontology_overlay()["version"], operations=batch,
                operation_id=self.operation_id("schema", batch), reason="Install additive researcher application ontology definitions")

    def uri(self, identity, kind):
        return self.config.urn_prefix + kind + "-" + digest(identity)[:36]

    def operation_id(self, kind, identity):
        # KGStore's memory receipts use a globally unique snapshot_id. Logical
        # fixture contents and ledger event numbers can be identical across
        # audiences and roles, so every adapter operation must bind namespace.
        return "research-" + kind + "-" + digest([self.config.urn_prefix, self.role, identity])[:44]

    def property_bindings(self, terms, identity):
        chain, seen = [], set()
        while identity and identity not in seen:
            seen.add(identity)
            term = terms.get(identity)
            if term is None:
                raise ValueError("Unknown research knowledge type")
            chain.append(term)
            identity = term.get("parent")
        return {prop["key"]: prop for term in reversed(chain) for prop in term.get("properties", [])}

    def profile_records(self, profile):
        terms = self.terms(profile)
        entities, relations, uris = [], [], {}
        for node in profile["knowledge"]["nodes"]:
            kind = storage_key("entity_types", node["type"])
            uri = self.uri(node["id"], kind)
            uris[node["id"]] = uri
            bindings = self.property_bindings(terms, node["type"])
            props = {"shared": False, "x_res_kind": "knowledge", "x_res_key": node["id"], "x_res_owner": self.role,
                "x_res_version": node["version"], "x_res_source": node["source"], "x_res_visibility": node["visibility"]}
            for key, value in node.get("properties", {}).items():
                prop = bindings[key]
                props[storage_key("properties", prop["id"])] = encoded(value) if prop["datatype"] == "string[]" else value
            entities.append({"uri": uri, "type": kind, "name": node["label"], "props": props})
        for edge in profile["knowledge"]["edges"]:
            relations.append({"from": uris[edge["source"]], "to": uris[edge["target"]], "type": storage_key("relations", edge["relation"]),
                "label": edge["relation"].split(":")[-1], "props": {"x_res_key": edge["id"], "x_res_owner": self.role, "x_res_version": str(edge.get("version", "1")), "x_res_source": str(edge.get("sourceRecord", "synthetic:research"))}})
        for index, row in enumerate(profile["calendar"]):
            identity = f"{self.role.lower()}:calendar-{index}"
            entities.append({"uri": self.uri(identity, "x_res_record"), "type": "x_res_record", "name": row["day"] + " " + row["time"],
                "props": {"shared": False, "x_res_kind": "calendar", "x_res_key": identity, "x_res_owner": self.role, "x_res_version": "1",
                    **{"x_res_" + key: value for key, value in row.items()}}})
        for material in profile["materials"]:
            entities.append({"uri": self.uri(material["id"], "x_res_record"), "type": "x_res_record", "name": material["label"],
                "props": {"shared": False, "x_res_kind": "material", "x_res_key": material["id"], "x_res_owner": self.role,
                    "x_res_version": material["version"], "x_res_json": encoded({"sourceIds": material["sourceIds"], "source": material["source"]}),
                    **{"x_res_content_" + key: value for key, value in material["fields"].items()}}})
        return entities, relations

    def seed(self, profile, *, seed_only=True, expected_revision=None):
        with self.lock:
            package = self.package()
            if package and package["state"] == "ready" and seed_only:
                if self.workspace_id and digest(profile) != digest(json.loads(package["source_json"])):
                    raise HTTPException(409, "This workspace was initialized from a different seed")
                return self.profile()
            if not isinstance(profile, dict) or profile.get("role") != self.role or profile.get("ontology", {}).get("owner") != self.role:
                raise HTTPException(422, "Provide this researcher's application profile")
            if package and package["state"] == "ready" and expected_revision != self.profile()["provenance"]["revision"]:
                raise HTTPException(409, "Native research profile changed; review the current version")
            if package and package["state"] != "ready" and digest(profile) != digest(json.loads(package["source_json"])):
                raise HTTPException(409, "Resume the same incomplete native profile installation first")
            self.save_package(profile, "installing")
            self.install_schema(profile)
            entities, relations = self.profile_records(profile)
            result = self.store.write_batch(entities, relations, origin="manual", include_implicit_relations=False,
                operation_id=self.operation_id("profile", profile), reason="Install explicit synthetic research profile and provenance")
            if result.get("disposition") == "deferred":
                raise HTTPException(409, "Research profile conflicts with reviewed native data")
            self.save_package(profile, "ready")
            return self.profile()

    def read_records(self):
        rows = self.store.run_read("""MATCH (n:KGEntity) WHERE n.uri STARTS WITH $prefix AND n.x_res_owner=$role
            AND NOT (n.uri STARTS WITH $experience_prefix)
            AND n.x_res_kind IN ['knowledge','calendar','material'] AND NOT n:KGQuarantined
            RETURN labels(n) AS labels,properties(n) AS properties ORDER BY n.x_res_key LIMIT 5000""",
            {"prefix": self.config.urn_prefix, "role": self.role, "experience_prefix": self.config.urn_prefix + "experience-"})
        uris = [row["properties"]["uri"] for row in rows]
        edges = self.store.run_read("""MATCH (a:KGEntity)-[r]->(b:KGEntity) WHERE a.uri IN $uris AND b.uri IN $uris AND r.x_res_owner=$role
            RETURN a.uri AS source,b.uri AS target,type(r) AS type,properties(r) AS properties ORDER BY r.x_res_key""",
            {"uris": uris, "role": self.role}) if uris else []
        return rows, edges

    def profile(self):
        package = self.package()
        if not package:
            raise HTTPException(404, "Initialize this research profile first")
        if package["state"] != "ready":
            raise HTTPException(503, "Native research profile installation is incomplete")
        original = json.loads(package["source_json"])
        output = deepcopy(original)
        schema = schema_for_store(self.store)
        native = {kind: {item["key"]: item for item in schema[kind]} for kind in ("entity_types", "properties", "relations")}
        terms = self.terms(original)
        type_ids = {storage_key("entity_types", identity): identity for identity in terms}
        relation_ids = {storage_key("relations", item["id"]): item["id"] for module in original["ontology"]["modules"] for item in module["relations"]}
        for module in output["ontology"]["modules"]:
            for term in module["concepts"]:
                definition = native["entity_types"].get(storage_key("entity_types", term["id"]))
                if not definition or not definition.get("active", True):
                    raise HTTPException(409, "A required research type was removed or disabled in the native ontology")
                term.update(label=definition["label"], definition=definition["description"])
                for prop in term.get("properties", []):
                    current = native["properties"].get(storage_key("properties", prop["id"]))
                    if not current or not current.get("active", True):
                        raise HTTPException(409, "A required research property was removed or disabled")
                    datatype = current["range"][0]
                    prop["datatype"] = "string[]" if prop["datatype"] == "string[]" and datatype == "string" else {"double": "number"}.get(datatype, datatype)
                    prop.update(definition=current["description"], nativeDomain=[type_ids.get(key, key) for key in current["domain"]])
            for relation in module["relations"]:
                current = native["relations"].get(storage_key("relations", relation["id"]))
                if not current or not current.get("active", True):
                    raise HTTPException(409, "A required research relationship was removed or disabled")
                relation.update(definition=current["description"], domain=["*"] if "any" in current["domain"] else [type_ids[key] for key in current["domain"] if key in type_ids],
                    range=["*"] if "any" in current["range"] else [type_ids[key] for key in current["range"] if key in type_ids])
        output["ontology"]["nativeVersion"] = schema["version"]
        output["ontology"].pop("hash", None)
        output["ontology"]["hash"] = digest(output["ontology"])
        rows, edges = self.read_records()
        output["knowledge"] = {"nodes": [], "edges": []}
        output["calendar"], output["materials"] = [], []
        native_to_id = {}
        material_certificates = {item["id"]: item for item in original["materials"]}
        actual_terms = self.terms(output)
        for row in rows:
            props = row["properties"]
            kind, identity = props["x_res_kind"], props["x_res_key"]
            if not identity.startswith(self.role.lower() + ":"):
                raise HTTPException(409, "A research record escaped its role namespace")
            name = props.get("hermes_name") or props.get("foaf_name") or identity
            if kind == "knowledge":
                term_type = next((type_ids[key] for key, value in native["entity_types"].items() if key in type_ids and value["storage_label"] in row["labels"]), None)
                if not term_type:
                    raise HTTPException(409, "A research record has an unsupported native type")
                bindings = self.property_bindings(actual_terms, term_type)
                values = {}
                for key, prop in bindings.items():
                    value = props.get(storage_key("properties", prop["id"]))
                    if value is not None:
                        values[key] = json.loads(value) if prop["datatype"] == "string[]" else value
                native_to_id[props["uri"]] = identity
                output["knowledge"]["nodes"].append({"id": identity, "type": term_type, "label": name, "properties": values,
                    "source": props.get("x_res_source", "native:research"), "version": str(props.get("hermes_revision", 1)),
                    "visibility": "private"})
            elif kind == "calendar":
                output["calendar"].append({key: props["x_res_" + key] for key in ("day", "time", "status")})
            elif kind == "material":
                fields = {key[len("x_res_content_"):]: value for key, value in props.items() if key.startswith("x_res_content_")}
                certificate = material_certificates.get(identity)
                certified = bool(certificate and certificate["version"] == props["x_res_version"] and certificate["fields"] == fields)
                metadata = json.loads(props.get("x_res_json", "{}"))
                output["materials"].append({"id": identity, "version": props["x_res_version"], "label": name, "fields": fields,
                    "source": metadata.get("source", "native:research"), "sourceIds": metadata.get("sourceIds", []),
                    "visibility": certificate["visibility"] if certified else "private", "ownerConfirmedVisibility": certified,
                    "nativeRevision": props.get("hermes_revision", 1)})
        for edge in edges:
            if edge["source"] in native_to_id and edge["target"] in native_to_id and edge["type"] in relation_ids:
                props = edge["properties"]
                output["knowledge"]["edges"].append({"id": props.get("x_res_key") or "native:" + digest([edge["source"], edge["target"], edge["type"]])[:24],
                    "source": native_to_id[edge["source"]], "target": native_to_id[edge["target"]], "relation": relation_ids[edge["type"]],
                    "sourceRecord": props.get("x_res_source", "native:research"), "version": str(props.get("x_res_version", 1))})
        provenance = {"provider": "kg", "namespace": self.config.urn_prefix,
            "revision": digest({"profile": output, "nativeVersion": schema["version"]})}
        if self.workspace_id:
            provenance.update(workspaceId=self.workspace_id, seedHash=digest(original))
            output["nativeWorkspace"] = {key: provenance[key] for key in ("workspaceId", "namespace", "seedHash")}
        return {"role": self.role, "profile": output, "provenance": provenance}

    def project(self, event):
        if not isinstance(event, dict) or not isinstance(event.get("workspaceId"), str) or not isinstance(event.get("id"), (str, int)):
            raise HTTPException(422, "Projection requires workspace and ledger event identifiers")
        if self.workspace_id and event["workspaceId"] != self.workspace_id:
            raise HTTPException(409, "Projection belongs to another workspace")
        identity = f"projection:{event['workspaceId']}:{event['id']}"
        record = event.get("record") or {}
        record_identity = f"control:{event['workspaceId']}:{event.get('recordId', event['id'])}"
        entities = [
            {"uri": self.uri(identity, "x_res_record"), "type": "x_res_record", "name": "Authorization event: " + str(event.get("topic", "record")),
             "props": {"shared": False, "x_res_kind": "projection", "x_res_key": identity, "x_res_owner": self.role, "x_res_json": encoded(event)}},
            {"uri": self.uri(record_identity, "x_res_record"), "type": "x_res_record", "name": str(event.get("topic", "Authorization")) + ": " + str(event.get("recordId", event["id"])),
             "props": {"shared": False, "x_res_kind": "control-reference", "x_res_key": record_identity, "x_res_owner": self.role, "x_res_json": encoded(record)}}
        ]
        relations = [{"from": entities[0]["uri"], "to": entities[1]["uri"], "type": "RELATED_TO", "label": "projects-authority-record"}]
        result = self.store.write_batch(entities, relations, origin="manual", include_implicit_relations=False,
            operation_id=self.operation_id("projection", identity), reason="Project authoritative ledger evidence for discovery; not executable permission")
        return {"role": self.role, "ok": True, "idempotent": bool(result.get("idempotent")), "authority": False}

    def record(self, workspace_id, nodes, edges):
        """Typed daily research writes are private and isolated from later visitors."""
        if (not isinstance(workspace_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,150}", workspace_id)
                or not isinstance(nodes, list) or not isinstance(edges, list) or len(nodes) > 100 or len(edges) > 200):
            raise HTTPException(422, "Provide bounded workspace-scoped research records")
        if self.workspace_id and workspace_id != self.workspace_id:
            raise HTTPException(409, "Knowledge belongs to another workspace")
        with self.lock:
            package = self.package()
            if not package or package["state"] != "ready":
                raise HTTPException(503, "Initialize the native research profile before recording knowledge")
            profile = json.loads(package["source_json"])
            identities = set()
            prepared_nodes = []
            for node in nodes:
                if not isinstance(node, dict) or not isinstance(node.get("id"), str) or not node["id"].startswith(self.role.lower() + ":") or node["id"] in identities:
                    raise HTTPException(422, "Knowledge records need unique IDs in this researcher's namespace")
                identities.add(node["id"])
                prepared_nodes.append({**node, "visibility": "private", "source": str(node.get("source", "native:workspace:" + workspace_id)), "version": str(node.get("version", "1"))})
            input_profile = {**profile, "knowledge": {"nodes": prepared_nodes, "edges": []}, "calendar": [], "materials": []}
            entities, _ = self.profile_records(input_profile)
            uris = {}
            for entity in entities:
                identity = entity["props"]["x_res_key"]
                entity["uri"] = self.uri(identity if self.workspace_id else [workspace_id, identity], entity["type"])
                entity["props"].update(x_res_kind="knowledge" if self.workspace_id else "workspace-knowledge", x_res_workspace=workspace_id, x_res_visibility="private")
                uris[identity] = entity["uri"]

            def endpoint(identity):
                if identity in uris:
                    return uris[identity]
                if not isinstance(identity, str) or not identity.startswith(self.role.lower() + ":"):
                    raise HTTPException(422, "Research relationship endpoint belongs to another role")
                found = self.store.run_read("""MATCH (n:KGEntity) WHERE n.uri STARTS WITH $prefix AND n.x_res_owner=$role
                    AND n.x_res_key=$identity AND NOT n:KGQuarantined
                    AND (n.x_res_kind='knowledge' OR n.x_res_kind='workspace-knowledge' AND n.x_res_workspace=$workspace)
                    RETURN n.uri AS uri ORDER BY n.x_res_workspace IS NULL LIMIT 1""",
                    {"prefix": self.config.urn_prefix, "role": self.role, "identity": identity, "workspace": workspace_id})
                if not found:
                    raise HTTPException(422, "Research relationship endpoint is missing in this workspace")
                return found[0]["uri"]

            allowed_relations = {item["id"] for module in profile["ontology"]["modules"] for item in module["relations"]}
            relations = []
            for edge in edges:
                if edge.get("relation") not in allowed_relations:
                    raise HTTPException(422, "Use a relationship defined by this researcher's ontology")
                relations.append({"from": endpoint(edge.get("source")), "to": endpoint(edge.get("target")),
                    "type": storage_key("relations", edge["relation"]), "label": edge["relation"].split(":")[-1],
                    "props": {"x_res_key": edge["id"], "x_res_owner": self.role, "x_res_workspace": workspace_id,
                        "x_res_source": str(edge.get("sourceRecord", "native:workspace:" + workspace_id)), "x_res_version": str(edge.get("version", "1"))}})
            result = self.store.write_batch(entities, relations, origin="manual", include_implicit_relations=False,
                operation_id=self.operation_id("memory", [workspace_id, nodes, edges]), reason="Record private workspace-scoped research knowledge and evidence")
            if result.get("disposition") == "deferred":
                raise HTTPException(409, "The research memory conflicts with reviewed native data")
            return {"role": self.role, "ok": True, "visibility": "private", "workspaceId": workspace_id, "idempotent": bool(result.get("idempotent"))}

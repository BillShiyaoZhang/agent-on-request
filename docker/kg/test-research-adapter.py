"""Pure adapter checks against the real adjacent KG schema, without a database."""
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent / "hermes-kg-plugin" / "plugins"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from kg.config import KGConfig
from kg.ontology_editing import effective_schema, merge_patch, validate_batch
from kg.ontology_presets import _assemble, _profile
from kg.schema import prepare_entity, prepare_relation
from research_adapter import ResearchKnowledge, encoded, storage_key


class ResearchAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = subprocess.check_output(["node", "--input-type=module", "-e",
            "import {researchProfile} from './src/research-profiles.mjs';console.log(JSON.stringify(['Alice','Bob'].map(researchProfile)));"], cwd=ROOT)
        cls.profiles = json.loads(source)

    def build(self, profile):
        config = KGConfig(home=ROOT, urn_prefix="urn:agent-on-request:" + profile["role"].lower() + ":")
        state, _, _ = _assemble(config, {"version": 0, "patch": {}}, _profile())
        store = SimpleNamespace(config=config, ontology_overlay=lambda: state)
        adapter = ResearchKnowledge(config, store, profile["role"])
        operations = adapter.schema_operations(profile, effective_schema(config, state))
        for offset in range(0, len(operations), 32):
            state, _ = merge_patch(config, state, {}, operations[offset:offset + 32])
            state["version"] += 1
        store.ontology_overlay = lambda: state
        return adapter, store, state

    def records(self, adapter, profile, state):
        schema = effective_schema(adapter.config, state)
        entities, relations = adapter.profile_records(profile)
        prepared = [prepare_entity(entity, adapter.config, schema)[0] for entity in entities]
        links = [prepare_relation(edge, adapter.config, schema) for edge in relations]
        validate_batch(adapter.config, state, prepared, links, {})
        rows = [{"labels": ["KGEntity", item["label"]], "properties": {**item["properties"], "uri": item["uri"], "hermes_revision": 1}} for item in prepared]
        edges = [{"source": edge["from"], "target": edge["to"], "type": edge["type"], "properties": edge["properties"]} for edge in links]
        return rows, edges

    def test_native_definitions_and_records_obey_real_runtime_constraints(self):
        for profile in self.profiles:
            with self.subTest(role=profile["role"]):
                adapter, _, state = self.build(profile)
                rows, edges = self.records(adapter, profile, state)
                self.assertGreater(len(rows), len(profile["knowledge"]["nodes"]))
                self.assertEqual(len(edges), len(profile["knowledge"]["edges"]))
                self.assertEqual(adapter.schema_operations(profile, effective_schema(adapter.config, state)), [])
                adapter.package = lambda: {"source_json": encoded(profile), "state": "ready"}
                adapter.read_records = lambda: (rows, edges)
                exported = adapter.profile()["profile"]
                validation = subprocess.check_output(["node", "--input-type=module", "-e",
                    "import {validateResearchProfile} from './src/research-profiles.mjs';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(validateResearchProfile(JSON.parse(s))));"],
                    input=encoded(exported).encode("utf-8"), cwd=ROOT)
                self.assertEqual(json.loads(validation), {"valid": True, "errors": []})

    def test_export_consumes_native_edits_and_preserves_semantic_relations(self):
        profile = self.profiles[0]
        adapter, store, state = self.build(profile)
        rows, edges = self.records(adapter, profile, state)
        # Real Neo4j edges carry native temporal metadata. Export must not try to
        # hash that metadata as a fallback when a stable research ID is present.
        edges[0]["properties"]["hermes_updatedAt"] = datetime.now(timezone.utc)
        adapter.package = lambda: {"source_json": encoded(profile), "state": "ready"}
        adapter.read_records = lambda: (rows, edges)
        first = adapter.profile()
        key = storage_key("entity_types", "alice:ResearchClaim")
        updated, _ = merge_patch(adapter.config, state, {"entity_types": {key: {"label": "Owner-edited claim type", "description": "A scoped claim with explicit evidence."}}})
        updated["version"] += 1
        store.ontology_overlay = lambda: updated
        second = adapter.profile()
        claim = next(term for module in second["profile"]["ontology"]["modules"] for term in module["concepts"] if term["id"] == "alice:ResearchClaim")
        self.assertEqual(claim["label"], "Owner-edited claim type")
        self.assertNotEqual(first["profile"]["ontology"]["hash"], second["profile"]["ontology"]["hash"])
        self.assertEqual(len(second["profile"]["knowledge"]["edges"]), len(profile["knowledge"]["edges"]))

    def test_native_memory_cannot_self_certify_a_new_public_material(self):
        profile = self.profiles[0]
        adapter, _, state = self.build(profile)
        rows, edges = self.records(adapter, profile, state)
        adapter.package = lambda: {"source_json": encoded(profile), "state": "ready"}
        adapter.read_records = lambda: (rows, edges)
        before = next(item for item in adapter.profile()["profile"]["materials"] if item["id"] == "alice:public-intro")
        self.assertEqual(before["visibility"], "public")
        record = next(row["properties"] for row in rows if row["properties"]["x_res_key"] == "alice:public-intro")
        record["x_res_content_summary"] = "Edited material with private numerical results"
        record["x_res_visibility"] = "public"
        after = next(item for item in adapter.profile()["profile"]["materials"] if item["id"] == "alice:public-intro")
        self.assertEqual(after["visibility"], "private")
        self.assertFalse(after["ownerConfirmedVisibility"])

    def test_daily_memory_uses_typed_private_workspace_records(self):
        profile = self.profiles[0]
        adapter, store, state = self.build(profile)
        rows, _ = self.records(adapter, profile, state)
        adapter.package = lambda: {"source_json": encoded(profile), "state": "ready"}
        submitted = []
        schema = effective_schema(adapter.config, state)

        def write(entities, relations, **kwargs):
            prepared = [prepare_entity(entity, adapter.config, schema)[0] for entity in entities]
            links = [prepare_relation(edge, adapter.config, schema) for edge in relations]
            current = {row["properties"]["uri"]: row for row in rows}
            validate_batch(adapter.config, state, prepared, links, current)
            submitted.append((entities, relations))
            return {"idempotent": False}

        store.write_batch = write
        store.run_read = lambda query, params: [{"uri": row["properties"]["uri"]} for row in rows if row["properties"].get("x_res_key") == params["identity"]][:1]
        node = {"id": "alice:daily-note", "type": "alice:ResearchNote", "label": "Today's mapping-review note", "properties": {"summary": "Inspect source definitions"}, "source": "synthetic:daily-note", "version": "1", "visibility": "public"}
        edge = {"id": "alice:daily-source", "source": node["id"], "target": "alice:source", "relation": "alice:sourcedFrom"}
        adapter.record("workspace-one", [node], [edge])
        adapter.record("workspace-two", [node], [edge])
        first = submitted[0][0][0]
        second = submitted[1][0][0]
        self.assertEqual(first["props"]["x_res_visibility"], "private")
        self.assertEqual(first["props"]["x_res_kind"], "workspace-knowledge")
        self.assertEqual(first["props"]["x_res_workspace"], "workspace-one")
        self.assertNotEqual(first["uri"], second["uri"])


if __name__ == "__main__":
    unittest.main()

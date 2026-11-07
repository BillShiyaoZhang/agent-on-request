"""Pure adapter checks against the real adjacent KG schema, without a database."""
import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent / "hermes-kg-plugin" / "plugins"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from kg.config import KGConfig
from kg.ontology_editing import effective_schema, merge_patch, validate_batch
from kg.ontology_presets import _assemble, _profile
from kg.schema import prepare_entity, prepare_relation
from research_adapter import ResearchKnowledge, digest, encoded, storage_key


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

    def test_each_audience_has_an_independent_native_namespace_overlay_and_home(self):
        profile = self.profiles[0]
        root, store, _ = self.build(profile)
        shared_driver = object()
        store.driver = shared_driver
        first_id, second_id = "a16f12ee-2e2e-40e0-8c6b-aace49832a01", "b16f12ee-2e2e-40e0-8c6b-aace49832a02"
        with TemporaryDirectory(dir=ROOT / "artifacts", prefix="kg-workspace-test-") as directory:
            root.config = replace(root.config, home=Path(directory))
            first, second = root.workspace(first_id), root.workspace(second_id)
            self.assertIs(root.workspace(first_id), first)
            self.assertNotEqual(first.config.urn_prefix, second.config.urn_prefix)
            self.assertNotEqual(first.config.home, second.config.home)
            self.assertTrue(first.config.home.is_dir())
            self.assertEqual(first.config.user_person_urn, first.config.urn_prefix + "person-self")
            self.assertIs(first.store.driver, shared_driver)
            self.assertFalse(first.store._owns_driver)
            self.assertNotEqual(first.uri("alice:claim", "claim"), second.uri("alice:claim", "claim"))

    def test_fresh_audience_exports_seed_after_another_audience_changes_schema_calendar_and_material(self):
        profile = self.profiles[0]
        root, store, _ = self.build(profile)
        store.driver = object()
        with TemporaryDirectory(dir=ROOT / "artifacts", prefix="kg-workspace-test-") as directory:
            root.config = replace(root.config, home=Path(directory))
            first = root.workspace("a16f12ee-2e2e-40e0-8c6b-aace49832a01")
            second = root.workspace("b16f12ee-2e2e-40e0-8c6b-aace49832a02")

            def load_seed(adapter):
                state, _, _ = _assemble(adapter.config, {"version": 0, "patch": {}}, _profile())
                operations = adapter.schema_operations(profile, effective_schema(adapter.config, state))
                for offset in range(0, len(operations), 32):
                    state, _ = merge_patch(adapter.config, state, {}, operations[offset:offset + 32])
                    state["version"] += 1
                adapter.store.ontology_overlay = lambda: state
                rows, edges = self.records(adapter, profile, state)
                adapter.package = lambda: {"source_json": encoded(profile), "state": "ready"}
                adapter.read_records = lambda: (rows, edges)
                return rows, state

            first_rows, first_state = load_seed(first)
            load_seed(second)
            claim_key = storage_key("entity_types", "alice:ResearchClaim")
            changed, _ = merge_patch(first.config, first_state, {"entity_types": {claim_key: {"label": "First audience edited claim", "description": "Scoped first-audience research claim."}}})
            changed["version"] += 1
            first.store.ontology_overlay = lambda: changed
            next(row["properties"] for row in first_rows if row["properties"]["x_res_kind"] == "calendar")["x_res_status"] = "Busy"
            next(row["properties"] for row in first_rows if row["properties"]["x_res_key"] == "alice:public-intro")["x_res_content_summary"] = "First audience private revision"
            first_export, second_export = first.profile(), second.profile()
            edited_claim = next(term for module in first_export["profile"]["ontology"]["modules"] for term in module["concepts"] if term["id"] == "alice:ResearchClaim")
            clean_claim = next(term for module in second_export["profile"]["ontology"]["modules"] for term in module["concepts"] if term["id"] == "alice:ResearchClaim")
            self.assertEqual(edited_claim["label"], "First audience edited claim")
            self.assertNotEqual(edited_claim["label"], clean_claim["label"])
            clean_intro = next(item for item in second_export["profile"]["materials"] if item["id"] == "alice:public-intro")
            seed_intro = next(item for item in profile["materials"] if item["id"] == "alice:public-intro")
            self.assertEqual(clean_intro["fields"], seed_intro["fields"])
            self.assertEqual(second_export["profile"]["calendar"], profile["calendar"])
            self.assertEqual(second_export["provenance"]["seedHash"], digest(profile))
            self.assertNotEqual(first_export["provenance"]["namespace"], second_export["provenance"]["namespace"])

    def test_workspace_seed_is_resumable_but_cannot_silently_overwrite_its_initial_conditions(self):
        profile = self.profiles[0]
        adapter, _, _ = self.build(profile)
        adapter.workspace_id = "a16f12ee-2e2e-40e0-8c6b-aace49832a01"
        adapter.package = lambda: {"source_json": encoded(profile), "state": "ready"}
        adapter.profile = lambda: {"role": "Alice", "resumed": True}
        self.assertEqual(adapter.seed(profile), {"role": "Alice", "resumed": True})
        changed = json.loads(encoded(profile))
        changed["calendar"][0]["status"] = "Changed"
        with self.assertRaises(Exception) as conflict:
            adapter.seed(changed)
        self.assertEqual(conflict.exception.status_code, 409)

    def test_workspace_adapter_rejects_invalid_paths_and_cross_audience_write_intents(self):
        adapter, _, _ = self.build(self.profiles[0])
        for identity in ["../alice", "not-an-audience", "", "A16F12EE-2E2E-40E0-8C6B-AACE49832A01"]:
            with self.assertRaises(Exception) as invalid:
                adapter.workspace(identity)
            self.assertEqual(invalid.exception.status_code, 422)
        adapter.workspace_id = "a16f12ee-2e2e-40e0-8c6b-aace49832a01"
        other = "b16f12ee-2e2e-40e0-8c6b-aace49832a02"
        with self.assertRaises(Exception) as invalid:
            adapter.record(other, [], [])
        self.assertEqual(invalid.exception.status_code, 409)
        with self.assertRaises(Exception) as invalid:
            adapter.project({"workspaceId": other, "id": 1})
        self.assertEqual(invalid.exception.status_code, 409)

    def test_global_memory_receipts_do_not_collide_for_identical_audience_seeds_or_role_event_numbers(self):
        # KGStore._read_receipt looks up KGSyncReceipt by snapshot_id globally,
        # and rejects reuse from another namespace. Exercise that actual
        # boundary with one shared registry, not one fake registry per adapter.
        receipts, packages, adapters = {}, {}, []
        audience_ids = ["a16f12ee-2e2e-40e0-8c6b-aace49832a01", "b16f12ee-2e2e-40e0-8c6b-aace49832a02"]

        def bind(profile, audience_id):
            adapter, store, _ = self.build(profile)
            adapter.config = replace(adapter.config,
                urn_prefix=f"urn:research:{profile['role'].lower()}:experience-{audience_id}:", user_person_urn=None)
            adapter.workspace_id = audience_id
            namespace = adapter.config.urn_prefix
            adapter.package = lambda: packages.get(namespace)
            adapter.save_package = lambda value, state: packages.update({namespace: {"source_json": encoded(value), "state": state}})
            adapter.install_schema = lambda value: None
            adapter.profile = lambda: {"role": adapter.role, "namespace": namespace}

            def write(entities, relations, *, operation_id, **kwargs):
                snapshot_id = "operation-" + operation_id
                payload = digest([entities, relations])
                if snapshot_id in receipts:
                    previous_namespace, previous_payload = receipts[snapshot_id]
                    if previous_namespace != namespace:
                        raise ValueError("Snapshot belongs to another namespace")
                    if previous_payload != payload:
                        raise ValueError("Snapshot already exists with a different extraction payload")
                    return {"idempotent": True}
                receipts[snapshot_id] = (namespace, payload)
                return {"idempotent": False}

            store.write_batch = write
            return adapter

        for audience_id in audience_ids:
            for profile in self.profiles:
                adapter = bind(profile, audience_id)
                adapters.append(adapter)
                adapter.seed(profile)
                adapter.project({"workspaceId": audience_id, "id": 1, "topic": "policy", "recordId": "standing-rule"})
                adapter.record(audience_id, [profile["knowledge"]["nodes"][0]], [])
        self.assertEqual(len(receipts), 12)
        for kind in ["schema", "profile", "projection", "memory"]:
            self.assertEqual(len({adapter.operation_id(kind, "identical-logical-input") for adapter in adapters}), 4)
            self.assertEqual(adapters[0].operation_id(kind, "identical-logical-input"), adapters[0].operation_id(kind, "identical-logical-input"))


if __name__ == "__main__":
    unittest.main()

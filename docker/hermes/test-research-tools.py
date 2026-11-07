"""Offline boundary checks for the native Hermes research plugin."""
import importlib.util
import ast
import io
import json
import hashlib
import copy
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("research_tools", Path(__file__).with_name("research-tools.py"))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
TEST_ROOT = Path(__file__).resolve().parents[2] / "tmp" / "research-plugin-tests"
TEST_ROOT.mkdir(parents=True, exist_ok=True)


def temporary_home():
    # The absolute parent is an explicitly named repository test workspace;
    # TemporaryDirectory only removes its own random child beneath this root.
    return tempfile.TemporaryDirectory(dir=TEST_ROOT)


class ResearchToolsTests(unittest.TestCase):
    def setUp(self):
        plugin._sessions.clear()
        plugin._retired.clear()
        self.environment = patch.dict(os.environ, {"DEMO_HERMES_ROLE": "Alice"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_session_pins_assignment_once_and_never_retargets_old_run(self):
        calls = []
        assignment = {"assignmentId": "assignment-first", "role": "Alice", "taskId": "task-first"}

        def gateway(route, payload=None):
            calls.append((route, payload))
            return dict(assignment) if payload is None else {"ok": True}

        with patch.object(plugin, "_request", gateway):
            plugin._on_session_start(session_id="session-1", platform="api_server")
            handler = plugin._handler("task_status")
            self.assertTrue(json.loads(handler({}, session_id="session-1"))["ok"])
            assignment["assignmentId"] = "assignment-second"
            self.assertTrue(json.loads(handler({}, session_id="session-1"))["ok"])
            sends = [payload for _, payload in calls if payload is not None]
            self.assertEqual([row["assignmentId"] for row in sends], ["assignment-first", "assignment-first"])
            self.assertEqual(sum(payload is None for _, payload in calls), 1)
            plugin._on_session_end(session_id="session-1", platform="api_server")
            self.assertFalse(json.loads(handler({}, session_id="session-1"))["ok"])

    def test_absent_or_wrong_role_context_is_never_bound(self):
        for value in [{}, {"assignmentId": "wrong-role", "role": "Bob"}]:
            with patch.object(plugin, "_request", return_value=value):
                self.assertFalse(json.loads(plugin._handler("task_status")({}, session_id="new"))["ok"])
        with patch.object(plugin, "_request", side_effect=AssertionError("Must not fetch without native identity")):
            self.assertFalse(json.loads(plugin._handler("task_status")({}))["ok"])

    def test_model_cannot_supply_identity_credentials_or_gateway(self):
        with patch.object(plugin, "_request", side_effect=AssertionError("Identity input must fail before dispatch")):
            for key in ["owner", "ownerId", "role", "taskId", "workspaceId", "assignmentId", "token", "url"]:
                result = json.loads(plugin._handler("task_status")({key: "forged"}, session_id="session"))
                self.assertFalse(result["ok"])
                self.assertNotIn("forged", json.dumps(result))

    def test_read_only_skill_tools_reject_path_traversal(self):
        with temporary_home() as home, patch.dict(os.environ, {"HERMES_HOME": home}):
            folder = Path(home) / "skills" / "research" / "research-brief"
            folder.mkdir(parents=True)
            (folder / "SKILL.md").write_text("---\nname: research-brief\ndescription: Prepare an evidence-linked brief\n---\nUse knowledge_search.\n", encoding="utf-8")
            plugin._sessions["session"] = {"assignmentId": "a", "role": "Alice"}
            catalog = json.loads(plugin._skills_list({}, session_id="session"))
            self.assertEqual(catalog["skills"][0]["name"], "research-brief")
            self.assertIn("knowledge_search", json.loads(plugin._skill_view({"name": "research-brief"}, session_id="session"))["content"])
            for name in ["../research-brief", "research-brief/SKILL.md", "C:\\secret", "unknown"]:
                self.assertFalse(json.loads(plugin._skill_view({"name": name}, session_id="session"))["ok"])

    def test_registration_and_hook_only_allow_the_native_tool_surface(self):
        class Context:
            def __init__(self):
                self.tools = {}
                self.hooks = {}

            def register_tool(self, **kwargs):
                self.tools[kwargs["name"]] = kwargs

            def register_hook(self, name, callback):
                self.hooks[name] = callback

        context = Context()
        plugin.register(context)
        self.assertEqual(len(context.tools), 21)
        self.assertTrue(all(value["toolset"] == "research" for value in context.tools.values()))
        self.assertIsNone(context.hooks["pre_tool_call"](tool_name="knowledge_search"))
        for tool in ["terminal", "skill_manage", "kg_write", "web_extract", "browser_exec", "write_file"]:
            self.assertEqual(context.hooks["pre_tool_call"](tool_name=tool)["action"], "block")

    def test_gateway_accepts_array_tool_results_without_changing_assignment_contract(self):
        opener = Mock()
        opener.open.return_value = io.BytesIO(b'[{"id":"room-a","capacity":8}]')
        with patch.object(plugin, "_configuration", return_value=("http://demo:4330", "Alice", "a" * 64)), patch.object(plugin, "build_opener", return_value=opener):
            self.assertEqual(plugin._request("/api/research/agent-tools", {"name": "resource_search", "arguments": {}}), [{"id": "room-a", "capacity": 8}])
        with patch.object(plugin, "_request", return_value=[]):
            with self.assertRaises(ValueError):
                plugin._bind("bad-context")

    def test_safe_controller_validation_messages_support_native_recovery_without_server_error_leakage(self):
        plugin._sessions["session"] = {"assignmentId": "a", "role": "Alice"}
        for status, message in [(404, "Reload task_status and choose a sourceResources id."), (503, "private-provider-response")]:
            error = HTTPError("http://demo:4330", status, "rejected", {}, io.BytesIO(json.dumps({"error": {"code": "RESEARCH_SOURCE", "message": message}}).encode()))
            with patch.object(plugin, "_request", side_effect=error):
                result = json.loads(plugin._handler("peer_send")({"resourceId": "unknown"}, session_id="session"))
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "RESEARCH_SOURCE")
            if status < 500:
                self.assertEqual(result["error"]["message"], message)
            else:
                self.assertNotIn(message, json.dumps(result))

    def test_configuration_limits_credential_destination_and_input_size(self):
        with temporary_home() as home:
            token = Path(home) / "service.token"
            token.write_text("a" * 64, encoding="ascii")
            with patch.dict(os.environ, {"DEMO_RESEARCH_TOKEN_FILE": str(token), "DEMO_RESEARCH_GATEWAY_URL": "http://demo:4330"}):
                self.assertEqual(plugin._configuration(), ("http://demo:4330", "Alice", "a" * 64))
                for origin in ["https://example.com", "http://demo:4330?key=token", "http://u:p@demo:4330", "http://demo:4330/path"]:
                    with patch.dict(os.environ, {"DEMO_RESEARCH_GATEWAY_URL": origin}):
                        with self.assertRaises(ValueError):
                            plugin._configuration()
                with self.assertRaises(ValueError):
                    plugin._request("/api/research/agent-tools", {"data": "x" * (plugin.MAX_BYTES + 1)})

    def test_fresh_profile_seeds_model_before_stock_entrypoint_and_preserves_owner_model(self):
        # configure-profile imports Linux/Hermes-only startup modules. Execute its
        # actual pure model initializer independently on Windows as well.
        source = ast.parse(Path(__file__).with_name("configure-profile.py").read_text(encoding="utf-8"))
        initializer = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "configure_model")
        seed = {"model": {"provider": "minimax-cn", "default": "MiniMax-M3.1-Flash", "streaming": False}}
        namespace = {"Path": Path, "require_readable_config_before_write": lambda _path: json.loads(json.dumps(seed))}
        exec(compile(ast.Module(body=[initializer], type_ignores=[]), "configure-profile.py", "exec"), namespace)
        configure_model = namespace["configure_model"]
        for value in [{}, {"model": None}, {"model": {}}, {"model": {"default": ""}}, {"model": {"default": "hermes-demo-fixture"}}]:
            self.assertTrue(configure_model(value))
            self.assertEqual(value["model"], seed["model"])
        configured = {"model": {"provider": "custom", "default": "owner-model", "streaming": True}}
        self.assertFalse(configure_model(configured))
        self.assertEqual(configured["model"], {"provider": "custom", "default": "owner-model", "streaming": True})

    def test_native_profile_loads_concrete_schemas_without_the_deferred_bridge(self):
        source = ast.parse(Path(__file__).with_name("configure-profile.py").read_text(encoding="utf-8"))
        initializer = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "configure_research_tool_search")
        namespace = {}
        exec(compile(ast.Module(body=[initializer], type_ignores=[]), "configure-profile.py", "exec"), namespace)
        for config in [{}, {"tools": None}, {"tools": {"other_setting": True, "tool_search": {"enabled": "on", "defer": ["knowledge_search"]}}}]:
            namespace["configure_research_tool_search"](config)
            self.assertEqual(config["tools"]["tool_search"], {"enabled": "off", "defer": []})
        self.assertTrue(config["tools"]["other_setting"])
        self.assertEqual(plugin._pre_tool_call(tool_name="tool_call")["action"], "block")

    def test_research_gateway_never_injects_global_profile_memory_into_a_new_experience(self):
        source = ast.parse(Path(__file__).with_name("configure-profile.py").read_text(encoding="utf-8"))
        initializer = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "configure_research_memory")
        namespace = {}
        exec(compile(ast.Module(body=[initializer], type_ignores=[]), "configure-profile.py", "exec"), namespace)
        config = {"memory": {"provider": "kg", "memory_enabled": True, "user_profile_enabled": True}}
        namespace["configure_research_memory"](config)
        self.assertEqual(config["memory"], {"provider": "builtin", "memory_enabled": False, "user_profile_enabled": False})

    def test_workspace_seed_is_exactly_the_gateway_role_and_not_a_peer_directory(self):
        source = ast.parse(Path(__file__).with_name("configure-profile.py").read_text(encoding="utf-8"))
        initializer = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "research_workspace_seed")
        namespace = {"Path": Path, "os": os, "json": json, "hashlib": hashlib}
        exec(compile(ast.Module(body=[initializer], type_ignores=[]), "configure-profile.py", "exec"), namespace)
        with temporary_home() as home, patch.dict(os.environ, {"DEMO_WORKSPACE_ROOT": home}):
            (Path(home) / "skills" / "fixture").mkdir(parents=True)
            skill = Path(home) / "skills" / "fixture" / "SKILL.md"
            skill.write_text("Own skill", encoding="utf-8")
            manifest = Path(home) / "manifest.json"
            manifest.write_text(json.dumps({"role": "Alice", "files": {"skills/fixture/SKILL.md": {"sha256": hashlib.sha256(skill.read_bytes()).hexdigest()}}}), encoding="utf-8")
            self.assertEqual(namespace["research_workspace_seed"]("Alice"), Path(home))
            with self.assertRaises(ValueError):
                namespace["research_workspace_seed"]("Bob")
            skill.write_text("Changed without versioning", encoding="utf-8")
            with self.assertRaises(ValueError):
                namespace["research_workspace_seed"]("Alice")

    def test_existing_hermes_category_description_does_not_break_workspace_reinitialization(self):
        source = ast.parse(Path(__file__).with_name("configure-profile.py").read_text(encoding="utf-8"))
        initializer = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "research_skill_folders")
        namespace = {}
        exec(compile(ast.Module(body=[initializer], type_ignores=[]), "configure-profile.py", "exec"), namespace)
        with temporary_home() as home:
            root = Path(home)
            (root / "DESCRIPTION.md").write_text("Hermes generated category description", encoding="utf-8")
            (root / "research-brief").mkdir()
            self.assertEqual([p.name for p in namespace["research_skill_folders"](root)], ["research-brief"])
            (root / "unexpected.txt").write_text("Unexpected content", encoding="utf-8")
            with self.assertRaises(ValueError):
                list(namespace["research_skill_folders"](root))

    def test_collaboration_schema_requires_agent_authored_mappings_and_explicit_peer_review(self):
        proposal = plugin.SCHEMAS["alignment_propose"][1]
        self.assertNotIn("mappingIds", proposal["properties"])
        self.assertEqual(proposal["required"], ["mappings"])
        mapping = proposal["properties"]["mappings"]["items"]
        self.assertTrue({"source", "target", "relation", "reason"}.issubset(mapping["required"]))
        review = plugin.SCHEMAS["alignment_accept"][1]
        self.assertEqual(review["properties"]["decision"]["enum"], ["accept", "reject"])
        self.assertTrue({"proposalId", "decision", "reason"}.issubset(review["required"]))
        self.assertTrue({"ontology", "capabilities"}.issubset(plugin.SCHEMAS["peer_request"][1]["properties"]["kind"]["enum"]))

    def test_artifact_fields_explicitly_require_text_for_drafts_and_revisions(self):
        for name in ("artifact_prepare", "artifact_revise"):
            fields = plugin.SCHEMAS[name][1]["properties"]["fields"]
            self.assertEqual(fields["type"], "object")
            self.assertEqual(fields["additionalProperties"], {"type": "string"}, name)
        self.assertIn("attendees", plugin.SCHEMAS["artifact_prepare"][1]["properties"]["fields"]["description"])

    def test_knowledge_updates_expose_the_existing_engine_version_lock(self):
        node = plugin.SCHEMAS["knowledge_record"][1]["properties"]["nodes"]["items"]
        self.assertNotIn("expectedVersion", node["required"], "New records do not have a prior version")
        version = node["properties"]["expectedVersion"]
        alternatives = {item["type"]: item for item in version["anyOf"]}
        self.assertEqual(set(alternatives), {"string", "integer"})
        self.assertEqual(alternatives["string"]["minLength"], 1)
        self.assertLessEqual(alternatives["string"]["maxLength"], 100)
        self.assertEqual(alternatives["integer"]["minimum"], 1)
        self.assertLessEqual(alternatives["integer"]["maximum"], 9007199254740991)
        self.assertFalse(node["additionalProperties"], "Only the declared optimistic-lock argument is added")

    def test_numeric_draft_fields_become_json_text_without_mutating_caller_arguments(self):
        plugin._sessions["session"] = {"assignmentId": "a", "role": "Alice"}
        for name in ("artifact_prepare", "artifact_revise"):
            args = {"kind": "reservation", "fields": {"attendees": 2, "score": 0.82, "decimal": 2.0,
                "day": "Thu", "time": "15:00–15:30"}, "expectedVersion": 1}
            original = copy.deepcopy(args)
            with patch.object(plugin, "_request", return_value={"id": "draft-1"}) as request:
                result = json.loads(plugin._handler(name)(args, session_id="session"))
            self.assertEqual(result["id"], "draft-1")
            sent = request.call_args.args[1]["arguments"]
            self.assertEqual(sent["fields"], {"attendees": "2", "score": "0.82", "decimal": "2.0", "day": "Thu", "time": "15:00–15:30"})
            self.assertEqual(sent["expectedVersion"], 1)
            self.assertEqual(args, original)
            self.assertIsNot(sent, args)
            self.assertIsNot(sent["fields"], args["fields"])

    def test_draft_numeric_repair_never_changes_typed_knowledge_or_execution_arguments(self):
        args = {"nodes": [{"id": "alice:example", "properties": {"minutes": 30, "value": 0.82}}],
            "fields": {"attendees": 2}}
        original = copy.deepcopy(args)
        for name in ("knowledge_record", "authorization_check", "authorization_request", "peer_send", "reservation_submit"):
            self.assertIs(plugin._draft_text_arguments(name, args), args)
            self.assertEqual(args, original)

    def test_invalid_draft_containers_booleans_and_nonfinite_values_remain_invalid(self):
        fields = {"attendees": 2, "flag": True, "nested": {"count": 3}, "items": [4], "nan": float("nan"), "infinity": float("inf")}
        fixed = plugin._draft_text_arguments("artifact_prepare", {"fields": fields})["fields"]
        self.assertEqual(fixed["attendees"], "2")
        self.assertIs(fixed["flag"], True)
        self.assertEqual(fixed["nested"], {"count": 3})
        self.assertEqual(fixed["items"], [4])
        self.assertTrue(math.isnan(fixed["nan"]))
        self.assertEqual(fixed["infinity"], float("inf"))
        with self.assertRaises(ValueError):
            json.dumps(fixed, allow_nan=False)

    def test_new_reservation_reuses_supplied_title_without_mutating_caller(self):
        args = {"kind": "reservation", "title": "Academic discussion", "fields": {
            "day": "Thu", "time": "15:00–15:30", "attendees": "2", "agenda": "Review findings"}}
        original = copy.deepcopy(args)
        fixed = plugin._draft_text_arguments("artifact_prepare", args)
        self.assertEqual(fixed["fields"], {**original["fields"], "title": original["title"]})
        self.assertEqual(args, original)
        self.assertIsNot(fixed, args)
        self.assertIsNot(fixed["fields"], args["fields"])
        self.assertIn("copied", plugin.SCHEMAS["artifact_prepare"][1]["properties"]["fields"]["description"])

    def test_reservation_title_reuse_never_overwrites_or_repairs_other_inputs(self):
        base = {"kind": "reservation", "title": "Outer title", "fields": {"attendees": "2"}}
        for explicit in ["Field title", "", None, 2, {"title": "nested"}]:
            args = {**base, "fields": {**base["fields"], "title": explicit}}
            fixed = plugin._draft_text_arguments("artifact_prepare", args)
            # The existing numeric text adapter still applies, but the outer
            # title must never replace any explicitly supplied field value.
            self.assertEqual(fixed["fields"]["title"], "2" if explicit == 2 else explicit)
            self.assertEqual(args["fields"]["title"], explicit)
        for name, kind, title in [("artifact_revise", "reservation", "Outer title"),
                ("artifact_prepare", "agenda", "Outer title"),
                ("artifact_prepare", "brief", "Outer title"),
                ("artifact_prepare", "reservation", ""),
                ("artifact_prepare", "reservation", "   "),
                ("artifact_prepare", "reservation", "x" * 201),
                ("artifact_prepare", "reservation", 2),
                ("artifact_prepare", "reservation", None)]:
            args = {**base, "kind": kind, "title": title}
            self.assertIs(plugin._draft_text_arguments(name, args), args)
            self.assertNotIn("title", args["fields"])


if __name__ == "__main__":
    unittest.main()

"""Offline boundary checks for the native Hermes research plugin."""
import importlib.util
import ast
import io
import json
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


if __name__ == "__main__":
    unittest.main()

"""The API proposal policy must retain native chat recall and tool behavior."""
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest


class NativeProvider:
    def initialize(self, session_id, **kwargs):
        self.calls = []

    def system_prompt_block(self):
        return "Native memory instructions"

    def get_tool_schemas(self):
        return [{"name": "kg_write"}]

    def prefetch(self, query, **kwargs):
        self.calls.append("recall")
        return "Historical memory"

    def handle_tool_call(self, name, args, **kwargs):
        self.calls.append("write")
        return "Native write receipt"

    def sync_turn(self, *args, **kwargs):
        self.calls.append("sync")


provider = types.ModuleType("kg.provider")
provider.KGMemoryProvider = NativeProvider
sys.modules["kg"] = types.ModuleType("kg")
sys.modules["kg.provider"] = provider
spec = importlib.util.spec_from_file_location("kg.demo_policy", Path(__file__).with_name("kg-proposal-policy.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PolicyTests(unittest.TestCase):
    def test_api_proposal_cannot_recall_write_or_enqueue_old_round_data(self):
        memory = module.DemoKGMemoryProvider()
        memory.initialize("round-2", platform="api_server")
        self.assertEqual(memory.system_prompt_block(), "")
        self.assertEqual(memory.get_tool_schemas(), [])
        self.assertEqual(memory.prefetch("Remember last round"), "")
        self.assertFalse(json.loads(memory.handle_tool_call("kg_write", {}))["ok"])
        memory.sync_turn("input", "output")
        self.assertEqual(memory.calls, [])

    def test_native_chat_keeps_the_real_provider_behavior(self):
        memory = module.DemoKGMemoryProvider()
        memory.initialize("native-chat", platform="cli")
        self.assertEqual(memory.system_prompt_block(), "Native memory instructions")
        self.assertEqual(memory.get_tool_schemas(), [{"name": "kg_write"}])
        self.assertEqual(memory.prefetch("Remember last round"), "Historical memory")
        self.assertEqual(memory.handle_tool_call("kg_write", {}), "Native write receipt")
        memory.sync_turn("input", "output")
        self.assertEqual(memory.calls, ["recall", "write", "sync"])


if __name__ == "__main__":
    unittest.main()

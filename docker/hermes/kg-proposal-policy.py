"""Use explicit task snapshots for API proposals and native KG memory for chat."""
import json

from .provider import KGMemoryProvider


class DemoKGMemoryProvider(KGMemoryProvider):
    def initialize(self, session_id, **kwargs):
        self._demo_proposal = kwargs.get("platform") == "api_server"
        return super().initialize(session_id, **kwargs)

    def system_prompt_block(self):
        return "" if getattr(self, "_demo_proposal", False) else super().system_prompt_block()

    def get_tool_schemas(self):
        return [] if getattr(self, "_demo_proposal", False) else super().get_tool_schemas()

    def prefetch(self, query, *, session_id=""):
        if getattr(self, "_demo_proposal", False):
            return ""
        return super().prefetch(query, session_id=session_id)

    def handle_tool_call(self, tool_name, args, **kwargs):
        if getattr(self, "_demo_proposal", False):
            return json.dumps({"ok": False, "error": "Demo proposals use the approved task snapshot; the controller commits confirmed receipts."})
        return super().handle_tool_call(tool_name, args, **kwargs)

    def sync_turn(self, user_content, assistant_content, **kwargs):
        if getattr(self, "_demo_proposal", False):
            return
        return super().sync_turn(user_content, assistant_content, **kwargs)

"""Install the native KG provider with the demo's API proposal boundary."""
from pathlib import Path
import sys

_vendor = Path(__file__).resolve().parent / "_vendor"
if _vendor.is_dir() and str(_vendor) not in sys.path:
    sys.path.insert(0, str(_vendor))


def register(ctx):
    from .demo_policy import DemoKGMemoryProvider
    ctx.register_memory_provider(DemoKGMemoryProvider())

import json
from pathlib import Path
import urllib.request


def main():
    try:
        key = Path("/run/demo-gateway-auth/key").read_text(encoding="ascii").strip()
        request = urllib.request.Request(
            "http://127.0.0.1:8642/health/detailed",
            headers={"Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            health = json.load(response)
        return 0 if health["platform"] == "hermes-agent" and health["readiness"]["status"] == "ok" else 1
    except (KeyError, OSError, TypeError, ValueError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

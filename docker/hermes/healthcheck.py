import json
import os
import urllib.request


def main():
    try:
        key = os.environ["API_SERVER_KEY"]
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

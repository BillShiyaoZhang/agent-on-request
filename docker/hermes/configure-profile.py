"""Seed the local demo provider without copying the source Hermes profile."""

import os
from pathlib import Path
import pwd
import re
import sys

sys.path.insert(0, "/opt/hermes")
from hermes_cli.config import load_env, require_readable_config_before_write, save_config, save_env_value


def main():
    home = Path("/opt/data")
    if Path(os.environ["HERMES_HOME"]).resolve() != home:
        raise ValueError("Unexpected profile path")
    key = sys.stdin.read(1024).strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{16,512}", key):
        raise ValueError("Invalid MiniMax credential")

    config_path = home / "config.yaml"
    env_path = home / ".env"
    if any(path.is_symlink() for path in (config_path, env_path)):
        raise ValueError("Unexpected profile symlink")
    config = require_readable_config_before_write(config_path)

    if not load_env().get("MINIMAX_CN_API_KEY"):
        save_env_value("MINIMAX_CN_API_KEY", key)
        make_private(env_path)

    model = config.get("model")
    if isinstance(model, dict) and model.get("default") == "hermes-demo-fixture":
        seed = require_readable_config_before_write(Path("/opt/hermes/cli-config.yaml.example"))
        config["model"] = seed["model"]
        save_config(config, strip_defaults=False)
        make_private(config_path)


def make_private(path):
    owner = pwd.getpwnam("hermes")
    os.chown(path, owner.pw_uid, owner.pw_gid)
    os.chmod(path, 0o600)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Could not configure the Docker Hermes profile ({type(error).__name__}).", file=sys.stderr)
        raise SystemExit(1) from None

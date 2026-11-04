"""Configure an isolated demo profile, then run the stock Hermes entrypoint."""

import os
from pathlib import Path
import pwd
import re
import secrets
import sys
from tempfile import NamedTemporaryFile

sys.path.insert(0, "/opt/hermes")
from hermes_cli.config import load_env, require_readable_config_before_write, save_config, save_env_value

MINIMAX_SECRET = Path("/run/secrets/minimax_cn_api_key")
GATEWAY_KEY = Path("/run/demo-gateway-auth/key")
HERMES_ENTRYPOINT = "/opt/hermes/docker/entrypoint-dispatch.sh"
# The demo container runs as the official Node image's unprivileged user.
DEMO_UID = 1000
DEMO_GID = 1000


def main():
    home = Path("/opt/data")
    if Path(os.environ["HERMES_HOME"]).resolve() != home:
        raise ValueError("Unexpected profile path")
    minimax_key = read_key(MINIMAX_SECRET)
    if not re.fullmatch(r"[A-Za-z0-9._-]{16,512}", minimax_key):
        print("Set a valid MINIMAX_CN_API_KEY in the project .env.", file=sys.stderr)
        raise SystemExit(1)

    if GATEWAY_KEY.is_symlink() or GATEWAY_KEY.parent.is_symlink():
        raise ValueError("Unexpected gateway auth symlink")
    saved_gateway_key = read_key(GATEWAY_KEY) if GATEWAY_KEY.exists() else None
    owner = pwd.getpwnam("hermes")

    # Native config writers can create profile directories. Use the existing
    # owner when it is already correct; otherwise stock startup fixes ownership.
    uid, gid = os.geteuid(), os.getegid()
    use_hermes_owner = uid == 0 and home.stat().st_uid == owner.pw_uid
    if use_hermes_owner:
        os.setegid(owner.pw_gid)
        os.seteuid(owner.pw_uid)
    try:
        gateway_key = configure_profile(home, minimax_key, saved_gateway_key, owner)
    finally:
        if use_hermes_owner:
            os.seteuid(uid)
            os.setegid(gid)

    publish_gateway_key(gateway_key)
    os.execv(HERMES_ENTRYPOINT, [HERMES_ENTRYPOINT, *sys.argv[1:]])


def configure_profile(home, minimax_key, saved_gateway_key, owner):
    config_path = home / "config.yaml"
    env_path = home / ".env"
    if config_path.is_symlink() or env_path.is_symlink():
        raise ValueError("Unexpected profile symlink")
    config = require_readable_config_before_write(config_path)
    profile_env = load_env()

    gateway_key = profile_env.get("API_SERVER_KEY") or saved_gateway_key or secrets.token_hex(32)
    if not re.fullmatch(r"[!-~]{16,512}", gateway_key):
        raise ValueError("Invalid gateway credential")

    if profile_env.get("MINIMAX_CN_API_KEY") != minimax_key:
        save_env_value("MINIMAX_CN_API_KEY", minimax_key)
        make_private(env_path, owner)
    if profile_env.get("API_SERVER_KEY") != gateway_key:
        save_env_value("API_SERVER_KEY", gateway_key)
        make_private(env_path, owner)

    model = config.get("model")
    if isinstance(model, dict) and model.get("default") == "hermes-demo-fixture":
        seed = require_readable_config_before_write(Path("/opt/hermes/cli-config.yaml.example"))
        config["model"] = seed["model"]
        save_config(config, strip_defaults=False)
        make_private(config_path, owner)

    return gateway_key


def read_key(path):
    with path.open(encoding="ascii") as stream:
        return stream.read(1024).strip()


def publish_gateway_key(key):
    temporary_path = None
    try:
        with NamedTemporaryFile(mode="w", encoding="ascii", dir=GATEWAY_KEY.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(key + "\n")
            temporary.flush()
            os.fchown(temporary.fileno(), DEMO_UID, DEMO_GID)
            os.fchmod(temporary.fileno(), 0o400)
            os.fsync(temporary.fileno())
        os.replace(temporary_path, GATEWAY_KEY)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def make_private(path, owner):
    if os.geteuid() == 0:
        os.chown(path, owner.pw_uid, owner.pw_gid)
    os.chmod(path, 0o600)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Could not configure the Docker Hermes profile ({type(error).__name__}).", file=sys.stderr)
        raise SystemExit(1) from None

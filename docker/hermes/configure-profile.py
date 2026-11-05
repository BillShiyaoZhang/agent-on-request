"""Configure an isolated demo profile, then run the stock Hermes entrypoint."""

import os
import json
from pathlib import Path
import pwd
import re
import secrets
import shutil
import site
import sys
from tempfile import NamedTemporaryFile

sys.path.insert(0, "/opt/hermes")
for packages in Path("/opt/hermes/.venv/lib").glob("python*/site-packages"):
    site.addsitedir(str(packages))
from hermes_cli.config import load_env, require_readable_config_before_write, save_config, save_env_value

MINIMAX_SECRET = Path("/run/secrets/minimax_cn_api_key")
GATEWAY_KEY = Path("/run/demo-gateway-auth/key")
KG_TOKEN = Path("/run/demo-gateway-auth/kg-token")
KG_SERVICE_TOKEN = Path("/run/demo-gateway-auth/kg-service-token")
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
        gateway_key, kg_token, kg_service_token = configure_profile(home, minimax_key, saved_gateway_key, owner)
    finally:
        if use_hermes_owner:
            os.seteuid(uid)
            os.setegid(gid)

    publish_gateway_key(gateway_key, GATEWAY_KEY)
    publish_gateway_key(kg_token, KG_TOKEN)
    publish_gateway_key(kg_service_token, KG_SERVICE_TOKEN)
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
    changed = False
    if isinstance(model, dict) and model.get("default") == "hermes-demo-fixture":
        seed = require_readable_config_before_write(Path("/opt/hermes/cli-config.yaml.example"))
        config["model"] = seed["model"]
        changed = True

    role = os.environ.get("DEMO_HERMES_ROLE")
    if role not in {"Alice", "Bob"}:
        raise ValueError("An exact demo role is required")
    from hermes_cli.profiles import read_profile_meta, write_profile_meta
    if not read_profile_meta(home).get("display_name"):
        write_profile_meta(home, display_name=role)
        make_private(home / "profile.yaml", owner)
    marker = home / ".demo-native-kg-v1"
    kg_token, kg_service_token = configure_kg(home, role, owner, seed_skills=not marker.exists())
    if not marker.exists():
        config.setdefault("memory", {}).update({"provider": "kg", "memory_enabled": True})
        enabled = config.setdefault("plugins", {}).setdefault("enabled", [])
        if "kg" not in enabled:
            enabled.append("kg")
        changed = True
    if changed:
        save_config(config, strip_defaults=False)
        make_private(config_path, owner)
    if not marker.exists():
        marker.write_text("1\n", encoding="ascii")
        make_private(marker, owner)

    return gateway_key, kg_token, kg_service_token


def configure_kg(home, role, owner, *, seed_skills):
    source = Path("/opt/demo-kg")
    for tree in ("plugins/kg", "skills/kg-memory", "skills/kg-memory-sync"):
        destination = home / tree
        if destination.is_symlink():
            raise ValueError("Unexpected KG installation symlink")
        shutil.copytree(source / tree, destination, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "tests"))
        for directory, folders, files in os.walk(destination):
            if os.geteuid() == 0:
                os.chown(directory, owner.pw_uid, owner.pw_gid)
                for name in folders + files:
                    os.chown(Path(directory) / name, owner.pw_uid, owner.pw_gid)

    configuration = home / "kg.json"
    if configuration.is_symlink():
        raise ValueError("Unexpected KG configuration symlink")
    if not configuration.exists():
        prefix = "urn:agent-on-request:" + role.lower() + ":"
        configuration.write_text(json.dumps({
            "enabled": True, "bolt_url": "bolt://neo4j:7687", "user": "neo4j",
            "password": "local-demo-graph-password", "database": "neo4j",
            "urn_prefix": prefix, "user_person_urn": prefix + "person-owner",
            "timezone": "Asia/Shanghai", "default_shared": False,
            "console_url": "http://127.0.0.1:8765"}, indent=2) + "\n", encoding="utf-8")
        make_private(configuration, owner)

    token_path = home / "kg-console.token"
    if token_path.is_symlink():
        raise ValueError("Unexpected KG console token symlink")
    if not token_path.exists():
        token_path.write_text(secrets.token_hex(32) + "\n", encoding="ascii")
        make_private(token_path, owner)
    token = read_key(token_path)
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("Invalid KG console token")
    service_path = home / "kg-service.token"
    if service_path.is_symlink():
        raise ValueError("Unexpected KG service token symlink")
    if not service_path.exists():
        service_path.write_text(secrets.token_hex(32) + "\n", encoding="ascii")
        make_private(service_path, owner)
    service_token = read_key(service_path)
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", service_token) or service_token == token:
        raise ValueError("Invalid or reused KG service token")
    if not seed_skills:
        return token, service_token

    skills = {
        "read_synthetic_calendar": ("Read own synthetic calendar", "Read the current task's own fictional calendar from the KG snapshot."),
        "preview_scoped_calendar": ("Preview a calendar projection", "Prepare the exact selected fields and dates for the owner to review. A preview grants no permission to send."),
        "send_scoped_snapshot": ("Send an approved snapshot", "Send only the snapshot the owner explicitly confirmed through the task controller. Keep the confirmed fields, time window and recipient."),
        "inspect_received_snapshot": ("Inspect received information", "Use only peer information with an actual signed receipt in the current task."),
        "send_scoped_reply": ("Send a scoped reply", "Propose availability from the current task KG snapshot. The controller checks owner policy and approvals before transfer."),
        "share_brief": ("Share a meeting brief", "Propose an optional meeting topic and agenda from the current task snapshot. The owner decides the exact fields before transfer.")}
    allowed = {"Alice": {"read_synthetic_calendar", "preview_scoped_calendar", "send_scoped_snapshot", "inspect_received_snapshot"},
               "Bob": {"read_synthetic_calendar", "send_scoped_reply", "share_brief"}}
    for skill_id in sorted(allowed[role]):
        name, description = skills[skill_id]
        folder = home / "skills" / skill_id
        if folder.is_symlink():
            raise ValueError("Unexpected demo skill symlink")
        folder.mkdir(parents=True, exist_ok=True)
        filename = folder / "SKILL.md"
        if filename.is_symlink():
            raise ValueError("Unexpected demo skill file symlink")
        if not filename.exists():
            filename.write_text(f"---\nname: {skill_id}\ndescription: {description}\n---\n\n# {name}\n\n{description}\n", encoding="utf-8")
            make_private(filename, owner)
        if os.geteuid() == 0:
            os.chown(folder, owner.pw_uid, owner.pw_gid)

    return token, service_token


def read_key(path):
    with path.open(encoding="ascii") as stream:
        return stream.read(1024).strip()


def publish_gateway_key(key, destination):
    temporary_path = None
    try:
        with NamedTemporaryFile(mode="w", encoding="ascii", dir=destination.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(key + "\n")
            temporary.flush()
            os.fchown(temporary.fileno(), DEMO_UID, DEMO_GID)
            os.fchmod(temporary.fileno(), 0o400)
            os.fsync(temporary.fileno())
        os.replace(temporary_path, destination)
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

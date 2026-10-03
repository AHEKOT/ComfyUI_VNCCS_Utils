"""ComfyUI-Manager install policy for the text-to-motion setup buttons.

The browser installs Python packages and code checkouts through ComfyUI-Manager
(``/customnode/install/pip`` and ``/customnode/install/git_url``). Recent Manager
versions only allow those when ``allow_pip_install`` / ``allow_git_url_install`` are
true in its ``config.ini`` *and* ComfyUI listens on a loopback address; older ones
require ``security_level`` weak or normal-. This module only reports that policy so
the panel can tell the user what to change; it never edits Manager's config. The
config lookup is ported from the VNCCS Control Center (AHEKOT/ComfyUI_VNCCS,
``nodes/vnccs_control_center.py``).
"""

from __future__ import annotations

import configparser
import ipaddress
import os

INSTALL_FLAGS = ("allow_pip_install", "allow_git_url_install")
_MAX_CONFIG_BYTES = 256 * 1024
_TRUE = {"1", "true", "yes", "on"}


def manager_config_path() -> str:
    """ComfyUI-Manager's per-user config.ini (the same lookup Manager itself uses)."""
    import folder_paths

    get_system_dir = getattr(folder_paths, "get_system_user_directory", None)
    if callable(get_system_dir):
        manager_dir = get_system_dir("manager")
    else:
        get_user_dir = getattr(folder_paths, "get_user_directory", None)
        if not callable(get_user_dir):
            raise RuntimeError("The ComfyUI user directory is unavailable.")
        manager_dir = os.path.join(get_user_dir(), "__manager")
    return os.path.join(os.path.abspath(os.fspath(manager_dir)), "config.ini")


def read_config_text(path: str) -> str:
    if not os.path.exists(path):
        return ""
    if os.path.islink(path):
        raise RuntimeError("Refusing to use a symlinked ComfyUI-Manager config.")
    if os.path.getsize(path) > _MAX_CONFIG_BYTES:
        raise RuntimeError("ComfyUI-Manager config is unexpectedly large.")
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read(_MAX_CONFIG_BYTES + 1)


def parse_policy(text: str) -> dict:
    values = {"security_level": "normal", **{flag: False for flag in INSTALL_FLAGS}}
    if not text.strip():
        return values
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        parser.read_string(text)
    except configparser.Error as exc:
        raise RuntimeError(f"ComfyUI-Manager config is invalid: {exc}") from exc
    section = next((name for name in parser.sections() if name.lower() == "default"), None)
    if section:
        values["security_level"] = parser[section].get("security_level", "normal").strip().lower()
        for flag in INSTALL_FLAGS:
            values[flag] = parser[section].get(flag, "false").strip().lower() in _TRUE
    return values


def listener_address():
    try:
        from comfy.cli_args import args

        address = getattr(args, "listen", None)
        if address:
            # "--listen 0.0.0.0,::" lists several addresses; any non-loopback one counts.
            return str(address).strip()
    except Exception:
        pass
    return None


def listener_is_loopback(address):
    if not address:
        return None
    parts = [part.strip() for part in str(address).split(",") if part.strip()]
    try:
        return all(ipaddress.ip_address(part).is_loopback for part in parts)
    except ValueError:
        return parts == ["localhost"]


def install_policy(path: str | None = None, listen: str | None = None) -> dict:
    path = path or manager_config_path()
    values = parse_policy(read_config_text(path))
    address = listen if listen is not None else listener_address()
    loopback = listener_is_loopback(address)
    return {
        **values,
        "config_path": path,
        "listener": address or "unknown",
        "listener_is_loopback": loopback,
        # New Manager: both flags and a loopback listener. Old Manager: security_level only.
        "flags_enabled": all(values[flag] for flag in INSTALL_FLAGS),
    }

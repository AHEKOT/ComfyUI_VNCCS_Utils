"""Build identity read from repository files without process execution."""
import os
from ..shared.paths import _EXTENSION_ROOT

def _vnccs_read_git_short_commit(repo_dir):
    # Resolve HEAD by reading .git files directly (no process execution).
    try:
        git_dir = os.path.join(repo_dir, ".git")
        if os.path.isfile(git_dir):
            with open(git_dir, "r", encoding="utf-8") as handle:
                pointer = handle.read().strip()
            if not pointer.startswith("gitdir:"):
                return ""
            git_dir = os.path.normpath(os.path.join(repo_dir, pointer[len("gitdir:"):].strip()))
        with open(os.path.join(git_dir, "HEAD"), "r", encoding="utf-8") as handle:
            head = handle.read().strip()
        sha = head
        if head.startswith("ref:"):
            ref = head[len("ref:"):].strip()
            sha = ""
            ref_path = os.path.normpath(os.path.join(git_dir, ref))
            if ref_path.startswith(os.path.normpath(git_dir) + os.sep) and os.path.isfile(ref_path):
                with open(ref_path, "r", encoding="utf-8") as handle:
                    sha = handle.read().strip()
            else:
                packed = os.path.join(git_dir, "packed-refs")
                if os.path.isfile(packed):
                    with open(packed, "r", encoding="utf-8") as handle:
                        for line in handle:
                            parts = line.strip().split(" ", 1)
                            if len(parts) == 2 and parts[1] == ref:
                                sha = parts[0]
                                break
        if len(sha) >= 7 and all(c in "0123456789abcdef" for c in sha.lower()):
            return sha[:7]
    except Exception:
        pass
    return ""


def _vnccs_unicanvas_build_info():
    # Debug identity for the UI: git commit (when the checkout has .git) plus the
    # same newest-mtime version the frontend staleness gate compares against.
    # The commit is read per call (cheap, once per popover open) so it can never
    # go stale after new commits land without a server restart.
    commit = _vnccs_read_git_short_commit(_EXTENSION_ROOT)
    version = 0
    try:
        import re
        web_dir = os.path.join(_EXTENSION_ROOT, "web")
        pattern = re.compile(r"^vnccs_(unicanvas|custom_select|pose_studio).*\.(js|mjs)$")
        for name in os.listdir(web_dir):
            if pattern.match(name):
                version = max(version, int(os.stat(os.path.join(web_dir, name)).st_mtime * 1000))
    except Exception:
        pass
    return {"commit": commit or None, "version": str(version)}

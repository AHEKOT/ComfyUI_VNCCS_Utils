"""Download public Hugging Face repositories into ComfyUI's models folder (no credentials).

Every file goes through ``hf_hub_download(..., token=False)``, the same rule as the
rest of the extension. A repository that needs a login (a gated model) cannot be
fetched this way; the error then says which folder to fill by hand.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path

_MAX_FILES = 512


class DownloadError(RuntimeError):
    pass


def ensure_repo(repo_id: str, target: Path, report=None, revision: str = "main",
                include=None, exclude=("*.md", ".gitattributes", "*.png", "*.jpg", "*.gif", "*.mp4")) -> Path:
    """Make sure ``target`` holds the repository's files; downloads only what is missing.

    A folder that already has a ``.complete`` marker is used as is, so a user can also
    place the files there manually (for example for a gated model).
    """
    target = Path(target)
    marker = target / ".complete"
    if marker.is_file():
        return target
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError as exc:
        raise DownloadError("huggingface_hub is not installed in ComfyUI's Python") from exc
    try:
        names = HfApi(token=False).list_repo_files(repo_id, revision=revision)
    except Exception as exc:
        raise DownloadError(
            f"Could not list {repo_id} on Hugging Face ({type(exc).__name__}: {exc}). If the model is gated, "
            f"download it yourself into {target} and create an empty file named .complete there."
        ) from exc
    wanted = [
        name for name in names
        if (not include or any(fnmatch.fnmatch(name, pattern) for pattern in include))
        and not any(fnmatch.fnmatch(name, pattern) for pattern in exclude)
    ]
    if len(wanted) > _MAX_FILES:
        raise DownloadError(f"{repo_id} lists an unexpected number of files")
    for index, name in enumerate(wanted):
        if ".." in Path(name).parts or name.startswith("/"):
            raise DownloadError(f"{repo_id} has an unsafe file name: {name!r}")
        local = target / name
        if local.is_file() and local.stat().st_size > 0:
            continue
        if report:
            report(f"Downloading {repo_id}/{name} ({index + 1}/{len(wanted)}, first run only)...", 3)
        try:
            hf_hub_download(repo_id=repo_id, filename=name, revision=revision, local_dir=str(target), token=False)
        except Exception as exc:
            raise DownloadError(
                f"Could not download {repo_id}/{name} ({type(exc).__name__}: {exc}). If the model is gated, "
                f"download it yourself into {target} and create an empty file named .complete there."
            ) from exc
    target.mkdir(parents=True, exist_ok=True)
    marker.write_text("")
    return target

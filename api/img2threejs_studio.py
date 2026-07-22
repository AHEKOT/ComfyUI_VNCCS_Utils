"""Safe async img2threejs backend; generated TypeScript is stored, never evaluated."""
from __future__ import annotations
import asyncio, base64, hashlib, importlib.util, io, json, logging, math, os, re, shutil, socket, subprocess, sys, tempfile, threading, time, traceback, uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from aiohttp import ClientSession, ClientTimeout, web
from PIL import Image, ImageOps, UnidentifiedImageError
PACKAGE_ROOT = Path(__file__).resolve().parent.parent; VENDOR_ROOT = PACKAGE_ROOT / "img2threejs"; SKILL_PATH = VENDOR_ROOT / "SKILL.md"
LOGGER = logging.getLogger("vnccs.img2threejs")
def _default_output_root() -> Path:
    override = os.environ.get("VNCCS_IMG2THREEJS_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    try:
        import folder_paths  # type: ignore
        return Path(folder_paths.get_output_directory()).resolve() / "vnccs_img2threejs"
    except Exception:
        return PACKAGE_ROOT / "output" / "vnccs_img2threejs"
PROJECTS_ROOT = _default_output_root()
def _default_model_root() -> Path:
    try:
        import folder_paths  # type: ignore
        return Path(folder_paths.models_dir).resolve() / "LLM" / "img2threejs"
    except Exception:
        return PACKAGE_ROOT / "models" / "LLM" / "img2threejs"
MODEL_ROOT = _default_model_root()
PROJECT_ID_RE = re.compile(r"^[a-f0-9]{32}$"); JOB_ID_RE = PROJECT_ID_RE
ARTIFACT_ID_RE = re.compile(r"^([a-f0-9]{32})\.([a-z][a-z0-9_-]{0,31})$")
MAX_IMAGE_BYTES = 32 * 1024**2; MAX_PREVIEW_BYTES = 16 * 1024**2; MAX_PAYLOAD_BYTES = 256 * 1024
MAX_MODEL_BYTES = 64 * 1024**3; MAX_IMAGE_PIXELS = 4096**2; MAX_COMPONENTS = 256; MAX_MATERIALS = 128
MAX_JSON_DEPTH = 20; MAX_JSON_ITEMS = 20_000; MAX_TEXT = 16_000; MAX_CONCURRENT_JOBS = 4
MAX_MANAGED_MODELS = 512; MAX_MANAGED_MODEL_BYTES = 128 * 1024**3
MAX_PROVIDER_LOG_BYTES = 8 * 1024**2
_MODEL_LOCK = threading.Lock()
_LOCAL_INFERENCE_LOCK = threading.Lock()
_LAUNCH_VERSION_CACHE: dict[tuple[str, ...], str] = {}
_CODEX_AUTH_CACHE: dict[tuple[str, ...], tuple[bool, str]] = {}
_ARTIFACT_FILES = {"reference": "reference.png", "scene": "scene.json", "sculpt-spec": "object-sculpt-spec.json",
                   "model": "model.ts", "preview": "preview.png", "provider-log": "provider.log"}
@dataclass(frozen=True)
class CliLaunch:
    argv: tuple[str, ...]
    executable_name: str
    discovery: str

@dataclass(frozen=True)
class LocalModelEntry:
    identifier: str
    label: str
    path: Path
    kind: str
    source: str

def _existing_file(value: Any) -> Path | None:
    if not value:
        return None
    try:
        path = Path(os.path.expandvars(os.path.expanduser(str(value)))).resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    return path if path.is_absolute() and path.is_file() else None

def _node_executable(environ: dict[str, str], path_lookup) -> Path | None:
    for name in ("node.exe", "node"):
        found = _existing_file(path_lookup(name))
        if found:
            return found
    for key in ("ProgramFiles", "ProgramFiles(x86)"):
        found = _existing_file(Path(environ[key]) / "nodejs" / "node.exe") if environ.get(key) else None
        if found:
            return found
    return None

def _codex_from_npm_root(root: Path, environ: dict[str, str], path_lookup, discovery: str) -> CliLaunch | None:
    package = root / "node_modules" / "@openai" / "codex"
    script = _existing_file(package / "bin" / "codex.js")
    node = _node_executable(environ, path_lookup)
    if script and node:
        return CliLaunch((str(node), str(script)), "codex.js", discovery)
    for pattern in ("vendor/*/codex/codex.exe", "vendor/*/codex.exe"):
        try:
            matches = sorted(package.glob(pattern))
        except OSError:
            matches = []
        for candidate in matches[:8]:
            executable = _existing_file(candidate)
            if executable:
                return CliLaunch((str(executable),), executable.name, discovery)
    return None

def _cli_launch(provider: str, *, platform: str | None = None,
                environ: dict[str, str] | None = None, path_lookup=None) -> CliLaunch | None:
    """Resolve a CLI without accepting executable paths from browser input."""
    cli_name = "codex" if provider == "codex_cli" else "claude"
    env_key = "VNCCS_CODEX_CLI" if provider == "codex_cli" else "VNCCS_CLAUDE_CLI"
    platform = platform or os.name
    environ = dict(os.environ) if environ is None else dict(environ)
    path_lookup = shutil.which if path_lookup is None else path_lookup

    override = _existing_file(environ.get(env_key))
    if override:
        if platform == "nt" and provider == "codex_cli" and override.suffix.lower() in {".cmd", ".ps1"}:
            npm_launch = _codex_from_npm_root(override.parent, environ, path_lookup, env_key)
            if npm_launch:
                return npm_launch
        elif provider == "claude_cli":
            return CliLaunch((str(override),), override.name, env_key)
        elif not (platform == "nt" and override.suffix.lower() in {".cmd", ".bat", ".ps1"}):
            return CliLaunch((str(override),), override.name, env_key)

    lookup_names = [f"{cli_name}.exe", cli_name] if platform == "nt" else [cli_name]
    if platform == "nt":
        lookup_names.extend((f"{cli_name}.cmd", f"{cli_name}.bat"))
    for name in lookup_names:
        found = _existing_file(path_lookup(name))
        if not found:
            continue
        if platform == "nt" and provider == "codex_cli" and found.suffix.lower() in {".cmd", ".ps1"}:
            npm_launch = _codex_from_npm_root(found.parent, environ, path_lookup, "PATH/npm")
            if npm_launch:
                return npm_launch
            continue
        if provider == "claude_cli":
            return CliLaunch((str(found),), found.name, "PATH")
        if platform == "nt" and found.suffix.lower() in {".cmd", ".bat", ".ps1"}:
            continue
        return CliLaunch((str(found),), found.name, "PATH")

    if platform != "nt" or provider != "codex_cli":
        return None

    user_profile = Path(environ["USERPROFILE"]) if environ.get("USERPROFILE") else None
    npm_roots: list[Path] = []
    for value in (environ.get("APPDATA"), environ.get("LOCALAPPDATA")):
        if value:
            npm_roots.append(Path(value) / "npm")
    if user_profile:
        npm_roots.append(user_profile / "AppData" / "Roaming" / "npm")
    seen: set[str] = set()
    for root in npm_roots:
        key = str(root).lower()
        if key in seen:
            continue
        seen.add(key)
        launch = _codex_from_npm_root(root, environ, path_lookup, "Windows npm")
        if launch:
            return launch

    if user_profile:
        for extension_root in (user_profile / ".vscode" / "extensions", user_profile / ".cursor" / "extensions"):
            try:
                candidates = sorted(extension_root.glob("openai.chatgpt-*/bin/windows-*/codex.exe"), reverse=True)
            except OSError:
                candidates = []
            for candidate in candidates[:12]:
                executable = _existing_file(candidate)
                if executable:
                    return CliLaunch((str(executable),), executable.name, "IDE extension")
    return None

def _llama_server_launch(*, platform: str | None = None, environ: dict[str, str] | None = None,
                         path_lookup=None, package_root: Path | None = None) -> CliLaunch | None:
    """Resolve a native llama.cpp server; its libmtmd build owns architecture support."""
    platform = platform or os.name
    environ = dict(os.environ) if environ is None else dict(environ)
    path_lookup = shutil.which if path_lookup is None else path_lookup
    package_root = (package_root or PACKAGE_ROOT).resolve()
    override = _existing_file(environ.get("VNCCS_LLAMA_SERVER"))
    if override:
        return CliLaunch((str(override),), override.name, "VNCCS_LLAMA_SERVER")
    lookup_names = ("llama-server.exe", "llama-server") if platform == "nt" else ("llama-server",)
    for name in lookup_names:
        executable = _existing_file(path_lookup(name))
        if executable:
            return CliLaunch((str(executable),), executable.name, "PATH")
    comfy_root = package_root.parent.parent
    relative_candidates = (
        Path("bin") / ("llama-server.exe" if platform == "nt" else "llama-server"),
        Path("llama.cpp") / "build" / "bin" / "Release" / "llama-server.exe",
        Path("llama.cpp") / "build" / "bin" / ("llama-server.exe" if platform == "nt" else "llama-server"),
    )
    for base, discovery in ((package_root, "Studio bin"), (comfy_root, "ComfyUI llama.cpp")):
        for relative in relative_candidates:
            executable = _existing_file(base / relative)
            if executable:
                return CliLaunch((str(executable),), executable.name, discovery)
    return None

def _launch_version(launch: CliLaunch | None) -> str:
    if not launch:
        return ""
    if launch.argv in _LAUNCH_VERSION_CACHE:
        return _LAUNCH_VERSION_CACHE[launch.argv]
    try:
        result = subprocess.run([*launch.argv, "--version"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=4, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    version = _safe_error(result.stdout.decode("utf-8", errors="replace"), 500).split("\n", 1)[0]
    _LAUNCH_VERSION_CACHE[launch.argv] = version
    return version

def _codex_auth_status(launch: CliLaunch | None) -> tuple[bool, str]:
    if not launch:
        return False, "Codex CLI executable was not found."
    if launch.argv in _CODEX_AUTH_CACHE:
        return _CODEX_AUTH_CACHE[launch.argv]
    try:
        result = subprocess.run([*launch.argv, "login", "status"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                cwd=str(PACKAGE_ROOT), env=_cli_child_environment("codex_cli"),
                                timeout=10, check=False)
        diagnostic = _safe_error(result.stdout.decode("utf-8", errors="replace"), 1500)
        status = (result.returncode == 0, diagnostic or f"codex login status exited with {result.returncode}")
    except (OSError, subprocess.SubprocessError) as exc:
        status = (False, _safe_error(f"codex login status could not run: {exc}", 1500))
    _CODEX_AUTH_CACHE[launch.argv] = status
    return status

def _cli_missing_message(provider: str) -> str:
    label = "Codex CLI" if provider == "codex_cli" else "Claude CLI"
    env_key = "VNCCS_CODEX_CLI" if provider == "codex_cli" else "VNCCS_CLAUDE_CLI"
    return (f"{label} is not visible to the ComfyUI server process. "
            f"On Windows set {env_key} to the absolute executable path or expose the CLI in ComfyUI's PATH, then restart ComfyUI")

def _cli_child_environment(provider: str, environ: dict[str, str] | None = None) -> dict[str, str]:
    source = os.environ if environ is None else environ
    allowed = {
        "PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "LOGNAME", "LANG", "LC_ALL",
        "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
        "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
        "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROCESSOR_ARCHITECTURE",
        "NUMBER_OF_PROCESSORS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_PATH", "NVM_HOME", "NVM_SYMLINK",
    }
    allowed.update({"CODEX_HOME", "OPENAI_API_KEY", "CODEX_API_KEY"} if provider == "codex_cli"
                   else {"CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY"})
    child = {key: value for key, value in source.items() if key.upper() in allowed}
    child.update({"NO_COLOR": "1", "DISABLE_AUTOUPDATER": "1"})
    return child
def resolve_project_dir(project_id: str) -> Path:
    """Resolve a strict opaque project id without accepting filesystem paths."""
    value = str(project_id or "").strip()
    if not PROJECT_ID_RE.fullmatch(value):
        raise ValueError("invalid project id")
    root = PROJECTS_ROOT.resolve()
    path = (root / value).resolve()
    if path.parent != root:
        raise ValueError("invalid project path")
    return path
def _project_file(project_id: str, filename: str) -> Path:
    directory = resolve_project_dir(project_id)
    path = (directory / filename).resolve()
    if path.parent != directory or Path(filename).name != filename:
        raise ValueError("invalid project artifact path")
    return path
def _safe_text(value: Any, fallback: str = "", limit: int = 240) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return fallback
    clean = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value))
    clean = re.sub(r"\s+", " ", clean).strip()
    return (clean or fallback)[:limit]
def _safe_id(value: Any, fallback: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9_.:-]+", "-", _safe_text(value, fallback, 96)).strip("-")
    clean = clean or fallback
    if clean.lower() in {"__proto__", "prototype", "constructor"}:
        clean = "item-" + clean
    return clean[:96]
def _number(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        result = fallback
    if not math.isfinite(result):
        result = fallback
    return min(high, max(low, result))
def _vec3(value: Any, fallback: tuple[float, float, float], low: float, high: float) -> list[float]:
    if isinstance(value, dict):
        value = [value.get("x"), value.get("y"), value.get("z")]
    source = value if isinstance(value, list) else []
    return [_number(source[i] if i < len(source) else fallback[i], low, high, fallback[i]) for i in range(3)]
def _color(value: Any, fallback: str = "#808080") -> str:
    if isinstance(value, int) and not isinstance(value, bool):
        return f"#{min(0xffffff, max(0, value)):06x}"
    if isinstance(value, list) and len(value) >= 3:
        rgb = [_number(item, 0, 255, 0) for item in value[:3]]
        if all(0 <= float(item) <= 1 for item in value[:3] if isinstance(item, (int, float))):
            rgb = [item * 255 for item in rgb]
        return "#" + "".join(f"{round(item):02x}" for item in rgb)
    if isinstance(value, str):
        text = value.strip()
        short = re.fullmatch(r"#([0-9a-fA-F]{3})", text)
        if short:
            return "#" + "".join(char * 2 for char in short.group(1)).lower()
        full = re.fullmatch(r"#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?", text)
        if full:
            return "#" + full.group(1).lower()
        rgb_match = re.match(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)", text, re.I)
        if rgb_match:
            return "#" + "".join(f"{round(_number(item, 0, 255, 0)):02x}" for item in rgb_match.groups())
    return fallback if re.fullmatch(r"#[0-9a-fA-F]{6}", fallback) else "#808080"
def _bounded_json(value: Any, *, depth: int = 0, budget: list[int] | None = None) -> Any:
    """Copy JSON-like data while bounding nesting, entries, strings and non-finite numbers."""
    if budget is None:
        budget = [MAX_JSON_ITEMS]
    if depth > MAX_JSON_DEPTH or budget[0] <= 0:
        return None
    budget[0] -= 1
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value if math.isfinite(float(value)) else 0
    if isinstance(value, str):
        return value[:MAX_TEXT]
    if isinstance(value, list):
        return [_bounded_json(item, depth=depth + 1, budget=budget) for item in value[:MAX_JSON_ITEMS]]
    if isinstance(value, dict):
        output: dict[str, Any] = {}
        for raw_key, item in list(value.items())[:MAX_JSON_ITEMS]:
            key = _safe_text(raw_key, "", 128)
            if key and key not in {"__proto__", "prototype", "constructor"}:
                output[key] = _bounded_json(item, depth=depth + 1, budget=budget)
        return output
    return None
_SECRET_KEYS = {"api_key", "apikey", "authorization", "token", "access_token", "refresh_token",
                "secret", "password", "credential", "credentials"}
def _without_secrets(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _without_secrets(item) for key, item in value.items() if not _secret_key(key)}
    if isinstance(value, list):
        return [_without_secrets(item) for item in value]
    return value
def _secret_key(value: Any) -> bool:
    key = re.sub(r"[^a-z0-9]+", "_", str(value).lower()).strip("_")
    return key in _SECRET_KEYS or key.endswith(("_api_key", "_token", "_secret", "_password", "_credential"))
def _safe_error(error: BaseException | str, limit: int = 6000) -> str:
    text = str(error)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    text = re.sub(r"(?i)(bearer|api[-_ ]?key|token|secret|password)\s*[:=]?\s*[^\s,;]+", r"\1 [redacted]", text)
    text = re.sub(r"(?i)sk-[A-Za-z0-9_-]{8,}", "[redacted]", text)
    return (text or "Request failed")[:max(1, limit)]
def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
def _atomic_json(path: Path, payload: Any) -> None:
    safe = _without_secrets(_bounded_json(payload))
    _atomic_bytes(path, (json.dumps(safe, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8"))
def _read_json(path: Path, maximum: int = 16 * 1024 * 1024) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError(f"invalid or oversized {path.name}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain an object")
    return value
def _read_bounded_text(path: Path, maximum: int = 32 * 1024 * 1024) -> str:
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError(f"invalid or oversized {path.name}")
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeError as exc:
        raise ValueError(f"{path.name} is not valid UTF-8") from exc
def _read_diagnostic_tail(path: Path, maximum: int = 64 * 1024) -> str:
    """Read a bounded CLI log tail for safe UI/server diagnostics."""
    if not path.is_file():
        return ""
    try:
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - maximum))
            raw = handle.read(maximum)
    except OSError:
        return ""
    return _safe_error(raw.decode("utf-8", errors="replace"))
def _cli_failure_message(provider: str, returncode: int | None, stdout_path: Path, stderr_path: Path,
                         project: Path) -> str:
    label = "Codex CLI" if provider == "codex_cli" else "Claude CLI"
    stderr = _read_diagnostic_tail(stderr_path)
    stdout = _read_diagnostic_tail(stdout_path)
    details = stderr or stdout or "The CLI did not produce diagnostic output."
    details = details.replace(str(project), "<project>")
    return _safe_error(f"{label} exited with status {returncode}.\n\n{details}")
def _read_log_text(path: Path, maximum: int = MAX_PROVIDER_LOG_BYTES // 2) -> str:
    if not path.is_file():
        return ""
    try:
        with path.open("rb") as handle:
            raw = handle.read(maximum + 1)
    except OSError:
        return ""
    suffix = "\n[log truncated by Img2ThreeJS]" if len(raw) > maximum else ""
    return _safe_error(raw[:maximum].decode("utf-8", errors="replace"), maximum) + suffix
def _command_for_log(args: list[str] | tuple[str, ...]) -> str:
    return subprocess.list2cmdline([str(item) for item in args]) if os.name == "nt" else " ".join(
        "'" + str(item).replace("'", "'\\''") + "'" for item in args
    )
def _write_cli_log(project: Path, provider: str, args: list[str], returncode: int | None,
                   stdout_path: Path, stderr_path: Path) -> None:
    stdout = _read_log_text(stdout_path)
    stderr = _read_log_text(stderr_path)
    body = (f"VNCCS Img2ThreeJS provider log\n"
            f"timestamp: {time.strftime('%Y-%m-%d %H:%M:%S %z')}\n"
            f"provider: {provider}\n"
            f"exit_code: {returncode}\n"
            f"command: {_command_for_log(args)}\n\n"
            f"===== STDERR =====\n{stderr or '[empty]'}\n\n"
            f"===== STDOUT =====\n{stdout or '[empty]'}\n")
    _atomic_bytes(project / "provider.log", _safe_error(body, MAX_PROVIDER_LOG_BYTES).encode("utf-8", errors="replace"))
def _append_project_log(project_id: str, heading: str, content: str) -> None:
    path = _project_file(project_id, "provider.log")
    existing = _read_log_text(path, MAX_PROVIDER_LOG_BYTES)
    addition = f"\n\n===== {heading} =====\n{content}\n"
    combined = (existing + addition)[-MAX_PROVIDER_LOG_BYTES:]
    _atomic_bytes(path, _safe_error(combined, MAX_PROVIDER_LOG_BYTES).encode("utf-8", errors="replace"))
def _normalize_image_bytes(payload: bytes, limit: int, label: str) -> bytes:
    if not payload or len(payload) > limit:
        raise ValueError(f"{label} must be between 1 byte and {limit} bytes")
    try:
        with Image.open(io.BytesIO(payload)) as source:
            if source.width <= 0 or source.height <= 0 or source.width * source.height > MAX_IMAGE_PIXELS:
                raise ValueError(f"{label} dimensions exceed {MAX_IMAGE_PIXELS} pixels")
            source.load()
            image = ImageOps.exif_transpose(source)
            if "A" in image.getbands() or image.mode == "P":
                rgba = image.convert("RGBA")
                background = Image.new("RGB", rgba.size, (255, 255, 255))
                background.paste(rgba, mask=rgba.getchannel("A"))
                image = background
            else:
                image = image.convert("RGB")
            output = io.BytesIO()
            image.save(output, "PNG", optimize=True)
            normalized = output.getvalue()
            if len(normalized) > limit:
                raise ValueError(f"normalized {label} exceeds {limit} bytes")
            return normalized
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as exc:
        raise ValueError(f"{label} is not a supported safe image") from exc
def _normalize_material(value: Any, index: int) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    material_id = _safe_id(source.get("id"), f"material-{index + 1}")
    albedo = source.get("albedo") if isinstance(source.get("albedo"), dict) else {}
    def scalar(key: str, default: float) -> Any:
        value = source.get(key, default)
        if isinstance(value, dict):
            return value.get("base", value.get("value", value.get("amount", default)))
        return value
    opacity = _number(scalar("opacity", 1), 0, 1, 1)
    transmission = _number(scalar("transmission", 0), 0, 1, 0)
    side = _safe_text(source.get("side"), "", 12).lower()
    if side not in {"front", "back", "double"}: side = "double" if source.get("doubleSided") is True else "front"
    return {
        "id": material_id,
        "name": _safe_text(source.get("name"), material_id, 120),
        "color": _color(source.get("color", source.get("baseColor", albedo.get("dominant"))), "#8a7a5f"),
        "roughness": _number(scalar("roughness", 0.62), 0, 1, 0.62),
        "metalness": _number(scalar("metalness", 0), 0, 1, 0),
        "emissive": _color(source.get("emissive", source.get("emissiveColor")), "#000000"),
        "emissiveIntensity": _number(source.get("emissiveIntensity"), 0, 20, 0),
        "opacity": opacity,
        "transparent": source.get("transparent") is True or opacity < 1 or transmission > 0,
        "alphaTest": _number(source.get("alphaTest"), 0, 1, 0),
        "clearcoat": _number(scalar("clearcoat", 0), 0, 1, 0),
        "clearcoatRoughness": _number(source.get("clearcoatRoughness"), 0, 1, 0),
        "transmission": transmission,
        "ior": _number(source.get("ior"), 1, 2.333, 1.5),
        "thickness": _number(source.get("thickness"), 0, 100, 0),
        "flatShading": source.get("flatShading") is True,
        "depthWrite": source.get("depthWrite") is not False and not (opacity < 1 or transmission > 0),
        "side": side,
    }
def _normalize_component(value: Any, index: int) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    transform = source.get("transform") if isinstance(source.get("transform"), dict) else {}
    dimensions = source.get("dimensions")
    if isinstance(dimensions, dict):
        dimensions = [dimensions.get("width"), dimensions.get("height"), dimensions.get("depth")]
    scale = _vec3(transform.get("scale", source.get("scale", dimensions)), (1, 1, 1), -1000, 1000)
    scale = [max(0.0001, abs(item)) for item in scale]
    rotation = _vec3(transform.get("rotation", source.get("rotation")), (0, 0, 0), -math.pi * 8, math.pi * 8)
    degrees = transform.get("rotationDegrees", source.get("rotationDegrees"))
    unit = _safe_text(transform.get("rotationUnit", source.get("rotationUnit")), "radians", 12).lower()
    if degrees is not None:
        rotation = [math.radians(item) for item in _vec3(degrees, (0, 0, 0), -1440, 1440)]
    elif unit.startswith("deg"):
        rotation = [math.radians(item) for item in rotation]
    primitive = _safe_text(source.get("primitive", source.get("type")), "box", 32).lower()
    if primitive == "plane-card":
        primitive = "plane"
    if primitive not in {"box", "sphere", "ellipsoid", "cylinder", "cone", "capsule", "torus", "plane"}:
        primitive = "box"
    parent = source.get("parentId", source.get("parent"))
    return {
        "id": _safe_id(source.get("id"), f"component-{index + 1}"),
        "name": _safe_text(source.get("name"), f"Component {index + 1}", 160),
        "primitive": primitive,
        "parentId": _safe_id(parent, "") if parent not in (None, "") else None,
        "materialId": _safe_id(source.get("materialId", source.get("material")), "default"),
        "position": _vec3(transform.get("position", source.get("position")), (0, 0, 0), -10000, 10000),
        "rotation": rotation,
        "scale": scale,
        "visible": source.get("visible") is not False,
        "castShadow": source.get("castShadow") is not False,
        "receiveShadow": source.get("receiveShadow") is not False,
        "level": _safe_text(source.get("level"), "", 24),
        "role": _safe_text(source.get("role"), "", 80),
        "importance": _number(source.get("importance"), 0, 1, 0.5),
        "confidence": _number(source.get("confidence"), 0, 1, 0.5),
        "notes": _safe_text(source.get("notes", source.get("description")), "", 600),
    }
def _hierarchy(components: list[dict[str, Any]]) -> dict[str, Any]:
    by_component = {item["id"]: item for item in components}
    parent_by_id: dict[str, str | None] = {}
    issues: list[dict[str, str | None]] = []
    for item in components:
        item_id, parent = item["id"], item.get("parentId")
        if not parent:
            parent_by_id[item_id] = None
        elif parent == item_id:
            parent_by_id[item_id] = None
            issues.append({"code": "self-parent", "id": item_id, "parentId": parent,
                           "message": f"{item_id} cannot parent itself"})
        elif parent not in by_component:
            parent_by_id[item_id] = None
            issues.append({"code": "missing-parent", "id": item_id, "parentId": parent,
                           "message": f"{item_id} references a missing parent"})
        else:
            parent_by_id[item_id] = parent
    for start in list(parent_by_id):
        visited: set[str] = set()
        current: str | None = start
        while current is not None:
            if current in visited:
                old_parent = parent_by_id[current]
                parent_by_id[current] = None
                issues.append({"code": "parent-cycle", "id": current, "parentId": old_parent,
                               "message": f"Parent cycle was broken at {current}"})
                break
            visited.add(current)
            current = parent_by_id.get(current)
    children = {item["id"]: [] for item in components}
    roots: list[str] = []
    for item in components:
        parent = parent_by_id[item["id"]]
        (children[parent] if parent else roots).append(item["id"])
    metadata: dict[str, Any] = {}
    order: list[str] = []
    def visit(item_id: str, depth: int, path: list[str], names: list[str]) -> None:
        item = by_component[item_id]
        item_path = path + [item_id]
        name_path = names + [item["name"]]
        metadata[item_id] = {
            "id": item_id, "name": item["name"], "parentId": parent_by_id[item_id],
            "childrenIds": list(children[item_id]), "depth": depth, "path": item_path,
            "namePath": name_path, "index": len(order), "primitive": item["primitive"],
        }
        order.append(item_id)
        for child in children[item_id]:
            visit(child, depth + 1, item_path, name_path)
    for root in roots:
        visit(root, 0, [], [])
    return {"roots": roots, "order": order, "sourceOrder": [item["id"] for item in components],
            "byId": metadata, "issues": issues, "parents": parent_by_id}
def _normalize_light(value: Any, color: str, intensity: float, position: tuple[float, float, float]) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    return {
        "enabled": source.get("enabled") is not False,
        "color": _color(source.get("color"), color),
        "intensity": _number(source.get("intensity"), 0, 20, intensity),
        "position": _vec3(source.get("position"), position, -1000, 1000),
    }
def normalize_scene_spec(value: Any) -> dict[str, Any]:
    """Normalize untrusted model output into Scene Spec v1 accepted by the viewer."""
    source = value if isinstance(value, dict) else {}
    warnings: list[str] = []
    raw_materials = source.get("materials") if isinstance(source.get("materials"), list) else []
    materials: list[dict[str, Any]] = []
    material_ids: set[str] = set()
    raw_material_ids: dict[str, str] = {}
    for index, raw in enumerate(raw_materials[:MAX_MATERIALS]):
        material = _normalize_material(raw, index)
        base, material_id = material["id"], material["id"]
        suffix = 2
        while material_id in material_ids:
            material_id = f"{base}-{suffix}"
            suffix += 1
        if material_id != base:
            warnings.append(f"Duplicate material id {base} was renamed")
        material["id"] = material_id
        material_ids.add(material_id)
        materials.append(material)
        if isinstance(raw, dict) and _safe_text(raw.get("id"), "", 96):
            raw_material_ids.setdefault(_safe_text(raw.get("id"), "", 96), material_id)
    if len(raw_materials) > MAX_MATERIALS:
        warnings.append(f"Materials were limited to {MAX_MATERIALS}")
    if not materials:
        materials = [_normalize_material({"id": "default", "color": "#8a7a5f"}, 0)]
        material_ids = {materials[0]["id"]}
    raw_components = source.get("components")
    if not isinstance(raw_components, list):
        raw_components = source.get("componentTree") if isinstance(source.get("componentTree"), list) else []
    components: list[dict[str, Any]] = []
    component_ids: set[str] = set()
    raw_to_normalized: dict[str, str] = {}
    raw_parents: list[str] = []
    raw_component_materials: list[str] = []
    for index, raw in enumerate(raw_components[:MAX_COMPONENTS]):
        raw_source = raw if isinstance(raw, dict) else {}
        raw_parents.append(_safe_text(raw_source.get("parentId", raw_source.get("parent")), "", 96))
        raw_component_materials.append(_safe_text(raw_source.get("materialId", raw_source.get("material")), "", 96))
        component = _normalize_component(raw, index)
        base, component_id = component["id"], component["id"]
        suffix = 2
        while component_id in component_ids:
            component_id = f"{base}-{suffix}"
            suffix += 1
        if component_id != base:
            warnings.append(f"Duplicate component id {base} was renamed")
        raw_id = _safe_text(raw.get("id"), "", 96) if isinstance(raw, dict) else ""
        if raw_id: raw_to_normalized.setdefault(raw_id, component_id)
        component["id"] = component_id
        component_ids.add(component_id)
        components.append(component)
    if len(raw_components) > MAX_COMPONENTS:
        warnings.append(f"Components were limited to {MAX_COMPONENTS}")
    for index, component in enumerate(components):
        if raw_parents[index]:
            component["parentId"] = raw_to_normalized.get(raw_parents[index], _safe_id(raw_parents[index], ""))
        if raw_component_materials[index]:
            component["materialId"] = raw_material_ids.get(raw_component_materials[index], _safe_id(raw_component_materials[index], "default"))
        if component["materialId"] not in material_ids:
            warnings.append(f"Component {component['id']} referenced a missing material")
            component["materialId"] = materials[0]["id"]
    hierarchy = _hierarchy(components)
    for component in components:
        component["parentId"] = hierarchy["parents"][component["id"]]
    warnings.extend(issue["message"] or "Hierarchy issue" for issue in hierarchy["issues"])
    hierarchy.pop("parents", None)
    suitability_source = source.get("suitability")
    if not isinstance(suitability_source, dict):
        suitability_source = {"status": suitability_source}
    status = _safe_text(suitability_source.get("status", suitability_source.get("verdict")), "unknown", 24).lower()
    if status not in {"pass", "conditional", "reject", "unknown"}:
        status = "unknown"
    score_source = suitability_source.get("scores") if isinstance(suitability_source.get("scores"), dict) else {}
    suitability_scores = {
        _safe_id(key, "score"): _number(score, 0, 1, 0)
        for key, score in list(score_source.items())[:32]
    }
    camera_source = source.get("camera", source.get("referenceCamera"))
    camera_source = camera_source if isinstance(camera_source, dict) else {}
    target = _vec3(camera_source.get("target", camera_source.get("lookAt")), (0, 0, 0), -10000, 10000)
    camera_position = _vec3(camera_source.get("position"), (4.5, 3.2, 6.5), -10000, 10000)
    if all(abs(camera_position[i] - target[i]) < 0.0001 for i in range(3)):
        camera_position = [target[0] + 4.5, target[1] + 3.2, target[2] + 6.5]
    near = _number(camera_source.get("near"), 0.001, 1000, 0.01)
    environment_source = source.get("environment")
    if isinstance(environment_source, str):
        environment_source = {"preset": environment_source}
    if not isinstance(environment_source, dict):
        environment_source = {}
    ground = environment_source.get("ground") if isinstance(environment_source.get("ground"), dict) else {}
    grid = environment_source.get("grid") if isinstance(environment_source.get("grid"), dict) else {}
    subject_source = source.get("subject") if isinstance(source.get("subject"), dict) else {}
    review_source = source.get("review") if isinstance(source.get("review"), dict) else {}
    review_notes = review_source.get("notes", review_source.get("summary", ""))
    if not isinstance(review_notes, list):
        review_notes = [review_notes] if review_notes else []
    declared_version = source.get("version", source.get("schemaVersion", 1))
    if declared_version not in (1, "1", "1.0"):
        warnings.append(f"Scene Spec version was normalized as v1")
    return {
        "version": 1,
        "name": _safe_text(source.get("name", source.get("targetName")), "Untitled 3D asset", 160),
        "summary": _safe_text(source.get("summary", source.get("description")), "", 1600),
        "suitability": {
            "status": status,
            "reason": _safe_text(suitability_source.get("reason", suitability_source.get("summary")), "", 1200),
            "confidence": _number(suitability_source.get("confidence"), 0, 1, 0 if status == "unknown" else 0.5),
            "scores": suitability_scores,
        },
        "subject": {
            "name": _safe_text(subject_source.get("name", source.get("targetName")), "", 160),
            "category": _safe_text(subject_source.get("category", subject_source.get("type")), "object", 80),
            "description": _safe_text(subject_source.get("description", subject_source.get("summary")), "", 1200),
            "sourceImage": "reference.png",
            "scale": _safe_text(subject_source.get("scale", subject_source.get("units")), "relative", 32),
        },
        "materials": materials,
        "components": components,
        "camera": {
            "fov": _number(camera_source.get("fov", camera_source.get("fovDegrees")), 10, 100, 42),
            "near": near, "far": _number(camera_source.get("far"), near + 1, 100000, 5000),
            "position": camera_position, "target": target,
            "up": [0, 1, 0],
        },
        "environment": {
            "preset": _safe_text(environment_source.get("preset", environment_source.get("name")), "studio", 32).lower(),
            "visible": environment_source.get("visible") is not False,
            "transparent": environment_source.get("transparent") is True,
            "background": _color(environment_source.get("background", environment_source.get("backgroundColor")), "#171b25"),
            "ambientColor": _color(environment_source.get("ambientColor"), "#dce7ff"),
            "ambientIntensity": _number(environment_source.get("ambientIntensity"), 0, 10, 0.55),
            "hemisphereSkyColor": _color(environment_source.get("hemisphereSkyColor"), "#dce7ff"),
            "hemisphereGroundColor": _color(environment_source.get("hemisphereGroundColor"), "#352c26"),
            "hemisphereIntensity": _number(environment_source.get("hemisphereIntensity"), 0, 10, 0.75),
            "key": _normalize_light(environment_source.get("key", environment_source.get("keyLight")), "#fff3de", 3.2, (4, 7, 5)),
            "fill": _normalize_light(environment_source.get("fill", environment_source.get("fillLight")), "#9dbdff", 1.25, (-5, 3, 2)),
            "rim": _normalize_light(environment_source.get("rim", environment_source.get("rimLight")), "#b9d2ff", 2.1, (1, 5, -6)),
            "ground": {
                "visible": environment_source.get("ground") if isinstance(environment_source.get("ground"), bool) else ground.get("visible", True) is not False,
                "color": _color(ground.get("color"), "#202633"), "roughness": _number(ground.get("roughness"), 0, 1, 0.9),
                "metalness": _number(ground.get("metalness"), 0, 1, 0), "size": _number(ground.get("size"), 1, 10000, 40),
                "height": _number(ground.get("height", ground.get("y")), -10000, 10000, -0.001),
                "opacity": _number(ground.get("opacity"), 0, 1, 1),
            },
            "grid": {
                "visible": environment_source.get("grid") if isinstance(environment_source.get("grid"), bool) else grid.get("visible", True) is not False,
                "size": _number(grid.get("size"), 1, 10000, 40), "divisions": round(_number(grid.get("divisions"), 2, 200, 40)),
                "centerColor": _color(grid.get("centerColor"), "#59657a"),
                "gridColor": _color(grid.get("color", grid.get("gridColor")), "#343d4d"),
                "opacity": _number(grid.get("opacity"), 0, 1, 0.58),
            },
        },
        "review": {
            "status": _safe_text(review_source.get("status", review_source.get("action")), "unreviewed", 32),
            "score": _number(review_source.get("score", review_source.get("fidelity")), 0, 1, 0),
            "notes": [_safe_text(item, "", 600) for item in review_notes[:64] if _safe_text(item, "", 600)],
        },
        "hierarchy": hierarchy,
        "warnings": warnings[:256],
    }
normalize_img2threejs_scene_spec = normalize_scene_spec
_VENDOR_LOCK = threading.Lock()
_VENDOR_MODULES: tuple[Any, Any] | None = None
def _load_vendored_modules() -> tuple[Any, Any]:
    global _VENDOR_MODULES
    with _VENDOR_LOCK:
        if _VENDOR_MODULES is not None:
            return _VENDOR_MODULES
        spec_path = VENDOR_ROOT / "forge" / "stage2_spec" / "new_sculpt_spec.py"
        generator_path = VENDOR_ROOT / "forge" / "stage3_build" / "generate_threejs_factory.py"
        stage3 = str(generator_path.parent)
        author_spec = importlib.util.spec_from_file_location("_vnccs_img2threejs_spec", spec_path)
        generator_spec = importlib.util.spec_from_file_location("_vnccs_img2threejs_generator", generator_path)
        if not author_spec or not author_spec.loader or not generator_spec or not generator_spec.loader:
            raise RuntimeError("vendored img2threejs forge is unavailable")
        author = importlib.util.module_from_spec(author_spec)
        author_spec.loader.exec_module(author)
        original_sys_path = list(sys.path)
        original_modules = set(sys.modules)
        shadowed = {name: sys.modules.pop(name) for name in ("orchestrate_passes", "feature_acceptance_policy") if name in sys.modules}
        sys.path.insert(0, stage3)
        try:
            generator = importlib.util.module_from_spec(generator_spec)
            generator_spec.loader.exec_module(generator)
        finally:
            sys.path[:] = original_sys_path
            for name in set(sys.modules) - original_modules:
                module_path = getattr(sys.modules.get(name), "__file__", "") or ""
                if module_path and VENDOR_ROOT in Path(module_path).resolve().parents: sys.modules.pop(name, None)
            sys.modules.update(shadowed)
        _VENDOR_MODULES = (author, generator)
        return _VENDOR_MODULES
def load_skill_text() -> str:
    """Load the vendored skill without trimming or rewriting any byte of text."""
    return SKILL_PATH.read_text(encoding="utf-8")
MODEL_RESPONSE_SCHEMA: dict[str, Any] = {"type": "object", "required": ["scene_spec"], "additionalProperties": True,
    "properties": {"scene_spec": {"type": "object"}, "object_sculpt_spec": {"type": "object"}, "quality": {"type": "object"}}}
def _build_prompt(request_data: dict[str, Any], *, refining: bool) -> str:
    user_prompt = _safe_text(request_data.get("prompt"), "Rebuild the visible subject faithfully.", 8000)
    negative = _safe_text(request_data.get("negative_prompt"), "", 4000)
    threshold = _number(request_data.get("quality_threshold"), 0.7, 0.98, 0.86)
    transport = {"task": "refine-current-reconstruction" if refining else "create-reconstruction",
        "user_instruction": user_prompt, "avoid": negative, "subject_type": _safe_text(request_data.get("subject_type"), "auto", 32),
        "quality_profile": _safe_text(request_data.get("quality_profile"), "strict", 32), "quality_threshold": threshold,
        "self_review_cycles": round(_number(request_data.get("review_cycles"), 1, 8, 4)),
        "projection_assisted_texture": request_data.get("texture_projection") is True,
        "seed": round(_number(request_data.get("seed"), -1, 2147483647, -1))}
    contract = (
        "\n\n--- VNCCS transport contract (the skill above is included verbatim) ---\n"
        "Inspect every supplied image visually. Return JSON only. The top-level object must contain "
        "scene_spec, object_sculpt_spec, and quality. scene_spec must be declarative Scene Spec v1 with "
        "materials and components made only from box, sphere, ellipsoid, cylinder, cone, capsule, torus, "
        "or plane primitives. Use finite numeric position/rotation/scale vectors and acyclic parent ids. "
        "object_sculpt_spec should contain the best evidence-based ObjectSculptSpec fields you can infer; "
        "do not emit executable source. Never include credentials, local absolute paths, or hidden reasoning.\n"
        f"Request: {json.dumps(transport, ensure_ascii=False, separators=(',', ':'))}\n"
    )
    return load_skill_text() + contract
def _extract_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        if isinstance(value.get("output_text"), str):
            value = value["output_text"]
        elif isinstance(value.get("result"), str):
            value = value["result"]
        elif isinstance(value.get("content"), list):
            texts = [item.get("text", "") for item in value["content"] if isinstance(item, dict)]
            value = "\n".join(texts)
        elif isinstance(value.get("choices"), list) and value["choices"]:
            choice = value["choices"][0]
            value = choice.get("message", {}).get("content", "") if isinstance(choice, dict) else ""
        else:
            return value
    if not isinstance(value, str) or len(value) > 32 * 1024 * 1024:
        raise ValueError("provider did not return a bounded JSON object")
    text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", value.strip(), flags=re.I)
    start = text.find("{")
    if start < 0:
        raise ValueError("provider response did not contain JSON")
    try:
        parsed, _ = json.JSONDecoder().raw_decode(text[start:])
    except json.JSONDecodeError as exc:
        raise ValueError("provider returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("provider JSON must be an object")
    return parsed
def _sculpt_from_result(result: dict[str, Any], scene: dict[str, Any], existing: dict[str, Any] | None) -> tuple[dict[str, Any], str]:
    author, generator = _load_vendored_modules()
    name = scene["name"]
    baseline = existing if isinstance(existing, dict) else author.make_spec(name, "reference.png")
    baseline = _bounded_json(baseline)
    incoming = result.get("object_sculpt_spec", result.get("sculpt_spec", {}))
    if isinstance(incoming, dict):
        allowed = {
            "targetName", "suitability", "scores", "preSpecAssessment", "qualityContract",
            "qualityTargets", "featureReviewTargets", "lookDevTargets", "referenceCamera",
            "coordinateFrame", "silhouette", "viewEvidence", "componentTree", "materials",
            "proceduralStrategy", "repetitionSystems", "lightingFromPhoto", "assumptions",
            "anatomy", "actionReadiness", "reviewHistory", "terminologyProfile",
            "selfCorrectLoop", "sculptPipeline", "visualEvidence", "lodPlan",
            "performanceBudget", "animationAnchors", "destructionAnchors", "risks",
            "projectedTextureBake",
        }
        for key in allowed:
            if key in incoming:
                baseline[key] = _bounded_json(incoming[key])
    baseline["targetName"] = name
    baseline["sourceImage"] = "reference.png"
    # A scene-only provider response still upgrades the vendored starter spec.
    if not (isinstance(incoming, dict) and isinstance(incoming.get("materials"), list)
            and any(isinstance(item, dict) for item in incoming["materials"])):
        baseline["materials"] = [
            {"id": item["id"], "name": item["name"], "baseColor": item["color"],
             "roughness": item["roughness"], "metalness": item["metalness"]}
            for item in scene["materials"]
        ]
    if not (isinstance(incoming, dict) and isinstance(incoming.get("componentTree"), list)
            and any(isinstance(item, dict) for item in incoming["componentTree"])):
        baseline["componentTree"] = [
            {"id": item["id"], "name": item["name"], "parent": item["parentId"],
             "primitive": "plane-card" if item["primitive"] == "plane" else item["primitive"],
             "material": item["materialId"], "level": item["level"] or "macro", "role": item["role"] or "body",
             "importance": item["importance"], "confidence": item["confidence"],
             "transform": {"position": item["position"], "rotation": item["rotation"], "scale": item["scale"]}}
            for item in scene["components"]
        ]
    baseline["materials"] = list(baseline.get("materials") or [])[:MAX_MATERIALS]
    baseline["componentTree"] = list(baseline.get("componentTree") or [])[:MAX_COMPONENTS]
    pass_id = generator.unlocked_pass(baseline)
    component_refs = [str(item.get("id")) for item in baseline["componentTree"] if isinstance(item, dict) and item.get("id")]
    for build_pass in baseline.get("buildPasses", []):
        if isinstance(build_pass, dict) and build_pass.get("id") == pass_id:
            build_pass["componentRefs"] = component_refs
    source = generator.generate(baseline, pass_id)
    if len(source.encode("utf-8")) > 16 * 1024 * 1024:
        raise ValueError("generated model.ts exceeds the safety limit")
    return baseline, source
@dataclass
class JobState:
    id: str
    project_id: str
    status: str = "queued"
    progress: float = 0.01
    stage: str = "Queued"
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    task: asyncio.Task[Any] | None = None
    process: asyncio.subprocess.Process | None = None
    native_process: subprocess.Popen[Any] | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    def update(self, progress: float, stage: str) -> None:
        self.progress, self.stage = _number(progress, 0, 1, self.progress), _safe_text(stage, "Working", 200)
        self.updated_at = time.time()
    def public(self) -> dict[str, Any]:
        return {"job_id": self.id, "project_id": self.project_id, "status": self.status,
                "progress": self.progress, "stage": self.stage, "error": self.error,
                "created_at": self.created_at, "updated_at": self.updated_at}
_JOBS: dict[str, JobState] = {}
_ACTIVE_PROJECT_JOBS: dict[str, str] = {}
_SUBMITTING_PROJECTS: set[str] = set()
def _provider_secret(provider: str, config: dict[str, Any]) -> str:
    supplied = config.get("api_key")
    environment = {
        "openai": "OPENAI_API_KEY", "azure_openai": "AZURE_OPENAI_API_KEY",
        "claude_api": "ANTHROPIC_API_KEY",
    }.get(provider, "")
    return (supplied if isinstance(supplied, str) and 8 <= len(supplied) <= 8192 else "") or os.environ.get(environment, "")
def _endpoint(value: Any, default: str, suffix: str, service: str) -> str:
    base = _safe_text(value, default, 2048).rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query:
        raise ValueError("provider endpoint must be an HTTPS URL without credentials or a query")
    host = (parsed.hostname or "").lower()
    configured = {item.strip().lower() for item in os.environ.get("VNCCS_IMG2THREEJS_ENDPOINT_HOSTS", "").split(",") if item.strip()}
    built_in = (host == "api.openai.com" if service == "openai" else host == "api.anthropic.com" if service == "anthropic"
                else host.endswith(".openai.azure.com") or host.endswith(".services.ai.azure.com"))
    if not built_in and host not in configured:
        raise ValueError("provider endpoint host is not server-approved")
    if parsed.path.endswith(suffix): return base
    prefix, leaf = suffix.rsplit("/", 1)
    return base + "/" + leaf if parsed.path.rstrip("/").endswith(prefix) else base + suffix
def _image_data_url(path: Path, encoded_limit: int = 80 * 1024 * 1024) -> str:
    if path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("provider image exceeds the safety limit")
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    if len(encoded) > encoded_limit:
        raise ValueError("encoded provider image is too large; use a smaller or less noisy reference")
    return "data:image/png;base64," + encoded
def _responses_output(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    texts: list[str] = []
    for output in payload.get("output", []) if isinstance(payload.get("output"), list) else []:
        for content in output.get("content", []) if isinstance(output, dict) else []:
            if isinstance(content, dict) and isinstance(content.get("text"), str):
                texts.append(content["text"])
    return "\n".join(texts)
async def _http_json(url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    timeout = ClientTimeout(total=15 * 60, connect=30)
    async with ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=body) as response:
            if response.status < 200 or response.status >= 300:
                response.release()
                raise RuntimeError(f"provider request failed with HTTP {response.status}")
            raw_buffer = bytearray()
            async for chunk in response.content.iter_chunked(1024 * 1024):
                raw_buffer.extend(chunk)
                if len(raw_buffer) > 32 * 1024 * 1024: raise ValueError("provider response is too large")
            raw = bytes(raw_buffer)
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError("provider returned invalid JSON transport") from exc
            if not isinstance(value, dict):
                raise ValueError("provider response must be an object")
            return value
async def _openai_response(config: dict[str, Any], prompt: str, images: list[Path], azure: bool) -> dict[str, Any]:
    provider = "azure_openai" if azure else "openai"
    key = _provider_secret(provider, config)
    if not key:
        raise ValueError(f"{provider} API key is not configured")
    if azure:
        url = _endpoint(config.get("endpoint") or os.environ.get("AZURE_OPENAI_ENDPOINT"), "", "/openai/v1/responses", "azure")
        api_version = _safe_text(config.get("api_version"), "", 64)
        if api_version:
            if not re.fullmatch(r"[A-Za-z0-9.-]+", api_version): raise ValueError("invalid Azure API version")
            url += "?" + urlencode({"api-version": api_version})
        headers = {"api-key": key, "Content-Type": "application/json"}
        model = _safe_text(config.get("deployment") or config.get("model") or os.environ.get("AZURE_OPENAI_DEPLOYMENT"), "", 200)
    else:
        url = _endpoint(config.get("base_url"), "https://api.openai.com/v1", "/responses", "openai")
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        model = _safe_text(config.get("model"), "gpt-5.6", 200)
    if not model:
        raise ValueError("provider model or Azure deployment is required")
    encoded_images = [_image_data_url(path, 50 * 1024 * 1024) for path in images]
    if sum(len(item) for item in encoded_images) > 50 * 1024 * 1024:
        raise ValueError("combined OpenAI image payload exceeds 50 MB; use smaller images")
    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    content.extend({"type": "input_image", "image_url": item} for item in encoded_images)
    body = {"model": model, "input": [{"role": "user", "content": content}],
            "text": {"format": {"type": "json_schema", "name": "img2threejs_scene",
                                 "schema": MODEL_RESPONSE_SCHEMA, "strict": False}}}
    response = await _http_json(url, headers, body)
    return _extract_json(_responses_output(response))
async def _claude_message(config: dict[str, Any], prompt: str, images: list[Path]) -> dict[str, Any]:
    key = _provider_secret("claude_api", config)
    if not key:
        raise ValueError("Anthropic API key is not configured")
    url = _endpoint(config.get("base_url"), "https://api.anthropic.com", "/v1/messages", "anthropic")
    content: list[dict[str, Any]] = []
    for path in images:
        encoded = _image_data_url(path, 10 * 1024 * 1024).split(",", 1)[1]
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": encoded}})
    content.append({"type": "text", "text": prompt})
    if len(prompt.encode("utf-8")) + sum(len(item["source"]["data"]) for item in content[:-1]) > 32 * 1024 * 1024:
        raise ValueError("combined Claude request exceeds 32 MB; use smaller images")
    body = {"model": _safe_text(config.get("model"), "claude-sonnet-5", 200),
            "max_tokens": round(_number(config.get("max_tokens"), 256, 131072, 16384)),
            "messages": [{"role": "user", "content": content}],
            "output_config": {"format": {"type": "json_schema", "schema": MODEL_RESPONSE_SCHEMA}}}
    response = await _http_json(url, {"x-api-key": key, "anthropic-version": "2023-06-01",
                                      "content-type": "application/json"}, body)
    return _extract_json(response)
async def _cli_response(provider: str, config: dict[str, Any], prompt: str, images: list[Path], job: JobState) -> dict[str, Any]:
    launch = _cli_launch(provider)
    if not launch:
        raise ValueError(_cli_missing_message(provider))
    project = resolve_project_dir(job.project_id)
    model = _safe_text(config.get("model"), "", 200)
    if provider == "codex_cli":
        answer_path = _project_file(job.project_id, ".response.json")
        try: answer_path.unlink()
        except FileNotFoundError: pass
        args = [*launch.argv, "exec", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config",
                "--ignore-rules", "--skip-git-repo-check", "--color", "never", "-C", str(project),
                "--output-last-message", str(answer_path)]
        for image in images:
            args.extend(["--image", str(image)])
        if model:
            args.extend(["--model", model])
        args.append("-")
    else:
        image_note = "\nControlled image files: " + ", ".join(str(path) for path in images)
        prompt += image_note
        mcp_path = _project_file(job.project_id, ".empty-mcp.json"); _atomic_json(mcp_path, {"mcpServers": {}})
        args = [*launch.argv, "-p", "--output-format", "json", "--permission-mode", "plan", "--tools", "Read",
                "--setting-sources", "", "--mcp-config", str(mcp_path), "--strict-mcp-config"]
        if os.environ.get("ANTHROPIC_API_KEY"): args.append("--bare")
        if model:
            args.extend(["--model", model])
        answer_path = None
    child_env = _cli_child_environment(provider)
    stdout_descriptor, stdout_name = tempfile.mkstemp(prefix=".cli-", suffix=".stdout", dir=project)
    stderr_descriptor, stderr_name = tempfile.mkstemp(prefix=".cli-", suffix=".stderr", dir=project)
    stdout_path, stderr_path = Path(stdout_name), Path(stderr_name)
    stdout_handle, stderr_handle = os.fdopen(stdout_descriptor, "wb"), os.fdopen(stderr_descriptor, "wb")
    try:
        job.process = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE,
                                                            stdout=stdout_handle, stderr=stderr_handle,
                                                            cwd=str(project), env=child_env)
        await job.process.communicate(prompt.encode("utf-8"))
        stdout_handle.close(); stderr_handle.close()
        if job.process.returncode != 0:
            raise RuntimeError(_cli_failure_message(provider, job.process.returncode, stdout_path, stderr_path, project))
        if answer_path and not answer_path.is_file():
            raise RuntimeError(_cli_failure_message(provider, job.process.returncode, stdout_path, stderr_path, project)
                               + "\n\nThe expected final-response file was not created.")
        raw = _read_bounded_text(answer_path) if answer_path else _read_bounded_text(stdout_path)
        try:
            return _extract_json(raw)
        except ValueError as exc:
            response_tail = _safe_error(raw[-6000:]).replace(str(project), "<project>")
            raise ValueError(f"{provider} returned an invalid final response: {exc}\n\n{response_tail}") from exc
    except asyncio.CancelledError:
        if job.process and job.process.returncode is None:
            job.process.terminate()
            try: await asyncio.wait_for(job.process.wait(), 3)
            except asyncio.TimeoutError: job.process.kill()
        raise
    finally:
        returncode = job.process.returncode if job.process else None
        if not stdout_handle.closed: stdout_handle.close()
        if not stderr_handle.closed: stderr_handle.close()
        try:
            _write_cli_log(project, provider, args, returncode, stdout_path, stderr_path)
        except Exception as log_error:
            LOGGER.error("Img2ThreeJS could not persist CLI log for job %s: %s", job.id, _safe_error(log_error))
        job.process = None
        for path in (stdout_path, stderr_path):
            try: path.unlink()
            except OSError: pass
        for name in (".response.json", ".empty-mcp.json"):
            try:
                (project / name).unlink()
            except OSError:
                pass
def _loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])
def _native_llama_failure(log_path: Path, message: str) -> RuntimeError:
    tail = _read_diagnostic_tail(log_path, 128 * 1024)
    return RuntimeError(_safe_error(f"{message}\n\n{tail or 'llama-server produced no log output.'}"))
def _native_llama_inference(config: dict[str, Any], prompt: str, images: list[Path], job: JobState) -> dict[str, Any]:
    launch = _llama_server_launch()
    if not launch:
        raise ValueError("Native llama-server was not found. Install a current llama.cpp build, expose llama-server in "
                         "ComfyUI's PATH or set VNCCS_LLAMA_SERVER to its absolute path, then restart ComfyUI. "
                         "Native libmtmd is required for architecture-neutral vision support such as Qwen3.5.")
    if job.cancelled.is_set():
        raise asyncio.CancelledError
    model_path = _resolve_model(config.get("model"))
    mmproj_path = _resolve_model(config.get("mmproj"))
    project = resolve_project_dir(job.project_id)
    log_path = _project_file(job.project_id, "provider.log")
    port = _loopback_port()
    context_size = round(_number(config.get("context_size"), 2048, 262144, 32768))
    gpu_layers = round(_number(config.get("gpu_layers"), -1, 999, -1))
    threads = round(_number(config.get("threads"), 0, 256, 0)) or max(1, os.cpu_count() or 1)
    args = [*launch.argv, "--model", str(model_path), "--mmproj", str(mmproj_path),
            "--host", "127.0.0.1", "--port", str(port), "--ctx-size", str(context_size),
            "--threads", str(threads), "--parallel", "1", "--n-gpu-layers", str(999 if gpu_layers < 0 else gpu_layers)]
    environment = dict(os.environ); environment.update({"NO_COLOR": "1", "LLAMA_LOG_COLORS": "0"})
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    result_payload: dict[str, Any] | None = None
    with _LOCAL_INFERENCE_LOCK:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("wb") as log_handle:
            header = (f"VNCCS Img2ThreeJS provider log\n"
                      f"timestamp: {time.strftime('%Y-%m-%d %H:%M:%S %z')}\n"
                      f"provider: local_gguf\nengine: native llama.cpp/libmtmd\n"
                      f"discovery: {launch.discovery}\nversion: {_launch_version(launch) or 'unknown'}\n"
                      f"command: {_command_for_log(args)}\n\n===== LLAMA-SERVER =====\n")
            log_handle.write(_safe_error(header, 32 * 1024).encode("utf-8")); log_handle.flush()
            try:
                job.update(0.2, "Loading model with native llama.cpp")
                job.native_process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log_handle,
                                                      stderr=subprocess.STDOUT, cwd=str(project), env=environment,
                                                      creationflags=creationflags)
                health_url = f"http://127.0.0.1:{port}/health"
                deadline = time.monotonic() + 10 * 60
                while time.monotonic() < deadline:
                    if job.cancelled.is_set(): raise asyncio.CancelledError
                    returncode = job.native_process.poll()
                    if returncode is not None:
                        log_handle.flush()
                        raise _native_llama_failure(log_path, f"llama-server exited during model loading with status {returncode}.")
                    try:
                        with urlopen(Request(health_url, method="GET"), timeout=1) as health:
                            if health.status == 200: break
                    except HTTPError as exc:
                        if exc.code != 503:
                            log_handle.write(f"\nhealth endpoint returned HTTP {exc.code}\n".encode("utf-8")); log_handle.flush()
                        time.sleep(0.25)
                    except (URLError, TimeoutError, OSError):
                        time.sleep(0.25)
                else:
                    raise _native_llama_failure(log_path, "llama-server did not become healthy within 10 minutes.")
                job.update(0.42, "Analyzing reference with native llama.cpp")
                content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
                content.extend({"type": "image_url", "image_url": {"url": _image_data_url(path)}} for path in images)
                body = {"messages": [{"role": "user", "content": content}], "temperature": 0,
                        "max_tokens": min(16384, max(2048, context_size // 2)), "stream": False,
                        "response_format": {"type": "json_object"},
                        "chat_template_kwargs": {"enable_thinking": False}, "reasoning_budget": 0}
                raw_body = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                request = Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=raw_body, method="POST",
                                  headers={"Content-Type": "application/json"})
                try:
                    with urlopen(request, timeout=45 * 60) as response:
                        raw_response = response.read(32 * 1024 * 1024 + 1)
                        if len(raw_response) > 32 * 1024 * 1024:
                            raise ValueError("llama-server response exceeds 32 MB")
                except HTTPError as exc:
                    error_body = exc.read(512 * 1024).decode("utf-8", errors="replace")
                    log_handle.write(f"\n\n===== HTTP ERROR {exc.code} =====\n{error_body}\n".encode("utf-8", errors="replace")); log_handle.flush()
                    raise _native_llama_failure(log_path, f"llama-server chat request failed with HTTP {exc.code}.") from exc
                except (URLError, TimeoutError, OSError) as exc:
                    log_handle.flush()
                    raise _native_llama_failure(log_path, f"llama-server chat request failed: {exc}") from exc
                try:
                    decoded = json.loads(raw_response)
                except json.JSONDecodeError as exc:
                    preview = raw_response[-32 * 1024:].decode("utf-8", errors="replace")
                    log_handle.write(f"\n\n===== INVALID HTTP RESPONSE =====\n{preview}\n".encode("utf-8", errors="replace")); log_handle.flush()
                    raise _native_llama_failure(log_path, "llama-server returned invalid JSON transport.") from exc
                if not isinstance(decoded, dict):
                    raise _native_llama_failure(log_path, "llama-server response must be a JSON object.")
                result_payload = _extract_json(decoded)
                log_handle.write(b"\n\n===== VNCCS RESULT =====\nValidated provider JSON received.\n"); log_handle.flush()
            finally:
                process = job.native_process
                if process and process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=8)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=5)
                job.native_process = None
    if job.cancelled.is_set():
        raise asyncio.CancelledError
    if result_payload is None:
        raise _native_llama_failure(log_path, "llama-server finished without a provider result.")
    return result_payload
def _local_inference(config: dict[str, Any], prompt: str, images: list[Path], job: JobState) -> dict[str, Any]:
    return _native_llama_inference(config, prompt, images, job)
async def _run_provider(config: dict[str, Any], prompt: str, images: list[Path], job: JobState) -> dict[str, Any]:
    provider = _safe_text(config.get("type"), "codex_cli", 32)
    if provider in {"codex_cli", "claude_cli"}:
        return await _cli_response(provider, config, prompt, images, job)
    if provider == "openai":
        return await _openai_response(config, prompt, images, False)
    if provider == "azure_openai":
        return await _openai_response(config, prompt, images, True)
    if provider == "claude_api":
        return await _claude_message(config, prompt, images)
    if provider == "local_gguf":
        return await asyncio.to_thread(_local_inference, config, prompt, images, job)
    raise ValueError("unsupported provider")
def _validate_provider_config(config: dict[str, Any]) -> None:
    provider = _safe_text(config.get("type"), "codex_cli", 32)
    if provider in {"codex_cli", "claude_cli"}:
        launch = _cli_launch(provider)
        if not launch: raise ValueError(_cli_missing_message(provider))
        if provider == "codex_cli":
            authenticated, diagnostic = _codex_auth_status(launch)
            if not authenticated:
                raise ValueError("Codex CLI was found but its login is not available to the ComfyUI server process. "
                                 f"codex login status: {diagnostic}")
    elif provider == "openai":
        if not _provider_secret(provider, config): raise ValueError("OpenAI API key is not configured")
        _endpoint(config.get("base_url"), "https://api.openai.com/v1", "/responses", "openai")
    elif provider == "azure_openai":
        if not _provider_secret(provider, config): raise ValueError("Azure API key is not configured")
        if not _safe_text(config.get("deployment") or config.get("model") or os.environ.get("AZURE_OPENAI_DEPLOYMENT"), "", 200): raise ValueError("Azure deployment is required")
        _endpoint(config.get("endpoint") or os.environ.get("AZURE_OPENAI_ENDPOINT"), "", "/openai/v1/responses", "azure")
    elif provider == "claude_api":
        if not _provider_secret(provider, config): raise ValueError("Anthropic API key is not configured")
        _endpoint(config.get("base_url"), "https://api.anthropic.com", "/v1/messages", "anthropic")
    elif provider == "local_gguf":
        _resolve_model(config.get("model")); _resolve_model(config.get("mmproj"))
        if not _llama_server_launch():
            raise ValueError("Native llama-server is required for Local GGUF vision inference. Install a current "
                             "llama.cpp build or set VNCCS_LLAMA_SERVER, then restart ComfyUI.")
def _local_model_roots() -> list[tuple[str, Path, bool]]:
    roots: list[tuple[str, Path, bool]] = [("Studio imports", MODEL_ROOT, False)]
    try:
        import folder_paths  # type: ignore
        models_dir = Path(folder_paths.models_dir).resolve()
        roots.extend((("ComfyUI LLM", models_dir / "LLM", True),
                      ("ComfyUI LLM", models_dir / "llm", True),
                      ("ComfyUI models", models_dir, False)))
        for category in ("LLM", "llm", "language_models"):
            try:
                configured = folder_paths.get_folder_paths(category) or []
            except Exception:
                configured = []
            roots.extend((f"ComfyUI {category}", Path(value), True) for value in configured if value)
    except Exception:
        pass
    output: list[tuple[str, Path, bool]] = []
    seen: set[str] = set()
    for label, root, recursive in roots:
        try:
            resolved = root.expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            continue
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        output.append((label, resolved, recursive))
    return output
def _iter_gguf_files(root: Path, recursive: bool, maximum: int = 10_000):
    if not root.is_dir(): return
    examined = 0
    if not recursive:
        try: candidates = sorted(root.iterdir(), key=lambda item: item.name.lower())
        except OSError: return
        for path in candidates:
            examined += 1
            if examined > maximum: return
            if path.is_file() and path.suffix.lower() == ".gguf": yield path
        return
    def ignore_walk_error(_error): return None
    for current, directories, files in os.walk(root, topdown=True, followlinks=False, onerror=ignore_walk_error):
        directories[:] = sorted((name for name in directories if not name.startswith(".")), key=str.lower)
        for filename in sorted(files, key=str.lower):
            examined += 1
            if examined > maximum: return
            if filename.lower().endswith(".gguf"):
                yield Path(current) / filename
def _model_kind(path: Path, index: dict[str, str] | None = None) -> str:
    if index and path.parent == MODEL_ROOT.resolve() and path.name in index:
        return index[path.name]
    name = path.name.lower().replace("_", "-")
    return "mmproj" if "mmproj" in name or "vision-projector" in name else "model"
def _model_catalog() -> list[LocalModelEntry]:
    entries: list[LocalModelEntry] = []
    seen_paths: set[str] = set()
    seen_ids: set[str] = set()
    managed_root = MODEL_ROOT.resolve()
    index = _model_index()
    for source, root, recursive in _local_model_roots():
        for path in _iter_gguf_files(root, recursive):
            try:
                resolved = path.resolve()
                if not resolved.is_file(): continue
            except (OSError, RuntimeError):
                continue
            path_key = os.path.normcase(str(resolved))
            if path_key in seen_paths: continue
            seen_paths.add(path_key)
            managed = resolved.parent == managed_root
            identifier = resolved.name if managed else "comfy-" + hashlib.sha256(
                path_key.encode("utf-8", "surrogatepass")
            ).hexdigest()[:32]
            if identifier in seen_ids: continue
            seen_ids.add(identifier)
            try: relative = path.relative_to(root).as_posix()
            except ValueError: relative = path.name
            label = f"{source} · {relative}"
            entries.append(LocalModelEntry(identifier, label, resolved, _model_kind(resolved, index), source))
            if len(entries) >= 4096: return entries
    return entries
def _resolve_model(value: Any) -> Path:
    name = _safe_text(value, "", 512)
    if not name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise ValueError("select an available ComfyUI GGUF file")
    for entry in _model_catalog():
        if entry.identifier == name:
            return entry.path
    raise ValueError("selected ComfyUI GGUF file was not found; refresh the provider model list")
def _model_index() -> dict[str, str]:
    path = MODEL_ROOT / "index.json"
    if path.is_symlink() or not path.is_file(): return {}
    try: raw = _read_json(path, 512 * 1024)
    except (ValueError, OSError, json.JSONDecodeError): return {}
    return {Path(name).name: kind for name, kind in raw.items() if kind in {"model", "mmproj"} and Path(name).name == name}
def _save_model_kind(filename: str, kind: str) -> None:
    index = _model_index(); index[filename] = kind
    _atomic_json(MODEL_ROOT / "index.json", dict(list(sorted(index.items()))[-4096:]))
def _artifact_list(project_id: str) -> list[dict[str, Any]]:
    directory, result = resolve_project_dir(project_id), []
    for kind, filename in _ARTIFACT_FILES.items():
        path = _project_file(project_id, filename)
        if path.is_file():
            artifact_id = f"{project_id}.{kind}"
            result.append({"id": artifact_id, "kind": kind, "name": filename, "size": path.stat().st_size,
                           "download_url": f"/vnccs/img2threejs/artifacts/{artifact_id}/download"})
    return result
def _load_metadata(project_id: str) -> dict[str, Any]:
    path = _project_file(project_id, "metadata.json")
    if not path.is_file(): raise FileNotFoundError(path)
    return _read_json(path, 2 * 1024 * 1024)
def load_project(project_id: str) -> dict[str, Any]:
    directory = resolve_project_dir(project_id)
    metadata = _load_metadata(project_id)
    stale_job = _safe_text(metadata.get("job_id"), "", 32)
    if metadata.get("status") in {"queued", "running"} and stale_job not in _JOBS:
        metadata = _save_metadata(project_id, status="failed", job_id="", error="Job was interrupted by a server restart")
    scene_path = _project_file(project_id, "scene.json")
    scene = _read_json(scene_path) if scene_path.is_file() else None
    response = {"project_id": project_id, "id": project_id, "name": metadata.get("name", "Img2ThreeJS project"),
                "status": metadata.get("status", "unknown"), "request": metadata.get("request", {}),
                "viewer_state": metadata.get("viewer_state", {}), "quality": metadata.get("quality", {}),
                "scene_spec": scene, "artifacts": _artifact_list(project_id)}
    if _project_file(project_id, "reference.png").is_file():
        response["source_image_url"] = f"/vnccs/img2threejs/artifacts/{project_id}.reference/download"
        response["source_filename"] = "reference.png"
    job_id = _safe_text(metadata.get("job_id"), "", 32)
    if job_id:
        response["job_id"] = job_id
    if metadata.get("error"):
        response["error"] = _safe_error(metadata["error"])
    return response
def _save_metadata(project_id: str, **changes: Any) -> dict[str, Any]:
    path = _project_file(project_id, "metadata.json")
    try:
        metadata = _read_json(path, 2 * 1024 * 1024)
    except (ValueError, OSError, json.JSONDecodeError):
        metadata = {"project_id": project_id, "created_at": time.time()}
    metadata.update(_without_secrets(changes)); metadata["updated_at"] = time.time()
    _atomic_json(path, metadata)
    return metadata
async def _multipart(request: web.Request, allowed: dict[str, int]) -> dict[str, tuple[bytes, str]]:
    if not request.content_type.startswith("multipart/"):
        raise ValueError("multipart/form-data is required")
    maximum = sum(allowed.values()) + 2 * 1024 * 1024
    if request.content_length is not None and request.content_length > maximum:
        raise ValueError("multipart request is too large")
    reader, values = await request.multipart(), {}
    async for part in reader:
        name = str(part.name or "")
        if name not in allowed or name in values:
            raise ValueError("multipart request contains an unexpected or duplicate field")
        data = bytearray()
        while True:
            chunk = await part.read_chunk(1024 * 1024)
            if not chunk: break
            data.extend(chunk)
            if len(data) > allowed[name]: raise ValueError(f"multipart field {name} is too large")
        values[name] = (bytes(data), _safe_text(part.filename, "", 255))
    return values
def _payload_field(parts: dict[str, tuple[bytes, str]]) -> dict[str, Any]:
    raw = parts.get("payload", (b"{}", ""))[0]
    try: value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc: raise ValueError("payload must be valid JSON") from exc
    if not isinstance(value, dict): raise ValueError("payload must be an object")
    return _bounded_json(value)
async def _pipeline(job: JobState, provider: dict[str, Any], request_data: dict[str, Any], refining: bool) -> None:
    directory = resolve_project_dir(job.project_id)
    try:
        job.status = "running"; job.update(0.08, "Loading img2threejs skill")
        prompt = _build_prompt(request_data, refining=refining)
        images = [_project_file(job.project_id, "reference.png")]
        if refining: images.append(_project_file(job.project_id, "preview.png"))
        job.update(0.18, "Inspecting reference with provider")
        result = await _run_provider(provider, prompt, images, job)
        if job.cancelled.is_set(): raise asyncio.CancelledError
        job.update(0.72, "Normalizing declarative scene")
        raw_scene = result.get("scene_spec", result.get("sceneSpec", result))
        scene = normalize_scene_spec(raw_scene)
        if not scene["components"]: raise ValueError("provider returned a scene without components")
        previous = None
        sculpt_path = _project_file(job.project_id, "object-sculpt-spec.json")
        if refining and sculpt_path.is_file(): previous = _read_json(sculpt_path)
        sculpt, source = await asyncio.to_thread(_sculpt_from_result, result, scene, previous)
        job.update(0.9, "Writing project artifacts")
        _atomic_json(_project_file(job.project_id, "scene.json"), scene); _atomic_json(sculpt_path, sculpt)
        _atomic_bytes(_project_file(job.project_id, "model.ts"), source.encode("utf-8"))
        quality = _bounded_json(result.get("quality", {"score": scene["review"]["score"],
                                                         "threshold": request_data.get("quality_threshold", 0.86)}))
        job.status = "success"; job.update(1, "Complete")
        _save_metadata(job.project_id, status="success", name=scene["name"], quality=quality, error="")
    except asyncio.CancelledError:
        job.status = "cancelled"; job.update(job.progress, "Cancelled")
        _save_metadata(job.project_id, status="cancelled", error="")
    except Exception as exc:
        job.status = "failed"; job.error = _safe_error(exc); job.update(job.progress, "Failed")
        try:
            _append_project_log(job.project_id, "PIPELINE FAILURE", traceback.format_exc())
        except Exception as log_error:
            LOGGER.error("Img2ThreeJS could not append project failure log for job %s: %s",
                         job.id, _safe_error(log_error))
        LOGGER.error("Img2ThreeJS job %s failed for provider %s: %s",
                     job.id, _safe_text(provider.get("type"), "unknown", 32), job.error, exc_info=True)
        _save_metadata(job.project_id, status="failed", error=job.error)
    finally:
        if _ACTIVE_PROJECT_JOBS.get(job.project_id) == job.id: _ACTIVE_PROJECT_JOBS.pop(job.project_id, None)
        job.updated_at = time.time()
def _start_job(project_id: str, provider: dict[str, Any], request_data: dict[str, Any], refining: bool) -> JobState:
    if sum(job.status in {"queued", "running"} for job in _JOBS.values()) >= MAX_CONCURRENT_JOBS:
        raise ValueError("img2threejs job capacity is full; try again later")
    active = _ACTIVE_PROJECT_JOBS.get(project_id)
    if active and active in _JOBS and _JOBS[active].status in {"queued", "running"}:
        raise ValueError("a job is already active for this project")
    job = JobState(uuid.uuid4().hex, project_id); _JOBS[job.id] = job; _ACTIVE_PROJECT_JOBS[project_id] = job.id
    _save_metadata(project_id, status="queued", job_id=job.id)
    job.task = asyncio.create_task(_pipeline(job, provider, request_data, refining))
    return job
def _prune_state() -> None:
    now = time.time()
    terminal = sorted((job for job in _JOBS.values() if job.status not in {"queued", "running"}),
                      key=lambda item: item.updated_at, reverse=True)
    for job in terminal[128:]: _JOBS.pop(job.id, None)
    for job in terminal[:128]:
        if now - job.updated_at > 24 * 3600: _JOBS.pop(job.id, None)
    try: entries = [item for item in PROJECTS_ROOT.iterdir() if item.is_dir() and PROJECT_ID_RE.fullmatch(item.name)]
    except OSError: return
    records, total = [], 0
    for item in entries:
        try:
            size = sum(path.stat().st_size for path in item.iterdir() if path.is_file())
            modified = (item / "metadata.json").stat().st_mtime
            records.append((modified, size, item)); total += size
        except OSError: continue
    records.sort()
    while records and (len(records) > 256 or total > 20 * 1024**3 or now - records[0][0] > 180 * 86400):
        _, size, path = records.pop(0)
        if path.name in _ACTIVE_PROJECT_JOBS or path.name in _SUBMITTING_PROJECTS: continue
        shutil.rmtree(path, ignore_errors=True); total -= size
def _json_handler(function):
    async def wrapped(request: web.Request):
        try: return await function(request)
        except web.HTTPException: raise
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            LOGGER.error("Img2ThreeJS request rejected in %s: %s", function.__name__, _safe_error(exc))
            return web.json_response({"error": _safe_error(exc)}, status=400)
        except FileNotFoundError:
            return web.json_response({"error": "not found"}, status=404)
        except Exception as exc:
            LOGGER.exception("Img2ThreeJS request failed in %s: %s", function.__name__, _safe_error(exc))
            return web.json_response({"error": _safe_error(exc)}, status=500)
    return wrapped
@_json_handler
async def get_capabilities(request: web.Request) -> web.Response:
    llama_launch = _llama_server_launch()
    local_available = llama_launch is not None
    local_catalog = _model_catalog()
    local_model_count = sum(entry.kind == "model" for entry in local_catalog)
    local_mmproj_count = sum(entry.kind == "mmproj" for entry in local_catalog)
    azure_credential = bool(os.environ.get("AZURE_OPENAI_API_KEY"))
    azure_configured = azure_credential and bool(os.environ.get("AZURE_OPENAI_ENDPOINT")) and bool(os.environ.get("AZURE_OPENAI_DEPLOYMENT"))
    codex_launch = _cli_launch("codex_cli")
    claude_launch = _cli_launch("claude_cli")
    codex_authenticated, codex_auth_diagnostic = _codex_auth_status(codex_launch)
    providers = [
        {"id": "codex_cli", "label": "Codex CLI", "available": codex_launch is not None, "configured": codex_authenticated,
         "executable": codex_launch.executable_name if codex_launch else "", "discovery": codex_launch.discovery if codex_launch else "",
         "version": _launch_version(codex_launch), "authenticated": codex_authenticated,
         "auth_diagnostic": codex_auth_diagnostic,
         "reason": "" if codex_authenticated else (codex_auth_diagnostic if codex_launch else _cli_missing_message("codex_cli"))},
        {"id": "claude_cli", "label": "Claude CLI", "available": claude_launch is not None, "configured": claude_launch is not None,
         "executable": claude_launch.executable_name if claude_launch else "", "discovery": claude_launch.discovery if claude_launch else "",
         "reason": "" if claude_launch else _cli_missing_message("claude_cli")},
        {"id": "openai", "label": "OpenAI Responses", "available": True, "configured": bool(os.environ.get("OPENAI_API_KEY")), "models": ["gpt-5.6"]},
        {"id": "azure_openai", "label": "Azure Responses", "available": True, "configured": azure_configured,
         "credential_configured": azure_credential},
        {"id": "claude_api", "label": "Claude Messages", "available": True, "configured": bool(os.environ.get("ANTHROPIC_API_KEY"))},
        {"id": "local_gguf", "label": "Local multimodal GGUF", "available": local_available,
         "configured": local_available and local_model_count > 0 and local_mmproj_count > 0,
         "model_count": local_model_count, "mmproj_count": local_mmproj_count,
         "engine": "native llama.cpp/libmtmd", "architecture_detection": "GGUF metadata + matching mmproj",
         "executable": llama_launch.executable_name if llama_launch else "",
         "discovery": llama_launch.discovery if llama_launch else "",
         "version": _launch_version(llama_launch),
         "reason": "" if llama_launch else "Current native llama-server is required; set VNCCS_LLAMA_SERVER or add it to ComfyUI's PATH."},
    ]
    return web.json_response({"schema_version": 1, "providers": providers,
                              "limits": {"image_bytes": MAX_IMAGE_BYTES, "preview_bytes": MAX_PREVIEW_BYTES,
                                         "model_bytes": MAX_MODEL_BYTES, "scene_components": MAX_COMPONENTS}})
@_json_handler
async def get_models(request: web.Request) -> web.Response:
    provider = _safe_text(request.query.get("provider"), "", 32)
    if provider == "openai": return web.json_response({"models": ["gpt-5.6"]})
    if provider != "local_gguf": return web.json_response({"models": [], "mmprojs": []})
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    catalog = _model_catalog()
    def public(entry: LocalModelEntry) -> dict[str, str]:
        return {"id": entry.identifier, "value": entry.identifier, "name": entry.label,
                "label": entry.label, "source": entry.source}
    return web.json_response({"models": [public(entry) for entry in catalog if entry.kind == "model"][:2048],
                              "mmprojs": [public(entry) for entry in catalog if entry.kind == "mmproj"][:2048]})
@_json_handler
async def upload_model(request: web.Request) -> web.Response:
    if not request.content_type.startswith("multipart/"): raise ValueError("multipart/form-data is required")
    if request.content_length is not None and request.content_length > MAX_MODEL_BYTES + 2 * 1024 * 1024:
        raise ValueError("GGUF upload is too large")
    MODEL_ROOT.mkdir(parents=True, exist_ok=True); reader = await request.multipart()
    temporary, filename, kind, size, seen = None, "", "model", 0, set()
    try:
        async for part in reader:
            if part.name in seen: raise ValueError("duplicate upload field")
            seen.add(part.name)
            if part.name == "kind":
                chunk = await part.read_chunk(1024)
                if len(chunk) > 64 or await part.read_chunk(1024): raise ValueError("kind field is too large")
                kind = _safe_text(chunk.decode("utf-8"), "model", 16)
            elif part.name == "file" and temporary is None:
                filename = Path(_safe_text(part.filename, "", 255)).name
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_. -]{0,250}\.gguf", filename, re.I): raise ValueError("safe .gguf filename required")
                descriptor, temporary_name = tempfile.mkstemp(prefix=".upload-", suffix=".part", dir=MODEL_ROOT)
                temporary = Path(temporary_name)
                with os.fdopen(descriptor, "wb") as handle:
                    while True:
                        chunk = await part.read_chunk(4 * 1024 * 1024)
                        if not chunk: break
                        size += len(chunk)
                        if size > MAX_MODEL_BYTES: raise ValueError("GGUF upload is too large")
                        handle.write(chunk)
                    handle.flush(); os.fsync(handle.fileno())
            else: raise ValueError("unexpected or duplicate upload field")
        with temporary.open("rb") if temporary else io.BytesIO() as handle: magic = handle.read(4)
        if temporary is None or size < 4 or magic != b"GGUF": raise ValueError("file is not GGUF")
        if kind not in {"model", "mmproj"}: raise ValueError("kind must be model or mmproj")
        destination = MODEL_ROOT / filename
        with _MODEL_LOCK:
            root = MODEL_ROOT.resolve()
            managed = [path for path in MODEL_ROOT.iterdir() if path.suffix.lower() == ".gguf" and path.resolve().parent == root and path.is_file()]
            if len(managed) >= MAX_MANAGED_MODELS or sum(path.stat().st_size for path in managed) + size > MAX_MANAGED_MODEL_BYTES:
                raise ValueError("managed GGUF storage limit reached")
            try: os.link(temporary, destination)
            except FileExistsError as exc: raise ValueError("a managed GGUF with this name already exists") from exc
            temporary.unlink(); temporary = None
            try: _save_model_kind(filename, kind)
            except Exception:
                destination.unlink(missing_ok=True)
                raise
        return web.json_response({"path": filename, "name": filename, "kind": kind, "size": size}, status=201)
    finally:
        if temporary:
            try: temporary.unlink()
            except OSError: pass
async def _submit(request: web.Request, project_id: str | None, refining: bool) -> web.Response:
    limits = {"payload": MAX_PAYLOAD_BYTES, "image": MAX_IMAGE_BYTES}
    if refining: limits["preview"] = MAX_PREVIEW_BYTES
    parts = await _multipart(request, limits); payload = _payload_field(parts)
    payload_id = payload.get("project_id")
    if project_id is None and payload_id:
        project_id = str(payload_id)
    if project_id:
        directory = resolve_project_dir(project_id)
        if not directory.is_dir(): raise FileNotFoundError
    else:
        project_id = uuid.uuid4().hex; directory = resolve_project_dir(project_id)
    provider = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    request_data = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    provider_type = _safe_text(provider.get("type"), "codex_cli", 32)
    if provider_type not in {"codex_cli", "claude_cli", "openai", "azure_openai", "claude_api", "local_gguf"}: raise ValueError("unsupported provider")
    _validate_provider_config(provider)
    active_id = _ACTIVE_PROJECT_JOBS.get(project_id)
    if project_id in _SUBMITTING_PROJECTS or (active_id in _JOBS and _JOBS[active_id].status in {"queued", "running"}):
        raise ValueError("a job is already active for this project")
    if sum(job.status in {"queued", "running"} for job in _JOBS.values()) + len(_SUBMITTING_PROJECTS) >= MAX_CONCURRENT_JOBS:
        raise ValueError("img2threejs job capacity is full; try again later")
    _SUBMITTING_PROJECTS.add(project_id)
    try:
        if "image" in parts:
            normalized = await asyncio.to_thread(_normalize_image_bytes, parts["image"][0], MAX_IMAGE_BYTES, "reference image")
            _atomic_bytes(_project_file(project_id, "reference.png"), normalized)
        if not _project_file(project_id, "reference.png").is_file(): raise ValueError("a reference image is required")
        if refining:
            if "preview" not in parts: raise ValueError("refinement requires a viewport preview")
            normalized = await asyncio.to_thread(_normalize_image_bytes, parts["preview"][0], MAX_PREVIEW_BYTES, "preview")
            _atomic_bytes(_project_file(project_id, "preview.png"), normalized)
        safe_request = _bounded_json(request_data); viewer = _bounded_json(payload.get("viewer_state", {}))
        _save_metadata(project_id, status="queued", request=safe_request, viewer_state=viewer,
                       provider={"type": provider_type, "model": _safe_text(provider.get("model") or provider.get("deployment"), "", 200)}, error="")
        _prune_state(); job = _start_job(project_id, provider, safe_request, refining)
        return web.json_response(job.public(), status=202)
    finally:
        _SUBMITTING_PROJECTS.discard(project_id)
@_json_handler
async def post_generate(request: web.Request) -> web.Response: return await _submit(request, None, False)
@_json_handler
async def post_refine(request: web.Request) -> web.Response: return await _submit(request, request.match_info["project_id"], True)
@_json_handler
async def get_project(request: web.Request) -> web.Response: return web.json_response(load_project(request.match_info["project_id"]))
@_json_handler
async def post_preview(request: web.Request) -> web.Response:
    project_id = request.match_info["project_id"]; directory = resolve_project_dir(project_id)
    if not directory.is_dir(): raise FileNotFoundError
    active_id = _ACTIVE_PROJECT_JOBS.get(project_id)
    if project_id in _SUBMITTING_PROJECTS or (active_id in _JOBS and _JOBS[active_id].status in {"queued", "running"}):
        raise ValueError("preview cannot be replaced while a project job is active")
    _SUBMITTING_PROJECTS.add(project_id)
    try:
        parts = await _multipart(request, {"preview": MAX_PREVIEW_BYTES})
        if "preview" not in parts: raise ValueError("preview is required")
        _atomic_bytes(_project_file(project_id, "preview.png"), await asyncio.to_thread(_normalize_image_bytes, parts["preview"][0], MAX_PREVIEW_BYTES, "preview"))
        return web.json_response(load_project(project_id))
    finally:
        _SUBMITTING_PROJECTS.discard(project_id)
@_json_handler
async def get_job(request: web.Request) -> web.Response:
    job_id = request.match_info["job_id"]
    if not JOB_ID_RE.fullmatch(job_id) or job_id not in _JOBS: raise FileNotFoundError
    job = _JOBS[job_id]; response = job.public()
    if job.status not in {"queued", "running"}: response.update(load_project(job.project_id))
    return web.json_response(response)
@_json_handler
async def cancel_job(request: web.Request) -> web.Response:
    job_id = request.match_info["job_id"]
    if not JOB_ID_RE.fullmatch(job_id) or job_id not in _JOBS: raise FileNotFoundError
    job = _JOBS[job_id]
    if job.status in {"queued", "running"}:
        job.cancelled.set()
        if job.process and job.process.returncode is None: job.process.terminate()
        if job.native_process and job.native_process.poll() is None: job.native_process.terminate()
        if job.task: job.task.cancel()
        job.status = "cancelled"; job.update(job.progress, "Cancelled")
    return web.json_response(job.public())
@_json_handler
async def download_artifact(request: web.Request) -> web.StreamResponse:
    match = ARTIFACT_ID_RE.fullmatch(request.match_info["artifact_id"])
    if not match or match.group(2) not in _ARTIFACT_FILES: raise FileNotFoundError
    path = _project_file(match.group(1), _ARTIFACT_FILES[match.group(2)])
    if not path.is_file(): raise FileNotFoundError
    return web.FileResponse(path, headers={"Content-Disposition": f'attachment; filename="{path.name}"',
                                           "X-Content-Type-Options": "nosniff"})
_REGISTERED_ROUTE_TARGETS: set[int] = set()
def register_routes(routes: Any) -> None:
    """Register through PromptServer.routes so ComfyUI adds /api aliases.

    A standalone aiohttp Application remains supported for isolated embedding
    and tests, but ComfyUI integrations must pass PromptServer.instance.routes.
    """
    target = routes.router if hasattr(routes, "router") else routes
    if id(target) in _REGISTERED_ROUTE_TARGETS: return
    base = "/vnccs/img2threejs"
    definitions = (
        ("get", base + "/capabilities", get_capabilities),
        ("get", base + "/models", get_models),
        ("post", base + "/models/upload", upload_model),
        ("post", base + "/generate", post_generate),
        ("post", base + "/projects/{project_id}/refine", post_refine),
        ("get", base + "/projects/{project_id}", get_project),
        ("post", base + "/projects/{project_id}/preview", post_preview),
        ("get", base + "/jobs/{job_id}", get_job),
        ("post", base + "/jobs/{job_id}/cancel", cancel_job),
        ("get", base + "/artifacts/{artifact_id}/download", download_artifact),
    )
    if hasattr(routes, "router"):
        for method, path, handler in definitions:
            getattr(routes.router, f"add_{method}")(path, handler)
    else:
        for method, path, handler in definitions:
            getattr(routes, method)(path)(handler)
    _REGISTERED_ROUTE_TARGETS.add(id(target))
register_img2threejs_routes = register_routes

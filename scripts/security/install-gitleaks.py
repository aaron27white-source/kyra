"""Install the pinned, checksum-verified Gitleaks CLI without root access."""
from pathlib import Path
import hashlib
import io
import sys
import tarfile
import urllib.request

VERSION = "8.30.1"
SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"


def install(destination):
    # Fixed HTTPS release URL; no caller URL; SHA-256 checked before extraction.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    data = urllib.request.urlopen(
        "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz",
        timeout=60,
    ).read()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError("Gitleaks archive checksum mismatch")
    destination = Path(destination)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        # Select exact files; never extract archive-controlled filesystem paths.
        files = {name: archive.extractfile(name).read() for name in ("gitleaks", "LICENSE")}
    for name, content in files.items():
        target = destination / name
        if target.exists() and target.read_bytes() != content:
            raise RuntimeError("Refusing to replace unexpected existing tool content")
    destination.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (destination / name).write_bytes(content)
    (destination / "gitleaks").chmod(0o755)
    print(f"Installed Gitleaks {VERSION}; archive SHA-256 verified")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/security/install-gitleaks.py DESTINATION")
    install(sys.argv[1])

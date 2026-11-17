"""Prove reviewed historical exceptions cannot hide a new secret at the same path."""
from pathlib import Path
import json
import re
import secrets
import shutil
import string
import subprocess
import sys
import tempfile


def verify(binary):
    scanner = str(Path(binary).resolve(strict=True))
    project = Path(__file__).resolve().parents[2]
    reviewed = json.loads((project / "docs/security/gitleaks-reviewed.json").read_text())["findings"]
    ignored = [line for line in (project / ".gitleaksignore").read_text().splitlines() if line and not line.startswith("#")]
    if set(ignored) != {item["fingerprint"] for item in reviewed} or len(set(ignored)) != len(ignored):
        raise RuntimeError("Unreviewed or duplicate historical secret exception")
    for item in reviewed:
        if not item["reason"] or not re.fullmatch(r"[0-9a-f]{40}:[^*?]+:[a-z-]+:[0-9]+", item["fingerprint"]):
            raise RuntimeError("Secret exceptions must name exact reviewed commit/path/rule/line")
    with tempfile.TemporaryDirectory(prefix="lmc-secret-policy-") as temporary:
        root = Path(temporary)
        shutil.copyfile(project / ".gitleaksignore", root / ".gitleaksignore")
        source = root / "apps/admin/src/lib/lmc-env.test.ts"
        source.parent.mkdir(parents=True)
        # Generated synthetic token; never print it or use a provider API.
        token = "ghp_" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        source.write_text('const apiKey = "' + token + '";\n')
        for arguments in (["init", "-q"], ["config", "user.name", "LMC Security Test"], ["config", "user.email", "security@example.invalid"], ["add", "."], ["commit", "-qm", "Synthetic scanner regression"]):
            subprocess.run(["git", *arguments], cwd=root, check=True, capture_output=True)
        report = root / "report.json"
        result = subprocess.run([scanner, "git", "--redact=100", "--log-opts=--all", "--report-format", "json", "--report-path", str(report)], cwd=root, capture_output=True)
        findings = json.loads(report.read_text()) if report.exists() else []
        if result.returncode != 1 or not any(item["RuleID"] == "github-pat" and item["Secret"] == "REDACTED" for item in findings):
            raise RuntimeError("New synthetic secret was not rejected and redacted")
    print("Historical exceptions are exact; a new secret at the same path is rejected and redacted")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/security/verify-gitleaks-policy.py GITLEAKS_BINARY")
    verify(sys.argv[1])

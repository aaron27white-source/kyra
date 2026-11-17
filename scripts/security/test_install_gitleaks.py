import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-gitleaks.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def archive_bytes():
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for name, content in {"gitleaks": b"fixture-binary", "LICENSE": b"fixture-license", "../outside": b"must-not-extract"}.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            archive.addfile(member, io.BytesIO(content))
    return stream.getvalue()


class InstallTests(unittest.TestCase):
    def test_rejects_bad_checksum_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(b"tampered")):
            destination = Path(temporary) / "tool"
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                installer.install(destination)
            self.assertFalse(destination.exists())

    def test_extracts_only_selected_files_and_preserves_license(self):
        data = archive_bytes()
        with tempfile.TemporaryDirectory() as temporary, patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(data)) as download, patch.object(installer, "SHA256", hashlib.sha256(data).hexdigest()):
            destination = Path(temporary) / "tool"
            installer.install(destination)
            self.assertEqual(sorted(path.name for path in destination.iterdir()), ["LICENSE", "gitleaks"])
            self.assertEqual((destination / "LICENSE").read_bytes(), b"fixture-license")
            self.assertTrue((destination / "gitleaks").stat().st_mode & 0o111)
            self.assertFalse((Path(temporary) / "outside").exists())
            url = download.call_args.args[0]
            self.assertTrue(url.startswith("https://github.com/gitleaks/gitleaks/releases/download/"))
            self.assertNotIn("file:", url)

    def test_preserves_unexpected_existing_content(self):
        data = archive_bytes()
        with tempfile.TemporaryDirectory() as temporary, patch.object(installer.urllib.request, "urlopen", return_value=io.BytesIO(data)), patch.object(installer, "SHA256", hashlib.sha256(data).hexdigest()):
            destination = Path(temporary)
            (destination / "gitleaks").write_bytes(b"existing")
            with self.assertRaisesRegex(RuntimeError, "unexpected existing"):
                installer.install(destination)
            self.assertEqual((destination / "gitleaks").read_bytes(), b"existing")
            self.assertFalse((destination / "LICENSE").exists())


if __name__ == "__main__":
    unittest.main()

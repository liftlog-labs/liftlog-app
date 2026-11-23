"""Create a reviewable source tree from explicit paths, without Git history."""
import argparse
import hashlib
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = (
    ".dockerignore", "deploy/Dockerfile", "deploy/requirements.lock", "server/manage.py",
    "scripts/personal-context.mjs", "src/modules/personalContextCore.ts",
)
MOBILE = (
    "app.json", "app.config.js", "eas.json", "package.json", "package-lock.json",
    "babel.config.js", "metro.config.js", "tsconfig.json", "eslint.config.js",
    "assets/android-icon-background.png", "assets/android-icon-foreground.png",
    "assets/android-icon-monochrome.png", "assets/favicon.png", "assets/icon.png",
)
PRIVATE = re.compile(
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgsk_[A-Za-z0-9]{25,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{25,}"
    rb"|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}|SQLite format 3\x00"
    rb"|workout-notes-2026\.txt"
)
DEV_ONLY = {
    "chat/groq_smoke.py", "config/dev_https_settings.py",
    "config/postgres_test_settings.py", "config/sync_test_settings.py",
}


def inventory(kind):
    if kind == "backend":
        paths = list(SERVER)
        for package in ("accounts", "analytics", "chat", "config", "journal", "records"):
            for path in (ROOT / "server" / package).rglob("*.py"):
                local = path.relative_to(ROOT / "server")
                if "tests" not in local.parts and local.as_posix() not in DEV_ONLY:
                    paths.append(path.relative_to(ROOT).as_posix())
        return sorted(paths)
    return sorted([*MOBILE, *[
        path.relative_to(ROOT).as_posix() for path in (ROOT / "src").rglob("*")
        if path.suffix in {".ts", ".tsx"} and not path.name.endswith(".test.ts")
        and path.name != "nodeDriver.ts"
    ]])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("backend", "mobile"))
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    destination = args.destination.resolve()
    if destination.is_relative_to(ROOT):
        parser.error("Choose a new destination outside the working repository.")
    paths = inventory(args.kind)
    for relative in paths:
        path = ROOT / relative
        if not path.is_file() or path.resolve() != path or PRIVATE.search(path.read_bytes()):
            parser.error(f"Review excluded or flagged path: {relative}")
    destination.mkdir(mode=0o700)
    for relative in paths:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
        print(f"{hashlib.sha256(target.read_bytes()).hexdigest()}  {relative}")


if __name__ == "__main__":
    main()

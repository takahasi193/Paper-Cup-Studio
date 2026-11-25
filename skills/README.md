# Paper Cup Community Engine Skills

This directory hosts verified, self-contained visual novel engine skills bundled with Paper Cup. The package layout is designed to be standalone and directly compatible with a future dedicated `Paper-Cup-Skills` repository.

## 3-Tier Discovery Priority

Paper Cup discovers engine skills across three tiers (highest priority wins per engine/skill name):

1. **Workspace tier**: `<workspace>/.papercup/skills/engine-<name>/`
2. **User global tier**: `~/.papercup/skills/engine-<name>/` (or `$PAPERCUP_HOME/skills/`)
3. **Repository built-in tier**: `<PaperCup>/skills/engine-<name>/` (or `$PAPERCUP_REPO_SKILLS_DIR`)

When an engine skill is loaded from the **user global** or **repository** tier, Paper Cup enforces mandatory SHA-256 verification of `SKILL.md` and every runtime `.py` script against `engine.json` before execution. Any tampered file or undeclared `.py` script is rejected.

## Self-Contained Skill Package Specification

Every skill lives in its own lowercase kebab-case directory `engine-<engine>/`:

```text
skills/
└── engine-<engine>/
    ├── engine.json        # Required: engine metadata, match rules, writeback config, SHA-256 digests
    ├── SKILL.md           # Required: YAML frontmatter + format specification & caveats
    ├── unpack.py          # Required when pipeline="skill": unpack <archive> <dest_dir>
    ├── repack.py          # Required when pipeline="skill": repack <source_dir> <dest_archive>
    ├── extract.py         # Optional (required for pipeline="direct"): extract <unpacked_dir> <out_jsonl>
    ├── apply.py           # Optional (required for pipeline="direct"): apply <results_jsonl> <unpacked_dir>
    └── test_fixture.py    # Recommended: zero-copyright synthetic roundtrip self-test
```

### `engine.json` Contract

Required top-level fields:
- `schema_version`: `1`
- `name`: lowercase engine identifier matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`
- `skill`: must match the directory name (e.g. `engine-nexas-pacf`)
- `pipeline`: `"skill"` (custom archive unpack/repack), `"direct"` (direct script extract/apply), or `"builtin"` (post-unpack rules for a built-in container)
- `kinds`: non-empty list of archive/script kind identifiers (e.g. `["pac"]`)
- `match`: required for `pipeline="skill"`, specifying `extensions` and/or `magic_hex` (with optional `magic_offset`)
- `writeback`: `{ mode, encoding, control_pattern, repack_cmd, verified }`
- `skill-sha256`: canonical LF-normalized SHA-256 of `SKILL.md`
- `unpack-sha256` / `repack-sha256` / `extract-sha256` / `apply-sha256`: canonical LF-normalized SHA-256 for every runtime `.py` script present in the directory

**Forbidden machine-local fields** (automatically stripped by `vn_promote_skill` and rejected by the validator):
- `direct_root`, `source_sample`, `source-sample`, `source_sha256`, `source-sha256`, `workspace`, `game_dir`, `local_path`
- Any absolute filesystem paths (Windows drive paths, UNC network paths, or Unix home-directory paths)
- Any single-game titles, copyrighted game data, or credentials/API keys

For `pipeline="direct"` skills, Paper Cup binds the active workspace game directory dynamically at runtime during `vn_detect` without modifying global or repository skill files.

### Python Runtime & Security Rules

All `.py` files (including `test_fixture.py`) must pass `node scripts/validate-skills.mjs`, which runs schema checks, SHA-256 verification, secret/path scanning, and a Python `ast` static security audit:

- **Allowed**: Python 3 standard library plus pre-installed read-only codec libraries (such as `zstandard` when required by the container format).
- **Forbidden**: `subprocess`, `socket`, `ssl`, `http`, `urllib`, `requests`, `ctypes`, `cffi`, `importlib`, `runpy`, `pickle`, `eval`, `exec`, `compile`, `__import__`, `os.system`, `os.popen`, `os.spawn*`, `os.exec*`, `Path.home()`, `os.path.expanduser`, sensitive environment variable access, hardcoded absolute paths, `..` traversal writes, and `.papercup-*.json` sidecar file writes inside game directories.
- **CLI contracts**:
  - `unpack.py <archive_path> <dest_dir>` — validate every extracted path stays inside `<dest_dir>`.
  - `repack.py <source_dir> <dest_archive>` — ignore dotfiles (`.skill-manifest.json`, etc.) and `*.bak`; never overwrite original archives in-place unless explicitly given that destination.
  - `extract.py <unpacked_dir> <out_jsonl>` — emit UTF-8 JSONL with `id`, `file` (POSIX relative path), `line` (positive integer >= 1), `kind` (`say` / `choice` / `name` / `button` / `menu` / `system`), and single-line non-empty `source` (newlines escaped as `\\n`). Filter out asset paths and script jump targets matching archive TOC filenames/stems.
  - `apply.py <results_jsonl> <unpacked_dir>` — write `row["target"]` (falling back to `row["source"]` only when `target` is absent or empty), honor `PAPERCUP_TARGET_ENCODING`, pre-validate all entries before writing atomically, and leave zero sidecar files behind.

## Validating and Contributing a Skill

1. Export a sanitized package from your verified workspace skill using `vn_promote_skill` (or place a clean package under `skills/engine-<name>/`).
2. Add a zero-copyright synthetic `test_fixture.py` that exercises the full `unpack -> extract -> mutate -> apply -> re-extract -> repack -> re-unpack` roundtrip in-process.
3. Run the validator and synthetic self-test before opening a pull request:

```bash
node scripts/validate-skills.mjs
python skills/engine-<name>/test_fixture.py
```

## Bundled Skills

| Skill | Engine | Pipeline | Container / Format |
| --- | --- | --- | --- |
| [`engine-nexas-pacf`](./engine-nexas-pacf/) | `nexas-pacf` | `skill` | NeXAS PACF `.pac` (zstd + trailing `^ 0xFF` MSB-first Huffman TOC) + `.binu8` (`0x1C` text pool) + `.lngt` |

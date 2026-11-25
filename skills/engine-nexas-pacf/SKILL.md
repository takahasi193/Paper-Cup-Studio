---
name: engine-nexas-pacf
description: Generalized unpack, repack, script/UI extraction, and safe atomic writeback skill for NeXAS PACF (.pac) visual novels (.binu8/.bin 0x1C text pool + .lngt language tables).
source-engine: nexas-pacf
evidence: verified with zero-copyright synthetic PACF (zstd + XOR 0xFF MSB-first Huffman TOC) + 0x1C text pool + .lngt roundtrip fixture
---

Verified container, extraction, and writeback skill for the **NeXAS PACF** engine (`.pac` archives with zstd entry compression, trailing `^ 0xFF` MSB-first static Huffman 76-byte TOC, `.binu8`/`.bin` `0x1C` text pools, and `.lngt` UI language tables).

## Container Format (`unpack.py` / `repack.py`)

- **Header (12 bytes)**: `magic` (`PACF` or `PAC\x00`), `uint32 LE count`, `uint32 LE pack_type` (`7` = zstd, `3`/`4` = zlib, `0` = raw).
- **Entry payloads**: contiguous compressed payloads starting at byte offset `12`.
- **Trailing TOC**:
  - Final 4 bytes (`uint32 LE`): compressed TOC byte length.
  - Preceding TOC stream: XOR `0xFF` obfuscated, MSB-first static Huffman bitstream decompressing to `count * 76` bytes.
  - Each 76-byte TOC entry contains: 64-byte NUL-padded filename (`utf-8` / `cp932`), `uint32 LE offset`, `uint32 LE unpacked_size`, `uint32 LE packed_size`.
- `repack.py` ignores dotfiles (such as `.skill-manifest.json`) and `*.bak`, recomputes every offset/size and trailing Huffman TOC cleanly, and writes zero sidecar files.

## Text Extraction (`extract.py`)

- Parses `.binu8`/`.bin` compiled scripts (supporting `0x1C`-headered text pools, chunk-tagged `0x1C` text pools, `VER\x00` + code stream + pool, and direct code stream + pool) into `kind="say"` rows.
- Parses `.lngt` line-based UI/system tables into `kind="system"` rows.
- **TOC Jump-Target Guard**: builds the normalized set of all unpacked filenames and extensionless stems and automatically skips any script string matching a TOC entry (even when containing Japanese characters) so scene transitions never break or black-screen.
- Filters asset/media filenames, pure ASCII identifiers, and widget/object lookup strings.

## Safe Writeback (`apply.py`)

- Pre-validates every JSONL entry and script slot in memory before writing (two-phase atomic replacement via temporary file + `os.replace`).
- Writes `row["target"]` (falling back to `row["source"]` only when `target` is absent or empty) and honors `PAPERCUP_TARGET_ENCODING`.
- Updates `.binu8`/`.bin` `0x1C` pool/chunk length headers cleanly for variable-length translations without disturbing bytecode indices or untouched strings.
- Preserves `.lngt` original BOM, line endings (`\r\n` vs `\n`), blank lines, and the required **trailing blank line**.
- Never writes `.papercup-*.json` or any other auxiliary sidecar file into target directories.

## Inline Control Codes

NeXAS dialogue strings use inline markup tags such as `@n` (line break), `@k`/`@p` (pause/page), `@r<base>@<reading>@` (ruby furigana), and `<...>` tags. Keep all control tags intact during translation.

---
name: vn-reverse-engineering
description: Fast 4-stage methodology for reverse-engineering visual-novel archives, compiled binary scripts, obfuscated text tables, and native PE loaders in Paper Cup using vn_re_lookup, vn_re_inspect, vn_re_trace, and Python stdlib/pefile/capstone/zstandard. Emphasizes open-source spec lookup first, dynamic ReadFile + DR0 hardware-breakpoint tracing, layer-scoped epistemic invalidation, and a 4-level pragmatic repack ladder.
metadata:
  version: "2"
---

# VN Reverse Engineering Methodology (Fast 4-Stage Funnel)

Use this skill inside Paper Cup's `reverser` sandbox (`read`, `write`, `edit`, `ls`, `find`, `bash`, `vn_detect`, `vn_learn_skill`, `vn_re_inspect`, `vn_re_lookup`, `vn_re_trace`, `vn_patch_font`) to reverse-engineer unrecognized visual-novel containers, binary scripts, and native PE loaders quickly without blind brute-forcing.

## 1. Fast 4-Stage Funnel (Route the Target First)

1. **Stage 0 — Public Spec Lookup + Second-Level Triage**:
   - **Identifiable Engine (`vn_detect` hints, `papercup.toml`, exe/file names, magic)**:
     - Call `vn_re_lookup` (`search` / `tree` / `fetch`) to retrieve publicly documented open-source unpackers (e.g., GARbro, VNTranslationTools, chinesize) and combine with your own knowledge.
     - Log the recalled header struct, key derivation/XOR schedule, compression framing, and inner string obfuscation in `.papercup/research/<engine>/02-hypotheses.md` tagged `recalled-unverified`.
   - Run `vn_re_inspect(action="archive")` on target containers/scripts to get 64 B head/tail hex, 4 KB entropy chunks, lag autocorrelation, and common resource signatures (`PNG`, `BMP`, `JPG`, `OGG`, `WAV`, `ZLIB`, `ZIP`, `ZSTD`, `LZMA`).
   - Test each layer directly with **one consolidated script** and **one decisive byte oracle** (offsets/sizes sum cleanly; `len(decompressed) == declared_usize` immediately after fixed header fields; decoded strings yield coherent dialogue/names). Never mark recalled specs as confirmed until the byte oracle passes.
2. **Stage 1 — Dynamic + Static Consumer Anchoring**:
   - Read [PE and disassembly](references/pe-and-disassembly.md) and [archive and codec triage](references/archive-and-codec-triage.md) via their full `<location>`-relative paths when needed.
   - On Windows PE targets, **prefer `vn_re_trace` before scanning raw assembly**:
     - `vn_re_trace(mode="io_trace")`: captures `CreateFile`/`GetFileAttributes`/`FindFirstFile` loose-file override probes and `ReadFile` offsets + main `.exe` caller VAs.
     - `vn_re_trace(mode="read_watch")`: sets a `DR0` hardware read/write watchpoint on the `ReadFile` buffer to capture the exact decryption/decompression instruction VA and caller stack.
   - Use `vn_re_inspect(action="pe_overview")` + `vn_re_inspect(action="xrefs")` to resolve Win32 File/Text API IATs, `.rdata` error/archive string xrefs, and C++ RTTI `.?AV...@@` class hierarchies.
3. **Stage 2 — Algorithm Extraction & Neighbor Discovery**:
   - Call `vn_re_inspect(action="disasm", va=..., neighbors=true)` on anchored VAs to inspect annotated instructions and sibling functions within `+/-0x600`. Focus on function inputs/outputs rather than unrelated C++ template plumbing.
   - **Two-Step Algorithm Transcription**: When porting a custom decryption/decompression loop from disassembly, first transcribe instructions **1:1 into literal register/byte-accurate Python** and verify it passes your byte oracle before simplifying or refactoring.
4. **Stage 3 — 4-Level Pragmatic Repack Ladder**:
   1) Native loose-file override verified by `vn_re_trace(io_trace)`;
   2) Uncompressed / literal-only fake compression framing (e.g., LZSS `0xFF` literal flag bytes) accepted by the exact decompressor;
   3) Full re-compression & re-obfuscation;
   4) File-level semi-dynamic buffer replacement hook preferred over text-level display hooks (avoids backlog desync and state corruption; last resort only, never mutate original game `.exe` on disk).
   - **Non-Native Packaged VN Runtimes**:
     - **Electron / ASAR / JS**: inspect ASAR header/index and `package.json`/renderer JS directly.
     - **Unity / IL2CPP**: inspect `global-metadata.dat` header/magic and asset containers; unrecognized magic indicates encryption in native `GameAssembly.dll`.
     - **Godot PCK**: check standalone `.pck` or embedded EOF trailer layout.
     - **SQLite / Structured Config**: read schema first on a quiescent copy (+ `-wal` if present).

## 2. Layer-Scoped Epistemic Discipline (Observation vs Inference vs Unknown)

Every claim in `.papercup/research/<engine>/` MUST record its **data layer** (`[layer: raw]`, `[layer: post-xor]`, `[layer: post-decompress]`, `[layer: inner-script]`) and keep three categories separate:

- **Observation**: exact byte provenance — `file offset`, `RVA`/`VA`, `hex` bytes, `size`, or `SHA-256`, plus literal tool output.
- **Inference**: guessed field semantics or candidate transforms inferred from static/dynamic inspection.
- **Unknown**: unresolved trailers, unreached indirect calls, uninitialized `.bss`/`.data` slots, or untested codecs.

Critical epistemic rules:

- **Layer-Scoped Invalidation**: Whenever a new outer layer (such as XOR decryption or outer container unpacking) is verified and peeled, **ALL header-size inferences, entropy claims, and compression rejections tested on the earlier outer layer are AUTOMATICALLY INVALIDATED**. Never carry old-layer rejections forward as `DO NOT RETRY`; immediately re-test decompression starting right after verified fixed header fields using exact `len(out) == declared_usize` (never subtract guessed header bytes).
- **Bounded negative searches stay bounded**: `find() == -1`, `[]`, or low `0x30`/kana frequency proves absence **only under that probe's encoding/offset/layer assumptions**.
- **No filename-only attribution**: corroborate layout claims with format-aware parsing or consumer inspection.

## 3. Summary-First & Anti-Spin Execution

- **Small-slice triage first**: use `vn_re_inspect` and print concise summaries (`<= ~100` lines) straight to `stdout` instead of writing scratch `.txt`/`.log` dumps only to `read` them back.
- **Single-script aggregation**: edit and re-run **one** consolidated analysis script in `.papercup/tmp/<engine>/` instead of spawning `probe1.py`, `probe2.py`, ... across turns.
- **Hypothesis stop-loss**: never repeat an unchanged failing probe. After 2–3 failed probes on one layer, log the layer-tagged failure in `02-hypotheses.md` and pivot immediately to `vn_re_trace` or `vn_re_inspect`.

## 4. Staged Closure Checklist (Before `vn_learn_skill`)

1. **Container & TOC**: header fields, entry offset/size table, and exact role of any trailing bytes (`unresolved TOC` vs `verified non-runtime trailing payload`).
2. **Outer Codec Oracle**: decryption and decompression verified `N/N` across all entries (exact `len(out) == declared_usize`).
3. **Inner Text & Track Classification**: extracted samples contain genuine player-facing `kind="say"` dialogue/narration plus `system`/`ui` rows; internal keys, assertion logs, and TOC-matching jump targets (even containing Japanese) are filtered out. When **multi-language parallel tracks** exist (per-language dirs or multi-locale columns), document all discovered tracks and filter strictly to the user-confirmed source language rather than mixing languages.
4. **Font Loading & Charset Constraint Audit**: inspect bundled `.ttf`/`.otf`/`.ttc` fonts, engine config font directives, and PE IAT (`AddFontResourceExW` / `AddFontMemResourceEx` / `CreateFontIndirectW` / `EnumFontFamiliesExW`) for `SHIFTJIS_CHARSET` (`0x80`) or fixed-pitch filtering (`FIXED_PITCH` / `xAvgCharWidth`). Record findings in `01-layout.md` & `SKILL.md` (and declare `runtime_charset = "shift_jis"` in `engine.json` when Unicode scripts hit CP932/0x80 runtime checks), and directly invoke `vn_patch_font` to patch missing target glyphs in-place (preserving base metrics & Japanese charset) instead of replacing with non-Japanese system fonts or delegating font patching back to the main agent.
5. **Consumer-Side Variable-Length & Full-Archive Integrity**: proven whether script/VM references strings by **record index** or **byte/unit offset**, and whether `repack.py`/`apply.py` recalculates every dependent size, offset, header/TOC entry, and checksum across every sampled script extension. Never write a partial `unpack.py`/`repack.py` that drops media/assets and shrinks a replaced large archive — preserve all untouched entries byte-for-byte unless using an additive engine overlay (`action="add"`).
6. **Clean Writeback, Builtin Overrides & >64 MiB Anchoring**: `apply.py`/`repack.py` pre-validates entries, writes atomically without dropping `.papercup-*.json` sidecar files or synthetic EOF footers, honors `PAPERCUP_TARGET_ENCODING` and optional `PAPERCUP_CHAR_REMAP_PATH`, and passes `vn_learn_skill` identity + per-format variable-length mutation readback (`adopted`). For protected/encrypted builtin containers (`xp3`/`rpa`/`pe-zip`/`nsa`) where builtin self-check/unpack fails, register a project-level override (`override_builtin: true`) under a non-reserved custom `engine` name. Always pass the real original game file as `archive` (never a file under `.papercup/tmp/`); when real `archive` > 64 MiB, pair it with `sampleArchive` (<= 64 MiB workspace subset with identical extension and magic bytes at `magicOffset`).

## 5. Encoding & Charset Iron Rule (Shift-JIS -> GBK, Unicode -> Unicode)

- **Global Iron Rule**: Whenever Shift-JIS / CP932 is encountered — whether scripts are CP932 OR scripts are UTF-16/UTF-8 while the executable hardcodes `SHIFTJIS_CHARSET (0x80)` or CP932 fullwidth/halfwidth stepping — NEVER fight Shift-JIS or repeatedly hack font `hmtx`. Switch uniformly to **GBK (`CP936` / `GB2312_CHARSET = 0x86`)**. Only keep Unicode directly when the engine supports Chinese wide characters end-to-end (using `vn_patch_font` in-place when bundled fonts lack glyphs).
- **Troubleshooting Decision Tree (Post-Patch Non-Shift-JIS Hanzi ~50% Horizontal Overlap)**:
  - **Symptom**: In-place font patching eliminated missing glyphs (`·`/tofu), yet **only non-Shift-JIS Hanzi** overlap horizontally by ~50%.
  - **Stop tweaking `hmtx` / `numberOfHMetrics` immediately.** Audit `CreateFontIndirectW` / `EnumFontFamiliesExW` (hardcoded `0x80` `SHIFTJIS_CHARSET`) and `WideCharToMultiByte` / `IsDBCSLeadByteEx` / codepage `932` fullwidth-halfwidth stepping via `vn_re_inspect`:
    1. **GBK Runtime Hook Config (Preferred)**: Declare `runtime_charset = "shift_jis"` in `papercup.toml [vn.patch]` or `engine.json` (`writeback.runtime_charset`) so writeback emits `papercup_patch.ini` (`codepage=936`, `charset=134`) for Win32 Proxy Hook or external locale loaders.
    2. **Zero-DLL Pure-Asset Remapping**: If no Proxy Hook is available and zero-DLL delivery is required, run `vn_patch_font(remapMode="sjis_fullwidth_slots")` to remap non-Shift-JIS Hanzi into valid free JIS double-byte fullwidth slots (`.papercup/data/vn/fonts/char_remap.json`), and have `apply.py` translate characters via `PAPERCUP_CHAR_REMAP_PATH` at writeback (zero `.exe`/`.dll` edits).

## Reference Guides

- [PE layout, static memory, dynamic tracing, and consumer disassembly](references/pe-and-disassembly.md)
- [Archive structure, entropy, layered codecs, and writeback safety](references/archive-and-codec-triage.md)

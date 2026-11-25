# Archive Structure, Entropy, Layered Codecs, and Writeback Safety

Use this workflow when analyzing unknown VN archives, compressed entry streams, or obfuscated inner script tables.

## 1. Header, Magic & EOF Trailer Triage (`vn_re_inspect`)

- Run `vn_re_inspect(action="archive")` first to inspect **both** the first `<= 64 KB` and last `<= 64 KB`, 4 KB entropy chunks, periodic lag autocorrelation (`16/32/64/128/256`), and common resource signatures:
  - Images: `PNG` (`89 50 4E 47`), `BMP` (`42 4D`), `JPG` (`FF D8 FF`), `WEBP` (`RIFF....WEBP`)
  - Audio: `OGG` (`OggS`), `WAV` (`RIFF....WAVE`)
  - Streams: `ZLIB` (`78 01/5E/9C/DA`), `ZIP` (`PK\x03\x04`), `ZSTD` (`28 B5 2F FD`), `LZMA` (`5D 00 00`), `GZIP` (`1F 8B`)
- Check offset arithmetic early:
  - Do `header_size + toc_tables + sum(entry_csize) == file_size`, or is there a trailing payload after `data_end`?
  - Does a header/footer integer match `entry_count`, `toc_offset`, `toc_size`, `data_offset`, or an original-source trailer size?
- **Unresolved TOC Trailer vs Verified Non-Runtime Payload**:
  - If a trailer's size scales with `entry_count` or holds encoded offsets/sizes consumed at runtime, **you must reverse and rebuild it**.
  - If the header/TOC explicitly accounts for all runtime entry offsets and sizes AND declares a separate non-runtime trailing payload (or `vn_re_trace` / consumer disassembly proves runtime script loading stops at `data_end`), verify that invariant and carry the trailing payload cleanly after repacked runtime data instead of burning turns trying to extract dialogue from it.

## 2. Byte Entropy, Layer Boundaries & Layer-Scoped Invalidation

- **Flat ~7.9+ entropy with zero multi-byte repeats**: strong compression (`zlib`/`zstd`/`LZMA`) or stream cipher / encrypted block.
- **Cross-entry same-offset equality or periodic autocorrelation (`lag = k`)**: repeating-key XOR of period `k` (often 16, 32, 256, or header-derived) whose phase resets per entry.
  - Attack via per-lane (`offset % k`) frequency analysis or `vn_re_trace(read_watch)`, verified against constant header fields (`csize == table_csize`).
- **Layer-Scoped Invalidation (MANDATORY)**:
  - Tag every observation and every disproven hypothesis with its layer (`[layer: raw]`, `[layer: post-xor]`, `[layer: post-decompress]`).
  - Once an outer XOR/encryption layer is stripped, **ALL header-size guesses (e.g. "24-byte header"), entropy claims, and LZSS/deflate rejections measured on `[layer: raw]` are INVALID**. Never carry them over as `DO NOT RETRY`.
- **Check exact layer boundaries**: after stripping an outer XOR layer, inspect bytes immediately at offset `0`, `4`, `8`, `12`... Never misread the first flag byte + literal bytes of a compressed stream as part of a "constant plaintext header" and then search only from offset `16+` or `24+`.

## 3. Layered Decoding Order & Exact Length Oracles

Peel transformations strictly outside-in: **outer archive obfuscation -> per-entry compression -> inner script/string encoding**.

1. **Test standard codecs at exact boundaries**: `zlib`, raw `deflate`, `gzip`, `zstd`, `LZMA`/`xz`, `LZ4`.
2. **Parameterize custom LZSS cleanly in one probe**:
   - Start immediately after verified fixed header fields (e.g., offset `8` after `[u32 packedSize][u32 unpackedSize]`, or offset `12`/`16`).
   - Vary **flag bit order** (`LSB-first` vs `MSB-first`), **literal polarity** (`bit == 1` vs `bit == 0`), **offset/length bit split** (`12/4`, `11/5`, `13/3`), **length bias** (`+2` vs `+3`), and **relative lookback (`out[-off]`) vs ring-buffer (`N-F`)**.
   - **Exact Oracle Rule**: use **`len(decompressed) == declared_usize` across `N/N` entries** — NEVER subtract guessed/unverified header lengths (`declared_usize - 24`) as the target length.
   - Beware mistaking LZSS flag bytes (`0xFF`, `0x3F`) interspersed before UTF-16 literals for a custom 2-bit-per-character string codec.
3. **Never dismiss inner bodies via raw `0x30`/kana frequency alone**:
   - Compiled VN scripts often obfuscate UTF-16LE/CP932 string tables with a per-string index XOR (`c ^ ((K * i) & 0xFFFF)`), rotation, or half-width katakana compression.
   - Locate the decompressed script's section header and `(string_offset, string_length)` table first, then inspect repeated patterns (like `"none"` or short ASCII IDs) to recover the per-string transform.

## 4. Pragmatic Repack Ladder & Variable-Length Writeback

- **Identity repack (`repack(unpack(arc)) == original`) proves ONLY structural reversibility — NEVER variable-length safety.**
- When translated strings expand or shrink relative to Japanese:
  1. **Check loose-file override first** (`vn_re_trace(io_trace)`): if the engine checks disk before reading the archive, loose localized scripts can bypass archive repacking entirely.
     - **Priority & activation modes**: verify whether loose files outrank the archive directly, lose to the archive unless the original pack is renamed/removed, or require a config flag / path convention (empty pack argument, trailing slash) to enter the loose-file branch.
     - **Codec-layer trap**: many engines short-circuit only *container lookup* on loose files and still run inner script decryption/decompression — never drop already-decrypted bytes into a loose-file path without verifying which codec layer the loose-file reader expects.
     - **Loose large-media lead**: if the game keeps large videos or media unarchived outside packs, trace how the binary opens them with `vn_re_trace(io_trace)` — it often leads straight to the engine's generic loose-file / VFS branch.
  2. **Prefer uncompressed / literal-only framing next**: if the engine's exact decompressor accepts an uncompressed flag or literal-only framing (e.g. LZSS `0xFF` flag byte + 8 literal bytes) within `csize`/`usize` limits, verify it in a roundtrip check instead of writing a fragile compressor from scratch.
  3. **Full re-encoding / re-packing**: recalculate **every** inner script string `(offset, length)` entry, shift downstream section offsets inside the script header, re-apply entry XOR phase from 0, and update outer TOC `(offset, csize)` for every subsequent entry.
  4. **Hash-indexed archives & fallback hooks**: when a modified archive TOC stores only filename hashes (no plaintext names), cross-reference the original open-source engine call chain (`vn_re_lookup`) and collide candidate names extracted from scripts against the recovered hash function. If static repacking remains infeasible, prefer file-level semi-dynamic buffer replacement over text-level display hooks.

## 5. VM Bytecode Text-Modification Dichotomy

- **Separated `.code` + `.str` sections (offset-referenced pool)**: instead of shifting the entire string pool in place when translations expand, **append modified strings to the end** of `.str` / the script body and patch only the referencing opcode/table offsets so untouched references stay valid.
- **Interleaved `[instr][text]` bytecode**: never grow inline strings blindly — doing so corrupts every downstream relative/absolute jump offset and label. Either decode every opcode length and relocate jumps, fit translations within existing slot lengths, or redirect execution via a VM `JMP` trampoline / VM dispatch hook.
- **Serialized block/object scripts**: many binary scripts are serialized object records loaded directly into runtime structs rather than bytecode; rebuild each length-prefixed block cleanly in order.

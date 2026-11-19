# REA スキル（内蔵）

本ディレクトリは [morluto/rea](https://github.com/morluto/rea) の `reverse-engineer-anything` スキルをそのまま内蔵しています：

- アップストリームコミット：`7557e39dcda0b957327152d8be4f90b8c8d1c03d`
- ライセンス：MIT、[`LICENSE`](LICENSE) を参照（Copyright (c) 2026 morluto）
- ファイル：`SKILL.md`、`references/*.md` はアップストリームと同一であり、変更していません

Paper Cup は汎用スキルローダーを介して本ディレクトリを読み込みません。`SKILL.md` が `skills.MAX_BYTES`（32 KiB）を超えており、またこのスキルは `reverser` のみに所属するためです。パスとインデックスは [`reversing.py`](../reversing.py) からサブロールのプロンプトに提供され、`reverser` は `papercup engine list` と `papercup engine detect` の両方でヒットしなかった場合のみこれを参照します。

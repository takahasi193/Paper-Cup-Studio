#!/usr/bin/env node
/**
 * Validate self-contained Paper Cup community engine skill packages.
 *
 * Checks per skill package:
 *   1) Directory layout & allowed files (no symlinks, stray binaries, or sidecars)
 *   2) `engine.json` schema & required fields (no `direct_root` / `source-sample` / local fields)
 *   3) `SKILL.md` frontmatter & public-export hygiene (no drafts, local fields, or private dev refs)
 *   4) Zero credentials/secrets & zero machine-local absolute paths across all text files
 *   5) Exact LF-normalized SHA-256 verification of `SKILL.md` and every runtime `.py` script
 *   6) Python `ast` static security audit (forbids subprocess/network/ctypes/eval/exec/os.system/
 *      dynamic imports/shell exec/sensitive env access/out-of-bounds disk writes)
 *
 * Usage:
 *   node scripts/validate-skills.mjs                    # validate all skills under <repo>/skills/
 *   node scripts/validate-skills.mjs --dir <skillsDir>  # validate all skills under <skillsDir>
 *   node scripts/validate-skills.mjs --skill <skillDir> # validate one skill package directory
 *   node scripts/validate-skills.mjs --json             # print JSON report
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_SKILLS_DIR = path.join(ROOT, 'skills');

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RESERVED_SKILL_ENGINES = new Set(['renpy', 'kirikiri', 'nscripter']);

export const RUNTIME_SCRIPTS = ['unpack.py', 'repack.py', 'extract.py', 'apply.py'];
export const OPTIONAL_SCRIPTS = ['test_fixture.py'];
export const ALLOWED_SKILL_FILES = new Set([
  'engine.json',
  'SKILL.md',
  'README.md',
  ...RUNTIME_SCRIPTS,
  ...OPTIONAL_SCRIPTS,
]);

export const SCRIPT_DIGEST_FIELDS = {
  'unpack.py': 'unpack-sha256',
  'repack.py': 'repack-sha256',
  'extract.py': 'extract-sha256',
  'apply.py': 'apply-sha256',
};

export const FORBIDDEN_ENGINE_KEYS = new Set([
  'direct_root',
  'source_sample',
  'source-sample',
  'source_sha256',
  'source-sha256',
  'workspace',
  'game_dir',
  'local_path',
]);

export const FORBIDDEN_FRONTMATTER_KEYS = new Set([
  'source-sample',
  'source-sha256',
  'direct-root',
  'workspace',
  'game-dir',
  'local-path',
]);

const SECRET_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;
const SECRET_PAIR_RE =
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key)\s*[=:]\s*(?:['"][A-Za-z0-9_+/.:=-]{8,}['"]|[A-Za-z0-9_+/.=-]{16,}\b)|\b(?:token|secret|password|passwd|cookie)\s*[=:]\s*['"][A-Za-z0-9_+/.:=-]{12,}['"]/i;

const LOCAL_PATH_PATTERNS = [
  { label: 'windows_drive_path', re: /(?:^|[\s"'`(=,:])([A-Za-z]:\\[^\s"'`),;]+)/ },
  { label: 'windows_drive_slash_path', re: /(?:^|[\s"'`(=,:])([A-Za-z]:\/[^\s"'`),;]+)/ },
  { label: 'unc_path', re: /(?:^|[\s"'`(=,:])(\\\\[A-Za-z0-9._-]+\\[^\s"'`),;]+)/ },
  { label: 'unix_home_path', re: /(?:^|[\s"'`(=,:])(\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`),;]*)?)/ },
  { label: 'msys_drive_path', re: /(?:^|[\s"'`(=,:])(\/[a-z]\/(?:Users|Program Files|Windows)\/[^\s"'`),;]+)/i },
];

const PRIVATE_DOC_REF_PATTERNS = [
  { label: 'AGENTS.md', re: /\bAGENTS\.md\b/i },
  { label: 'TODO.md', re: /\bTODO\.md\b/i },
  { label: 'CODEX_HANDOFF.md', re: /\bCODEX_HANDOFF\.md\b/i },
  { label: 'CLAUDE.md', re: /\bCLAUDE\.md\b/i },
  { label: 'GEMINI.md', re: /\bGEMINI\.md\b/i },
  { label: 'scripts/export-public.mjs', re: /scripts\/export-public\.mjs/i },
  { label: 'change/', re: /(?:^|[\s(`"'\[])(?:\.?\/)?change\//i },
  { label: '.github/', re: /(?:^|[\s(`"'\[])(?:\.?\/)?\.github\//i },
];

const MAX_JSON_BYTES = 64 * 1024;
const MAX_MD_BYTES = 64 * 1024;
const MAX_SCRIPT_BYTES = 256 * 1024;

const PYTHON_AST_AUDIT_CODE = String.raw`
import ast
import json
import re
import sys

FORBIDDEN_MODULES = {
    "subprocess",
    "socket",
    "ssl",
    "http",
    "urllib",
    "urllib3",
    "requests",
    "httpx",
    "aiohttp",
    "ftplib",
    "smtplib",
    "telnetlib",
    "xmlrpc",
    "paramiko",
    "webbrowser",
    "ctypes",
    "cffi",
    "importlib",
    "runpy",
    "imp",
    "pickle",
    "marshal",
    "shelve",
    "code",
    "codeop",
    "pty",
    "pexpect",
    "winreg",
    "pip",
    "ensurepip",
    "pkgutil",
}

FORBIDDEN_BUILTINS = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "breakpoint",
}

FORBIDDEN_OS_FUNCS = {
    "system",
    "popen",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnlpe",
    "spawnv",
    "spawnve",
    "spawnvp",
    "spawnvpe",
    "execl",
    "execle",
    "execlp",
    "execlpe",
    "execv",
    "execve",
    "execvp",
    "execvpe",
    "fork",
    "forkpty",
    "kill",
    "killpg",
    "startfile",
    "putenv",
    "unsetenv",
    "chroot",
    "setuid",
    "setgid",
    "symlink",
    "link",
}

FORBIDDEN_GETATTR_NAMES = (
    FORBIDDEN_BUILTINS
    | FORBIDDEN_OS_FUNCS
    | {"Popen", "run", "call", "check_call", "check_output", "urlopen", "create_connection"}
)

SENSITIVE_ENV_RE = re.compile(
    r"(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PASSWD|USERPROFILE|APPDATA|LOCALAPPDATA|PAPERCUP_HOME|^HOME$)",
    re.IGNORECASE,
)

ABS_OR_TRAVERSAL_RE = re.compile(
    r"(?:^[A-Za-z]:[\\/]|^\\\\|^/(?:etc|usr|var|tmp|root|home|Users|Windows|Program Files)(?:/|$)|(?:^|[\\/])\.\.(?:[\\/]|$))"
)

SIDECAR_RE = re.compile(r"\.papercup-[A-Za-z0-9._-]+\.json$", re.IGNORECASE)

WRITE_MODES = set("wax+")


def is_write_mode_literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return any(ch in WRITE_MODES for ch in node.value)
    return False


def dotted_name(node):
    parts = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
        return ".".join(reversed(parts))
    return ""


def iter_string_constants(node):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
            yield sub.value


def expr_uses_home_or_expand(node, module_aliases, symbol_aliases):
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            dn = dotted_name(sub.func)
            resolved = resolve_call_name(dn, module_aliases, symbol_aliases)
            if resolved in {
                "os.path.expanduser",
                "os.path.expandvars",
                "pathlib.Path.home",
                "Path.home",
            } or dn.endswith(".home") or dn.endswith(".expanduser") or dn.endswith(".expandvars"):
                return resolved or dn
        if isinstance(sub, ast.Subscript):
            dn = dotted_name(sub.value)
            if dn in {"os.environ", "environ"} or dn.endswith(".environ"):
                for s in iter_string_constants(sub.slice):
                    if SENSITIVE_ENV_RE.search(s):
                        return f"environ[{s}]"
    return None


def resolve_call_name(dn, module_aliases, symbol_aliases):
    if not dn:
        return ""
    if dn in symbol_aliases:
        return symbol_aliases[dn]
    head, *rest = dn.split(".")
    if head in module_aliases:
        return ".".join([module_aliases[head]] + rest)
    if head in symbol_aliases:
        return ".".join([symbol_aliases[head]] + rest)
    return dn


class SecurityVisitor(ast.NodeVisitor):
    def __init__(self, filename, is_fixture=False):
        self.filename = filename
        self.is_fixture = is_fixture
        self.findings = []
        self.module_aliases = {}
        self.symbol_aliases = {}

    def report(self, node, rule, detail):
        self.findings.append({
            "file": self.filename,
            "line": getattr(node, "lineno", 0),
            "rule": rule,
            "detail": detail,
        })

    def visit_Import(self, node):
        for alias in node.names:
            top = alias.name.split(".")[0]
            local = alias.asname or alias.name
            self.module_aliases[local] = alias.name
            if top in FORBIDDEN_MODULES:
                self.report(node, "forbidden_import", f"disallowed import '{alias.name}'")
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        mod = node.module or ""
        top = mod.split(".")[0] if mod else ""
        if top in FORBIDDEN_MODULES:
            self.report(node, "forbidden_import", f"disallowed import from '{mod}'")
        for alias in node.names:
            local = alias.asname or alias.name
            full = f"{mod}.{alias.name}" if mod else alias.name
            self.symbol_aliases[local] = full
            if top == "os" and alias.name in FORBIDDEN_OS_FUNCS:
                self.report(node, "forbidden_os_import", f"disallowed import 'from os import {alias.name}'")
            if top in {"builtins", "__builtin__"} and alias.name in FORBIDDEN_BUILTINS:
                self.report(node, "forbidden_builtin_import", f"disallowed import '{full}'")
            if top == "os" and alias.name == "path":
                self.module_aliases[local] = "os.path"
        self.generic_visit(node)

    def check_write_target_expr(self, node, target_expr, op_label):
        if target_expr is None:
            return
        home_ref = expr_uses_home_or_expand(target_expr, self.module_aliases, self.symbol_aliases)
        if home_ref:
            self.report(node, "out_of_bounds_write", f"{op_label} targets home/env path via {home_ref}")
        for s in iter_string_constants(target_expr):
            if ABS_OR_TRAVERSAL_RE.search(s):
                self.report(node, "out_of_bounds_write", f"{op_label} uses hardcoded absolute or traversal path literal '{s}'")
            if not self.is_fixture and SIDECAR_RE.search(s):
                self.report(node, "forbidden_sidecar_write", f"{op_label} writes forbidden sidecar file '{s}'")

    def visit_Call(self, node):
        dn = dotted_name(node.func)
        resolved = resolve_call_name(dn, self.module_aliases, self.symbol_aliases)

        # 1) Direct forbidden builtins
        if resolved in FORBIDDEN_BUILTINS:
            self.report(node, "forbidden_builtin_call", f"disallowed builtin call '{dn}'")

        # 2) builtins.<forbidden>
        if resolved.startswith("builtins.") or resolved.startswith("__builtin__.") or resolved.startswith("__builtins__."):
            attr = resolved.split(".")[-1]
            if attr in FORBIDDEN_BUILTINS:
                self.report(node, "forbidden_builtin_call", f"disallowed dynamic builtin call '{resolved}'")

        # 3) getattr smuggling
        if resolved == "getattr" and len(node.args) >= 2:
            attr_arg = node.args[1]
            if isinstance(attr_arg, ast.Constant) and isinstance(attr_arg.value, str):
                if attr_arg.value in FORBIDDEN_GETATTR_NAMES:
                    self.report(node, "forbidden_getattr", f"disallowed getattr(..., '{attr_arg.value}')")
            elif isinstance(node.args[0], ast.Name) and node.args[0].id in {"builtins", "__builtins__", "os", "sys"}:
                self.report(node, "forbidden_dynamic_getattr", f"dynamic getattr on sensitive object '{node.args[0].id}'")

        # 4) Forbidden os.* / posix.* / nt.* calls
        if resolved.startswith(("os.", "posix.", "nt.")):
            fn = resolved.split(".", 1)[1]
            if fn in FORBIDDEN_OS_FUNCS:
                self.report(node, "forbidden_os_call", f"disallowed OS call '{resolved}'")

        # 5) Home / user-path expansion in runtime scripts
        if resolved in {"os.path.expanduser", "os.path.expandvars", "pathlib.Path.home", "Path.home"} or dn.endswith(".home"):
            self.report(node, "forbidden_user_path_access", f"disallowed host home/env expansion '{resolved or dn}'")

        # 6) Sensitive environment variable reads
        if resolved in {"os.getenv", "os.environ.get"} or dn.endswith(".environ.get"):
            if node.args:
                for s in iter_string_constants(node.args[0]):
                    if SENSITIVE_ENV_RE.search(s):
                        self.report(node, "forbidden_env_access", f"disallowed access to sensitive env var '{s}'")

        # 7) open(...) / io.open(...) write targets
        if resolved in {"open", "io.open", "builtins.open"}:
            mode_node = node.args[1] if len(node.args) >= 2 else None
            if mode_node is None:
                for kw in node.keywords:
                    if kw.arg == "mode":
                        mode_node = kw.value
                        break
            if mode_node is not None and is_write_mode_literal(mode_node):
                target = node.args[0] if node.args else None
                self.check_write_target_expr(node, target, "open(write)")

        # 8) Path.write_text / Path.write_bytes / Path.open(write) / Path.mkdir / Path.unlink / Path.rename / Path.replace
        if isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            if attr in {"write_text", "write_bytes", "mkdir", "unlink", "rmdir"}:
                self.check_write_target_expr(node, node.func.value, f"Path.{attr}")
            elif attr in {"rename", "replace"} and node.args:
                self.check_write_target_expr(node, node.func.value, f"Path.{attr}(src)")
                self.check_write_target_expr(node, node.args[0], f"Path.{attr}(dst)")
            elif attr == "open":
                mode_node = node.args[0] if node.args else None
                if mode_node is None:
                    for kw in node.keywords:
                        if kw.arg == "mode":
                            mode_node = kw.value
                            break
                if mode_node is not None and is_write_mode_literal(mode_node):
                    self.check_write_target_expr(node, node.func.value, "Path.open(write)")

        # 9) os / shutil filesystem mutation targets
        if resolved in {"os.remove", "os.unlink", "os.rmdir", "os.mkdir", "os.makedirs", "shutil.rmtree"}:
            if node.args:
                self.check_write_target_expr(node, node.args[0], resolved)
            if not self.is_fixture and resolved == "shutil.rmtree":
                self.report(node, "forbidden_rmtree", "runtime skill scripts must not call shutil.rmtree")
        if resolved in {"os.rename", "os.replace", "shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copytree", "shutil.move"}:
            if len(node.args) >= 2:
                self.check_write_target_expr(node, node.args[1], f"{resolved}(dst)")

        # 10) __builtins__[...] subscript call
        if isinstance(node.func, ast.Subscript):
            base_dn = dotted_name(node.func.value)
            if base_dn in {"__builtins__", "builtins"} or "builtins" in base_dn:
                self.report(node, "forbidden_builtin_subscript", f"disallowed dynamic builtin call via '{base_dn}[...]'")

        self.generic_visit(node)

    def visit_Subscript(self, node):
        dn = dotted_name(node.value)
        if dn in {"os.environ", "environ"} or dn.endswith(".environ"):
            for s in iter_string_constants(node.slice):
                if SENSITIVE_ENV_RE.search(s):
                    self.report(node, "forbidden_env_access", f"disallowed access to sensitive env var '{s}'")
        self.generic_visit(node)


def audit_file(file_path):
    is_fixture = file_path.replace("\\", "/").endswith("/test_fixture.py") or file_path == "test_fixture.py"
    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            source = fh.read()
    except Exception as exc:
        return [{"file": file_path, "line": 0, "rule": "read_error", "detail": str(exc)}]
    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError as exc:
        return [{"file": file_path, "line": exc.lineno or 0, "rule": "syntax_error", "detail": str(exc)}]

    visitor = SecurityVisitor(file_path, is_fixture=is_fixture)
    visitor.visit(tree)
    return visitor.findings


def main():
    findings = []
    for path in sys.argv[1:]:
        findings.extend(audit_file(path))
    sys.stdout.write(json.dumps({"ok": len(findings) == 0, "findings": findings}, ensure_ascii=False))


if __name__ == "__main__":
    main()
`;

function isSymlinkSafe(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function hashSkillText(content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function resolvePythonCommand(override) {
  if (override && String(override).trim()) return String(override).trim();
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!res.error && res.status === 0) return cmd;
  }
  throw new Error('Python 3 executable not found in PATH (required for AST security audit).');
}

export function runPythonAstAudit(pyFiles, pythonOverride) {
  if (!pyFiles.length) return { ok: true, findings: [] };
  const pyCmd = resolvePythonCommand(pythonOverride);
  const args = pyCmd === 'py' ? ['-3', '-I', '-c', PYTHON_AST_AUDIT_CODE, ...pyFiles] : ['-I', '-c', PYTHON_AST_AUDIT_CODE, ...pyFiles];
  const res = spawnSync(pyCmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) {
    return {
      ok: false,
      findings: [{ file: pyFiles[0], line: 0, rule: 'ast_runner_error', detail: res.error.message }],
    };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      findings: [
        {
          file: pyFiles[0],
          line: 0,
          rule: 'ast_runner_failed',
          detail: (res.stderr || res.stdout || `exit ${res.status}`).trim(),
        },
      ],
    };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return {
      ok: Boolean(parsed.ok),
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch (err) {
    return {
      ok: false,
      findings: [{ file: pyFiles[0], line: 0, rule: 'ast_parse_output_error', detail: String(err) }],
    };
  }
}

function scanTextForSecretsAndPaths(relLabel, text, errors) {
  if (SECRET_RE.test(text) || SECRET_PAIR_RE.test(text)) {
    errors.push(`${relLabel}: contains suspected credential or secret token`);
  }
  for (const rule of LOCAL_PATH_PATTERNS) {
    const m = rule.re.exec(text);
    if (m) {
      errors.push(`${relLabel}: contains machine-local path (${rule.label}: ${m[1] || m[0]})`);
    }
  }
}

function parseFrontmatter(mdText) {
  const norm = mdText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!norm.startsWith('---\n')) return null;
  const endIdx = norm.indexOf('\n---\n', 4);
  if (endIdx === -1) return null;
  const raw = norm.slice(4, endIdx);
  const fields = {};
  for (const line of raw.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (key) fields[key] = val;
  }
  return fields;
}

function collectForbiddenJsonKeys(obj, prefix, found) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => collectForbiddenJsonKeys(item, `${prefix}[${idx}]`, found));
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_ENGINE_KEYS.has(key.toLowerCase())) {
      found.push(nextPath);
    }
    collectForbiddenJsonKeys(val, nextPath, found);
  }
}

export function validateSkillDirectory(skillDir, options = {}) {
  const absDir = path.resolve(skillDir);
  const skillName = path.basename(absDir);
  const errors = [];
  const warnings = [];
  const checkedFiles = [];

  if (isSymlinkSafe(absDir) || !fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    return {
      ok: false,
      skillName,
      directory: absDir,
      errors: [`Skill directory does not exist, is not a directory, or is a symlink: ${absDir}`],
      warnings,
      checkedFiles,
    };
  }

  if (!SKILL_NAME_RE.test(skillName) || skillName.length > 64) {
    errors.push(`Invalid skill directory name "${skillName}": must match ${SKILL_NAME_RE}`);
  }

  // 1) Inspect directory entries
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const presentRuntimeScripts = [];
  const allPyFiles = [];

  for (const ent of entries) {
    const full = path.join(absDir, ent.name);
    if (isSymlinkSafe(full)) {
      errors.push(`Symlink not allowed inside skill package: ${ent.name}`);
      continue;
    }
    if (ent.isDirectory()) {
      if (ent.name === '__pycache__') continue;
      errors.push(`Unexpected subdirectory inside skill package: ${ent.name}/`);
      continue;
    }
    if (!ent.isFile()) {
      errors.push(`Non-regular file inside skill package: ${ent.name}`);
      continue;
    }
    if (!ALLOWED_SKILL_FILES.has(ent.name)) {
      errors.push(`Unexpected file inside skill package: ${ent.name}`);
      continue;
    }
    checkedFiles.push(ent.name);
    if (RUNTIME_SCRIPTS.includes(ent.name)) presentRuntimeScripts.push(ent.name);
    if (ent.name.endsWith('.py')) allPyFiles.push(full);
  }

  const engineJsonPath = path.join(absDir, 'engine.json');
  const skillMdPath = path.join(absDir, 'SKILL.md');

  if (!fs.existsSync(engineJsonPath)) {
    errors.push('Missing required file: engine.json');
  }
  if (!fs.existsSync(skillMdPath)) {
    errors.push('Missing required file: SKILL.md');
  }

  // 2) Validate engine.json
  let engineJson = null;
  if (fs.existsSync(engineJsonPath) && !isSymlinkSafe(engineJsonPath)) {
    const st = fs.statSync(engineJsonPath);
    if (st.size <= 0 || st.size > MAX_JSON_BYTES) {
      errors.push(`engine.json size out of range (1..${MAX_JSON_BYTES} bytes)`);
    } else {
      const rawJson = fs.readFileSync(engineJsonPath, 'utf8').replace(/^\uFEFF/, '');
      scanTextForSecretsAndPaths(`${skillName}/engine.json`, rawJson, errors);
      try {
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push('engine.json must be a JSON object');
        } else {
          engineJson = parsed;
        }
      } catch (err) {
        errors.push(`engine.json is not valid JSON: ${err.message}`);
      }
    }
  }

  if (engineJson) {
    const forbiddenKeys = [];
    collectForbiddenJsonKeys(engineJson, '', forbiddenKeys);
    for (const keyPath of forbiddenKeys) {
      errors.push(`engine.json contains forbidden machine-local field: ${keyPath}`);
    }

    if (engineJson.schema_version !== undefined && engineJson.schema_version !== 1) {
      errors.push(`engine.json schema_version must be 1 (got ${JSON.stringify(engineJson.schema_version)})`);
    }

    const engName = typeof engineJson.name === 'string' ? engineJson.name.trim() : '';
    if (!engName || !SKILL_NAME_RE.test(engName)) {
      errors.push(`engine.json missing valid lowercase name (got ${JSON.stringify(engineJson.name)})`);
    }

    const skillField = typeof engineJson.skill === 'string' ? engineJson.skill.trim() : '';
    if (!skillField || skillField !== skillName) {
      errors.push(`engine.json "skill" (${JSON.stringify(skillField)}) must match directory name "${skillName}"`);
    }

    const pipeline = typeof engineJson.pipeline === 'string' ? engineJson.pipeline.trim().toLowerCase() : '';
    if (!['skill', 'direct', 'builtin'].includes(pipeline)) {
      errors.push(`engine.json "pipeline" must be one of skill|direct|builtin (got ${JSON.stringify(engineJson.pipeline)})`);
    }
    if (pipeline === 'skill' && RESERVED_SKILL_ENGINES.has(engName)) {
      errors.push(`engine.json cannot override reserved builtin engine "${engName}" with pipeline="skill"`);
    }

    if (!Array.isArray(engineJson.kinds) || engineJson.kinds.length === 0) {
      errors.push('engine.json "kinds" must be a non-empty string array');
    } else {
      for (const k of engineJson.kinds) {
        if (typeof k !== 'string' || !SKILL_NAME_RE.test(k.trim())) {
          errors.push(`engine.json "kinds" contains invalid entry: ${JSON.stringify(k)}`);
        }
      }
    }

    if (pipeline === 'skill') {
      const m = engineJson.match;
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        errors.push('engine.json requires "match" object when pipeline="skill"');
      } else {
        const hasExts = Array.isArray(m.extensions) && m.extensions.length > 0;
        const hasMagic = typeof m.magic_hex === 'string' && /^[0-9a-fA-F]{2,64}$/.test(m.magic_hex) && m.magic_hex.length % 2 === 0;
        if (!hasExts && !hasMagic) {
          errors.push('engine.json "match" must declare valid extensions and/or even-length magic_hex');
        }
        if (hasExts) {
          for (const ext of m.extensions) {
            if (typeof ext !== 'string' || !ext.startsWith('.') || ext.length < 2 || /[/\\ ]/.test(ext)) {
              errors.push(`engine.json match.extensions contains invalid extension: ${JSON.stringify(ext)}`);
            }
          }
        }
        if (m.magic_offset !== undefined && (!Number.isInteger(m.magic_offset) || m.magic_offset < 0 || m.magic_offset > 4096)) {
          errors.push(`engine.json match.magic_offset must be an integer in 0..4096`);
        }
      }
      if (!presentRuntimeScripts.includes('unpack.py')) {
        errors.push('pipeline="skill" requires unpack.py');
      }
      if (!presentRuntimeScripts.includes('repack.py')) {
        errors.push('pipeline="skill" requires repack.py');
      }
    }

    if (pipeline === 'direct') {
      if (!presentRuntimeScripts.includes('extract.py')) {
        errors.push('pipeline="direct" requires extract.py');
      }
      if (!presentRuntimeScripts.includes('apply.py')) {
        errors.push('pipeline="direct" requires apply.py');
      }
    }

    if (engineJson.writeback !== undefined) {
      if (!engineJson.writeback || typeof engineJson.writeback !== 'object' || Array.isArray(engineJson.writeback)) {
        errors.push('engine.json "writeback" must be an object');
      }
    }
  }

  // 3) Validate SKILL.md & hash
  if (fs.existsSync(skillMdPath) && !isSymlinkSafe(skillMdPath)) {
    const st = fs.statSync(skillMdPath);
    if (st.size <= 0 || st.size > MAX_MD_BYTES) {
      errors.push(`SKILL.md size out of range (1..${MAX_MD_BYTES} bytes)`);
    } else {
      const mdBuf = fs.readFileSync(skillMdPath);
      if (mdBuf.includes(0x00)) {
        errors.push('SKILL.md contains NUL bytes');
      } else {
        const mdText = mdBuf.toString('utf8');
        scanTextForSecretsAndPaths(`${skillName}/SKILL.md`, mdText, errors);
        if (mdText.includes('PAPERCUP_DRAFT')) {
          errors.push('SKILL.md contains PAPERCUP_DRAFT marker');
        }
        if (/disable-model-invocation:\s*(?:true|yes|1)/i.test(mdText)) {
          errors.push('SKILL.md sets disable-model-invocation: true (draft skill not allowed)');
        }
        for (const rule of PRIVATE_DOC_REF_PATTERNS) {
          if (rule.re.test(mdText)) {
            errors.push(`SKILL.md references private dev trace (${rule.label})`);
          }
        }
        const fm = parseFrontmatter(mdText);
        if (!fm) {
          errors.push('SKILL.md missing YAML frontmatter (--- ... ---)');
        } else {
          if (fm.name !== skillName) {
            errors.push(`SKILL.md frontmatter name (${JSON.stringify(fm.name)}) must match "${skillName}"`);
          }
          if (!fm.description) {
            errors.push('SKILL.md frontmatter missing description');
          }
          for (const key of Object.keys(fm)) {
            if (FORBIDDEN_FRONTMATTER_KEYS.has(key)) {
              errors.push(`SKILL.md frontmatter contains forbidden machine-local key: ${key}`);
            }
          }
        }

        if (engineJson) {
          const expectedSkillSha = typeof engineJson['skill-sha256'] === 'string' ? engineJson['skill-sha256'].trim().toLowerCase() : '';
          const actualSkillSha = hashSkillText(mdText);
          if (!SHA256_RE.test(expectedSkillSha)) {
            errors.push('engine.json missing valid 64-hex "skill-sha256"');
          } else if (expectedSkillSha !== actualSkillSha) {
            errors.push(`SKILL.md SHA-256 mismatch (expected ${expectedSkillSha.slice(0, 12)}, actual ${actualSkillSha.slice(0, 12)})`);
          }
        }
      }
    }
  }

  // 4) Validate runtime script SHA-256 hashes & content hygiene
  for (const script of RUNTIME_SCRIPTS) {
    const field = SCRIPT_DIGEST_FIELDS[script];
    const scriptPath = path.join(absDir, script);
    const exists = fs.existsSync(scriptPath) && !isSymlinkSafe(scriptPath);
    const expected = engineJson && typeof engineJson[field] === 'string' ? engineJson[field].trim().toLowerCase() : '';

    if (expected && !SHA256_RE.test(expected)) {
      errors.push(`engine.json "${field}" is not a valid 64-hex SHA-256 digest`);
      continue;
    }
    if (expected && !exists) {
      errors.push(`engine.json declares "${field}" but ${script} is missing`);
      continue;
    }
    if (exists && !expected) {
      errors.push(`${script} is present without required "${field}" in engine.json`);
      continue;
    }
    if (exists && expected) {
      const st = fs.statSync(scriptPath);
      if (st.size <= 0 || st.size > MAX_SCRIPT_BYTES) {
        errors.push(`${script} size out of range (1..${MAX_SCRIPT_BYTES} bytes)`);
        continue;
      }
      const buf = fs.readFileSync(scriptPath);
      if (buf.includes(0x00)) {
        errors.push(`${script} contains NUL bytes`);
        continue;
      }
      const text = buf.toString('utf8');
      if (text.includes('PAPERCUP_DRAFT')) {
        errors.push(`${script} contains PAPERCUP_DRAFT marker`);
      }
      scanTextForSecretsAndPaths(`${skillName}/${script}`, text, errors);
      const actual = hashSkillText(text);
      if (actual !== expected) {
        errors.push(`${script} SHA-256 mismatch (expected ${expected.slice(0, 12)}, actual ${actual.slice(0, 12)})`);
      }
    }
  }

  // Also check test_fixture.py hygiene if present
  const fixturePath = path.join(absDir, 'test_fixture.py');
  if (fs.existsSync(fixturePath) && !isSymlinkSafe(fixturePath)) {
    const buf = fs.readFileSync(fixturePath);
    if (buf.includes(0x00)) {
      errors.push('test_fixture.py contains NUL bytes');
    } else {
      scanTextForSecretsAndPaths(`${skillName}/test_fixture.py`, buf.toString('utf8'), errors);
    }
  }

  // 5) Python AST static security audit on all .py files (including test_fixture.py)
  if (allPyFiles.length > 0) {
    const astAudit = runPythonAstAudit(allPyFiles, options.python);
    for (const f of astAudit.findings) {
      const rel = path.relative(absDir, f.file).replace(/\\/g, '/');
      errors.push(`AST security violation in ${rel}:${f.line} [${f.rule}] ${f.detail}`);
    }
  }

  return {
    ok: errors.length === 0,
    skillName,
    directory: absDir,
    errors,
    warnings,
    checkedFiles,
  };
}

export function validateSkillsRoot(skillsDir = DEFAULT_SKILLS_DIR, options = {}) {
  const absRoot = path.resolve(skillsDir);
  if (isSymlinkSafe(absRoot) || !fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    return {
      ok: false,
      skillsDir: absRoot,
      results: [],
      errors: [`Skills root directory does not exist or is not a directory: ${absRoot}`],
    };
  }

  const rootErrors = [];
  const skillDirs = [];
  for (const ent of fs.readdirSync(absRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(absRoot, ent.name);
    if (ent.name.startsWith('.')) continue;
    if (isSymlinkSafe(full)) {
      rootErrors.push(`Symlink not allowed in skills root: ${ent.name}`);
      continue;
    }
    if (ent.isDirectory()) {
      skillDirs.push(full);
    } else if (ent.isFile() && ent.name === 'README.md') {
      const mdText = fs.readFileSync(full, 'utf8');
      scanTextForSecretsAndPaths('skills/README.md', mdText, rootErrors);
      for (const rule of PRIVATE_DOC_REF_PATTERNS) {
        if (rule.re.test(mdText)) {
          rootErrors.push(`skills/README.md references private dev trace (${rule.label})`);
        }
      }
    }
  }

  const results = skillDirs.map((dir) => validateSkillDirectory(dir, options));
  const ok = rootErrors.length === 0 && results.every((r) => r.ok);
  return { ok, skillsDir: absRoot, results, errors: rootErrors };
}

function parseArgs(argv) {
  const opts = {
    dir: '',
    skill: '',
    python: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg.startsWith('--dir=')) opts.dir = arg.slice(6);
    else if (arg === '--dir' && argv[i + 1]) opts.dir = argv[++i];
    else if (arg.startsWith('--skill=')) opts.skill = arg.slice(8);
    else if (arg === '--skill' && argv[i + 1]) opts.skill = argv[++i];
    else if (arg.startsWith('--python=')) opts.python = arg.slice(9);
    else if (arg === '--python' && argv[i + 1]) opts.python = argv[++i];
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/validate-skills.mjs [--dir <skillsDir>] [--skill <skillDir>] [--python <cmd>] [--json]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (opts.dir && opts.skill) {
    throw new Error('Cannot combine --dir and --skill.');
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.skill) {
    const res = validateSkillDirectory(opts.skill, { python: opts.python || undefined });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.ok) {
      console.log(`[validate-skills] PASS ${res.skillName} (${res.checkedFiles.length} files verified + Python AST audit)`);
    } else {
      console.error(`[validate-skills] FAIL ${res.skillName}:`);
      for (const err of res.errors) console.error(`  - ${err}`);
    }
    process.exit(res.ok ? 0 : 1);
  }

  const rootDir = opts.dir || DEFAULT_SKILLS_DIR;
  const report = validateSkillsRoot(rootDir, { python: opts.python || undefined });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const err of report.errors) {
      console.error(`[validate-skills] ROOT ERROR: ${err}`);
    }
    for (const res of report.results) {
      if (res.ok) {
        console.log(`[validate-skills] PASS ${res.skillName} (${res.checkedFiles.length} files verified + Python AST audit)`);
      } else {
        console.error(`[validate-skills] FAIL ${res.skillName}:`);
        for (const err of res.errors) console.error(`  - ${err}`);
      }
    }
    if (report.ok) {
      console.log(`[validate-skills] All ${report.results.length} skill package(s) passed validation.`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
}

if (isDirectEntry()) {
  try {
    main();
  } catch (err) {
    console.error('[validate-skills]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

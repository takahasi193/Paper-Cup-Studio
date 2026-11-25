import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_DIR, '..');
const EXPORT_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'export-public.mjs');
const VALIDATE_SKILLS_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'validate-skills.mjs');
const START_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'start.mjs');
const VITE_CONFIG_PATH = path.join(WEB_DIR, 'vite.config.ts');
const REPO_SKILLS_DIR = path.join(REPO_ROOT, 'skills');

const exportMod = await import(pathToFileURL(EXPORT_SCRIPT_PATH).href);
const validateSkillsMod = await import(pathToFileURL(VALIDATE_SKILLS_SCRIPT_PATH).href);
const startMod = await import(pathToFileURL(START_SCRIPT_PATH).href);

function runGit(args: string[], cwd: string) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Runner',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test Runner',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFileNested(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

describe('scripts/export-public.mjs — dual-repo privacy guards', () => {
  it('enforces top-level allowlist and blocks sensitive files at any depth while allowing public paths', () => {
    const entries = [
      // Legitimate public entries
      '.env.example',
      '.gitattributes',
      '.gitignore',
      'LICENSE',
      'README.md',
      'Start-PaperCup.bat',
      'start-papercup.sh',
      'package.json',
      'scripts/start.mjs',
      'server/src/index.ts',
      'skills/README.md',
      'skills/engine-nexas-pacf/engine.json',
      'skills/engine-nexas-pacf/SKILL.md',
      'skills/engine-nexas-pacf/unpack.py',
      'web/src/App.tsx',
      // Disallowed top-level private entries
      'AGENTS.md',
      'TODO.md',
      'CODEX_HANDOFF.md',
      'CLAUDE.md',
      'GEMINI.md',
      'change/2026-11-21-audit.md',
      '.github/workflows/ci.yml',
      '.papercup/foo',
      '.env',
      '.env.local',
      'unknown-private.txt',
      // Nested any-depth sensitive entries inside allowed top-level dirs
      'server/AGENTS.md',
      'web/TODO.md',
      'server/CODEX_HANDOFF.md',
      'web/CLAUDE.md',
      'server/GEMINI.md',
      'server/.papercup/state.json',
      'web/.env',
      'server/.env.local',
      'server/auth.json',
      'web/certs/key.pem',
      'server/tls/private.key',
      'scripts/export-public.mjs',
      'server/change/internal.md',
      'web/.github/secret.yml',
      'skills/.env',
      'skills/engine-nexas-pacf/.env.local',
      'skills/engine-nexas-pacf/secret.pem',
      'skills/engine-nexas-pacf/private.key',
      'skills/AGENTS.md',
      'skills/TODO.md',
      'skills/.papercup/state.json',
      'skills/auth.json',
    ];

    const result = exportMod.validateExportEntries(entries);
    assert.equal(result.ok, false);

    // Top-level unknown/private entries rejected by allowlist
    for (const expectedTop of [
      'AGENTS.md',
      'TODO.md',
      'CODEX_HANDOFF.md',
      'CLAUDE.md',
      'GEMINI.md',
      'change/2026-11-21-audit.md',
      '.github/workflows/ci.yml',
      '.papercup/foo',
      '.env',
      '.env.local',
      'unknown-private.txt',
    ]) {
      assert.ok(
        result.disallowedTopLevel.includes(expectedTop),
        `Expected top-level disallow for ${expectedTop}, got: ${JSON.stringify(result)}`
      );
    }

    // Nested sensitive entries rejected by any-depth denylist
    for (const expectedSensitive of [
      'server/AGENTS.md',
      'web/TODO.md',
      'server/CODEX_HANDOFF.md',
      'web/CLAUDE.md',
      'server/GEMINI.md',
      'server/.papercup/state.json',
      'web/.env',
      'server/.env.local',
      'server/auth.json',
      'web/certs/key.pem',
      'server/tls/private.key',
      'scripts/export-public.mjs',
      'server/change/internal.md',
      'web/.github/secret.yml',
      'skills/.env',
      'skills/engine-nexas-pacf/.env.local',
      'skills/engine-nexas-pacf/secret.pem',
      'skills/engine-nexas-pacf/private.key',
      'skills/AGENTS.md',
      'skills/TODO.md',
      'skills/.papercup/state.json',
      'skills/auth.json',
    ]) {
      assert.ok(
        result.sensitiveMatched.includes(expectedSensitive),
        `Expected sensitive match for ${expectedSensitive}, got: ${JSON.stringify(result)}`
      );
    }

    // Legitimate public entries must never be flagged
    const publicOnly = exportMod.validateExportEntries([
      '.env.example',
      '.gitattributes',
      '.gitignore',
      'LICENSE',
      'README.md',
      'Start-PaperCup.bat',
      'start-papercup.sh',
      'package.json',
      'scripts/start.mjs',
      'server/src/index.ts',
      'skills/README.md',
      'skills/engine-nexas-pacf/engine.json',
      'skills/engine-nexas-pacf/SKILL.md',
      'skills/engine-nexas-pacf/unpack.py',
      'web/src/App.tsx',
    ]);
    assert.equal(publicOnly.ok, true);
    assert.equal(exportMod.PUBLIC_TOP_LEVEL_ALLOWLIST.has('skills'), true);
    assert.deepEqual(publicOnly.disallowedTopLevel, []);
    assert.deepEqual(publicOnly.sensitiveMatched, []);
  });

  it('strips export-ignore lines in .gitattributes without truncating public attributes placed after private marker', () => {
    const raw = [
      '*.bat text eol=crlf',
      '# --- private-only: excluded from public export ---',
      'TODO.md export-ignore',
      'AGENTS.md export-ignore',
      '/.env.example -export-ignore',
      '*.sh text eol=lf',
      '*.png binary',
      '',
    ].join('\n');

    const cleaned = exportMod.stripPrivateGitattributesContent(raw);
    assert.equal(cleaned.includes('export-ignore'), false);
    assert.equal(cleaned.includes('private-only'), false);
    assert.ok(cleaned.includes('*.bat text eol=crlf'));
    assert.ok(cleaned.includes('*.sh text eol=lf'));
    assert.ok(cleaned.includes('*.png binary'));

    // Empty-after-strip removes .gitattributes cleanly on disk
    const tmp = makeTempDir('pc-gitattr-');
    try {
      const attrPath = path.join(tmp, '.gitattributes');
      fs.writeFileSync(attrPath, '# --- private-only\n/TODO.md export-ignore\n', 'utf8');
      exportMod.stripPrivateGitattributes(tmp);
      assert.equal(fs.existsSync(attrPath), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detects private dev trace references in public Markdown and passes the real repository README.md', () => {
    const badDoc = [
      '# Public Doc',
      'See [audit](change/2026-11-21-audit.md) for details.',
      'Check TODO.md and AGENTS.md before editing.',
      'Also CODEX_HANDOFF.md, CLAUDE.md, GEMINI.md, scripts/export-public.mjs, and .github/workflows/ci.yml.',
    ].join('\n');

    const findings = exportMod.scanMarkdownForPrivateRefs('README.md', badDoc);
    const rulesHit = new Set(findings.map((f: { rule: string }) => f.rule));
    for (const expected of [
      'change/',
      'TODO.md',
      'AGENTS.md',
      'CODEX_HANDOFF.md',
      'CLAUDE.md',
      'GEMINI.md',
      'scripts/export-public.mjs',
      '.github/',
    ]) {
      assert.ok(rulesHit.has(expected), `Expected Markdown scanner to flag ${expected}`);
    }

    const cleanDoc = '# Paper Cup Studio\n\nSummary of recent changes to localization pipeline.\n';
    assert.deepEqual(exportMod.scanMarkdownForPrivateRefs('README.md', cleanDoc), []);

    // Real repository README.md and public skills Markdown must have 0 private dev trace references
    const repoReadme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const repoFindings = exportMod.scanMarkdownForPrivateRefs('README.md', repoReadme);
    assert.deepEqual(repoFindings, []);
    for (const relMd of ['skills/README.md', 'skills/engine-nexas-pacf/SKILL.md']) {
      const mdContent = fs.readFileSync(path.join(REPO_ROOT, relMd), 'utf8');
      assert.deepEqual(
        exportMod.scanMarkdownForPrivateRefs(relMd, mdContent),
        [],
        `Public skill Markdown ${relMd} must have 0 private dev trace references`
      );
    }
  });

  it('passes end-to-end --dry-run in an isolated temp git repo and blocks leaked private files & Markdown refs', () => {
    const tmpRepo = makeTempDir('pc-export-e2e-');
    try {
      runGit(['init', '-b', 'main'], tmpRepo);
      const realGitAttributes = fs.readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8');
      const realExportScript = fs.readFileSync(EXPORT_SCRIPT_PATH, 'utf8');

      writeFileNested(tmpRepo, '.gitattributes', realGitAttributes);
      writeFileNested(tmpRepo, 'scripts/export-public.mjs', realExportScript);
      writeFileNested(tmpRepo, 'scripts/start.mjs', 'console.log("ok");\n');
      writeFileNested(tmpRepo, 'package.json', JSON.stringify({ name: 'paper-cup', version: '0.1.0-test' }));
      writeFileNested(tmpRepo, 'README.md', '# Paper Cup Studio\n\nPublic clean readme.\n');
      writeFileNested(tmpRepo, '.env.example', 'OPENAI_API_KEY=\n');
      writeFileNested(tmpRepo, 'server/src/index.ts', 'export const ok = true;\n');
      writeFileNested(tmpRepo, 'skills/README.md', '# Community Engine Skills\n\nPublic clean skill docs.\n');
      writeFileNested(tmpRepo, 'skills/engine-demo/engine.json', '{"name":"demo","skill":"engine-demo"}\n');
      writeFileNested(tmpRepo, 'web/src/App.tsx', 'export const App = () => null;\n');

      // Private files that MUST be stripped by .gitattributes export-ignore
      writeFileNested(tmpRepo, 'AGENTS.md', '# Private\n');
      writeFileNested(tmpRepo, 'server/AGENTS.md', '# Nested Private\n');
      writeFileNested(tmpRepo, 'TODO.md', '- secret todo\n');
      writeFileNested(tmpRepo, 'CLAUDE.md', '# Private Claude\n');
      writeFileNested(tmpRepo, 'GEMINI.md', '# Private Gemini\n');
      writeFileNested(tmpRepo, 'CODEX_HANDOFF.md', '# Handoff\n');
      writeFileNested(tmpRepo, 'change/2026-11-21-note.md', '# Change log\n');
      writeFileNested(tmpRepo, '.github/workflows/ci.yml', 'name: CI\n');
      writeFileNested(tmpRepo, '.papercup/internal.json', '{}');
      writeFileNested(tmpRepo, '.env', 'SECRET=1\n');
      writeFileNested(tmpRepo, '.env.local', 'SECRET=2\n');

      runGit(['add', '-A'], tmpRepo);
      runGit(['commit', '-m', 'initial snapshot'], tmpRepo);

      // 1) Clean dry-run must PASS
      const passRes = spawnSync(process.execPath, ['scripts/export-public.mjs', '--dry-run'], {
        cwd: tmpRepo,
        encoding: 'utf8',
      });
      assert.equal(passRes.status, 0, `Expected dry-run pass, stderr: ${passRes.stderr}`);
      assert.match(passRes.stdout, /Dry-run audit PASSED/);

      // 2) Negative: unignored sensitive file inside allowed dir (.pem) must ABORT
      writeFileNested(tmpRepo, 'server/leak.pem', '-----BEGIN PRIVATE KEY-----\n');
      runGit(['add', 'server/leak.pem'], tmpRepo);
      runGit(['commit', '-m', 'add leaked pem'], tmpRepo);
      const pemFail = spawnSync(process.execPath, ['scripts/export-public.mjs', '--dry-run'], {
        cwd: tmpRepo,
        encoding: 'utf8',
      });
      assert.notEqual(pemFail.status, 0);
      assert.match(pemFail.stderr, /\[sensitive-path\] server\/leak\.pem/);

      // Clean up leak.pem
      fs.rmSync(path.join(tmpRepo, 'server/leak.pem'));
      runGit(['add', '-A'], tmpRepo);
      runGit(['commit', '-m', 'remove leak.pem'], tmpRepo);

      // 3) Negative: unknown top-level file not in allowlist must ABORT
      writeFileNested(tmpRepo, 'INTERNAL_NOTES.txt', 'internal only\n');
      runGit(['add', 'INTERNAL_NOTES.txt'], tmpRepo);
      runGit(['commit', '-m', 'add unknown top-level'], tmpRepo);
      const topFail = spawnSync(process.execPath, ['scripts/export-public.mjs', '--dry-run'], {
        cwd: tmpRepo,
        encoding: 'utf8',
      });
      assert.notEqual(topFail.status, 0);
      assert.match(topFail.stderr, /\[not-in-allowlist\] INTERNAL_NOTES\.txt/);

      fs.rmSync(path.join(tmpRepo, 'INTERNAL_NOTES.txt'));
      runGit(['add', '-A'], tmpRepo);
      runGit(['commit', '-m', 'remove unknown top-level'], tmpRepo);

      // 4) Negative: sensitive file nested inside skills/ (.key) must ABORT
      writeFileNested(tmpRepo, 'skills/engine-demo/secret.key', 'SECRET_KEY\n');
      runGit(['add', 'skills/engine-demo/secret.key'], tmpRepo);
      runGit(['commit', '-m', 'add leaked key in skills'], tmpRepo);
      const skillKeyFail = spawnSync(process.execPath, ['scripts/export-public.mjs', '--dry-run'], {
        cwd: tmpRepo,
        encoding: 'utf8',
      });
      assert.notEqual(skillKeyFail.status, 0);
      assert.match(skillKeyFail.stderr, /\[sensitive-path\] skills\/engine-demo\/secret\.key/);

      fs.rmSync(path.join(tmpRepo, 'skills/engine-demo/secret.key'));
      runGit(['add', '-A'], tmpRepo);
      runGit(['commit', '-m', 'remove leaked key in skills'], tmpRepo);

      // 5) Negative: README or skills/README.md referencing change/ or TODO.md must ABORT
      writeFileNested(tmpRepo, 'skills/README.md', '# Skills\nSee AGENTS.md for rules.\n');
      runGit(['add', 'skills/README.md'], tmpRepo);
      runGit(['commit', '-m', 'leak private ref in skills readme'], tmpRepo);
      const skillMdFail = spawnSync(process.execPath, ['scripts/export-public.mjs', '--dry-run'], {
        cwd: tmpRepo,
        encoding: 'utf8',
      });
      assert.notEqual(skillMdFail.status, 0);
      assert.match(skillMdFail.stderr, /Private dev trace references found in public Markdown/);

      writeFileNested(tmpRepo, 'skills/README.md', '# Community Engine Skills\n\nPublic clean skill docs.\n');
      writeFileNested(tmpRepo, 'README.md', '# Paper Cup\nSee TODO.md and change/log.md.\n');
      runGit(['add', 'skills/README.md', 'README.md'], tmpRepo);
      runGit(['commit', '-m', 'leak private refs in readme'], tmpRepo);
      const mdFail = spawnSync(process.execPath, ['scripts/export-public.mjs', '--dry-run'], {
        cwd: tmpRepo,
        encoding: 'utf8',
      });
      assert.notEqual(mdFail.status, 0);
      assert.match(mdFail.stderr, /Private dev trace references found in public Markdown/);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('passes --dry-run against the real repository HEAD', () => {
    const res = spawnSync(process.execPath, [EXPORT_SCRIPT_PATH, '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `Real repo export dry-run failed: ${res.stderr}`);
    assert.match(res.stdout, /Dry-run audit PASSED/);
  });
});

describe('web/vite.config.ts — dynamic API proxy target', () => {
  function evaluateViteProxy(envOverrides: Record<string, string | undefined>) {
    const tsxCli = path.join(REPO_ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const script = `import cfg from ${JSON.stringify(pathToFileURL(VITE_CONFIG_PATH).href)}; console.log(JSON.stringify({ api: cfg.server?.proxy?.['/api']?.target, health: cfg.server?.proxy?.['/health']?.target }));`;
    const res = spawnSync(process.execPath, [tsxCli, '-e', script], {
      cwd: WEB_DIR,
      env,
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `Evaluating vite.config.ts failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim()) as { api: string; health: string };
  }

  it('defaults proxy targets to 127.0.0.1:3100 and honors custom PORT / HOST env vars', () => {
    const def = evaluateViteProxy({ PORT: undefined, HOST: undefined });
    assert.equal(def.api, 'http://127.0.0.1:3100');
    assert.equal(def.health, 'http://127.0.0.1:3100');

    const custom = evaluateViteProxy({ PORT: '3200', HOST: 'localhost' });
    assert.equal(custom.api, 'http://localhost:3200');
    assert.equal(custom.health, 'http://localhost:3200');

    const invalid = evaluateViteProxy({ PORT: 'not-a-port', HOST: '127.0.0.1' });
    assert.equal(invalid.api, 'http://127.0.0.1:3100');
    assert.equal(invalid.health, 'http://127.0.0.1:3100');
  });
});

describe('scripts/start.mjs — port validation, dynamic version, and dist staleness', () => {
  it('validates PORT env and --port CLI arguments strictly', () => {
    for (const bad of ['abc', '0', '-1', '65536', '70000', '3100.5', '']) {
      assert.throws(() => startMod.parsePortValue(bad, 'PORT'), /无效端口|端口超出范围/);
    }
    assert.equal(startMod.parsePortValue('3100', 'PORT'), 3100);
    assert.equal(startMod.parsePortValue('65535', '--port'), 65535);

    assert.throws(() => startMod.parseArgs([], { PORT: 'abc' }), /无效端口/);
    assert.throws(() => startMod.parseArgs(['--port=0'], {}), /端口超出范围/);
    assert.throws(() => startMod.parseArgs(['--port=70000'], {}), /端口超出范围/);
    assert.throws(() => startMod.parseArgs(['--port'], {}), /缺少 --port/);

    const fromEnv = startMod.parseArgs([], { PORT: '3456' });
    assert.equal(fromEnv.port, 3456);
    const cliOverridesEnv = startMod.parseArgs(['--port=4567', '--dev', '--no-open'], { PORT: '3456' });
    assert.equal(cliOverridesEnv.port, 4567);
    assert.equal(cliOverridesEnv.dev, true);
    assert.equal(cliOverridesEnv.open, false);
  });

  it('reads version dynamically from root package.json rather than hardcoding', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(startMod.readAppVersion(REPO_ROOT), rootPkg.version);

    const tmp = makeTempDir('pc-start-ver-');
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '9.8.7-custom' }), 'utf8');
      assert.equal(startMod.readAppVersion(tmp), '9.8.7-custom');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detects missing and stale dist artifacts relative to nested source files', () => {
    const tmp = makeTempDir('pc-stale-');
    try {
      const distEntry = path.join(tmp, 'dist', 'index.js');
      const srcDir = path.join(tmp, 'src');
      const nestedSrc = path.join(srcDir, 'nested', 'mod.ts');
      const pkgFile = path.join(tmp, 'package.json');

      writeFileNested(tmp, 'src/nested/mod.ts', 'export const x = 1;\n');
      writeFileNested(tmp, 'package.json', '{"name":"demo"}\n');

      // Missing dist -> stale
      assert.equal(startMod.isBuildStale(distEntry, [srcDir, pkgFile]), true);

      // Dist newer than all sources -> fresh
      writeFileNested(tmp, 'dist/index.js', 'console.log(1);\n');
      const older = new Date(Date.now() - 10_000);
      const newer = new Date(Date.now() - 1_000);
      fs.utimesSync(nestedSrc, older, older);
      fs.utimesSync(pkgFile, older, older);
      fs.utimesSync(distEntry, newer, newer);
      assert.equal(startMod.isBuildStale(distEntry, [srcDir, pkgFile]), false);

      // Nested source updated after dist -> stale
      const newest = new Date(Date.now() + 5_000);
      fs.utimesSync(nestedSrc, newest, newest);
      assert.equal(startMod.isBuildStale(distEntry, [srcDir, pkgFile]), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

interface SyntheticSkillOverrides {
  dirName?: string;
  skillMd?: string;
  unpackPy?: string;
  repackPy?: string;
  extractPy?: string;
  applyPy?: string;
  enginePatch?: Record<string, unknown>;
  extraFiles?: Record<string, string>;
  omitFiles?: string[];
  tamperDigestFor?: 'skill' | 'unpack' | 'repack';
}

function writeSyntheticSkillPackage(rootDir: string, overrides: SyntheticSkillOverrides = {}): string {
  const dirName = overrides.dirName ?? 'engine-synth';
  const skillDir = path.join(rootDir, dirName);
  fs.mkdirSync(skillDir, { recursive: true });

  const skillMd =
    overrides.skillMd ??
    [
      '---',
      `name: ${dirName}`,
      'description: Synthetic self-contained engine skill for validator contract tests.',
      '---',
      '',
      `# ${dirName}`,
      '',
      'Generalized format documentation with zero machine-local paths.',
      '',
    ].join('\n');

  const unpackPy =
    overrides.unpackPy ??
    [
      'import os, sys',
      'def main():',
      '    src, dst = sys.argv[1], sys.argv[2]',
      '    os.makedirs(dst, exist_ok=True)',
      '    with open(src, "rb") as fh:',
      '        raw = fh.read()',
      '    with open(os.path.join(dst, "script.txt"), "wb") as out:',
      '        out.write(raw[4:])',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n');

  const repackPy =
    overrides.repackPy ??
    [
      'import os, sys',
      'def main():',
      '    src, dst = sys.argv[1], sys.argv[2]',
      '    with open(os.path.join(src, "script.txt"), "rb") as fh:',
      '        data = fh.read()',
      '    with open(dst, "wb") as out:',
      '        out.write(b"SYNT" + data)',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n');

  const omit = new Set(overrides.omitFiles ?? []);
  const files: Record<string, string> = {
    'SKILL.md': skillMd,
    'unpack.py': unpackPy,
    'repack.py': repackPy,
  };
  if (overrides.extractPy !== undefined) files['extract.py'] = overrides.extractPy;
  if (overrides.applyPy !== undefined) files['apply.py'] = overrides.applyPy;

  const engineObj: Record<string, unknown> = {
    schema_version: 1,
    name: dirName.replace(/^engine-/, ''),
    kinds: ['synt'],
    pipeline: 'skill',
    skill: dirName,
    'skill-sha256': validateSkillsMod.hashSkillText(skillMd),
    'unpack-sha256': validateSkillsMod.hashSkillText(unpackPy),
    'repack-sha256': validateSkillsMod.hashSkillText(repackPy),
    match: {
      extensions: ['.synt'],
      magic_hex: '53594e54',
      magic_offset: 0,
    },
    writeback: {
      mode: 'builtin_apply',
      encoding: 'utf-8',
      repack_cmd: 'vn_repack',
      verified: true,
    },
  };
  if (overrides.extractPy !== undefined) {
    engineObj['extract-sha256'] = validateSkillsMod.hashSkillText(overrides.extractPy);
  }
  if (overrides.applyPy !== undefined) {
    engineObj['apply-sha256'] = validateSkillsMod.hashSkillText(overrides.applyPy);
  }
  if (overrides.enginePatch) {
    Object.assign(engineObj, overrides.enginePatch);
  }
  if (overrides.tamperDigestFor === 'skill') {
    engineObj['skill-sha256'] = '0'.repeat(64);
  } else if (overrides.tamperDigestFor === 'unpack') {
    engineObj['unpack-sha256'] = 'f'.repeat(64);
  } else if (overrides.tamperDigestFor === 'repack') {
    engineObj['repack-sha256'] = 'a'.repeat(64);
  }

  for (const [rel, content] of Object.entries(files)) {
    if (!omit.has(rel)) {
      writeFileNested(skillDir, rel, content);
    }
  }
  if (!omit.has('engine.json')) {
    writeFileNested(skillDir, 'engine.json', JSON.stringify(engineObj, null, 2) + '\n');
  }
  for (const [rel, content] of Object.entries(overrides.extraFiles ?? {})) {
    writeFileNested(skillDir, rel, content);
  }
  return skillDir;
}

describe('scripts/validate-skills.mjs — schema, integrity & Python AST security gate', () => {
  it('validates the real repository skills/ directory and synthetic clean skill packages via API and CLI', () => {
    const repoReport = validateSkillsMod.validateSkillsRoot(REPO_SKILLS_DIR);
    assert.equal(
      repoReport.ok,
      true,
      `Real skills/ validation failed: ${JSON.stringify(repoReport, null, 2)}`
    );
    assert.ok(
      repoReport.results.some((r: { skillName: string; ok: boolean }) => r.skillName === 'engine-nexas-pacf' && r.ok),
      'Expected engine-nexas-pacf to pass validation'
    );

    const cliRepo = spawnSync(process.execPath, [VALIDATE_SKILLS_SCRIPT_PATH, '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(cliRepo.status, 0, `CLI validate-skills failed: ${cliRepo.stderr}\n${cliRepo.stdout}`);
    const cliReport = JSON.parse(cliRepo.stdout);
    assert.equal(cliReport.ok, true);

    const tmp = makeTempDir('pc-val-clean-');
    try {
      writeFileNested(tmp, 'README.md', '# Community Skills\n\nClean public documentation.\n');
      const cleanDir = writeSyntheticSkillPackage(tmp);
      const apiRes = validateSkillsMod.validateSkillDirectory(cleanDir);
      assert.equal(apiRes.ok, true, `Clean synthetic skill should pass, got: ${JSON.stringify(apiRes.errors)}`);

      const cliSkill = spawnSync(process.execPath, [VALIDATE_SKILLS_SCRIPT_PATH, '--skill', cleanDir, '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.equal(cliSkill.status, 0, `CLI --skill failed: ${cliSkill.stderr}`);
      assert.equal(JSON.parse(cliSkill.stdout).ok, true);

      const cliDir = spawnSync(process.execPath, [VALIDATE_SKILLS_SCRIPT_PATH, '--dir', tmp, '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.equal(cliDir.status, 0, `CLI --dir failed: ${cliDir.stderr}`);
      assert.equal(JSON.parse(cliDir.stdout).ok, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks every forbidden Python AST security construct (imports, eval/exec, os.system, dynamic exec, out-of-bounds writes, sidecars, secret envs)', () => {
    const tmp = makeTempDir('pc-val-ast-');
    try {
      const negativeCases: Array<{ label: string; snippet: string; expectedRule: string }> = [
        { label: 'subprocess import', snippet: 'import subprocess\n', expectedRule: 'forbidden_import' },
        { label: 'from subprocess import run', snippet: 'from subprocess import run\n', expectedRule: 'forbidden_import' },
        { label: 'socket import', snippet: 'import socket\n', expectedRule: 'forbidden_import' },
        { label: 'urllib import', snippet: 'import urllib.request\n', expectedRule: 'forbidden_import' },
        { label: 'requests import', snippet: 'import requests\n', expectedRule: 'forbidden_import' },
        { label: 'ctypes import', snippet: 'import ctypes\n', expectedRule: 'forbidden_import' },
        { label: 'importlib dynamic import', snippet: 'import importlib\n', expectedRule: 'forbidden_import' },
        { label: 'eval call', snippet: 'x = eval("1 + 1")\n', expectedRule: 'forbidden_builtin_call' },
        { label: 'exec call', snippet: 'exec("x = 1")\n', expectedRule: 'forbidden_builtin_call' },
        { label: '__import__ call', snippet: 'm = __import__("os")\n', expectedRule: 'forbidden_builtin_call' },
        { label: 'os.system call', snippet: 'import os\nos.system("echo hi")\n', expectedRule: 'forbidden_os_call' },
        { label: 'aliased os.popen call', snippet: 'import os as _o\n_o.popen("ls")\n', expectedRule: 'forbidden_os_call' },
        { label: 'from os import system', snippet: 'from os import system\n', expectedRule: 'forbidden_os_import' },
        { label: 'getattr smuggling', snippet: 'fn = getattr(__builtins__, "eval")\n', expectedRule: 'forbidden_getattr' },
        { label: '__builtins__ subscript exec', snippet: '__builtins__["exec"]("x=1")\n', expectedRule: 'forbidden_builtin_subscript' },
        { label: 'out-of-bounds absolute POSIX write', snippet: 'open("/etc/passwd", "w").write("x")\n', expectedRule: 'out_of_bounds_write' },
        { label: 'out-of-bounds traversal write', snippet: 'open("../escape.txt", "w").write("x")\n', expectedRule: 'out_of_bounds_write' },
        { label: 'out-of-bounds Windows drive write', snippet: 'open(r"C:\\Windows\\temp\\pwn.txt", "w").write("x")\n', expectedRule: 'out_of_bounds_write' },
        { label: 'Path.home out-of-bounds write', snippet: 'from pathlib import Path\n(Path.home() / "pwn.txt").write_text("x")\n', expectedRule: 'out_of_bounds_write' },
        { label: 'os.path.expanduser out-of-bounds write', snippet: 'import os\nopen(os.path.expanduser("~/pwn.txt"), "w").write("x")\n', expectedRule: 'out_of_bounds_write' },
        { label: 'shutil.rmtree in runtime script', snippet: 'import shutil, sys\nshutil.rmtree(sys.argv[1])\n', expectedRule: 'forbidden_rmtree' },
        { label: 'sidecar .papercup-names.json write', snippet: 'import os, sys\nopen(os.path.join(sys.argv[2], ".papercup-names.json"), "w").write("{}")\n', expectedRule: 'forbidden_sidecar_write' },
        { label: 'sensitive env var read', snippet: 'import os\nk = os.environ.get("OPENAI_API_KEY")\n', expectedRule: 'forbidden_env_access' },
      ];

      for (let i = 0; i < negativeCases.length; i += 1) {
        const tc = negativeCases[i];
        const caseRoot = path.join(tmp, `case-${i}`);
        const skillDir = writeSyntheticSkillPackage(caseRoot, {
          unpackPy: tc.snippet,
        });
        const res = validateSkillsMod.validateSkillDirectory(skillDir);
        assert.equal(res.ok, false, `AST validator must reject [${tc.label}]`);
        assert.ok(
          res.errors.some((e: string) => e.includes(`[${tc.expectedRule}]`)),
          `Expected rule [${tc.expectedRule}] for [${tc.label}], got: ${JSON.stringify(res.errors)}`
        );
      }

      // Verify CLI exits non-zero on AST failure
      const badSkillDir = writeSyntheticSkillPackage(path.join(tmp, 'cli-fail'), {
        unpackPy: 'import subprocess\nsubprocess.run(["echo", "hi"])\n',
      });
      const cliFail = spawnSync(process.execPath, [VALIDATE_SKILLS_SCRIPT_PATH, '--skill', badSkillDir], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      assert.notEqual(cliFail.status, 0, 'CLI validate-skills must exit non-zero on AST violation');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('blocks schema violations, machine-local fields/paths, credentials, stray files, and SHA-256 tampering', () => {
    const tmp = makeTempDir('pc-val-schema-');
    try {
      // 1) Missing required SKILL.md
      const noMd = writeSyntheticSkillPackage(path.join(tmp, 'no-md'), { omitFiles: ['SKILL.md'] });
      const noMdRes = validateSkillsMod.validateSkillDirectory(noMd);
      assert.equal(noMdRes.ok, false);
      assert.ok(noMdRes.errors.some((e: string) => e.includes('Missing required file: SKILL.md')));

      // 2) Mismatched engine.json skill field & reserved builtin engine override
      const badSchema = writeSyntheticSkillPackage(path.join(tmp, 'bad-schema'), {
        enginePatch: { name: 'kirikiri', skill: 'engine-other', pipeline: 'skill' },
      });
      const badSchemaRes = validateSkillsMod.validateSkillDirectory(badSchema);
      assert.equal(badSchemaRes.ok, false);
      assert.ok(badSchemaRes.errors.some((e: string) => e.includes('must match directory name')));
      assert.ok(badSchemaRes.errors.some((e: string) => e.includes('reserved builtin engine')));

      // 3) Forbidden machine-local keys in engine.json (direct_root / source-sample / source-sha256)
      const localKeys = writeSyntheticSkillPackage(path.join(tmp, 'local-keys'), {
        enginePatch: { direct_root: 'game_trial', 'source-sample': 'D:\\Games\\sample.pac', 'source-sha256': '0'.repeat(64) },
      });
      const localKeysRes = validateSkillsMod.validateSkillDirectory(localKeys);
      assert.equal(localKeysRes.ok, false);
      assert.ok(localKeysRes.errors.some((e: string) => e.includes('direct_root')));
      assert.ok(localKeysRes.errors.some((e: string) => e.includes('source-sample')));

      // 4) Hardcoded local path & credential leak in SKILL.md / script
      const credAndPath = writeSyntheticSkillPackage(path.join(tmp, 'cred-path'), {
        skillMd: [
          '---',
          'name: engine-synth',
          'description: Leak test',
          'source-sample: /Users/alice/games/trial.pac',
          '---',
          '',
          'Sample path: C:\\Users\\alice\\Desktop\\game\\Script.pac',
          'Leak key: AIzaSyDummyValidatorLeakSecret1234567890',
          'Private ref: TODO.md',
          '',
        ].join('\n'),
      });
      const credRes = validateSkillsMod.validateSkillDirectory(credAndPath);
      assert.equal(credRes.ok, false);
      assert.ok(credRes.errors.some((e: string) => e.includes('suspected credential')));
      assert.ok(credRes.errors.some((e: string) => e.includes('machine-local path')));
      assert.ok(credRes.errors.some((e: string) => e.includes('forbidden machine-local key: source-sample')));
      assert.ok(credRes.errors.some((e: string) => e.includes('private dev trace (TODO.md)')));

      // 5) Stray unexpected sidecar file inside skill package
      const stray = writeSyntheticSkillPackage(path.join(tmp, 'stray-file'), {
        extraFiles: { '.papercup-names.json': '{"a":"b"}\n' },
      });
      const strayRes = validateSkillsMod.validateSkillDirectory(stray);
      assert.equal(strayRes.ok, false);
      assert.ok(strayRes.errors.some((e: string) => e.includes('Unexpected file inside skill package: .papercup-names.json')));

      // 6) SHA-256 tampering on unpack.py and SKILL.md
      const tamperedUnpack = writeSyntheticSkillPackage(path.join(tmp, 'tamper-unpack'), {
        tamperDigestFor: 'unpack',
      });
      const tamperUnpackRes = validateSkillsMod.validateSkillDirectory(tamperedUnpack);
      assert.equal(tamperUnpackRes.ok, false);
      assert.ok(tamperUnpackRes.errors.some((e: string) => e.includes('unpack.py SHA-256 mismatch')));

      const tamperedMd = writeSyntheticSkillPackage(path.join(tmp, 'tamper-md'), {
        tamperDigestFor: 'skill',
      });
      const tamperMdRes = validateSkillsMod.validateSkillDirectory(tamperedMd);
      assert.equal(tamperMdRes.ok, false);
      assert.ok(tamperMdRes.errors.some((e: string) => e.includes('SKILL.md SHA-256 mismatch')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('skills/engine-nexas-pacf — synthetic roundtrip & contract invariants', () => {
  const NEXAS_DIR = path.join(REPO_SKILLS_DIR, 'engine-nexas-pacf');
  const PY_CMD = validateSkillsMod.resolvePythonCommand();

  function runPython(args: string[], envExtra: Record<string, string> = {}) {
    const fullArgs = PY_CMD === 'py' ? ['-3', '-B', ...args] : ['-B', ...args];
    const res = spawnSync(PY_CMD, fullArgs, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...envExtra },
    });
    assert.equal(res.status, 0, `Python failed (${args.join(' ')}):\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}`);
    return res.stdout;
  }

  function buildSyntheticBinu8Header0x1c(strings: string[]): Buffer {
    const codeChunks = strings.map((_, idx) => {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(0x04, 0);
      b.writeUInt32LE(idx, 4);
      return b;
    });
    const codeBuf = Buffer.concat(codeChunks);
    const poolBuf = Buffer.concat(strings.map((s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])));
    const tailBuf = Buffer.alloc(12, 0);
    const hdr = Buffer.alloc(0x1c);
    hdr.writeUInt32LE(0x1c, 0);
    hdr.writeUInt32LE(1, 4);
    hdr.writeUInt32LE(0x1c, 8);
    hdr.writeUInt32LE(strings.length, 12);
    hdr.writeUInt32LE(0x1c + codeBuf.length, 16);
    hdr.writeUInt32LE(strings.length, 20);
    hdr.writeUInt32LE(poolBuf.length, 24);
    return Buffer.concat([hdr, codeBuf, poolBuf, tailBuf]);
  }

  function buildSyntheticBinu8Chunk0x1c(strings: string[]): Buffer {
    const codeHeader = Buffer.alloc(4);
    codeHeader.writeUInt32LE(strings.length, 0);
    const codeBody = Buffer.concat([
      codeHeader,
      ...strings.map((_, idx) => {
        const b = Buffer.alloc(8);
        b.writeUInt32LE(0x04, 0);
        b.writeUInt32LE(idx, 4);
        return b;
      }),
    ]);
    const poolHeader = Buffer.alloc(4);
    poolHeader.writeUInt32LE(strings.length, 0);
    const poolBody = Buffer.concat([
      poolHeader,
      ...strings.map((s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])),
    ]);
    const tag1 = Buffer.alloc(8);
    tag1.writeUInt32LE(0x01, 0);
    tag1.writeUInt32LE(codeBody.length, 4);
    const tag1c = Buffer.alloc(8);
    tag1c.writeUInt32LE(0x1c, 0);
    tag1c.writeUInt32LE(poolBody.length, 4);
    return Buffer.concat([tag1, codeBody, tag1c, poolBody]);
  }

  function findSidecarFiles(dir: string): string[] {
    const hits: string[] = [];
    const stack = [dir];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (/^\.papercup-.*\.json$/i.test(ent.name)) hits.push(full);
      }
    }
    return hits;
  }

  it('passes bundled zero-copyright test_fixture.py self-test without creating __pycache__', () => {
    const pycacheDir = path.join(NEXAS_DIR, '__pycache__');
    const hadPycacheBefore = fs.existsSync(pycacheDir);
    const out = runPython([path.join(NEXAS_DIR, 'test_fixture.py')]);
    assert.match(out, /engine-nexas-pacf synthetic roundtrip self-test PASSED/);
    if (!hadPycacheBefore) {
      assert.equal(fs.existsSync(pycacheDir), false, 'test_fixture.py must not pollute skill directory with __pycache__');
    }
  });

  it('executes full CLI roundtrip (repack -> unpack -> extract -> mutate -> apply -> repack -> re-unpack -> re-extract) preserving TOC jump targets, .lngt trailing blank line, and zero sidecars', () => {
    const tmp = makeTempDir('pc-nexas-cli-');
    try {
      const srcDir = path.join(tmp, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      const introStrings = [
        '02_ascii_scene',
        '03_秘密の部屋',
        'bg_park.png',
        '夕暮れの風が頬を撫でた。@nそろそろ帰ろう。',
        '@r星@ほし@が輝き始めた。',
      ];
      const scene2Strings = ['図書館の窓から外を見下ろす。', '03_秘密の部屋'];
      const scene3Strings = ['静かな部屋の奥に鍵が置かれていた。'];
      const origLngt = 'はじめから\nつづきから\n設定\n\n';

      fs.writeFileSync(path.join(srcDir, '01_intro.binu8'), buildSyntheticBinu8Header0x1c(introStrings));
      fs.writeFileSync(path.join(srcDir, '02_ascii_scene.binu8'), buildSyntheticBinu8Chunk0x1c(scene2Strings));
      fs.writeFileSync(path.join(srcDir, '03_秘密の部屋.binu8'), buildSyntheticBinu8Header0x1c(scene3Strings));
      fs.writeFileSync(path.join(srcDir, 'ui.lngt'), origLngt, 'utf8');

      // 1) Pack via repack.py CLI
      const pacPath = path.join(tmp, 'Script.pac');
      runPython([path.join(NEXAS_DIR, 'repack.py'), srcDir, pacPath]);
      assert.equal(fs.readFileSync(pacPath).subarray(0, 4).toString('ascii'), 'PACF');

      // 2) Unpack via unpack.py CLI -> byte-exact & zero sidecars
      const unpackedDir = path.join(tmp, 'unpacked');
      runPython([path.join(NEXAS_DIR, 'unpack.py'), pacPath, unpackedDir]);
      assert.deepEqual(findSidecarFiles(unpackedDir), []);
      for (const fname of ['01_intro.binu8', '02_ascii_scene.binu8', '03_秘密の部屋.binu8', 'ui.lngt']) {
        assert.ok(
          fs.readFileSync(path.join(unpackedDir, fname)).equals(fs.readFileSync(path.join(srcDir, fname))),
          `Unpacked ${fname} differs from baseline`
        );
      }

      // 3) Extract via extract.py CLI -> filters ASCII & Japanese TOC jump targets
      const extractedPath = path.join(tmp, 'extracted.jsonl');
      runPython([path.join(NEXAS_DIR, 'extract.py'), unpackedDir, extractedPath]);
      assert.deepEqual(findSidecarFiles(unpackedDir), []);
      const rows = fs
        .readFileSync(extractedPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l) as { id: string; file: string; line: number; kind: string; source: string });
      const sources = rows.map((r) => r.source);

      assert.equal(sources.includes('02_ascii_scene'), false, 'ASCII TOC jump target must be filtered');
      assert.equal(sources.includes('03_秘密の部屋'), false, 'Japanese TOC jump target must be filtered');
      assert.equal(sources.includes('bg_park.png'), false, 'Media asset filename must be filtered');
      assert.ok(sources.includes('夕暮れの風が頬を撫でた。@nそろそろ帰ろう。'));
      assert.ok(sources.includes('@r星@ほし@が輝き始めた。'));
      assert.ok(sources.includes('はじめから'));
      assert.ok(sources.includes('設定'));

      // 4) Mutate variable-length dialogue + .lngt UI line and apply via apply.py CLI
      const mutatedDialogue = '黄昏的微风轻拂脸颊。@n差不多该回家了（CLI 变长写回验证）。';
      const mutatedUi = '新的开始';
      const mutatedRows = rows.map((r) => ({
        ...r,
        target:
          r.source === '夕暮れの風が頬を撫でた。@nそろそろ帰ろう。'
            ? mutatedDialogue
            : r.source === 'はじめから'
              ? mutatedUi
              : r.source,
      }));
      const mutJsonlPath = path.join(tmp, 'mutated.jsonl');
      fs.writeFileSync(mutJsonlPath, mutatedRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      runPython([path.join(NEXAS_DIR, 'apply.py'), mutJsonlPath, unpackedDir], {
        PAPERCUP_TARGET_ENCODING: 'utf-8',
      });
      assert.deepEqual(findSidecarFiles(unpackedDir), [], 'apply.py must NEVER write .papercup-*.json sidecar files');

      // Verify .lngt trailing blank line preserved verbatim
      const lngtAfter = fs.readFileSync(path.join(unpackedDir, 'ui.lngt'), 'utf8');
      assert.equal(lngtAfter.endsWith('\n\n'), true, `.lngt trailing blank line lost: ${JSON.stringify(lngtAfter)}`);
      assert.equal(lngtAfter, '新的开始\nつづきから\n設定\n\n');

      // 5) Repack -> fresh re-unpack -> re-extract readback
      const rebuiltPac = path.join(tmp, 'Script_rebuilt.pac');
      runPython([path.join(NEXAS_DIR, 'repack.py'), unpackedDir, rebuiltPac]);
      const reunpackedDir = path.join(tmp, 'reunpacked');
      runPython([path.join(NEXAS_DIR, 'unpack.py'), rebuiltPac, reunpackedDir]);
      assert.deepEqual(findSidecarFiles(reunpackedDir), []);

      const reExtractedPath = path.join(tmp, 're_extracted.jsonl');
      runPython([path.join(NEXAS_DIR, 'extract.py'), reunpackedDir, reExtractedPath]);
      const reRows = fs
        .readFileSync(reExtractedPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l) as { id: string; source: string });

      assert.equal(reRows.length, rows.length, 'Row count must remain identical after writeback roundtrip');
      const reById = new Map(reRows.map((r) => [r.id, r.source]));
      for (const expected of mutatedRows) {
        assert.equal(reById.get(expected.id), expected.target, `Readback mismatch for ${expected.id}`);
      }

      // Verify TOC jump target strings survived untouched inside the raw repacked binary
      const rawIntroAfter = fs.readFileSync(path.join(reunpackedDir, '01_intro.binu8'));
      assert.equal(rawIntroAfter.includes(Buffer.from('02_ascii_scene\0', 'utf8')), true, 'ASCII jump target lost in binary');
      assert.equal(rawIntroAfter.includes(Buffer.from('03_秘密の部屋\0', 'utf8')), true, 'Japanese jump target lost in binary');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

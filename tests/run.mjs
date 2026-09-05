import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Each suite gets its own database, skills and workspaces.
const suites = process.argv.slice(2);
const files = suites.length ? suites : readdirSync('tests').filter(f => /^test_.*\.ts$/.test(f)).sort();
let failed = false;
for (const file of files) {
  const root = mkdtempSync(path.join(tmpdir(), 'openchat-test-'));
  try {
    const result = spawnSync(process.execPath, ['--import=tsx', path.join('tests', file)], {
      stdio: 'inherit',
      env: { ...process.env, OPENCHAT_HOME: root, OPENCHAT_DB_PATH: path.join(root, 'test.db'),
        OPENCHAT_WORKSPACE_ROOT: path.join(root, 'workspace'), OPENCHAT_WORKSPACE_TRASH_ROOT: path.join(root, 'trash'),
        OPENCHAT_SKILLS_DIR: path.join(root, 'skills'), LLM_API_KEY: '', LLM_BASE_URL: 'http://127.0.0.1:1/v1',
        OPENCHAT_ALLOWED_ORIGINS: '',
        OPENCHAT_CONTEXT_WINDOW_TOKENS: '128000', OPENCHAT_MAX_OUTPUT_TOKENS: '8192' },
    });
    failed ||= result.status !== 0;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
process.exitCode = failed ? 1 : 0;

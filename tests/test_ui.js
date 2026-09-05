import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['--import=tsx', 'tests/fixtures/server.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stderr.on('data', chunk => { log += chunk; });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture startup timed out: ' + log)), 15000);
    server.stdout.on('data', chunk => { const match = String(chunk).match(/READY (\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error('Fixture exited: ' + code + ' ' + log)); });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${port}`;
  await page.goto(base);
  await page.getByLabel('접속 키', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/openchat-ui-login.png' });
  await page.getByLabel('접속 키', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: '접속', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('접속 키', { exact: true }).fill(process.env.OPENCHAT_AUTH_TOKEN);
  await page.getByRole('button', { name: '접속', exact: true }).click();
  const textarea = page.locator('textarea').first();
  await textarea.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-model-trigger]')?.textContent?.includes('fixture-model'));
  console.log('PASS browser access-key login and keyless local model picker');

  await textarea.fill('/');
  await page.locator('[data-slash-item]').first().waitFor();
  await textarea.press('ArrowDown'); await textarea.press('Enter');
  assert.match(await textarea.inputValue(), /^\/[a-z0-9-]+ $/);
  assert.equal(await page.locator('[data-slash-item]').count(), 0);
  console.log('PASS slash autocomplete keyboard selection');

  const send = async text => {
    await textarea.fill(text);
    const submitted = page.waitForResponse(response => response.request().method() === 'POST' && /\/messages$/.test(new URL(response.url()).pathname));
    await textarea.press('Enter');
    assert.equal((await submitted).status(), 200);
  };
  const sessionData = () => page.evaluate(async () => { const sessions = await (await fetch('/api/sessions')).json(); return (await fetch('/api/sessions/' + sessions[0].id)).json(); });
  const waitIdle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await sessionData()).status === 'idle') return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Session did not finish');
  };
  await send('flow');
  await page.getByText('Fixture response complete.', { exact: true }).waitFor();
  await page.locator('button').filter({ hasText: /^\d+ steps?$/ }).last().click();
  await page.locator('[data-step-sheet]').waitFor();
  assert.match(await page.locator('[data-step-sheet]').innerText(), /list_files/);
  await page.keyboard.press('Escape');
  console.log('PASS streamed reasoning, tool execution and steps sheet');

  await send('slow');
  await page.getByText(/Streaming Streaming/).first().waitFor();
  await page.reload();
  await page.getByText(/Streaming Streaming/).first().waitFor();
  const live = await sessionData();
  assert.equal(live.status, 'running'); assert.ok(live.run.content.includes('Streaming'));
  await page.getByTitle('Stop generating').click();
  await send('flow again');
  await waitIdle();
  const afterStop = await sessionData();
  assert.equal(afterStop.messages.filter(m => m.role === 'user' && m.content === 'flow again').length, 1);
  assert.equal(afterStop.messages.at(-1).content, 'Fixture response complete.', JSON.stringify({ snapshot: afterStop, error: await page.locator('[data-error-notice]').allTextContents() }));
  console.log('PASS reload restores live snapshot and Stop→send reaches one completed run');

  await send('react preview');
  await page.locator('.open-artifact-btn[data-artifact-type="react"]').last().click();
  const frame = page.frameLocator('iframe[title="React Artifact Preview"]');
  await frame.getByRole('button', { name: 'Count 0' }).click();
  await frame.getByRole('button', { name: 'Count 1' }).waitFor();
  assert.equal(await page.locator('iframe[title="React Artifact Preview"]').getAttribute('sandbox'), 'allow-scripts');
  await page.screenshot({ path: '/tmp/openchat-ui-react.png' });
  await page.getByTitle('닫기', { exact: true }).last().click();
  await send('mermaid preview');
  await page.locator('.open-artifact-btn[data-artifact-type="mermaid"]').last().click();
  await page.locator('[data-mermaid-preview] svg').waitFor();
  assert.match(await page.locator('[data-mermaid-preview]').textContent(), /Start/);
  assert.match(await page.locator('[data-mermaid-preview]').textContent(), /Done/);
  await page.screenshot({ path: '/tmp/openchat-ui-mermaid.png' });
  await page.getByTitle('닫기', { exact: true }).last().click();
  console.log('PASS interactive TSX counter in sandbox and rendered Mermaid SVG');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '사이드바 닫기' }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.getByLabel('접속 키', { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/openchat-ui-mobile.png' });
  assert.equal(await page.evaluate(async () => (await fetch('/api/sessions')).status), 401);
  assert.deepEqual(errors, []);
  console.log('PASS mobile width, logout and no browser runtime errors');
} finally {
  await browser?.close(); server.kill('SIGTERM');
  if (log) console.log(log.trim());
}

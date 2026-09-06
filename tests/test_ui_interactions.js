import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['--import=tsx', 'tests/fixtures/server.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', browser;
server.stderr.on('data', data => { log += data; });
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UI fixture startup timed out: ' + log)), 15000);
    server.stdout.on('data', data => { const match = String(data).match(/READY (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    server.on('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited: ' + code + log)); });
  });
  const base = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, route + ': ' + response.status);
    return response.json();
  };
  const responseFor = (suffix, method = 'POST') => page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname.endsWith(suffix));
  const input = page.getByRole('textbox', { name: '메시지 입력', exact: true });
  const idle = async () => {
    await page.getByRole('button', { name: /^(메시지 보내기|다시 보내기)$/ }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-session-loading]'));
  };
  const send = async text => { await idle(); await input.fill(text); const sent = responseFor('/messages'); await input.press('Control+Enter'); assert.equal((await sent).status(), 200); await idle(); };
  await page.goto(base); await idle();
  await page.getByRole('heading', { name: '무엇을 함께 해볼까요?' }).waitFor();
  await page.screenshot({ path: '/tmp/openchat-ui-new-home.png' });

  await page.locator('[data-model-trigger]').click();
  const modelDialog = page.getByRole('dialog', { name: '모델 선택', exact: true });
  await modelDialog.getByRole('textbox', { name: '모델 검색' }).waitFor();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('dialog[open]')), 'modal focus remains inside, step ' + i + ': ' + await page.evaluate(() => document.activeElement.outerHTML.slice(0, 500)));
  }
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('[data-model-trigger]').evaluate(el => el === document.activeElement));
  console.log('PASS native modal focus containment, Escape and focus return');

  await send('프로젝트 구조를 정리해줘');
  await page.getByRole('heading', { name: '프로젝트를 한눈에 보기' }).waitFor();
  assert.equal(await page.locator('.markdown-content table').count(), 1);
  assert.equal(await page.locator('.markdown-content ol li').count(), 3);
  await page.screenshot({ path: '/tmp/openchat-ui-new-chat.png' });
  const a = (await api('/api/sessions'))[0].id;
  await input.fill('A 대화에 남겨 둔 초안');
  await page.locator('input[type=file]').setInputFiles({ name: 'A-only.txt', mimeType: 'text/plain', buffer: Buffer.from('conversation A attachment') });
  await page.getByText('A-only.txt', { exact: true }).waitFor();
  const created = responseFor('/api/sessions');
  await page.getByTitle('채팅 새로 만들기', { exact: true }).click();
  const b = (await (await created).json()).id;
  await idle();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.getByText('A-only.txt', { exact: true }).count(), 0);
  const sourceLoaded = responseFor('/api/sessions/' + a, 'GET');
  await page.locator(`[data-row="${a}"] [data-row-content]`).click(); await sourceLoaded; await idle();
  assert.equal(await input.inputValue(), 'A 대화에 남겨 둔 초안');
  assert.equal(await page.getByText('A-only.txt', { exact: true }).count(), 1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = async route => { await gate; await route.continue(); };
  await page.route(base + '/api/sessions/' + b, delayed);
  await page.locator(`[data-row="${b}"] [data-row-content]`).click();
  await page.locator('[data-session-loading]').waitFor();
  assert.equal(await page.getByRole('heading', { name: '프로젝트를 한눈에 보기' }).count(), 0, 'old conversation disappears while loading');
  const targetLoaded = responseFor('/api/sessions/' + b, 'GET'); release(); await targetLoaded;
  await page.unroute(base + '/api/sessions/' + b, delayed); await idle();
  console.log('PASS conversation drafts and attachments are isolated; delayed switching shows a loading state');

  const rejectSend = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"전송 실패 테스트"}' });
  await page.route('**/api/sessions/*/messages', rejectSend);
  await input.fill('실패해도 보관되는 메시지');
  const failedSend = responseFor('/messages'); await input.press('Control+Enter'); await failedSend;
  await page.locator('[data-error-notice]').waitFor();
  assert.equal(await input.inputValue(), '실패해도 보관되는 메시지');
  assert.equal(await page.locator('.markdown-content').getByText('실패해도 보관되는 메시지', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '다시 보내기', exact: true }).count(), 1);
  await page.unroute('**/api/sessions/*/messages', rejectSend);
  await page.reload(); await idle();
  assert.equal(await input.inputValue(), '실패해도 보관되는 메시지', 'draft survives reload');
  await send('실패해도 보관되는 메시지');
  assert.equal(await input.inputValue(), '');
  assert.equal((await api('/api/sessions/' + b)).messages.filter(m => m.role === 'user').length, 1);

  const rejectDelete = route => route.request().method() === 'DELETE' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"삭제 실패 테스트"}' }) : route.continue();
  await page.route(base + '/api/sessions/' + b, rejectDelete);
  await page.locator('[data-session-menu-trigger]').click();
  await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: '대화 삭제', exact: true });
  await deleteDialog.getByRole('button', { name: '삭제', exact: true }).click();
  await deleteDialog.getByRole('alert').waitFor();
  assert.ok((await api('/api/sessions')).some(s => s.id === b));
  assert.equal(await page.locator(`[data-row="${b}"]`).count(), 1);
  await deleteDialog.getByRole('button', { name: '취소', exact: true }).click();
  await page.unroute(base + '/api/sessions/' + b, rejectDelete);
  await page.getByRole('button', { name: '오류 알림 닫기' }).click();

  const rejectEdit = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"수정 실패 테스트"}' });
  await page.route('**/messages/*/edit', rejectEdit);
  await page.getByRole('button', { name: '메시지 수정', exact: true }).last().click();
  await page.getByRole('textbox', { name: '메시지 수정', exact: true }).fill('실패한 수정');
  const edited = responseFor('/edit'); await page.getByRole('button', { name: '수정 후 보내기' }).click(); await edited;
  await page.getByText('Fixture response complete.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '메시지 수정', exact: true }).inputValue(), '실패한 수정');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await page.unroute('**/messages/*/edit', rejectEdit);
  await page.getByRole('button', { name: '오류 알림 닫기' }).click();
  const rejectRegenerate = route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"재생성 실패 테스트"}' });
  await page.route('**/messages/*/regenerate', rejectRegenerate);
  const regenerated = responseFor('/regenerate'); await page.getByRole('button', { name: '답변 다시 생성' }).last().click(); await regenerated;
  await page.getByText('Fixture response complete.', { exact: true }).waitFor();
  await page.unroute('**/messages/*/regenerate', rejectRegenerate);
  console.log('PASS failed send retains the draft; failed delete, edit and regeneration preserve server-backed content');

  await send('failed tool');
  await page.locator('[data-steps-trigger]').filter({ hasText: '1개 실패' }).waitFor();
  await page.reload(); await idle();
  await page.locator('[data-steps-trigger]').filter({ hasText: '1개 실패' }).waitFor();
  console.log('PASS tool failure status remains visible after reload');

  await send('react preview');
  await page.locator('.open-artifact-btn[data-artifact-type=react]').last().click();
  await page.frameLocator('iframe').getByRole('button', { name: 'Count 0' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('dialog', { name: '미리보기', exact: true }).waitFor();
  await page.frameLocator('iframe').getByRole('button', { name: 'Count 0' }).waitFor();
  const previewBounds = await page.locator('[data-artifact-viewer]').boundingBox();
  assert.ok(previewBounds.x >= 0 && previewBounds.x + previewBounds.width <= 391);
  const closeBounds = await page.getByRole('button', { name: '미리보기 닫기' }).boundingBox();
  assert.ok(closeBounds.x + closeBounds.width <= 390);
  await page.screenshot({ path: '/tmp/openchat-ui-new-mobile-preview.png' });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied fixture'); } } }));
  await page.getByTitle('코드 복사').click();
  await page.getByRole('status').filter({ hasText: '복사 권한을 확인' }).waitFor();
  assert.equal(await page.getByText('복사됨', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '미리보기 닫기' }).click();
  if (await page.getByRole('button', { name: '사이드바 닫기' }).isVisible()) {
    await page.getByRole('button', { name: '사이드바 닫기' }).click();
    await page.waitForFunction(() => document.querySelector('aside[aria-label="대화 목록"]').getBoundingClientRect().right <= 1);
  }
  await page.screenshot({ path: '/tmp/openchat-ui-new-mobile-chat.png' });

  for (let i = 0; i < 12; i++) await api('/api/providers', 'POST', { name: 'UI provider ' + i, base_url: 'http://localhost:1/v1' });
  await page.getByRole('button', { name: '사이드바 열기' }).click();
  await page.locator('[data-settings-trigger]').click();
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await settings.getByRole('button', { name: '프로바이더', exact: true }).click();
  const lastProvider = settings.getByText('UI provider 11', { exact: true });
  await lastProvider.scrollIntoViewIfNeeded();
  const bounds = await lastProvider.boundingBox();
  assert.ok(bounds.y > 0 && bounds.y + bounds.height < 844);
  assert.ok(await settings.locator('[data-dialog-scroll]').evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0));
  await page.screenshot({ path: '/tmp/openchat-ui-new-mobile-settings.png' });
  assert.equal(await settings.getByText('API 키 필요', { exact: true }).count(), 0, 'local keyless providers are active');
  await settings.getByRole('button', { name: '화면', exact: true }).click();
  await settings.getByRole('button', { name: '다크', exact: true }).click();
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.querySelector('dialog[open] .ui-dialog-panel'));
    return style.backgroundColor.match(/\d+/g).slice(0, 3).every(value => Number(value) < 100) && style.color.match(/\d+/g).slice(0, 3).every(value => Number(value) > 150);
  });
  await page.screenshot({ path: '/tmp/openchat-ui-new-dark-settings.png' });
  await settings.getByRole('button', { name: '프로바이더', exact: true }).click();
  await settings.getByRole('button', { name: '추가', exact: true }).click();
  await settings.getByRole('button', { name: /커스텀/ }).click();
  await settings.getByLabel('이름', { exact: true }).fill('IPv6 local');
  await settings.getByLabel('API 주소').fill('http://[::1]:11434/v1');
  assert.ok(await settings.getByRole('button', { name: '저장', exact: true }).isEnabled());
  await page.setViewportSize({ width: 360, height: 520 });
  await settings.getByRole('button', { name: '저장', exact: true }).scrollIntoViewIfNeeded();
  const saveBounds = await settings.getByRole('button', { name: '저장', exact: true }).boundingBox();
  assert.ok(saveBounds.x >= 0 && saveBounds.x + saveBounds.width <= 360 && saveBounds.y + saveBounds.height <= 520);
  await page.keyboard.press('Escape');
  const mobileCreated = responseFor('/api/sessions');
  await page.getByTitle('채팅 새로 만들기', { exact: true }).click(); await mobileCreated; await idle();
  const inputBounds = await input.boundingBox();
  assert.ok(inputBounds.x >= 0 && inputBounds.x + inputBounds.width <= 360 && inputBounds.y + inputBounds.height <= 520);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/openchat-ui-new-mobile-home.png' });
  assert.deepEqual(errors, []);
  console.log('PASS bounded mobile previews, clipboard failure feedback, scrollable settings, dark theme and IPv6 local provider form');
} finally {
  await browser?.close(); server.kill('SIGTERM');
  if (log) console.log(log.trim());
}

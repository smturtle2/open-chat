import { chromium } from 'playwright';

const MODEL = 'ox-alpha-free';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
    if (!cond) failures++;
  };

  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // fresh chat
  await page.locator('button:has-text("New chat")').first().click();
  await page.waitForTimeout(500);

  // select model via pill dropup
  await page.locator('[data-model-trigger]').click();
  await page.waitForTimeout(250);
  await page.locator('input[placeholder="Search models..."]').fill(MODEL);
  await page.waitForTimeout(150);
  await page.locator(`[data-model-sheet] button:has-text("${MODEL}")`).last().click();
  await page.waitForTimeout(300);

  const t0 = Date.now();
  const el = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

  const textarea = page.locator('textarea').first();
  await textarea.fill(
    'Do these one at a time, waiting for each result before continuing: create f1.py printing F1 and run it; then create f2.py printing F2 and run it; then create f3.py printing F3 and run it. Report all three outputs.'
  );
  await textarea.press('Control+Enter');
  console.log(`1. ${el()} prompt sent`);

  const stepToggles = () => page.locator('button span.font-mono', { hasText: /^\d+ steps?$/ });
  const sheet = () => page.locator('[data-step-sheet]');
  const scrollerPreCount = () =>
    page.evaluate(() => {
      const s = document.querySelector('div.absolute.inset-0.overflow-y-auto');
      return s ? s.querySelectorAll('pre').length : -1;
    });

  // ---- A. click an inline steps toggle mid-stream -> bottom sheet opens ----
  let sheetOpened = false;
  let sheetHasThink = false;
  let openedDuringStream = false;
  for (let i = 0; i < 100 && !sheetOpened; i++) {
    await page.waitForTimeout(500);
    const nToggles = await stepToggles().count();
    if (nToggles === 0) continue;
    try {
      await stepToggles().last().click();
      await page.waitForTimeout(350);
      if ((await sheet().count()) > 0) {
        sheetOpened = true;
        openedDuringStream =
          (await page.locator('button[title="Stop generating"]').count()) > 0;
        // think entry is icon-only now (Brain icon), no text label
        sheetHasThink = (await sheet().locator('svg.lucide-brain').count()) > 0;
      }
    } catch {}
  }
  check('inline steps toggle opens bottom sheet', sheetOpened);
  check('sheet opened while generation active', openedDuringStream);
  check('sheet contains think entry', sheetHasThink);
  check(
    'step details NOT rendered inline in chat',
    (await scrollerPreCount()) === 0,
    `(scroller <pre> count=${await scrollerPreCount()})`
  );

  // ---- B. live updates flow into the open sheet ----
  const counts = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(900);
    if ((await sheet().count()) === 0) break;
    // entries are icon-only rows inside the sheet body
    counts.push(await sheet().locator('.space-y-3 > div').count());
  }
  console.log(`   ${el()} sheet entry rows over time: [${counts.join(',')}]`);
  check('sheet stayed open with content', counts.length >= 4 && counts.every((c) => c > 0));

  // ---- C. wait for completion ----
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator('button[title="Stop generating"]').count()) === 0 && i > 3) break;
  }
  await page.waitForTimeout(800);

  const stillOpenAfterCompletion = (await sheet().count()) > 0;
  console.log(`   ${el()} sheet open after completion: ${stillOpenAfterCompletion}`);

  // close via drag-down on the grab handle
  let dragCloseWorks = true;
  if (stillOpenAfterCompletion) {
    try {
      const panel = page.locator('div.rounded-t-2xl').first();
      const hb = await panel.boundingBox();
      const cx = hb.x + hb.width / 2, cy = hb.y + 12;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let y = 20; y <= 140; y += 20) { await page.mouse.move(cx, cy + y, { steps: 2 }); await page.waitForTimeout(25); }
      await page.mouse.up();
      await page.waitForTimeout(600);
      dragCloseWorks = (await sheet().count()) === 0;
    } catch {
      dragCloseWorks = false;
    }
  }
  check('sheet closes via drag-down', dragCloseWorks);

  // reopen toggles -> some group must show finalized tool observations
  const nHeaders = await stepToggles().count();
  check('steps toggles persist after completion', nHeaders >= 1, `(count=${nHeaders})`);
  let reopenedWithObs = false;
  for (let k = 0; k < nHeaders && !reopenedWithObs; k++) {
    try {
      await stepToggles().nth(k).click();
      await page.waitForTimeout(300);
      if ((await sheet().count()) > 0) {
        const txt = await sheet().innerText();
        reopenedWithObs = /F\d/.test(txt); // tool observation output present
      }
      const closeBtn = sheet().locator('button[title="Close"]');
      if ((await closeBtn.count()) > 0) {
        await closeBtn.click();
        await page.waitForTimeout(200);
      }
    } catch {}
  }
  check('reopened sheet shows tool observations', reopenedWithObs);

  const body = await page.locator('body').innerText();
  check('all outputs present (F1/F2/F3)', /F1/.test(body) && /F2/.test(body) && /F3/.test(body));
  check(
    'no inline step details even after completion',
    (await scrollerPreCount()) === 0,
    `(scroller <pre> count=${await scrollerPreCount()})`
  );

  await page.screenshot({ path: '/root/openchat/screenshot_sheet_final.png' });
  console.log(failures === 0 ? '\n>>> ALL CHECKS PASSED <<<' : `\n>>> ${failures} CHECKS FAILED <<<`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})();

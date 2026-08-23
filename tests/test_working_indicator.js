import { chromium } from 'playwright';

const MODEL = 'ox-alpha-free';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let failures = 0;
  const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) failures++; };

  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('button:has-text("New chat")').first().click();
  await page.waitForTimeout(500);
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
    'Do these one at a time: create f1.py printing F1 and run it; then f2.py printing F2 and run it; then f3.py printing F3 and run it. Report outputs.'
  );
  await textarea.press('Control+Enter');
  console.log(`1. ${el()} prompt sent`);

  const metrics = () =>
    page.evaluate(() => {
      const s = document.querySelector('div.absolute.inset-0.overflow-y-auto');
      return {
        dots: s ? s.querySelectorAll('.typing-dot-wave').length : -1,
        pulses: s ? s.querySelectorAll('span.animate-pulse').length : -1,
        label: (() => {
          if (!s) return '';
          const spans = [...s.querySelectorAll('div span.text-\\[11px\\]')];
          return spans.length ? spans[spans.length - 1].textContent || '' : '';
        })(),
        len: s ? s.innerText.length : 0,
      };
    });

  // wait for generation to start
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    if ((await page.locator('button[title="Stop generating"]').count()) > 0) break;
  }

  // continuity sampling
  let prevLen = (await metrics()).len;
  let worstStreak = 0, streak = 0, samples = 0, labelsSeen = new Set(), lastLen = prevLen;
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(400);
    const stop = (await page.locator('button[title="Stop generating"]').count()) > 0;
    const m = await metrics();
    if (!stop) break;
    samples++;
    const grew = m.len > lastLen + 5; // prose streaming -> dots intentionally hidden
    lastLen = Math.max(lastLen, m.len);
    const hasIndicator = m.dots > 0 || m.pulses > 0 || grew;
    if (hasIndicator) { streak = 0; if (m.label) labelsSeen.add(m.label); }
    else { streak++; worstStreak = Math.max(worstStreak, streak); }
    prevLen = m.len;
    void prevLen;
  }
  console.log(`   ${el()} samples=${samples} longest gap without indicator: ${(worstStreak * 0.4).toFixed(1)}s`);
  console.log(`   labels seen: [${[...labelsSeen].join(' | ')}]`);
  check('working indicator never disappears >1.2s during generation', samples >= 10 && worstStreak <= 3);

  // wait completion
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    if ((await page.locator('button[title="Stop generating"]').count()) === 0 && i > 3) break;
  }
  const body = await page.locator('body').innerText();
  check('task completed (F1/F2/F3)', /F1/.test(body) && /F2/.test(body) && /F3/.test(body));
  const dotsAfter = await page.evaluate(() => {
    const s = document.querySelector('div.absolute.inset-0.overflow-y-auto');
    return s ? s.querySelectorAll('.typing-dot-wave').length : -1;
  });
  check('indicator gone after completion', dotsAfter === 0, `(dots=${dotsAfter})`);

  console.log(failures === 0 ? '\n>>> ALL CHECKS PASSED <<<' : `\n>>> ${failures} CHECKS FAILED <<<`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})();

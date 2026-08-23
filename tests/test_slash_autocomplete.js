// Slash-command autocomplete E2E — no LLM involved.
// Run: node tests/test_slash_autocomplete.js
import { chromium } from 'playwright';

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
  await page.waitForTimeout(800);
  await page.locator('button:has-text("New chat")').first().click();
  await page.waitForTimeout(400);

  const textarea = page.locator('textarea').first();

  // 1. typing "/" opens the dropdown with installed skills
  await textarea.pressSequentially('/', { delay: 40 });
  await page.waitForTimeout(300);
  const items = page.locator('[data-slash-item]');
  check('dropdown opens on "/"', (await items.count()) > 0, `items=${await items.count()}`);

  // 2. filtering narrows candidates
  const firstName = (await items.first().innerText()).split('\n')[0];
  await textarea.pressSequentially(firstName.slice(1, 3), { delay: 30 });
  await page.waitForTimeout(200);
  const filtered = await items.count();
  check('filtering narrows list', filtered >= 1 && filtered <= 8, `filtered=${filtered}, token=${await textarea.inputValue()}`);

  // 3. keyboard: ArrowDown moves highlight, Enter applies "/name "
  await textarea.press('ArrowDown');
  await page.waitForTimeout(100);
  await textarea.press('Enter');
  await page.waitForTimeout(150);
  const val = await textarea.inputValue();
  check('Enter applies skill token', /^\/[a-z0-9-]+ $/.test(val), `value="${val}"`);
  check('dropdown closed after apply', (await items.count()) === 0);

  // 4. exact match does not re-open dropdown mid-instruction
  await textarea.pressSequentially('인사해줘', { delay: 20 });
  check('instruction text appends', (await textarea.inputValue()) === `${val}인사해줘`);

  // 5. Escape dismisses
  await textarea.fill('');
  await textarea.pressSequentially('/', { delay: 30 });
  await page.waitForTimeout(200);
  await textarea.press('Escape');
  await page.waitForTimeout(150);
  check('Escape dismisses dropdown', (await items.count()) === 0);

  // 6. Skills installed mid-session appear WITHOUT page reload
  const fs = await import('fs');
  fs.mkdirSync('/root/.openchat/skills/zz-fresh-skill', { recursive: true });
  fs.writeFileSync(
    '/root/.openchat/skills/zz-fresh-skill/SKILL.md',
    '---\nname: zz-fresh-skill\ndescription: Installed while the client was open.\n---\nFresh.\n'
  );
  await textarea.fill('');
  await textarea.pressSequentially('/', { delay: 30 });
  await page.waitForTimeout(500); // refetch on slash start + render
  const names = await items.allInnerTexts();
  check('mid-session install appears in dropdown', names.some((n) => n.includes('zz-fresh-skill')), `items=[${names.map((n) => n.split('\n')[0]).join(', ')}]`);
  fs.rmSync('/root/.openchat/skills/zz-fresh-skill', { recursive: true, force: true });

  await page.screenshot({ path: '/root/openchat/screenshot_slash.png' });
  console.log(failures === 0 ? '\n>>> ALL CHECKS PASSED <<<' : `\n>>> ${failures} CHECKS FAILED <<<`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})();

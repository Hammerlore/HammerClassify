import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = 'file://' + path.join(here, 'index.html');
const out = path.join(here, 'shots');
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, opts = {}) {
  await page.screenshot({ path: path.join(out, name), fullPage: !!opts.full });
  console.log('shot:', name);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(base);
  await sleep(600);
  await shot(page, '01-login-dark.png');

  // Login -> App
  await page.click('#btn-login');
  await sleep(500);
  await shot(page, '02-dashboard-dark.png', { full: true });

  // Dokumente
  await page.click('[data-view="documents"]');
  await sleep(400);
  await shot(page, '03-documents-dark.png', { full: true });

  // Filter chip klicken (Nebenkosten)
  const chip = page.locator('.filter-chip', { hasText: 'Nebenkosten' });
  if (await chip.count()) { await chip.first().click(); await sleep(300); }
  await shot(page, '04-documents-filtered-dark.png', { full: true });

  // Regeln
  await page.click('[data-view="rules"]');
  await sleep(400);
  await shot(page, '05-rules-dark.png', { full: true });

  // Neue Regel -> Formular
  await page.click('#btn-new-rule');
  await sleep(300);
  await shot(page, '06-rule-form-dark.png', { full: true });
  await page.click('#btn-rule-cancel');

  // Scan
  await page.click('[data-view="scan"]');
  await sleep(400);
  await shot(page, '07-scan-dark.png', { full: true });

  // Dokument-Detail (d1)
  await page.click('[data-view="documents"]');
  await sleep(300);
  await page.locator('#docs-tbody [data-doc="d1"]').click();
  await sleep(400);
  await shot(page, '08-document-dark.png', { full: true });

  // Upload-Dialog
  await page.click('[data-view="dashboard"]');
  await sleep(300);
  await page.click('[data-open-upload]');
  await sleep(300);
  await page.click('#dropzone');
  await sleep(200);
  await shot(page, '09-upload-dark.png');

  // Light Theme
  await page.click('#btn-upload-close');
  await sleep(200);
  await page.click('#btn-theme');
  await sleep(500);
  await shot(page, '10-dashboard-light.png', { full: true });
  await page.click('[data-view="documents"]');
  await sleep(300);
  await shot(page, '11-documents-light.png', { full: true });

  // Mobil
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-view="dashboard"]');
  await sleep(400);
  await shot(page, '12-dashboard-mobile.png', { full: true });

  console.log('--- errors ---');
  console.log(errors.length ? errors.join('\n') : 'keine');
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

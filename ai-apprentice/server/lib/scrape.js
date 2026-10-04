// Bright Data Scraping Browser adapter.
//
// Bright Data provisions a remote Chrome instance reachable over the Chrome
// DevTools Protocol; proxying, residential IP rotation, and CAPTCHA solving
// all happen on their end. We just connect with Puppeteer, navigate, and read
// the rendered page — no local browser/Chromium is launched or bundled.

import puppeteer from 'puppeteer-core';

const WS_ENDPOINT = process.env.BRIGHTDATA_WS_ENDPOINT;
// CAPTCHA solving on Bright Data's side can take a while; give navigation room.
const NAV_TIMEOUT_MS = Math.max(15000, Number(process.env.BRIGHTDATA_TIMEOUT_MS) || 90000);

export const scrapeMode = WS_ENDPOINT ? 'brightdata' : 'off';

// Scrapes `url` and returns { url, title, text }. Throws on bad input or a
// provider/navigation failure — callers should catch and surface the message.
export async function scrapeUrl(url) {
  if (!WS_ENDPOINT) throw new Error('Bright Data is not configured on this server (BRIGHTDATA_WS_ENDPOINT missing).');
  let target;
  try { target = new URL(url); } catch { throw new Error('That does not look like a valid URL.'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('Only http/https URLs can be scraped.');

  const browser = await puppeteer.connect({ browserWSEndpoint: WS_ENDPOINT });
  try {
    const page = await browser.newPage();
    try {
      await page.goto(target.href, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      const [title, text] = await Promise.all([
        page.title(),
        page.evaluate(() => document.body?.innerText || ''),
      ]);
      return { url: target.href, title: title || target.hostname, text: text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000) };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await browser.disconnect();
  }
}

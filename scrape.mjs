// scrape.mjs
// Visits each card's SNKRDUNK page, reads the latest PSA10 (1-count) trade price,
// converts JPY -> KRW (with 10% import duty/VAT), and appends today's snapshot
// to data.json so the trend chart accumulates real history over time.
//
// Run by .github/workflows/update-prices.yml on a schedule, or manually via
// `node scrape.mjs` (requires `npx playwright install --with-deps chromium` first).

import { chromium } from "playwright";
import fs from "fs/promises";

const DATA_PATH = new URL("./data.json", import.meta.url);
const TAX_RATE = 1.10; // 관부가세 10%
const FALLBACK_JPY_KRW = 9.05;

async function getExchangeRate() {
  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?base=JPY&symbols=KRW");
    const json = await res.json();
    if (json?.rates?.KRW) return json.rates.KRW;
  } catch (e) {
    console.warn("환율 조회 실패, 기본값 사용:", e.message);
  }
  return FALLBACK_JPY_KRW;
}

// Grabs the first "PSA10 ... 1枚 ¥N" line from the trade-history text (topmost = most recent).
function extractLatestPsa10(pageText) {
  const lines = pageText.split("\n");
  for (const line of lines) {
    const m = line.match(/PSA10\s+1枚\s+¥([\d,]+)/);
    if (m) return parseInt(m[1].replace(/,/g, ""), 10);
  }
  return null;
}

async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  const data = JSON.parse(raw);
  const rate = await getExchangeRate();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  });

  for (const name of Object.keys(data)) {
    const card = data[name];
    if (!card.url) {
      console.log(`[skip] ${name}: URL 없음`);
      continue;
    }
    try {
      await page.goto(card.url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      const jpy = extractLatestPsa10(text);
      if (jpy === null) {
        console.warn(`[warn] ${name}: PSA10 1장 거래를 찾지 못함`);
        continue;
      }
      const krw = Math.round(jpy * rate * TAX_RATE);
      const series = card.series;
      if (series.length && series[series.length - 1][0] === today) {
        series[series.length - 1][1] = krw; // same-day re-run: overwrite
      } else {
        series.push([today, krw]);
      }
      console.log(`[ok] ${name}: ¥${jpy.toLocaleString()} -> ₩${krw.toLocaleString()}`);
    } catch (e) {
      console.error(`[error] ${name}:`, e.message);
    }
  }

  await browser.close();
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 1), "utf-8");
  console.log("data.json 갱신 완료:", today, "(환율:", rate, ")");
}

main();

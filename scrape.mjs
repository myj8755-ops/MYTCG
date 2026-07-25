// scrape.mjs
// Visits each card's SNKRDUNK page, reads the latest PSA10 (1-count) trade price
// AND its trade date, converts JPY -> KRW (with 10% import duty/VAT), and appends
// today's snapshot (plus the trade date) to data.json so the trend chart
// accumulates real history over time.
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

// SNKRDUNK 매매이력의 한 거래 줄은 대략
//   "18시간 전   PSA10   1장   ¥39,000"
//   "1일 전      PSA10   1장   ¥10,000"
//   "2026/07/20  PSA10   1장   ¥10,380"
// 형식으로 나타난다 (한국어/일본어 로케일에 따라 "1장"/"1枚"가 섞여 나올 수 있음).
// 날짜 부분(date text)과 가격(¥N)을 함께 뽑는다. 가장 위(topmost) = 가장 최근 거래.
function extractLatestPsa10(pageText) {
  const lines = pageText.split("\n");
  for (const line of lines) {
    const m = line.match(/^(.*?)\s*PSA10\s+1(?:枚|장)\s+¥([\d,]+)/);
    if (m) {
      const dateText = m[1].trim();
      const jpy = parseInt(m[2].replace(/,/g, ""), 10);
      return { jpy, dateText };
    }
  }
  return null;
}

// "18시간 전" / "1일 전" / "2026/07/20" 형식의 텍스트를 "YYYY-MM-DD" ISO 날짜로 변환.
// 상대 표현(시간 전/분 전/방금)은 오늘 날짜로, "N일 전"은 오늘에서 N일을 뺀 날짜로 계산.
function parseTradeDateText(dateText, now = new Date()) {
  const text = dateText.trim();

  if (/시간\s*전$/.test(text) || /분\s*전$/.test(text) || /방금/.test(text)) {
    return now.toISOString().slice(0, 10);
  }

  const dayAgoMatch = text.match(/^(\d+)\s*일\s*전$/);
  if (dayAgoMatch) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - parseInt(dayAgoMatch[1], 10));
    return d.toISOString().slice(0, 10);
  }

  const absMatch = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (absMatch) {
    return `${absMatch[1]}-${absMatch[2]}-${absMatch[3]}`;
  }

  // 일본어 로케일 대비 ("時間前", "日前" 등)도 함께 지원
  if (/時間前$/.test(text) || /分前$/.test(text) || /たった今/.test(text)) {
    return now.toISOString().slice(0, 10);
  }
  const jpDayAgoMatch = text.match(/^(\d+)日前$/);
  if (jpDayAgoMatch) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - parseInt(jpDayAgoMatch[1], 10));
    return d.toISOString().slice(0, 10);
  }

  console.warn(`[warn] 거래일 텍스트를 해석하지 못함: "${text}"`);
  return null;
}

async function main() {
  const raw = await fs.readFile(DATA_PATH, "utf-8");
  const data = JSON.parse(raw);
  const rate = await getExchangeRate();
  const now = new Date();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  });

  for (const name of Object.keys(data)) {
    if (name === "_meta") continue;
    const card = data[name];
    if (!card.url) {
      console.log(`[skip] ${name}: URL 없음`);
      continue;
    }
    try {
      await page.goto(card.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const found = extractLatestPsa10(text);
      if (found === null) {
        console.warn(`[warn] ${name}: PSA10 1장 거래를 찾지 못함`);
        continue;
      }
      const { jpy, dateText } = found;
      const krw = Math.round(jpy * rate * TAX_RATE);

      const series = card.series;
      if (series.length && series[series.length - 1][0] === today) {
        series[series.length - 1][1] = krw; // same-day re-run: overwrite
      } else {
        series.push([today, krw]);
      }

      const lastTradeDate = parseTradeDateText(dateText, now);
      if (lastTradeDate) {
        card.lastTradeDate = lastTradeDate;
      }

      console.log(
        `[ok] ${name}: ¥${jpy.toLocaleString()} -> ₩${krw.toLocaleString()} (거래일: ${dateText} -> ${lastTradeDate || "해석 실패"})`
      );
    } catch (e) {
      console.error(`[error] ${name}:`, e.message);
    }
  }

  await browser.close();
  data._meta = { updatedAt: new Date().toISOString() };
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 1), "utf-8");
  console.log("data.json 갱신 완료:", today, "(환율:", rate, ")");
}

main();

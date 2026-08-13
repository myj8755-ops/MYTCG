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
const HISTORY_RETENTION_DAYS = 30; // 시각별(보통 1시간 간격) 기록은 최근 30일치만 보관, 그 이전은 자동 삭제
// 실행마다(시각+원화가+엔화원가) 기록을 card.history에 추가하고 30일이 지난 기록은 정리한다.
// 엔화 원가(jpy)를 같이 남겨두는 이유: 프론트엔드의 "포트폴리오 히스토리"가 환율 변동만으로
// 생기는 노이즈(엔화 시세는 그대로인데 원화 환산값만 바뀌는 것)를 걸러내고, 실제 엔화 시세가
// 움직였을 때만 변동으로 표시할 수 있게 하기 위함.
//
// 여기서 한 가지 더: 스니커덩크에 새 거래가 없어서 엔화 원가(jpy)가 지난 회차와 완전히 똑같으면
// 아예 새 기록을 추가하지 않는다(마지막 기록의 시각만 갱신). 예전엔 값이 안 바뀌어도 매 실행마다
// 새 (시각, 가격) 쌍을 계속 쌓다 보니, 프론트에서 "그 시점 환율"로 재계산할 때 아주 작은 반올림/시점
// 차이만으로도 "변동"처럼 보이는 경우가 있었다. jpy가 그대로면 기록 자체를 늘리지 않으면 이 문제가
// 원천적으로 사라진다.
function appendHistory(card, now, krw, jpy) {
  if (!Array.isArray(card.history)) card.history = [];
  const last = card.history[card.history.length - 1];
  if (last && last[2] === jpy) {
    // 엔화 원가가 지난 기록과 완전히 동일 -> 새 기록을 추가하지 않고 마지막 기록의 시각/원화값만 최신으로 갱신
    last[0] = now.toISOString();
    last[1] = krw;
  } else {
    card.history.push([now.toISOString(), krw, jpy]);
  }
  const cutoff = now.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  card.history = card.history.filter(([ts]) => new Date(ts).getTime() >= cutoff);
}
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
// "18시간 전" / "45분 전" / "1일 전" / "2026/07/20" 형식의 텍스트를 실제 시각으로 변환.
// 시간/분/일 단위 상대 표현은 정확한 시각(ISO datetime)으로, 절대 날짜("YYYY/MM/DD")는
// 정확한 시각을 알 수 없어 날짜만("YYYY-MM-DD") 저장한다.
// 한국어("N분 전" 등)와 일본어("N分前" 등) 로케일을 모두 지원.
function parseTradeDateText(dateText, now = new Date()) {
  const text = dateText.trim();
  if (/^방금(\s*전)?$/.test(text) || /たった今/.test(text)) {
    return now.toISOString();
  }
  let m = text.match(/^(\d+)\s*분\s*전$/) || text.match(/^(\d+)分前$/);
  if (m) {
    const mins = parseInt(m[1], 10);
    return new Date(now.getTime() - mins * 60 * 1000).toISOString();
  }
  m = text.match(/^(\d+)\s*시간\s*전$/) || text.match(/^(\d+)時間前$/);
  if (m) {
    const hrs = parseInt(m[1], 10);
    return new Date(now.getTime() - hrs * 60 * 60 * 1000).toISOString();
  }
  m = text.match(/^(\d+)\s*일\s*전$/) || text.match(/^(\d+)日前$/);
  if (m) {
    const days = parseInt(m[1], 10);
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  m = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`; // 시각 정보 없음, 날짜만 저장
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
    if (name === "_meta" || name === "_watchlist") continue;
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
      appendHistory(card, now, krw, jpy);
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
  // 관심 후보 카드(워치리스트)도 동일하게 시세를 갱신 (구매가/손익 계산에는 포함되지 않음)
  const watchlist = data._watchlist || {};
  for (const name of Object.keys(watchlist)) {
    const card = watchlist[name];
    if (!card.url) {
      console.log(`[skip-watchlist] ${name}: URL 없음`);
      continue;
    }
    try {
      await page.goto(card.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body.innerText);
      const found = extractLatestPsa10(text);
      if (found === null) {
        console.warn(`[warn-watchlist] ${name}: PSA10 1장 거래를 찾지 못함`);
        continue;
      }
      const { jpy, dateText } = found;
      const krw = Math.round(jpy * rate * TAX_RATE);
      if (!card.series) card.series = [];
      const series = card.series;
      if (series.length && series[series.length - 1][0] === today) {
        series[series.length - 1][1] = krw;
      } else {
        series.push([today, krw]);
      }
      appendHistory(card, now, krw, jpy);
      const lastTradeDate = parseTradeDateText(dateText, now);
      if (lastTradeDate) {
        card.lastTradeDate = lastTradeDate;
      }
      console.log(
        `[ok-watchlist] ${name}: ¥${jpy.toLocaleString()} -> ₩${krw.toLocaleString()} (거래일: ${dateText} -> ${lastTradeDate || "해석 실패"})`
      );
    } catch (e) {
      console.error(`[error-watchlist] ${name}:`, e.message);
    }
  }
  await browser.close();
  data._meta = { updatedAt: new Date().toISOString(), rate };
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 1), "utf-8");
  console.log("data.json 갱신 완료:", today, "(환율:", rate, ")");
}
main();

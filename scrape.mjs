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

// 관심 후보 카드(워치리스트)의 최근 시세 흐름을 Claude API에 보내
// "저평가/적정가/고평가" 판단과 한 줄 코멘트를 받아온다.
// ANTHROPIC_API_KEY 환경변수(GitHub Secret)가 없으면 조용히 건너뜀.
const CLAUDE_MODEL = "claude-haiku-4-5-20251001"; // 짧은 평가용, 비용 효율적인 모델

async function evaluateCandidateWithClaude(name, card) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`[ai-skip] ${name}: ANTHROPIC_API_KEY 환경변수가 없어 AI 평가를 건너뜁니다.`);
    return null;
  }

  const series = card.series || [];
  const currentPrice = series.length ? series[series.length - 1][1] : null;
  const recentSeries = series.slice(-10);
  const seriesText = recentSeries.length
    ? recentSeries.map(([d, p]) => `${d}: ₩${p.toLocaleString("ko-KR")}`).join("\n")
    : "가격 이력 없음";

  const prompt = `너는 포켓몬 카드(트레이딩 카드) 투자 판단을 돕는 어시스턴트야. 아래 후보 카드의 최근 시세 흐름을 보고 지금이 매수하기에 저평가/적정가/고평가 중 어디에 해당하는지 판단해줘.

카드명: ${name}
등급/세트: ${card.grade || "정보없음"}
현재가(관부가세 포함, KRW): ${currentPrice !== null ? "₩" + currentPrice.toLocaleString("ko-KR") : "정보없음"}
목표 매수가: ${card.targetPrice ? "₩" + card.targetPrice.toLocaleString("ko-KR") : "설정 안 함"}
메모: ${card.memo || "없음"}

최근 시세 흐름(날짜: 가격, 오래된 순):
${seriesText}

반드시 아래 JSON 형식으로만 답해. 다른 텍스트, 설명, 마크다운은 절대 포함하지 마:
{"verdict": "저평가 또는 적정가 또는 고평가 중 하나", "comment": "40자 이내의 한글 한 줄 코멘트"}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[ai-warn] ${name}: Claude API 호출 실패 (${res.status}) ${errText.slice(0, 200)}`);
      return null;
    }

    const json = await res.json();
    const textBlock = (json.content || []).find((b) => b.type === "text");
    if (!textBlock) {
      console.warn(`[ai-warn] ${name}: 응답에 텍스트 블록이 없음`);
      return null;
    }

    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.verdict || !parsed.comment) {
      console.warn(`[ai-warn] ${name}: 응답 형식이 예상과 다름 - ${cleaned.slice(0, 200)}`);
      return null;
    }

    return {
      verdict: parsed.verdict,
      comment: parsed.comment,
      evaluatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.warn(`[ai-warn] ${name}: 평가 처리 중 오류 - ${e.message}`);
    return null;
  }
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

      const lastTradeDate = parseTradeDateText(dateText, now);
      if (lastTradeDate) {
        card.lastTradeDate = lastTradeDate;
      }

      console.log(
        `[ok-watchlist] ${name}: ¥${jpy.toLocaleString()} -> ₩${krw.toLocaleString()} (거래일: ${dateText} -> ${lastTradeDate || "해석 실패"})`
      );

      const evaluation = await evaluateCandidateWithClaude(name, card);
      if (evaluation) {
        card.aiEvaluation = evaluation;
        console.log(`[ai-ok] ${name}: ${evaluation.verdict} - ${evaluation.comment}`);
      }
    } catch (e) {
      console.error(`[error-watchlist] ${name}:`, e.message);
    }
  }

  await browser.close();
  data._meta = { updatedAt: new Date().toISOString() };
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 1), "utf-8");
  console.log("data.json 갱신 완료:", today, "(환율:", rate, ")");
}

main();

// README에 쓰는 화면 캡처(images/*.png)를 재생성하는 스크립트.
//
//   npm run capture
//
// 로컬 서버(server.js)를 임시 포트로 직접 띄우고, puppeteer-core + 시스템에 설치된
// Chrome으로 실제 화면을 조작해 촬영한다. 캡처가 끝나면 만들어 둔 약속을 지우고
// 서버도 종료하므로 별도 정리가 필요 없다.
//
// 환경 변수
//   PORT         임시 서버 포트 (기본 8899)
//   CHROME_PATH  Chrome 실행 파일 경로 (기본: 아래 CHROME_CANDIDATES에서 탐색)
//   BASE         이미 띄워 둔 서버를 쓰고 싶을 때의 주소 (지정하면 서버를 띄우지 않음)
//   HEADFUL=1    브라우저 창을 띄워서 진행 과정을 눈으로 확인
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'images');
const PORT = Number(process.env.PORT || 8899);

// 캡처 기준 시나리오: 총원 5명 / 표시 범위 오늘~2026-09-30 / 평일 약속.
// 9월 22~25일이 전원(5명) 겹치는 1위가 되도록 날짜를 배치한다.
const RANGE_END = '2026-09-30';
const TOP_DATES = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
const MANAGE_PIN = '1234';
const SEEDED = [
  { name: '김하늘', dates: [...TOP_DATES, '2026-09-01', '2026-09-02', '2026-09-03'] },
  { name: '이준호', dates: [...TOP_DATES, '2026-09-02', '2026-09-03'] },
  { name: '박서연', dates: [...TOP_DATES, '2026-09-03'] },
  { name: '최민재', dates: [...TOP_DATES, '2026-09-08', '2026-09-09'] },
];
const LAST_PERSON = '정예은';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Chrome을 찾을 수 없습니다. CHROME_PATH 환경 변수로 경로를 지정해 주세요.\n확인한 경로:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
  }
  return found;
}

async function waitForServer(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // 아직 준비되지 않음
    }
    await sleep(200);
  }
  throw new Error(`서버가 ${timeoutMs}ms 안에 뜨지 않았습니다: ${base}`);
}

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://localhost:${PORT}`;
  await waitForServer(base);
  return { base, child };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  let server = null;
  let base = process.env.BASE;
  if (!base) {
    server = await startServer();
    base = server.base;
    console.log(`임시 서버 실행: ${base}`);
  }

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: !process.env.HEADFUL,
    defaultViewport: { width: 900, height: 900, deviceScaleFactor: 2 },
    args: ['--hide-scrollbars', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();

  // puppeteer의 clip은 문서 좌표 기준이라, 뷰포트 기준 사각형에 스크롤 오프셋을 더해준다.
  const shotClip = async (file, rectFn) => {
    const r = await page.evaluate(rectFn);
    await sleep(300);
    await page.screenshot({
      path: path.join(OUT, file),
      clip: {
        x: Math.round(r.x + r.sx),
        y: Math.round(r.y + r.sy),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    });
  };

  const shot = (file, options = {}) => page.screenshot({ path: path.join(OUT, file), ...options });

  // 달력 셀을 화면 중앙으로 스크롤하고 중심 좌표를 돌려준다.
  const cellCenter = (date) =>
    page.evaluate((d) => {
      const el = document.querySelector(`#vote-calendar .cal-cell[data-date="${d}"]`);
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, date);

  let eventId = null;
  try {
    // ---------- 01. 약속 만들기 (관리 비밀번호 포함) ----------
    await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
    await page.type('#title', '9월 팀 회식');
    await page.type('#total', '5');
    await page.type('#manage-pin', MANAGE_PIN);
    await page.click('label[for="range-custom"]');
    await page.waitForFunction(() => !document.getElementById('range-end').hidden);
    await page.evaluate((value) => {
      const el = document.getElementById('range-end');
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, RANGE_END);
    await page.click('label[for="theme-weekday"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);
    await shot('01-create-event.png', { fullPage: true });
    console.log('01-create-event.png');

    // ---------- 약속 생성 후 참여자 4명 시드 ----------
    await page.click('#create-form button[type="submit"]');
    await page.waitForFunction(() => location.pathname.startsWith('/m/'), { timeout: 15000 });
    await page.waitForSelector('#vote-calendar .cal-cell[data-date]');
    eventId = await page.evaluate(() => location.pathname.split('/').pop());

    await page.evaluate(async (id, people) => {
      for (const person of people) {
        const res = await fetch(`/api/events/${id}/participants`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(person),
        });
        if (!res.ok) throw new Error(`${person.name}: ${res.status} ${await res.text()}`);
      }
    }, eventId, SEEDED);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('#vote-calendar .cal-cell[data-date]');

    // ---------- 02. 드래그 범위 미리보기 ----------
    await page.type('#name', LAST_PERSON);
    await sleep(300);
    const start = await cellCenter(TOP_DATES[0]);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const date of TOP_DATES.slice(1)) {
      const box = await cellCenter(date);
      await page.mouse.move(box.x, box.y, { steps: 6 });
      await sleep(120);
    }
    await sleep(500);
    await shot('02-drag-select.png', { fullPage: true });
    console.log('02-drag-select.png');

    // ---------- 03. 드래그 선택 완료 ----------
    await page.mouse.up();
    await page.waitForFunction(
      (count) => document.querySelectorAll('#vote-calendar .cal-cell.selected').length >= count,
      {},
      TOP_DATES.length
    );
    await sleep(500);
    await shot('03-vote-selected.png', { fullPage: true });
    console.log('03-vote-selected.png');

    // ---------- 05. 공휴일 표시 (추석 연휴 구간) ----------
    await shotClip('05-holidays.png', () => {
      const cell = (d) => document.querySelector(`#vote-calendar .cal-cell[data-date="${d}"]`);
      cell('2026-09-21').scrollIntoView({ block: 'center' });
      const grid = cell('2026-09-21').closest('.cal-grid').getBoundingClientRect();
      const first = cell('2026-09-13').getBoundingClientRect();
      const last = cell('2026-09-28').getBoundingClientRect();
      return {
        x: grid.x - 10,
        y: first.y - 14,
        width: grid.width + 20,
        height: last.bottom - first.y + 30,
        sx: window.scrollX,
        sy: window.scrollY,
      };
    });
    console.log('05-holidays.png');

    // ---------- 06. 플로팅 저장 바 (저장 버튼이 화면 아래로 벗어난 상태) ----------
    await page.evaluate(() => {
      const top = document.getElementById('save-btn').getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - window.innerHeight - 80));
    });
    await page.waitForFunction(() => !document.getElementById('float-save').hidden);
    await sleep(500);
    await shot('06-floating-save.png');
    console.log('06-floating-save.png');

    // ---------- 04. 결과 보기 ----------
    await page.evaluate(() => document.getElementById('save-btn').scrollIntoView({ block: 'center' }));
    await sleep(300);
    await page.click('#save-btn');
    await page.waitForFunction(() => !document.getElementById('panel-result').hidden, { timeout: 15000 });
    await page.waitForSelector('#result-calendar .cal-cell[data-date]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1500);
    await shot('04-result.png', { fullPage: true });
    console.log('04-result.png');

    // ---------- 07. 약속 파기 확인 창 ----------
    await page.click('#cancel-event');
    await page.waitForFunction(() => document.getElementById('cancel-dialog').open);
    await page.type('#cancel-pin', MANAGE_PIN);
    await sleep(500);
    await shot('07-cancel-event.png');
    console.log('07-cancel-event.png');

    // 캡처용으로 만든 약속은 지운다.
    await page.evaluate(async (id, pin) => {
      await fetch(`/api/events/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managePin: pin }),
      });
    }, eventId, MANAGE_PIN);
    eventId = null;
  } finally {
    await browser.close();
    if (server) server.child.kill();
  }

  console.log('완료: images/ 아래 7개 캡처를 갱신했습니다.');
}

await main();

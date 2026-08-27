// 로컬 개발/운영용 무의존성 서버.
// 정적 파일(public/)과 API(/api/...)를 함께 제공하며, 데이터는 .data/ 디렉토리에 JSON 파일로 저장한다.
// Cloudflare Pages 배포 시에는 functions/ 디렉토리의 Pages Functions가 동일한 API를 제공한다.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8788;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, '.data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function eventPath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function loadEvent(id) {
  if (!/^[a-z0-9]{6,20}$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(eventPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveEvent(event) {
  fs.writeFileSync(eventPath(event.id), JSON.stringify(event, null, 2));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// ---- 공용 검증 로직 (functions/ 쪽과 동일한 규칙) ----
const THEMES = ['weekday', 'weekend', 'both'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANAGE_PIN_RE = /^\d{4,6}$/;
const MAX_DELETE_ATTEMPTS = 5;
const DELETE_LOCK_MS = 3 * 60 * 1000;

function validateEventInput(body) {
  const title = String(body.title || '').trim();
  const totalCount = Number(body.totalCount);
  const theme = String(body.theme || '');
  const startDate = String(body.startDate || '');
  const endDate = String(body.endDate || '');
  const managePin = body.managePin == null ? '' : String(body.managePin);
  if (!title || title.length > 60) return '약속 이름은 1~60자로 입력해 주세요.';
  if (!Number.isInteger(totalCount) || totalCount < 2 || totalCount > 100) return '총 인원은 2~100 사이의 숫자여야 합니다.';
  if (!THEMES.includes(theme)) return '테마 값이 올바르지 않습니다.';
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || endDate < startDate) return '표시 범위가 올바르지 않습니다.';
  if ((new Date(endDate) - new Date(startDate)) / 86400000 > 370) return '표시 범위는 최대 1년까지 지정할 수 있습니다.';
  if (!MANAGE_PIN_RE.test(managePin)) return '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.';
  return null;
}

function validateParticipantInput(body) {
  const name = String(body.name || '').trim();
  const dates = body.dates;
  if (!name || name.length > 20) return '이름은 1~20자로 입력해 주세요.';
  if (!Array.isArray(dates) || dates.length > 366 || dates.some((d) => !DATE_RE.test(String(d)))) {
    return '날짜 형식이 올바르지 않습니다.';
  }
  return null;
}

function hashManagePin(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

function publicEvent(event) {
  const { managePinHash, managePinSalt, deleteAuthFailures, ...publicData } = event;
  return publicData;
}

function nextDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// 공동 1위가 여러 날이면 가장 늦은 후보 다음 날에 만료해 모든 1위 후보를 보존한다.
function refreshExpireDate(event) {
  const counts = {};
  for (const participant of event.participants) {
    for (const date of participant.dates) counts[date] = (counts[date] || 0) + 1;
  }
  const rankedDates = Object.keys(counts);
  if (rankedDates.length === 0) {
    event.expireDate = null;
    return;
  }
  const maxCount = Math.max(...Object.values(counts));
  const latestTopDate = rankedDates.filter((date) => counts[date] === maxCount).sort().at(-1);
  event.expireDate = nextDate(latestTopDate);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','events',id?,'participants'?]

  // POST /api/events
  if (req.method === 'POST' && parts.length === 2 && parts[1] === 'events') {
    const body = await readBody(req);
    const err = validateEventInput(body);
    if (err) return sendJson(res, 400, { error: err });
    const id = crypto.randomBytes(8).toString('hex').slice(0, 10);
    const managePinSalt = crypto.randomBytes(16).toString('hex');
    const event = {
      id,
      title: String(body.title).trim(),
      totalCount: Number(body.totalCount),
      theme: String(body.theme),
      startDate: String(body.startDate),
      endDate: String(body.endDate),
      managePinSalt,
      managePinHash: hashManagePin(String(body.managePin), managePinSalt),
      deleteAuthFailures: 0,
      deleteLockedUntil: null,
      expireDate: null,
      createdAt: new Date().toISOString(),
      participants: [],
    };
    saveEvent(event);
    return sendJson(res, 200, { id });
  }

  // GET /api/events/:id
  if (req.method === 'GET' && parts.length === 3 && parts[1] === 'events') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    return sendJson(res, 200, publicEvent(event));
  }

  // DELETE /api/events/:id
  if (req.method === 'DELETE' && parts.length === 3 && parts[1] === 'events') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    const body = await readBody(req);
    const managePin = body.managePin == null ? '' : String(body.managePin);
    const now = Date.now();
    if (event.deleteLockedUntil && new Date(event.deleteLockedUntil).getTime() > now) {
      return sendJson(res, 429, { error: '관리 비밀번호를 5회 틀려 3분 동안 약속 파기가 잠겼어요.', deleteLockedUntil: event.deleteLockedUntil });
    }
    if (!event.managePinHash || !event.managePinSalt) {
      return sendJson(res, 409, { error: '관리 비밀번호가 설정되지 않은 이전 약속은 파기할 수 없어요.' });
    }
    const pinHash = hashManagePin(managePin, event.managePinSalt);
    const isValidPin =
      MANAGE_PIN_RE.test(managePin) &&
      pinHash.length === event.managePinHash.length &&
      crypto.timingSafeEqual(Buffer.from(pinHash), Buffer.from(event.managePinHash));
    if (!isValidPin) {
      const attempts = (event.deleteAuthFailures || 0) + 1;
      if (attempts >= MAX_DELETE_ATTEMPTS) {
        event.deleteAuthFailures = 0;
        event.deleteLockedUntil = new Date(now + DELETE_LOCK_MS).toISOString();
        saveEvent(event);
        return sendJson(res, 429, { error: '관리 비밀번호를 5회 틀려 3분 동안 약속 파기가 잠겼어요.', deleteLockedUntil: event.deleteLockedUntil });
      }
      event.deleteAuthFailures = attempts;
      event.deleteLockedUntil = null;
      saveEvent(event);
      return sendJson(res, 401, { error: `관리 비밀번호가 올바르지 않습니다. (${MAX_DELETE_ATTEMPTS - attempts}회 남음)` });
    }
    fs.unlinkSync(eventPath(event.id));
    return sendJson(res, 200, { ok: true });
  }

  // PUT /api/events/:id/participants  (이름 기준 upsert)
  if (req.method === 'PUT' && parts.length === 4 && parts[1] === 'events' && parts[3] === 'participants') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    const body = await readBody(req);
    const err = validateParticipantInput(body);
    if (err) return sendJson(res, 400, { error: err });
    const name = String(body.name).trim();
    const dates = [...new Set(body.dates.map(String))].sort();
    const idx = event.participants.findIndex((p) => p.name === name);
    const entry = { name, dates, updatedAt: new Date().toISOString() };
    if (idx >= 0) event.participants[idx] = entry;
    else {
      if (event.participants.length >= event.totalCount) {
        return sendJson(res, 400, { error: `참여자는 총원 ${event.totalCount}명을 초과해 등록할 수 없습니다.` });
      }
      event.participants.push(entry);
    }
    refreshExpireDate(event);
    saveEvent(event);
    return sendJson(res, 200, publicEvent(event));
  }

  // DELETE /api/events/:id/participants?name=...
  if (req.method === 'DELETE' && parts.length === 4 && parts[1] === 'events' && parts[3] === 'participants') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    const name = String(url.searchParams.get('name') || '').trim();
    event.participants = event.participants.filter((p) => p.name !== name);
    refreshExpireDate(event);
    saveEvent(event);
    return sendJson(res, 200, publicEvent(event));
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  // 참여 링크 엔트리포인트: /m/<id> → event.html (id는 클라이언트에서 경로로부터 읽음)
  if (/^\/m\/[a-z0-9]+$/.test(filePath)) filePath = '/event.html';
  const resolved = path.join(PUBLIC_DIR, filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    sendJson(res, 400, { error: e.message || 'bad request' });
  }
});

server.listen(PORT, () => {
  console.log(`회식 날짜 잡기 서버 실행 중: http://localhost:${PORT}`);
});

// 로컬 개발/운영용 무의존성 서버.
// 정적 파일(public/)과 API(/api/...)를 함께 제공하며, 데이터는 .data/ 디렉토리에 JSON 파일로 저장한다.
// Cloudflare Pages 배포 시에는 functions/ 디렉토리의 Pages Functions가 동일한 API를 제공한다.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// NAVER.env(gitignore 대상)의 키를 process.env 로 올린다. 이미 설정된 환경변수가 우선한다.
function loadEnvFile(fileName) {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, fileName), 'utf8').split('\n')) {
      const matched = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (matched && !process.env[matched[1]]) process.env[matched[1]] = matched[2].trim();
    }
  } catch {
    // 파일이 없으면 환경변수만 사용한다.
  }
}
loadEnvFile('NAVER.env');
loadEnvFile('HUDY.env');
loadEnvFile('KAKAO.env');

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
// 일정 확정 시 받는 만나는 시간 (HH:MM, 24시간제)
const CONFIRM_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DELETE_ATTEMPTS = 5;
const DELETE_LOCK_MS = 3 * 60 * 1000;
const MANAGE_LOCK_MESSAGE = '관리 비밀번호를 5회 틀려 3분 동안 관리 기능이 잠겼어요.';
const MAX_PLACES = 12;
// 네이버 지역검색(NCP Naver API Hub). display 최대값은 5.
const PLACE_SEARCH_ENDPOINT = 'https://naverapihub.apigw.ntruss.com/search/v1/local';
const PLACE_SEARCH_DISPLAY = 5;
const TEAMS_EXPORT_COOLDOWN_MS = 10 * 1000;
const TEAMS_NOTE_MAX = 200;

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
  // 확정/장소 기능 이전에 만들어진 약속도 같은 모양으로 응답한다.
  return { confirmedAt: null, confirmedDate: null, confirmedTime: null, confirmedPlaceId: null, places: [], holidays: null, ...publicData };
}

// 관리 비밀번호 검증. 통과하면 null, 실패하면 { status, body } 를 돌려주고 실패 횟수를 저장한다.
// 파기·확정·확정 취소가 같은 잠금 카운터(deleteAuthFailures/deleteLockedUntil)를 공유한다.
function checkManagePin(event, managePin) {
  const now = Date.now();
  if (event.deleteLockedUntil && new Date(event.deleteLockedUntil).getTime() > now) {
    return { status: 429, body: { error: MANAGE_LOCK_MESSAGE, deleteLockedUntil: event.deleteLockedUntil } };
  }
  if (!event.managePinHash || !event.managePinSalt) {
    return { status: 409, body: { error: '관리 비밀번호가 설정되지 않은 이전 약속은 관리할 수 없어요.' } };
  }
  const pinHash = hashManagePin(managePin, event.managePinSalt);
  const isValidPin =
    MANAGE_PIN_RE.test(managePin) &&
    pinHash.length === event.managePinHash.length &&
    crypto.timingSafeEqual(Buffer.from(pinHash), Buffer.from(event.managePinHash));
  if (isValidPin) {
    if (event.deleteAuthFailures || event.deleteLockedUntil) {
      event.deleteAuthFailures = 0;
      event.deleteLockedUntil = null;
      saveEvent(event);
    }
    return null;
  }
  const attempts = (event.deleteAuthFailures || 0) + 1;
  if (attempts >= MAX_DELETE_ATTEMPTS) {
    event.deleteAuthFailures = 0;
    event.deleteLockedUntil = new Date(now + DELETE_LOCK_MS).toISOString();
    saveEvent(event);
    return { status: 429, body: { error: MANAGE_LOCK_MESSAGE, deleteLockedUntil: event.deleteLockedUntil } };
  }
  event.deleteAuthFailures = attempts;
  event.deleteLockedUntil = null;
  saveEvent(event);
  return { status: 401, body: { error: `관리 비밀번호가 올바르지 않습니다. (${MAX_DELETE_ATTEMPTS - attempts}회 남음)` } };
}

function nextDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// 가장 많은 인원이 겹친 1위 후보 날짜들(yyyy-MM-dd, 동점 포함 오름차순). 일정 확정은 이 중에서만 고를 수 있다.
function topCandidateDates(event) {
  const counts = {};
  for (const participant of event.participants) {
    for (const date of participant.dates) counts[date] = (counts[date] || 0) + 1;
  }
  const dates = Object.keys(counts);
  if (dates.length === 0) return [];
  const maxCount = Math.max(...Object.values(counts));
  return dates.filter((date) => counts[date] === maxCount).sort();
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

// ---- 공휴일 캐시 (hudy.co.kr) ----
// hudy 무료 플랜은 월 100콜이라 매 생성마다 호출하지 않는다.
// 서버 구동 시 캐시 파일(.data/holidays-cache.json)이 없으면 최초 1회만
// 현재+미래 5개년(6개 연도)을 연 단위 API 로 받아 저장하고(연 1콜에 그 해 모든 월 포함),
// 약속 생성 시에는 캐시만 읽는다. (Cloudflare 쪽은 D1 holiday_cache 테이블이 같은 역할)
const HOLIDAY_API_ENDPOINT = 'https://api.hudy.co.kr/v2/holidays';
const HOLIDAY_CACHE_YEARS = 6; // 현재 연도 + 미래 5개년
const HOLIDAY_CACHE_PATH = path.join(DATA_DIR, 'holidays-cache.json');

// 한 해의 공휴일을 { 'yyyy-MM-dd': '이름' } 으로 반환. 실패는 null. (빈 해는 {} — 정상)
async function fetchHolidayYear(year, apiKey) {
  try {
    const response = await fetch(`${HOLIDAY_API_ENDPOINT}?year=${year}`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.error(`[holidays] hudy 응답 ${response.status} (year=${year})`);
      return null;
    }
    const payload = await response.json().catch(() => null);
    if (!payload || payload.result !== true || !Array.isArray(payload.data)) return null;
    const holidays = {};
    for (const holiday of payload.data) {
      const date = String(holiday.date || '');
      if (date) holidays[date] = String(holiday.name || '').slice(0, 20);
    }
    return holidays;
  } catch (error) {
    console.error(`[holidays] hudy 조회 실패 (year=${year}): ${error.message}`);
    return null;
  }
}

function readHolidayCache() {
  try {
    return JSON.parse(fs.readFileSync(HOLIDAY_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

// 서버 구동 시 1회: 캐시 파일이 없을 때만 시딩한다. 빈 해(데이터 미공개)도 저장해 재호출을 막는다.
async function seedHolidayCache() {
  if (readHolidayCache()) return;
  const apiKey = process.env.HUDY_API_KEY;
  if (!apiKey) {
    console.log('[holidays] HUDY_API_KEY 없음 — 내장 데이터 폴백으로 동작');
    return;
  }
  const baseYear = new Date().getFullYear();
  const cache = { fetchedAt: new Date().toISOString(), years: {} };
  for (let year = baseYear; year < baseYear + HOLIDAY_CACHE_YEARS; year++) {
    const holidays = await fetchHolidayYear(year, apiKey);
    if (holidays === null) continue; // 실패한 해는 저장하지 않아 다음 구동 때 다시 시도된다
    cache.years[year] = holidays;
  }
  if (Object.keys(cache.years).length === 0) {
    console.error('[holidays] 시딩 실패 — 내장 데이터 폴백으로 동작');
    return;
  }
  fs.writeFileSync(HOLIDAY_CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`[holidays] 캐시 시딩 완료 (${Object.keys(cache.years).join(', ')})`);
}

// 표시 범위의 공휴일을 캐시에서 읽는다. 캐시가 없으면 null(클라이언트 내장 데이터 폴백).
function getHolidaysForRange(startDate, endDate) {
  const cache = readHolidayCache();
  if (!cache || !cache.years) return null;
  const holidays = {};
  let hasYear = false;
  for (let year = Number(startDate.slice(0, 4)); year <= Number(endDate.slice(0, 4)); year++) {
    const yearMap = cache.years[year];
    if (!yearMap) continue;
    hasYear = true;
    for (const [date, name] of Object.entries(yearMap)) {
      if (date >= startDate && date <= endDate) holidays[date] = name;
    }
  }
  return hasYear ? holidays : null;
}

// ---- 진행 단계 ----
// 1 새 일정 만들기 → 2 일정 투표 → 3 일정 확정하고 장소 정하기 → 4 장소 확정하고 공유하기
function isScheduleConfirmed(event) {
  return Boolean(event.confirmedAt && event.confirmedDate && event.confirmedTime);
}

function confirmedPlace(event) {
  return (event.places || []).find((place) => place.id === event.confirmedPlaceId) || null;
}

function isFullyConfirmed(event) {
  return isScheduleConfirmed(event) && Boolean(confirmedPlace(event));
}

// 주소에서 시/도 + 시군구 까지만 남긴다. ('경기도 성남시 분당구' 처럼 시 아래 구가 있으면 세 토막)
function addressRegion(address) {
  const tokens = String(address || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '';
  const hasDistrictUnderCity = /시$/.test(tokens[1]) && tokens[2] && /(구|군)$/.test(tokens[2]);
  return tokens.slice(0, hasDistrictUnderCity ? 3 : 2).join(' ');
}

// 붙여넣은 POI 링크가 있으면 그대로 쓴다. 없으면 검색 URL로 폴백하는데,
// 전체 도로명주소(층·호 포함)를 넣으면 네이버 지도 검색이 실패하므로 이름 + 시군구까지만 쓴다.
function placeMapLink(place) {
  if (place.link) return place.link;
  const query = [place.name, addressRegion(place.address || place.roadAddress)].filter(Boolean).join(' ');
  return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
}

// ---- 후보 장소 공용 로직 ----
// 장소 공유 링크는 주요 지도 앱(네이버지도·카카오맵·구글 지도) 도메인으로 제한한다. (임의 외부 링크 등록 방지)
function normalizePlaceLink(raw) {
  const value = String(raw || '').trim();
  if (!value) return { link: '' };
  if (value.length > 300) return { error: '링크가 너무 깁니다.' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: '링크 형식이 올바르지 않습니다.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: '링크 형식이 올바르지 않습니다.' };
  const host = parsed.hostname.toLowerCase();
  const MAP_LINK_HOSTS = ['naver.me', 'naver.com', 'kko.to', 'kakao.com', 'maps.app.goo.gl', 'google.com', 'goo.gl'];
  const isMapLink = MAP_LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!isMapLink) return { error: '지도 앱의 공유 링크(네이버지도·카카오맵·구글 지도)만 등록할 수 있어요.' };
  return { link: parsed.toString() };
}

function validatePlaceInput(body) {
  const name = String(body.name || '').trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const addedBy = String(body.addedBy || '').trim();
  if (!name || name.length > 60) return { error: '장소 이름은 1~60자로 입력해 주세요.' };
  // 대한민국 영역 밖 좌표는 잘못 넘어온 값으로 본다.
  if (!Number.isFinite(lat) || lat < 33 || lat > 39.5) return { error: '좌표가 대한민국 범위를 벗어났어요.' };
  if (!Number.isFinite(lng) || lng < 124 || lng > 132) return { error: '좌표가 대한민국 범위를 벗어났어요.' };
  if (addedBy.length > 20) return { error: '등록자 이름이 너무 깁니다.' };
  const linkResult = normalizePlaceLink(body.link);
  if (linkResult.error) return { error: linkResult.error };
  return {
    place: {
      name,
      category: String(body.category || '').trim().slice(0, 120),
      address: String(body.address || '').trim().slice(0, 160),
      roadAddress: String(body.roadAddress || '').trim().slice(0, 160),
      lat,
      lng,
      link: linkResult.link,
      addedBy,
    },
  };
}

function isSamePlace(left, right) {
  if (left.name === right.name && left.roadAddress && left.roadAddress === right.roadAddress) return true;
  return Math.abs(left.lat - right.lat) < 1e-6 && Math.abs(left.lng - right.lng) < 1e-6;
}

// 지역검색 title/category 에는 <b> 강조 태그와 HTML 엔티티가 섞여 온다.
function stripSearchMarkup(raw) {
  return String(raw || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// mapx/mapy 는 WGS84 좌표를 10^7배한 정수 문자열로 온다. (예: 1270284390 -> 127.028439)
function toCoord(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return NaN;
  return Math.abs(value) > 1000 ? value / 1e7 : value;
}

function toSearchItem(item) {
  const lat = toCoord(item.mapy);
  const lng = toCoord(item.mapx);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    name: stripSearchMarkup(item.title),
    category: stripSearchMarkup(item.category),
    address: stripSearchMarkup(item.address),
    roadAddress: stripSearchMarkup(item.roadAddress),
    lat,
    lng,
  };
}

// 네이버 지역검색 프록시. 검색 시크릿이 클라이언트로 나가지 않도록 서버에서만 호출한다.
async function searchLocalPlaces(query, keyId, keySecret) {
  if (!query) return { status: 400, body: { error: '검색어를 입력해 주세요.' } };
  if (query.length > 60) return { status: 400, body: { error: '검색어는 60자 이내로 입력해 주세요.' } };
  if (!keyId || !keySecret) {
    return { status: 503, body: { error: '장소 검색 키가 설정되지 않았어요. 이름과 주소를 직접 입력해 등록해 주세요.' } };
  }
  const endpoint = new URL(PLACE_SEARCH_ENDPOINT);
  endpoint.searchParams.set('query', query);
  endpoint.searchParams.set('display', String(PLACE_SEARCH_DISPLAY));
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { 'X-NCP-APIGW-API-KEY-ID': keyId, 'X-NCP-APIGW-API-KEY': keySecret },
    });
  } catch {
    return { status: 502, body: { error: '장소 검색 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' } };
  }
  if (!response.ok) {
    return { status: 502, body: { error: `장소 검색에 실패했어요. (네이버 응답 ${response.status})` } };
  }
  const data = await response.json().catch(() => null);
  const items = (data && Array.isArray(data.items) ? data.items : []).map(toSearchItem).filter(Boolean);
  return { status: 200, body: { items } };
}

// ---- 팀즈로 내보내기 공용 로직 ----
// !! functions/api/_shared.js 의 같은 목록과 반드시 함께 고칠 것 !!
// 웹후크 URL은 저장하지 않고 요청마다 받는다. 임의 URL을 서버가 그대로 호출하면 SSRF가 되므로
// Teams 워크플로(Power Automate) 웹후크 호스트만 허용한다.
const TEAMS_WEBHOOK_HOSTS = [
  'logic.azure.com', // Power Automate 워크플로 웹후크
  'logic.azure.us',
  'logic.azure.cn',
  'environment.api.powerplatform.com', // 신형 Power Platform 워크플로 URL
  'webhook.office.com', // 구 Office 365 커넥터 (은퇴했지만 남아 있을 수 있음)
];

function validateTeamsWebhookUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { error: '웹후크 URL을 입력해 주세요.' };
  if (value.length > 2000) return { error: '웹후크 URL이 너무 깁니다.' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: '웹후크 URL 형식이 올바르지 않습니다.' };
  }
  if (parsed.protocol !== 'https:') return { error: '웹후크 URL은 https 로 시작해야 합니다.' };
  const host = parsed.hostname.toLowerCase();
  const allowed = TEAMS_WEBHOOK_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) {
    return { error: 'Teams 워크플로 웹후크 주소가 아니에요. (logic.azure.com / powerplatform.com / webhook.office.com)' };
  }
  // 재직렬화하지 않고 입력 원문을 그대로 쓴다. sig(SAS 서명)가 한 글자라도 바뀌면 401이 난다.
  return { url: value };
}

// 채널에 올라가는 메모는 사용자가 적은 한 줄. 제어문자와 줄바꿈을 걷어내고 길이를 제한한다.
function sanitizeTeamsNote(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEAMS_NOTE_MAX);
}

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function formatCardDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const dow = DOW_LABELS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${month}/${day}(${dow})`;
}

function formatCardRange(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${year}.${month}.${day}`;
}

// 날짜 후보 순위. 동점은 같은 순위로 묶는다. (결과 탭의 '회식 날 후보 순위'와 같은 규칙)
function topDateRanks(event, limit = 3) {
  const counts = {};
  for (const participant of event.participants) {
    for (const date of participant.dates) counts[date] = (counts[date] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort(([dateA, countA], [dateB, countB]) => countB - countA || dateA.localeCompare(dateB));
  return [...new Set(ranked.map(([, count]) => count))].slice(0, limit).map((count, index) => ({
    rank: index + 1,
    count,
    dates: ranked.filter(([, dateCount]) => dateCount === count).map(([date]) => formatCardDate(date)),
  }));
}

function topPlaces(event, limit = 3) {
  return [...(event.places || [])]
    .sort((a, b) => (b.votes || []).length - (a.votes || []).length || String(a.addedAt).localeCompare(String(b.addedAt)))
    .slice(0, limit);
}

const THEME_CARD_LABELS = { weekday: '평일 약속', weekend: '주말 약속', both: '평일+주말 약속' };

// '19:00' -> '오후 7:00'
function formatMeetTime(time) {
  if (!CONFIRM_TIME_RE.test(String(time || ''))) return '';
  const [hour, minute] = time.split(':').map(Number);
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')}`;
}

// 공유는 모든 결정이 끝난 뒤에만 하므로, 카드에는 확정된 날짜·시간·장소를 싣는다.
// 카드 내용은 저장된 약속 데이터로 서버가 직접 만든다.
// (클라이언트가 보낸 임의 문구를 그대로 채널에 올리지 않기 위해 메모만 따로 받는다)
function buildTeamsCard(event, shareUrl, note) {
  const place = confirmedPlace(event);
  // 채널에 나가는 링크는 사용자가 직접 붙여넣은 POI 링크만 쓴다.
  // (검색 URL 폴백은 정확도가 보장되지 않아 채널에 내보내지 않는다)
  const mapUrl = place && place.link ? place.link : '';
  const body = [
    { type: 'TextBlock', text: `🍷 ${event.title}`, size: 'Large', weight: 'Bolder', wrap: true },
    {
      type: 'TextBlock',
      text: `${formatCardDate(event.confirmedDate)} ${formatMeetTime(event.confirmedTime)}`,
      size: 'Medium',
      weight: 'Bolder',
      color: 'Accent',
      spacing: 'Small',
      wrap: true,
    },
  ];
  if (note) body.push({ type: 'TextBlock', text: note, wrap: true, spacing: 'Medium' });

  const facts = [
    { title: '날짜', value: `${event.confirmedDate} (${formatCardDate(event.confirmedDate)})` },
    { title: '시간', value: `${event.confirmedTime} · ${formatMeetTime(event.confirmedTime)}` },
  ];
  if (place) {
    facts.push({ title: '장소', value: place.name });
    if (place.roadAddress || place.address) facts.push({ title: '주소', value: place.roadAddress || place.address });
    if (mapUrl) facts.push({ title: '장소 공유 링크', value: mapUrl });
  }
  facts.push({ title: '참여 인원', value: `${event.participants.length}명 / 총원 ${event.totalCount}명` });
  body.push({ type: 'FactSet', facts, spacing: 'Medium' });

  const actions = [];
  if (mapUrl) actions.push({ type: 'Action.OpenUrl', title: '지도에서 보기', url: mapUrl });
  actions.push({ type: 'Action.OpenUrl', title: '약속 페이지 열기', url: shareUrl });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          actions,
        },
      },
    ],
  };
}

// 웹후크 본문. 워크플로에서 바로 꺼내 쓸 수 있도록 확정 정보를 최상위 필드로 싣고,
// 기본 템플릿("웹후크 요청이 수신되면 채널에 게시")이 그대로 렌더할 수 있게 카드도 함께 넣는다.
function buildWebhookPayload(event, shareUrl, note) {
  const place = confirmedPlace(event);
  const link = place && place.link ? place.link : '';
  return {
    date: event.confirmedDate,
    time: event.confirmedTime,
    poi_name: place ? place.name : '',
    address: place ? place.roadAddress || place.address || '' : '',
    web_link: shareUrl,
    // 지도 링크는 사용자가 붙여넣은 값만 보낸다. 없으면 필드 자체를 빼서
    // 워크플로가 검색 URL을 실제 POI 링크로 오해하지 않게 한다.
    ...(link ? { url: link } : {}),
    ...buildTeamsCard(event, shareUrl, note),
  };
}


// 실패 응답 본문은 그대로 돌려주지 않는다. (웹후크 응답이 정보 유출 통로가 되지 않도록)
async function postToTeams(webhookUrl, card) {
  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      redirect: 'error', // 리다이렉트를 따라가면 호스트 화이트리스트가 무력해진다
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { status: 502, body: { error: 'Teams 웹후크에 연결하지 못했어요. URL이 아직 유효한지 확인해 주세요.' } };
  }
  if (!response.ok) {
    // 진단용 서버 로그. (응답 본문은 클라이언트로 내려보내지 않는다)
    const detail = await response.text().catch(() => '');
    console.error(`[teams-export] 웹후크 거부 status=${response.status} body=${detail.slice(0, 300)}`);
    if (response.status === 401 || response.status === 403) {
      return {
        status: 502,
        body: {
          error:
            `Teams가 인증을 거부했어요. (응답 ${response.status}) ` +
            "① 웹후크 URL이 끝까지(&sig=... 포함) 복사됐는지 ② 워크플로 트리거의 '흐름을 트리거할 수 있는 사용자'가 " +
            "'모든 사용자'(Anyone)로 되어 있는지 확인해 주세요.",
        },
      };
    }
    return { status: 502, body: { error: `Teams가 요청을 거부했어요. (응답 ${response.status}) 워크플로가 켜져 있는지 확인해 주세요.` } };
  }
  return { status: 200, body: { ok: true } };
}

// ---- 링크 미리보기(OG) ----
// Share to Teams 는 공유되는 페이지의 OG 메타태그로 미리보기 카드를 만든다.
// (제목+설명만 있어도 카드가 만들어지므로 og:image 는 넣지 않는다)
function buildEventMeta(event, shareUrl) {
  const parts = [];
  // 확정된 뒤에는 후보 순위 대신 결정된 내용을 보여준다.
  if (isScheduleConfirmed(event)) {
    parts.push(`${formatCardDate(event.confirmedDate)} ${formatMeetTime(event.confirmedTime)}`);
    const place = confirmedPlace(event);
    if (place) parts.push(place.name);
  } else {
    const dateRanks = topDateRanks(event, 1);
    parts.push(dateRanks.length ? `날짜 1위 ${dateRanks[0].dates.join(', ')} (${dateRanks[0].count}명)` : '아직 등록된 일정이 없어요');
  }
  parts.push(`참여 ${event.participants.length}명 / 총원 ${event.totalCount}명`);
  return { title: `🍷 ${event.title}`, description: parts.join(' · '), url: shareUrl };
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function buildMetaTags(meta) {
  const title = escapeHtmlAttribute(meta.title);
  const description = escapeHtmlAttribute(meta.description);
  return [
    `<meta name="title" content="${title}" />`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${escapeHtmlAttribute(meta.url)}" />`,
  ].join('');
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
      confirmedAt: null,
      confirmedDate: null,
      confirmedTime: null,
      confirmedPlaceId: null,
      createdAt: new Date().toISOString(),
      participants: [],
      places: [],
      // 표시 범위의 공휴일 (구동 시 시딩해 둔 캐시에서 조회). 캐시가 없으면 null → 내장 데이터 폴백.
      holidays: getHolidaysForRange(String(body.startDate), String(body.endDate)),
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
    const denied = checkManagePin(event, body.managePin == null ? '' : String(body.managePin));
    if (denied) return sendJson(res, denied.status, denied.body);
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
    // 삭제된 참여자가 넣어둔 장소 투표도 함께 정리한다.
    for (const place of event.places || []) {
      if (Array.isArray(place.votes)) place.votes = place.votes.filter((voter) => voter !== name);
    }
    refreshExpireDate(event);
    saveEvent(event);
    return sendJson(res, 200, publicEvent(event));
  }

  // POST /api/events/:id/confirm - 일정 확정 (날짜 + 만나는 시간 지정, 장소 정하기 단계 열기)
  // DELETE /api/events/:id/confirm - 일정 확정 취소. 장소 확정도 함께 풀린다.
  if ((req.method === 'POST' || req.method === 'DELETE') && parts.length === 4 && parts[1] === 'events' && parts[3] === 'confirm') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    const body = await readBody(req);
    const confirmedDate = String(body.confirmedDate || '');
    const confirmedTime = String(body.confirmedTime || '');
    if (req.method === 'POST') {
      if (!DATE_RE.test(confirmedDate)) return sendJson(res, 400, { error: '만나는 날짜를 선택해 주세요.' });
      if (confirmedDate < event.startDate || confirmedDate > event.endDate) {
        return sendJson(res, 400, { error: '만나는 날짜는 약속의 표시 범위 안에서 골라 주세요.' });
      }
      const candidateDates = topCandidateDates(event);
      if (candidateDates.length === 0) {
        return sendJson(res, 400, { error: '아직 등록된 일정이 없어 확정할 수 없어요. 먼저 일정을 등록해 주세요.' });
      }
      if (!candidateDates.includes(confirmedDate)) {
        return sendJson(res, 400, { error: '만나는 날짜는 가장 많은 인원이 겹친 1위 후보 날짜 중에서 골라 주세요.' });
      }
      if (!CONFIRM_TIME_RE.test(confirmedTime)) {
        return sendJson(res, 400, { error: '만나는 시간을 HH:MM 형식으로 입력해 주세요.' });
      }
    }
    const denied = checkManagePin(event, body.managePin == null ? '' : String(body.managePin));
    if (denied) return sendJson(res, denied.status, denied.body);
    if (req.method === 'POST') {
      event.confirmedAt = new Date().toISOString();
      event.confirmedDate = confirmedDate;
      event.confirmedTime = confirmedTime;
    } else {
      // 날짜·시간은 남겨 두어 다시 확정할 때 이전 값이 채워지게 한다.
      // 장소 확정은 독립이므로 함께 풀지 않는다.
      event.confirmedAt = null;
    }
    saveEvent(event);
    return sendJson(res, 200, publicEvent(event));
  }

  // POST /api/events/:id/confirm-place   - 후보지 하나를 최종 장소로 확정 (공유 단계 열기)
  // DELETE /api/events/:id/confirm-place - 장소 확정 취소
  if ((req.method === 'POST' || req.method === 'DELETE') && parts.length === 4 && parts[1] === 'events' && parts[3] === 'confirm-place') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    const body = await readBody(req);

    if (req.method === 'DELETE') {
      const denied = checkManagePin(event, body.managePin == null ? '' : String(body.managePin));
      if (denied) return sendJson(res, denied.status, denied.body);
      event.confirmedPlaceId = null;
      saveEvent(event);
      return sendJson(res, 200, publicEvent(event));
    }

    const place = (event.places || []).find((candidate) => candidate.id === String(body.placeId || ''));
    if (!place) return sendJson(res, 404, { error: '후보 장소를 찾을 수 없습니다.' });

    // 장소를 확정하면서 네이버 지도 링크를 함께 넣거나 고칠 수 있다. (빈 값이면 기존 링크 유지)
    const linkInput = String(body.link || '').trim();
    let normalizedLink = '';
    if (linkInput) {
      const linkResult = normalizePlaceLink(linkInput);
      if (linkResult.error) return sendJson(res, 400, { error: linkResult.error });
      normalizedLink = linkResult.link;
    }

    const denied = checkManagePin(event, body.managePin == null ? '' : String(body.managePin));
    if (denied) return sendJson(res, denied.status, denied.body);
    if (normalizedLink) place.link = normalizedLink;
    event.confirmedPlaceId = place.id;
    saveEvent(event);
    return sendJson(res, 200, publicEvent(event));
  }

  // POST /api/events/:id/places        - 후보 장소 등록
  // PUT  /api/events/:id/places        - 후보 장소 투표 토글
  // DELETE /api/events/:id/places?placeId=... - 후보 장소 삭제
  if (['POST', 'PUT', 'DELETE'].includes(req.method) && parts.length === 4 && parts[1] === 'events' && parts[3] === 'places') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    // 장소 정하기는 일정 확정과 병행할 수 있다. (공유만 둘 다 확정된 뒤 가능)
    if (!Array.isArray(event.places)) event.places = [];

    if (req.method === 'POST') {
      const body = await readBody(req);
      const result = validatePlaceInput(body);
      if (result.error) return sendJson(res, 400, { error: result.error });
      if (event.places.length >= MAX_PLACES) {
        return sendJson(res, 400, { error: `후보 장소는 최대 ${MAX_PLACES}곳까지 등록할 수 있어요.` });
      }
      if (event.places.some((place) => isSamePlace(place, result.place))) {
        return sendJson(res, 400, { error: '이미 등록된 장소예요.' });
      }
      event.places.push({ id: crypto.randomBytes(6).toString('hex'), ...result.place, addedAt: new Date().toISOString(), votes: [] });
      saveEvent(event);
      return sendJson(res, 200, publicEvent(event));
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const place = event.places.find((candidate) => candidate.id === String(body.placeId || ''));
      if (!place) return sendJson(res, 404, { error: '후보 장소를 찾을 수 없습니다.' });
      const name = String(body.name || '').trim();
      if (!event.participants.some((participant) => participant.name === name)) {
        return sendJson(res, 400, { error: '참여자 이름을 선택한 뒤 투표해 주세요.' });
      }
      if (!Array.isArray(place.votes)) place.votes = [];
      const voted = place.votes.indexOf(name);
      if (voted >= 0) place.votes.splice(voted, 1);
      else place.votes.push(name);
      saveEvent(event);
      return sendJson(res, 200, publicEvent(event));
    }

    const placeId = String(url.searchParams.get('placeId') || '');
    event.places = event.places.filter((place) => place.id !== placeId);
    // 확정된 장소가 지워졌으면 장소 확정도 함께 푼다.
    if (event.confirmedPlaceId === placeId) event.confirmedPlaceId = null;
    saveEvent(event);
    return sendJson(res, 200, publicEvent(event));
  }

  // POST /api/events/:id/teams-export - 약속 요약을 Teams 채널 웹후크로 전송 (URL은 저장하지 않음)
  if (req.method === 'POST' && parts.length === 4 && parts[1] === 'events' && parts[3] === 'teams-export') {
    const event = loadEvent(parts[2]);
    if (!event) return sendJson(res, 404, { error: '약속을 찾을 수 없습니다.' });
    // 공유는 모든 결정(날짜·시간·장소)이 끝난 뒤 마지막 단계에서만 한다.
    if (!isFullyConfirmed(event)) {
      return sendJson(res, 409, { error: '일정과 장소를 모두 확정한 뒤에 공유할 수 있어요.' });
    }
    const body = await readBody(req);
    const webhook = validateTeamsWebhookUrl(body.webhookUrl);
    if (webhook.error) return sendJson(res, 400, { error: webhook.error });

    // 같은 약속이 연달아 채널에 올라가지 않도록 짧은 쿨다운을 둔다.
    const now = Date.now();
    const lastSent = event.lastTeamsExportAt ? new Date(event.lastTeamsExportAt).getTime() : 0;
    if (now - lastSent < TEAMS_EXPORT_COOLDOWN_MS) {
      return sendJson(res, 429, { error: '방금 내보냈어요. 잠시 후 다시 시도해 주세요.' });
    }

    const shareUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/m/${event.id}`;
    const result = await postToTeams(webhook.url, buildWebhookPayload(event, shareUrl, sanitizeTeamsNote(body.note)));
    if (result.status === 200) {
      event.lastTeamsExportAt = new Date(now).toISOString();
      saveEvent(event);
    }
    return sendJson(res, result.status, result.body);
  }

  // GET /api/places/search?query=... - 네이버 지역검색 프록시
  if (req.method === 'GET' && parts.length === 3 && parts[1] === 'places' && parts[2] === 'search') {
    const result = await searchLocalPlaces(
      String(url.searchParams.get('query') || '').trim(),
      process.env.NAVER_SEARCH_KEY_ID,
      process.env.NAVER_SEARCH_KEY
    );
    return sendJson(res, result.status, result.body);
  }

  // GET /api/config - 클라이언트에 필요한 공개 설정 (지도 키는 도메인 제한으로 보호된다)
  if (req.method === 'GET' && parts.length === 2 && parts[1] === 'config') {
    return sendJson(res, 200, {
      naverMapKeyId: process.env.NAVER_MAP_KEY_ID || '',
      placeSearchEnabled: Boolean(process.env.NAVER_SEARCH_KEY_ID && process.env.NAVER_SEARCH_KEY),
      // 카카오 JavaScript 키. 브라우저 노출용이며 카카오 콘솔의 도메인 등록으로 보호된다.
      kakaoJsKey: process.env.KAKAO_JS_KEY || '',
    });
  }

  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  // 참여 링크 엔트리포인트: /m/<id> → event.html (id는 클라이언트에서 경로로부터 읽음)
  const eventPage = filePath.match(/^\/m\/([a-z0-9]+)$/);
  if (eventPage) filePath = '/event.html';
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
    let body = data;
    // 링크 미리보기용 OG 메타태그를 약속별로 주입한다.
    // (Cloudflare Pages 에서는 functions/m/[id].js 가 HTMLRewriter 로 같은 일을 한다)
    const event = eventPage ? loadEvent(eventPage[1]) : null;
    if (event) {
      const shareUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/m/${event.id}`;
      body = data.toString('utf8').replace('</title>', `</title>${buildMetaTags(buildEventMeta(event, shareUrl))}`);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(body);
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
  // 공휴일 캐시 시딩은 기동을 막지 않도록 백그라운드로 돌린다.
  seedHolidayCache().catch((error) => console.error(`[holidays] 시딩 오류: ${error.message}`));
});

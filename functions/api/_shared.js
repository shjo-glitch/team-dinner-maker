// Pages Functions 공용 로직. 파일명이 밑줄로 시작하면 라우트로 노출되지 않는다.
// 같은 규칙이 로컬 개발 서버(server.js)에도 복제되어 있다.
export const THEMES = ['weekday', 'weekend', 'both'];
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MANAGE_PIN_RE = /^\d{4,6}$/;
// 일정 확정 시 받는 만나는 시간 (HH:MM, 24시간제)
export const CONFIRM_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_DELETE_ATTEMPTS = 5;
export const DELETE_LOCK_MS = 3 * 60 * 1000;
export const MANAGE_LOCK_MESSAGE = '관리 비밀번호를 5회 틀려 3분 동안 관리 기능이 잠겼어요.';
export const MAX_PLACES = 12;
export const TEAMS_EXPORT_COOLDOWN_MS = 10 * 1000;
export const TEAMS_NOTE_MAX = 200;
// 네이버 지역검색(NCP Naver API Hub). display 최대값은 5.
const PLACE_SEARCH_ENDPOINT = 'https://naverapihub.apigw.ntruss.com/search/v1/local';
const PLACE_SEARCH_DISPLAY = 5;

export function createManagePinSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashManagePin(pin, salt) {
  const encoded = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function secureEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

export async function loadEvent(env, id) {
  const row = await env.DB.prepare('SELECT data FROM events WHERE id = ?1').bind(id).first();
  return row ? JSON.parse(row.data) : null;
}

export async function saveEvent(env, event) {
  await env.DB.prepare('UPDATE events SET data = ?2 WHERE id = ?1').bind(event.id, JSON.stringify(event)).run();
}

export function publicEvent(event) {
  const { managePinHash, managePinSalt, deleteAuthFailures, ...publicData } = event;
  // 확정/장소 기능 이전에 만들어진 약속도 같은 모양으로 응답한다.
  return { confirmedAt: null, confirmedDate: null, confirmedTime: null, confirmedPlaceId: null, places: [], holidays: null, ...publicData };
}

export async function readJson(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 }) };
  }
}

// 관리 비밀번호 검증. 통과하면 null, 실패하면 그대로 반환할 Response 를 돌려준다.
// 파기·확정·확정 취소가 같은 잠금 카운터(deleteAuthFailures/deleteLockedUntil)를 공유한다.
export async function checkManagePin(env, event, managePin) {
  const now = Date.now();
  if (event.deleteLockedUntil && new Date(event.deleteLockedUntil).getTime() > now) {
    return Response.json({ error: MANAGE_LOCK_MESSAGE, deleteLockedUntil: event.deleteLockedUntil }, { status: 429 });
  }
  if (!event.managePinHash || !event.managePinSalt) {
    return Response.json({ error: '관리 비밀번호가 설정되지 않은 이전 약속은 관리할 수 없어요.' }, { status: 409 });
  }
  const isValidPin =
    MANAGE_PIN_RE.test(managePin) && secureEqual(await hashManagePin(managePin, event.managePinSalt), event.managePinHash);
  if (isValidPin) {
    if (event.deleteAuthFailures || event.deleteLockedUntil) {
      event.deleteAuthFailures = 0;
      event.deleteLockedUntil = null;
      await saveEvent(env, event);
    }
    return null;
  }
  const attempts = (event.deleteAuthFailures || 0) + 1;
  if (attempts >= MAX_DELETE_ATTEMPTS) {
    event.deleteAuthFailures = 0;
    event.deleteLockedUntil = new Date(now + DELETE_LOCK_MS).toISOString();
    await saveEvent(env, event);
    return Response.json({ error: MANAGE_LOCK_MESSAGE, deleteLockedUntil: event.deleteLockedUntil }, { status: 429 });
  }
  event.deleteAuthFailures = attempts;
  event.deleteLockedUntil = null;
  await saveEvent(env, event);
  return Response.json({ error: `관리 비밀번호가 올바르지 않습니다. (${MAX_DELETE_ATTEMPTS - attempts}회 남음)` }, { status: 401 });
}

function nextDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// 공동 1위가 여러 날이면 가장 늦은 후보 다음 날에 만료해 모든 1위 후보를 보존한다.
export function refreshExpireDate(event) {
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
// D1 의 holiday_cache 테이블이 비어 있을 때 최초 1회만 현재+미래 5개년(6개 연도)을
// 연 단위 API 로 받아 저장하고(연 1콜에 그 해 모든 월이 포함된다), 이후에는 캐시만 읽는다.
const HOLIDAY_API_ENDPOINT = 'https://api.hudy.co.kr/v2/holidays';
export const HOLIDAY_CACHE_YEARS = 6; // 현재 연도 + 미래 5개년

// 한 해의 공휴일을 { 'yyyy-MM-dd': '이름' } 으로 반환. 실패는 null. (빈 해는 {} — 정상)
export async function fetchHolidayYear(year, apiKey) {
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

// 캐시가 비어 있으면 최초 1회 시딩한다. 빈 해(데이터 미공개)도 저장해 재호출을 막는다.
async function ensureHolidayCache(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS holiday_cache (year INTEGER PRIMARY KEY, data TEXT NOT NULL, fetched_at TEXT NOT NULL)'
  ).run();
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM holiday_cache').first();
  if (row && row.n > 0) return;
  if (!env.HUDY_API_KEY) return;

  const baseYear = new Date().getFullYear();
  const now = new Date().toISOString();
  for (let year = baseYear; year < baseYear + HOLIDAY_CACHE_YEARS; year++) {
    const holidays = await fetchHolidayYear(year, env.HUDY_API_KEY);
    if (holidays === null) continue; // 실패한 해는 저장하지 않아 다음 기회에 다시 시도된다
    await env.DB.prepare('INSERT OR REPLACE INTO holiday_cache (year, data, fetched_at) VALUES (?1, ?2, ?3)')
      .bind(year, JSON.stringify(holidays), now)
      .run();
  }
  console.log(`[holidays] 캐시 시딩 완료 (${baseYear}~${baseYear + HOLIDAY_CACHE_YEARS - 1})`);
}

// 표시 범위의 공휴일을 캐시에서 읽는다. 캐시가 전혀 없으면 null(클라이언트 내장 데이터 폴백).
export async function getHolidaysForRange(env, startDate, endDate) {
  try {
    await ensureHolidayCache(env);
    const rows = await env.DB.prepare('SELECT data FROM holiday_cache WHERE year BETWEEN ?1 AND ?2')
      .bind(Number(startDate.slice(0, 4)), Number(endDate.slice(0, 4)))
      .all();
    if (!rows.results || rows.results.length === 0) return null;
    const holidays = {};
    for (const row of rows.results) {
      const yearMap = JSON.parse(row.data);
      for (const [date, name] of Object.entries(yearMap)) {
        if (date >= startDate && date <= endDate) holidays[date] = name;
      }
    }
    return holidays;
  } catch (error) {
    console.error(`[holidays] 캐시 조회 실패: ${error.message}`);
    return null;
  }
}

// ---- 진행 단계 ----
// 1 새 일정 만들기 → 2 일정 투표 → 3 일정 확정하고 장소 정하기 → 4 장소 확정하고 공유하기
export function isScheduleConfirmed(event) {
  return Boolean(event.confirmedAt && event.confirmedDate && event.confirmedTime);
}

export function confirmedPlace(event) {
  return (event.places || []).find((place) => place.id === event.confirmedPlaceId) || null;
}

export function isFullyConfirmed(event) {
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
export function placeMapLink(place) {
  if (place.link) return place.link;
  const query = [place.name, addressRegion(place.address || place.roadAddress)].filter(Boolean).join(' ');
  return `https://map.naver.com/p/search/${encodeURIComponent(query)}`;
}

// ---- 후보 장소 ----
// 저장하는 링크는 네이버 도메인으로 제한한다. (임의 외부 링크 등록 방지)
export function normalizePlaceLink(raw) {
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
  const isNaver = ['naver.me', 'naver.com'].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!isNaver) return { error: '네이버 지도 링크(naver.me, map.naver.com)만 등록할 수 있어요.' };
  return { link: parsed.toString() };
}

export function validatePlaceInput(body) {
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

export function isSamePlace(left, right) {
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
export async function searchLocalPlaces(query, keyId, keySecret) {
  if (!query) return Response.json({ error: '검색어를 입력해 주세요.' }, { status: 400 });
  if (query.length > 60) return Response.json({ error: '검색어는 60자 이내로 입력해 주세요.' }, { status: 400 });
  if (!keyId || !keySecret) {
    return Response.json({ error: '장소 검색 키가 설정되지 않았어요. 이름과 주소를 직접 입력해 등록해 주세요.' }, { status: 503 });
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
    return Response.json({ error: '장소 검색 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' }, { status: 502 });
  }
  if (!response.ok) {
    return Response.json({ error: `장소 검색에 실패했어요. (네이버 응답 ${response.status})` }, { status: 502 });
  }
  const data = await response.json().catch(() => null);
  const items = (data && Array.isArray(data.items) ? data.items : []).map(toSearchItem).filter(Boolean);
  return Response.json({ items });
}

// ---- 팀즈로 내보내기 ----
// 웹후크 URL은 저장하지 않고 요청마다 받는다. 임의 URL을 서버가 그대로 호출하면 SSRF가 되므로
// Teams 워크플로(Power Automate) 웹후크 호스트만 허용한다.
const TEAMS_WEBHOOK_HOSTS = [
  'logic.azure.com', // Power Automate 워크플로 웹후크
  'logic.azure.us',
  'logic.azure.cn',
  'environment.api.powerplatform.com', // 신형 Power Platform 워크플로 URL
  'webhook.office.com', // 구 Office 365 커넥터 (은퇴했지만 남아 있을 수 있음)
];

export function validateTeamsWebhookUrl(raw) {
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
export function sanitizeTeamsNote(raw) {
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

// 가장 많은 인원이 겹친 1위 후보 날짜들(yyyy-MM-dd, 동점 포함 오름차순). 일정 확정은 이 중에서만 고를 수 있다.
export function topCandidateDates(event) {
  const counts = {};
  for (const participant of event.participants) {
    for (const date of participant.dates) counts[date] = (counts[date] || 0) + 1;
  }
  const dates = Object.keys(counts);
  if (dates.length === 0) return [];
  const maxCount = Math.max(...Object.values(counts));
  return dates.filter((date) => counts[date] === maxCount).sort();
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
export function formatMeetTime(time) {
  if (!CONFIRM_TIME_RE.test(String(time || ''))) return '';
  const [hour, minute] = time.split(':').map(Number);
  return `${hour < 12 ? '오전' : '오후'} ${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')}`;
}

// 공유는 모든 결정이 끝난 뒤에만 하므로, 카드에는 확정된 날짜·시간·장소를 싣는다.
// 카드 내용은 저장된 약속 데이터로 서버가 직접 만든다.
// (클라이언트가 보낸 임의 문구를 그대로 채널에 올리지 않기 위해 메모만 따로 받는다)
export function buildTeamsCard(event, shareUrl, note) {
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
  }
  facts.push({ title: '참여 인원', value: `${event.participants.length}명 / 총원 ${event.totalCount}명` });
  body.push({ type: 'FactSet', facts, spacing: 'Medium' });

  const actions = [];
  if (mapUrl) actions.push({ type: 'Action.OpenUrl', title: '네이버 지도에서 보기', url: mapUrl });
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
export function buildWebhookPayload(event, shareUrl, note) {
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
export async function postToTeams(webhookUrl, card) {
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

// ---- 링크 미리보기(OG) / 공유 문구 ----
// Share to Teams 는 공유되는 페이지의 OG 메타태그로 미리보기 카드를 만든다.
// (제목+설명만 있어도 카드가 만들어지므로 og:image 는 넣지 않는다)
export function buildEventMeta(event, shareUrl) {
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

// event.html 의 <head> 에 끼워 넣을 메타태그 문자열.
export function buildMetaTags(meta) {
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

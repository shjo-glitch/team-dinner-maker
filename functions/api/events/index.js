// POST /api/events - 새 약속 생성 (Cloudflare Pages Functions + D1)
const THEMES = ['weekday', 'weekend', 'both'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANAGE_PIN_RE = /^\d{4,6}$/;

function createManagePinSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashManagePin(pin, salt) {
  const encoded = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const title = String(body.title || '').trim();
  const totalCount = Number(body.totalCount);
  const theme = String(body.theme || '');

  if (!title || title.length > 60) {
    return Response.json({ error: '약속 이름은 1~60자로 입력해 주세요.' }, { status: 400 });
  }
  if (!Number.isInteger(totalCount) || totalCount < 2 || totalCount > 100) {
    return Response.json({ error: '총 인원은 2~100 사이의 숫자여야 합니다.' }, { status: 400 });
  }
  if (!THEMES.includes(theme)) {
    return Response.json({ error: '테마 값이 올바르지 않습니다.' }, { status: 400 });
  }

  const startDate = String(body.startDate || '');
  const endDate = String(body.endDate || '');
  const managePin = body.managePin == null ? '' : String(body.managePin);
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || endDate < startDate) {
    return Response.json({ error: '표시 범위가 올바르지 않습니다.' }, { status: 400 });
  }
  if ((new Date(endDate) - new Date(startDate)) / 86400000 > 370) {
    return Response.json({ error: '표시 범위는 최대 1년까지 지정할 수 있습니다.' }, { status: 400 });
  }
  if (!MANAGE_PIN_RE.test(managePin)) {
    return Response.json({ error: '관리 비밀번호는 숫자 4~6자리로 입력해 주세요.' }, { status: 400 });
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const managePinSalt = createManagePinSalt();
  const event = {
    id,
    title,
    totalCount,
    theme,
    startDate,
    endDate,
    managePinSalt,
    managePinHash: await hashManagePin(managePin, managePinSalt),
    deleteAuthFailures: 0,
    deleteLockedUntil: null,
    expireDate: null,
    createdAt: new Date().toISOString(),
    participants: [],
  };
  await env.DB.prepare('INSERT INTO events (id, data) VALUES (?1, ?2)').bind(id, JSON.stringify(event)).run();
  return Response.json({ id });
}

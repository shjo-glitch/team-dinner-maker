const MANAGE_PIN_RE = /^\d{4,6}$/;
const MAX_DELETE_ATTEMPTS = 5;
const DELETE_LOCK_MS = 3 * 60 * 1000;

function publicEvent(event) {
  const { managePinHash, managePinSalt, deleteAuthFailures, ...publicData } = event;
  return publicData;
}

async function hashManagePin(pin, salt) {
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

async function loadEvent(env, id) {
  const row = await env.DB.prepare('SELECT data FROM events WHERE id = ?1').bind(id).first();
  return row ? JSON.parse(row.data) : null;
}

async function saveEvent(env, event) {
  await env.DB.prepare('UPDATE events SET data = ?2 WHERE id = ?1').bind(event.id, JSON.stringify(event)).run();
}

// GET /api/events/:id - 약속 조회
export async function onRequestGet({ params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  return Response.json(publicEvent(event));
}

// DELETE /api/events/:id - 약속과 참여자 일정 전체 삭제
export async function onRequestDelete({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }
  const managePin = body.managePin == null ? '' : String(body.managePin);
  const now = Date.now();
  if (event.deleteLockedUntil && new Date(event.deleteLockedUntil).getTime() > now) {
    return Response.json({ error: '관리 비밀번호를 5회 틀려 3분 동안 약속 파기가 잠겼어요.', deleteLockedUntil: event.deleteLockedUntil }, { status: 429 });
  }
  if (!event.managePinHash || !event.managePinSalt) {
    return Response.json({ error: '관리 비밀번호가 설정되지 않은 이전 약속은 파기할 수 없어요.' }, { status: 409 });
  }

  const isValidPin = MANAGE_PIN_RE.test(managePin) && secureEqual(await hashManagePin(managePin, event.managePinSalt), event.managePinHash);
  if (!isValidPin) {
    const attempts = (event.deleteAuthFailures || 0) + 1;
    if (attempts >= MAX_DELETE_ATTEMPTS) {
      event.deleteAuthFailures = 0;
      event.deleteLockedUntil = new Date(now + DELETE_LOCK_MS).toISOString();
      await saveEvent(env, event);
      return Response.json({ error: '관리 비밀번호를 5회 틀려 3분 동안 약속 파기가 잠겼어요.', deleteLockedUntil: event.deleteLockedUntil }, { status: 429 });
    }
    event.deleteAuthFailures = attempts;
    event.deleteLockedUntil = null;
    await saveEvent(env, event);
    return Response.json({ error: `관리 비밀번호가 올바르지 않습니다. (${MAX_DELETE_ATTEMPTS - attempts}회 남음)` }, { status: 401 });
  }

  await env.DB.prepare('DELETE FROM events WHERE id = ?1').bind(params.id).run();
  return Response.json({ ok: true });
}

// PUT    /api/events/:id/participants        - 참여자 일정 등록/수정 (이름 기준 upsert)
// DELETE /api/events/:id/participants?name=x - 참여자 삭제
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function loadEvent(env, id) {
  const row = await env.DB.prepare('SELECT data FROM events WHERE id = ?1').bind(id).first();
  return row ? JSON.parse(row.data) : null;
}

async function saveEvent(env, event) {
  await env.DB.prepare('UPDATE events SET data = ?2 WHERE id = ?1').bind(event.id, JSON.stringify(event)).run();
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

export async function onRequestPut({ request, params, env }) {
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

  const name = String(body.name || '').trim();
  const dates = body.dates;
  if (!name || name.length > 20) {
    return Response.json({ error: '이름은 1~20자로 입력해 주세요.' }, { status: 400 });
  }
  if (!Array.isArray(dates) || dates.length > 366 || dates.some((d) => !DATE_RE.test(String(d)))) {
    return Response.json({ error: '날짜 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const entry = { name, dates: [...new Set(dates.map(String))].sort(), updatedAt: new Date().toISOString() };
  const idx = event.participants.findIndex((p) => p.name === name);
  if (idx >= 0) event.participants[idx] = entry;
  else {
    if (event.participants.length >= event.totalCount) {
      return Response.json({ error: `참여자는 총원 ${event.totalCount}명을 초과해 등록할 수 없습니다.` }, { status: 400 });
    }
    event.participants.push(entry);
  }

  refreshExpireDate(event);
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

export async function onRequestDelete({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  const name = String(new URL(request.url).searchParams.get('name') || '').trim();
  event.participants = event.participants.filter((p) => p.name !== name);
  refreshExpireDate(event);
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

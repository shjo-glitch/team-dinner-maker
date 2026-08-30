// PUT    /api/events/:id/participants        - 참여자 일정 등록/수정 (이름 기준 upsert)
// DELETE /api/events/:id/participants?name=x - 참여자 삭제
import { DATE_RE, loadEvent, publicEvent, readJson, refreshExpireDate, saveEvent } from '../../_shared.js';

export async function onRequestPut({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

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
  // 삭제된 참여자가 넣어둔 장소 투표도 함께 정리한다.
  for (const place of event.places || []) {
    if (Array.isArray(place.votes)) place.votes = place.votes.filter((voter) => voter !== name);
  }
  refreshExpireDate(event);
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

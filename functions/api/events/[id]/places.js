// POST   /api/events/:id/places                  - 후보 장소 등록
// PUT    /api/events/:id/places                  - 후보 장소 투표 토글
// DELETE /api/events/:id/places?placeId=...       - 후보 장소 삭제
import { MAX_PLACES, isSamePlace, loadEvent, publicEvent, readJson, saveEvent, validatePlaceInput } from '../../_shared.js';

// 장소 정하기는 일정 확정과 병행할 수 있다. (공유만 둘 다 확정된 뒤 가능)
async function loadPlaceEvent(env, id) {
  const event = await loadEvent(env, id);
  if (!event) {
    return { error: Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 }) };
  }
  if (!Array.isArray(event.places)) event.places = [];
  return { event };
}

export async function onRequestPost({ request, params, env }) {
  const { event, error } = await loadPlaceEvent(env, params.id);
  if (error) return error;

  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;

  const result = validatePlaceInput(parsed.body);
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  if (event.places.length >= MAX_PLACES) {
    return Response.json({ error: `후보 장소는 최대 ${MAX_PLACES}곳까지 등록할 수 있어요.` }, { status: 400 });
  }
  if (event.places.some((place) => isSamePlace(place, result.place))) {
    return Response.json({ error: '이미 등록된 장소예요.' }, { status: 400 });
  }

  event.places.push({
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    ...result.place,
    addedAt: new Date().toISOString(),
    votes: [],
  });
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

export async function onRequestPut({ request, params, env }) {
  const { event, error } = await loadPlaceEvent(env, params.id);
  if (error) return error;

  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;

  const place = event.places.find((candidate) => candidate.id === String(parsed.body.placeId || ''));
  if (!place) {
    return Response.json({ error: '후보 장소를 찾을 수 없습니다.' }, { status: 404 });
  }
  const name = String(parsed.body.name || '').trim();
  if (!event.participants.some((participant) => participant.name === name)) {
    return Response.json({ error: '참여자 이름을 선택한 뒤 투표해 주세요.' }, { status: 400 });
  }

  if (!Array.isArray(place.votes)) place.votes = [];
  const voted = place.votes.indexOf(name);
  if (voted >= 0) place.votes.splice(voted, 1);
  else place.votes.push(name);

  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

export async function onRequestDelete({ request, params, env }) {
  const { event, error } = await loadPlaceEvent(env, params.id);
  if (error) return error;

  const placeId = String(new URL(request.url).searchParams.get('placeId') || '');
  event.places = event.places.filter((place) => place.id !== placeId);
  // 확정된 장소가 지워졌으면 장소 확정도 함께 푼다.
  if (event.confirmedPlaceId === placeId) event.confirmedPlaceId = null;
  await saveEvent(env, event);
  return Response.json(publicEvent(event));
}

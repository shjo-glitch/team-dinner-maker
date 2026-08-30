// GET    /api/events/:id - 약속 조회
// DELETE /api/events/:id - 약속과 참여자 일정 전체 삭제
import { checkManagePin, loadEvent, publicEvent, readJson } from '../../_shared.js';

export async function onRequestGet({ params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  return Response.json(publicEvent(event));
}

export async function onRequestDelete({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }

  const { body, error } = await readJson(request);
  if (error) return error;

  const denied = await checkManagePin(env, event, body.managePin == null ? '' : String(body.managePin));
  if (denied) return denied;

  await env.DB.prepare('DELETE FROM events WHERE id = ?1').bind(params.id).run();
  return Response.json({ ok: true });
}

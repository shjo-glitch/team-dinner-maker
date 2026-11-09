// POST /api/events/:id/admin-auth - 관리자 메뉴 진입용 관리 비밀번호 확인 { managePin }
// 확정·파기와 같은 잠금 카운터를 쓴다. (여기서 틀린 횟수도 5회 잠금에 포함)
import { checkManagePin, loadEvent, readJson } from '../../_shared.js';

export async function onRequestPost({ request, params, env }) {
  const event = await loadEvent(env, params.id);
  if (!event) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  const { body, error } = await readJson(request);
  if (error) return error;

  const denied = await checkManagePin(env, event, body.managePin == null ? '' : String(body.managePin));
  if (denied) return denied;
  return Response.json({ ok: true });
}

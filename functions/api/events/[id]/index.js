// GET /api/events/:id - 약속 조회
export async function onRequestGet({ params, env }) {
  const row = await env.DB.prepare('SELECT data FROM events WHERE id = ?1').bind(params.id).first();
  if (!row) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  return new Response(row.data, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// DELETE /api/events/:id - 약속과 참여자 일정 전체 삭제
export async function onRequestDelete({ params, env }) {
  const result = await env.DB.prepare('DELETE FROM events WHERE id = ?1').bind(params.id).run();
  if (!result.meta.changes) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  return Response.json({ ok: true });
}

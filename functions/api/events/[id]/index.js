// GET /api/events/:id - 약속 조회
export async function onRequestGet({ params, env }) {
  const row = await env.DB.prepare('SELECT data FROM events WHERE id = ?1').bind(params.id).first();
  if (!row) {
    return Response.json({ error: '약속을 찾을 수 없습니다.' }, { status: 404 });
  }
  return new Response(row.data, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

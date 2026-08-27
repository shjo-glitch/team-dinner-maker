function koreaDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default {
  async fetch() {
    return new Response('Not found', { status: 404 });
  },

  // Cron Trigger: 매일 15:00 UTC = 한국 시간 00:00
  async scheduled(controller, env) {
    const today = koreaDate(controller.scheduledTime);
    const result = await env.DB.prepare(
      "DELETE FROM events WHERE json_extract(data, '$.expireDate') IS NOT NULL AND json_extract(data, '$.expireDate') <= ?1"
    )
      .bind(today)
      .run();
    console.log(`Expired events removed for ${today}: ${result.meta.changes || 0}`);
  },
};

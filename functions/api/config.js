// GET /api/config - 클라이언트에 필요한 공개 설정
// 지도 키는 브라우저에 노출되는 값이라 NCP 콘솔의 "서비스 URL"(도메인) 등록으로 보호한다.
// 검색 시크릿은 절대 내려보내지 않고, 사용 가능 여부만 알린다.
export function onRequestGet({ env }) {
  return Response.json({
    naverMapKeyId: env.NAVER_MAP_KEY_ID || '',
    placeSearchEnabled: Boolean(env.NAVER_SEARCH_KEY_ID && env.NAVER_SEARCH_KEY),
    // 카카오 JavaScript 키. 브라우저 노출용이며 카카오 콘솔의 도메인 등록으로 보호된다.
    kakaoJsKey: env.KAKAO_JS_KEY || '',
  });
}

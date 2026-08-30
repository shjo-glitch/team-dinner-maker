'use strict';

// 네이버 지도(NCP Maps JS API v3) 로더 + 후보지 핀 렌더러.
// 지도 키가 없거나 도메인 등록이 안 돼 있어도 후보지 목록과 투표는 그대로 쓸 수 있도록,
// 실패는 지도 영역의 안내 문구로만 알린다.

const NAVER_MAPS_SRC = 'https://oapi.map.naver.com/openapi/v3/maps.js';
const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9784 }; // 서울시청

let mapsLoadPromise = null;

function loadNaverMaps(keyId) {
  if (mapsLoadPromise) return mapsLoadPromise;
  mapsLoadPromise = new Promise((resolve, reject) => {
    if (!keyId) {
      reject(new Error('지도 키가 설정되지 않아 지도를 표시할 수 없어요. 후보지 목록과 투표는 그대로 사용할 수 있어요.'));
      return;
    }
    const script = document.createElement('script');
    script.src = `${NAVER_MAPS_SRC}?ncpKeyId=${encodeURIComponent(keyId)}`;
    script.async = true;
    script.onload = () => {
      if (window.naver && window.naver.maps) resolve(window.naver.maps);
      else reject(new Error('지도를 불러오지 못했어요.'));
    };
    script.onerror = () => reject(new Error('지도 스크립트를 불러오지 못했어요. 네트워크 상태를 확인해 주세요.'));
    document.head.appendChild(script);
  });
  return mapsLoadPromise;
}

class PlaceMap {
  constructor(container, { onSelect, onAuthFailure } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onAuthFailure = onAuthFailure;
    this.maps = null;
    this.map = null;
    this.markers = [];
  }

  async init(keyId) {
    // 키가 틀리거나 서비스 URL이 등록되지 않으면 스크립트는 정상 로드되고
    // 이 전역 콜백으로만 실패를 알려준다. (스크립트 로드 전에 걸어둬야 한다)
    window.navermap_authFailure = () => {
      if (this.onAuthFailure) {
        this.onAuthFailure('지도 키 인증에 실패했어요. NCP 콘솔에서 이 주소가 서비스 URL로 등록됐는지 확인해 주세요.');
      }
    };
    const maps = await loadNaverMaps(keyId);
    this.maps = maps;
    this.map = new maps.Map(this.container, {
      center: new maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
      zoom: 13,
      scaleControl: false,
      mapDataControl: false,
      logoControlOptions: { position: maps.Position.BOTTOM_LEFT },
    });
  }

  // 목록과 같은 순서를 핀 번호로 쓰고, 득표 1위(place.isTop)만 골드로 강조한다.
  setPlaces(places) {
    if (!this.map) return;
    this.markers.forEach((marker) => marker.setMap(null));
    this.markers = places.map((place, index) => {
      const marker = new this.maps.Marker({
        map: this.map,
        position: new this.maps.LatLng(place.lat, place.lng),
        title: place.name,
        icon: {
          content: `<span class="map-pin${place.isTop ? ' map-pin-top' : ''}">${index + 1}</span>`,
          anchor: new this.maps.Point(15, 36),
        },
      });
      this.maps.Event.addListener(marker, 'click', () => this.onSelect && this.onSelect(place.id));
      return marker;
    });
    this.fitTo(places);
  }

  fitTo(places) {
    if (!this.map || places.length === 0) return;
    if (places.length === 1) {
      this.map.setCenter(new this.maps.LatLng(places[0].lat, places[0].lng));
      this.map.setZoom(16);
      return;
    }
    const bounds = new this.maps.LatLngBounds();
    for (const place of places) bounds.extend(new this.maps.LatLng(place.lat, place.lng));
    this.map.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 });
  }
}

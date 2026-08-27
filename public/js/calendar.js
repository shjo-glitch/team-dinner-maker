// 달력 컴포넌트.
// 약속의 표시 범위(startDate~endDate)에 포함된 모든 달을 수직으로 이어서 렌더링한다.
// mode: 'select' — 참여자가 가능한 날짜를 클릭/드래그(+스크롤)로 선택
// mode: 'result' — 인원수에 따라 뱃지(#7A1025)의 알파값이 진해지는 결과 화면
'use strict';

const CAL_BADGE_RGB = '122, 16, 37'; // #7A1025
const CAL_DOW_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

function calFmt(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function calToday() {
  const t = new Date();
  return calFmt(t.getFullYear(), t.getMonth(), t.getDate());
}

class Calendar {
  /**
   * @param {HTMLElement} el 달력을 그릴 컨테이너
   * @param {object} opts
   *   startDate, endDate: 'YYYY-MM-DD' 표시/선택 가능 범위
   *   theme: 'weekday' | 'weekend' | 'both'
   *   mode: 'select' | 'result'
   *   onChange(selectedSet)  select 모드에서 선택이 바뀔 때
   *   onDateClick(dateStr)   result 모드에서 날짜를 눌렀을 때
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.theme = opts.theme || 'both';
    this.mode = opts.mode || 'select';
    this.startDate = opts.startDate;
    this.endDate = opts.endDate;
    this.onChange = opts.onChange || null;
    this.onDateClick = opts.onDateClick || null;

    this.selected = new Set(); // select 모드: 'YYYY-MM-DD'
    this.counts = {}; // result 모드: dateStr -> 선택 인원수
    this.totalCount = 1; // result 모드: 총원 (알파 = count / totalCount)

    this.drag = null; // {anchor, current, mode: 'paint'|'erase'}
    this.lastX = 0;
    this.lastY = 0;
    this._raf = null;
    this._bindEvents();
  }

  isWeekend(dow) {
    return dow === 0 || dow === 6;
  }

  themeAllows(dow) {
    if (this.theme === 'weekday') return !this.isWeekend(dow);
    if (this.theme === 'weekend') return this.isWeekend(dow);
    return true;
  }

  inRange(dateStr) {
    return dateStr >= this.startDate && dateStr <= this.endDate;
  }

  isSelectable(dateStr, dow) {
    return this.inRange(dateStr) && dateStr >= calToday() && this.themeAllows(dow);
  }

  setSelected(dates) {
    this.selected = new Set(dates);
    this.render();
  }

  setResult(counts, totalCount) {
    this.counts = counts;
    this.totalCount = Math.max(1, totalCount);
    this.render();
  }

  render() {
    const [sy, sm] = this.startDate.split('-').map(Number);
    const [ey, em] = this.endDate.split('-').map(Number);
    let html = '';
    for (let ym = sy * 12 + (sm - 1); ym <= ey * 12 + (em - 1); ym++) {
      html += this._renderMonth(Math.floor(ym / 12), ym % 12);
    }
    this.el.innerHTML = html;
    this._applyPreview();
  }

  _renderMonth(y, m) {
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const maxCount = Math.max(0, ...Object.values(this.counts));

    let html = `
      <div class="cal-month" data-month="${y}-${String(m + 1).padStart(2, '0')}">
        <div class="cal-month-title">${y}년 ${m + 1}월</div>
        <div class="cal-grid">`;

    for (let i = 0; i < 7; i++) {
      html += `<div class="cal-dow dow-${i}">${CAL_DOW_NAMES[i]}</div>`;
    }
    for (let i = 0; i < firstDow; i++) {
      html += '<div class="cal-cell empty"></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dow = (firstDow + d - 1) % 7;
      const dateStr = calFmt(y, m, d);
      const holiday = KR_HOLIDAYS[dateStr];
      const selectable = this.isSelectable(dateStr, dow);

      const classes = ['cal-cell', `dow-${dow}`];
      if (holiday) classes.push('holiday-cell');
      if (!this.inRange(dateStr)) classes.push('out-range');
      let badgeStyle = '';
      let countHtml = '';

      if (this.mode === 'select') {
        if (!selectable) classes.push('disabled');
        if (this.selected.has(dateStr)) classes.push('selected');
      } else {
        const count = this.counts[dateStr] || 0;
        if (count > 0) {
          const alpha = Math.min(1, count / this.totalCount);
          classes.push('has-count');
          if (alpha >= 0.45) classes.push('badge-light-text');
          if (count === maxCount) classes.push('top-pick'); // 공동 1등 포함 노란 테두리
          badgeStyle = ` style="background: rgba(${CAL_BADGE_RGB}, ${alpha.toFixed(3)})"`;
          countHtml = `<span class="cal-count">${count}명</span>`;
        }
        if (!this.themeAllows(dow)) classes.push('theme-off');
      }

      html += `
        <div class="${classes.join(' ')}" data-date="${dateStr}">
          <span class="cal-day"${badgeStyle}>${d}</span>
          ${holiday ? `<span class="cal-holiday">${holiday}</span>` : ''}
          ${countHtml}
        </div>`;
    }

    html += '</div></div>';
    return html;
  }

  _bindEvents() {
    if (this.mode === 'result') {
      this.el.addEventListener('click', (e) => {
        const cell = e.target.closest('.cal-cell[data-date]');
        if (cell && !cell.classList.contains('out-range') && this.onDateClick) {
          this.onDateClick(cell.dataset.date);
        }
      });
      return;
    }

    // 드래그 범위 선택: 누른 날짜(anchor)부터 포인터가 위치한 날짜(current)까지
    // 사이의 모든 선택 가능한 날짜를 범위로 칠하거나(paint) 지운다(erase).
    // 달이 수직으로 이어져 있으므로 화면 가장자리로 드래그하면 자동 스크롤되어
    // 여러 달에 걸친 연속 범위도 끊김 없이 선택할 수 있다.
    this.el.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cal-cell[data-date]');
      if (!cell || cell.classList.contains('disabled')) return;
      e.preventDefault();
      const date = cell.dataset.date;
      this.drag = {
        anchor: date,
        current: date,
        mode: this.selected.has(date) ? 'erase' : 'paint',
      };
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this._applyPreview();
      this._autoScroll();
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this._updateFromPoint();
    });

    // 드래그 중 휠/트랙패드로 스크롤해도 포인터 아래의 날짜를 계속 따라간다.
    window.addEventListener(
      'scroll',
      () => {
        if (this.drag) this._updateFromPoint();
      },
      { passive: true }
    );

    window.addEventListener('pointerup', () => {
      if (!this.drag) return;
      const range = this._rangeDates(this.drag.anchor, this.drag.current);
      for (const dateStr of range) {
        if (this.drag.mode === 'paint') this.selected.add(dateStr);
        else this.selected.delete(dateStr);
      }
      this._stopDrag();
      this.render();
      if (this.onChange) this.onChange(this.selected);
    });

    window.addEventListener('pointercancel', () => {
      if (!this.drag) return;
      this._stopDrag();
      this.render();
    });
  }

  _stopDrag() {
    this.drag = null;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _updateFromPoint() {
    const target = document.elementFromPoint(this.lastX, this.lastY);
    const cell = target && target.closest('.cal-cell[data-date]');
    if (!cell || !this.el.contains(cell)) return;
    if (cell.dataset.date !== this.drag.current) {
      this.drag.current = cell.dataset.date;
      this._applyPreview();
    }
  }

  // 드래그 중 화면 상/하단 가장자리에 가까워지면 자동으로 스크롤
  _autoScroll() {
    if (!this.drag) return;
    const margin = 90;
    let dy = 0;
    if (this.lastY > window.innerHeight - margin) {
      dy = Math.ceil((this.lastY - (window.innerHeight - margin)) / 4);
    } else if (this.lastY < margin) {
      dy = -Math.ceil((margin - this.lastY) / 4);
    }
    if (dy) {
      window.scrollBy(0, dy);
      this._updateFromPoint();
    }
    this._raf = requestAnimationFrame(() => this._autoScroll());
  }

  // anchor~current 사이의 (범위/테마/과거 제외) 선택 가능한 날짜 목록
  _rangeDates(a, b) {
    const [start, end] = a <= b ? [a, b] : [b, a];
    const result = [];
    const cur = new Date(start + 'T00:00:00');
    const last = new Date(end + 'T00:00:00');
    while (cur <= last) {
      const dateStr = calFmt(cur.getFullYear(), cur.getMonth(), cur.getDate());
      if (this.isSelectable(dateStr, cur.getDay())) result.push(dateStr);
      cur.setDate(cur.getDate() + 1);
    }
    return result;
  }

  _applyPreview() {
    const cells = this.el.querySelectorAll('.cal-cell[data-date]');
    if (!this.drag) {
      cells.forEach((c) => c.classList.remove('preview-paint', 'preview-erase'));
      return;
    }
    const range = new Set(this._rangeDates(this.drag.anchor, this.drag.current));
    const cls = this.drag.mode === 'paint' ? 'preview-paint' : 'preview-erase';
    cells.forEach((c) => {
      c.classList.remove('preview-paint', 'preview-erase');
      if (range.has(c.dataset.date)) c.classList.add(cls);
    });
  }
}

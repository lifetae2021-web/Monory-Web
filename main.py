from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import sqlite3
import os
from datetime import datetime

app = FastAPI()

# 프론트엔드와의 통신 에러(CORS)를 방지하는 가장 좋은 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class Reservation(BaseModel):
    name: str
    date: str
    start_time: str
    end_time: str
    amount: int

def init_db():
    conn = sqlite3.connect("monory.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS reservations 
        (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, date TEXT, start_time TEXT, end_time TEXT, amount INTEGER)
    """)
    # 기존 테이블에 컬럼 추가 시도 (에러 무시)
    try:
        cursor.execute("ALTER TABLE reservations ADD COLUMN end_time TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    try:
        cursor.execute("ALTER TABLE reservations ADD COLUMN amount INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()

init_db()

# ── 로컬 개발 편의: 파일을 저장하면 브라우저가 자동으로 새로고침되게 한다 ──
# (이 서버는 로컬 확인용이며 Firebase Hosting 배포에는 포함되지 않는다)
NO_CACHE = {"Cache-Control": "no-store"}
WATCH_EXT = (".html", ".css", ".js")

def _mtimes() -> str:
    """css / html / js 파일의 마지막 수정 시각을 각각 돌려준다."""
    latest = {".css": 0.0, ".html": 0.0, ".js": 0.0}
    for name in os.listdir("."):
        for ext in latest:
            if name.endswith(ext):
                latest[ext] = max(latest[ext], os.path.getmtime(name))
    return f'{latest[".css"]},{latest[".html"]},{latest[".js"]}'

# 파일이 바뀌면 화면을 그대로 둔 채 바뀐 부분만 반영한다.
#  - CSS      : 스타일시트만 다시 불러온다 (화면 상태 유지)
#  - HTML     : 바뀐 요소만 교체하고, 입력값·열린 팝업·스크롤은 그대로 둔다
#  - JS/구조  : 전체 새로고침하되 열린 팝업·입력값·스크롤을 복원한다
DEV_RELOAD_SNIPPET = r"""
<script>
(function () {
    var SKIP = '__dev/mtime', last = null, prevDoc = null, busy = false;
    function parse(t) { return new DOMParser().parseFromString(t, 'text/html'); }
    function fetchDoc() { return fetch(location.pathname + location.search, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(parse); }
    function scriptsSig(doc) {
        return Array.prototype.map.call(doc.querySelectorAll('script'), function (s) {
            return (s.textContent || '').indexOf(SKIP) > -1 ? '' : (s.getAttribute('src') || '') + '|' + (s.textContent || '');
        }).join('\u0001');
    }
    function ownSig(el) {
        var c = el.cloneNode(true);
        Array.prototype.forEach.call(c.querySelectorAll('[id]'), function (d) {
            var p = document.createElement('i'); p.setAttribute('data-ph', d.id); d.replaceWith(p);
        });
        return c.outerHTML;
    }

    // ── 화면 상태 저장/복원 (전체 새로고침이 필요할 때) ──
    // 예약 팝업 안에서 작업 중이던 상태(날짜·이용 방식·시간 선택·입력값·스크롤)를 그대로 되살린다
    function captureState() {
        var st = { ts: Date.now(), vals: {}, open: [], step2: false, scroll: {} };
        Array.prototype.forEach.call(document.querySelectorAll('input[id], textarea[id], select[id]'), function (el) {
            st.vals[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
        });
        Array.prototype.forEach.call(document.querySelectorAll('.modal-overlay.active'), function (el) { if (el.id) st.open.push(el.id); });
        var bm = document.getElementById('bookingModal');
        if (bm && /flex|block/.test(getComputedStyle(bm).display) && st.open.indexOf('bookingModal') < 0) st.open.push('bookingModal');
        var inner = document.getElementById('booking-steps-inner'); st.step2 = !!(inner && inner.classList.contains('step-2'));
        try {
            if (typeof selectedDateObj !== 'undefined' && selectedDateObj) st.date = [selectedDateObj.getFullYear(), selectedDateObj.getMonth(), selectedDateObj.getDate()];
            if (typeof currentReservationMode !== 'undefined') st.mode = currentReservationMode;
            if (typeof hourlySelection !== 'undefined') st.hourly = { start: hourlySelection.start, end: hourlySelection.end };
            if (typeof currentBookingType !== 'undefined') st.btype = currentBookingType;
        } catch (e) {}
        var mc = document.querySelector('.booking-modal-container'); if (mc) st.scroll.modal = mc.scrollTop;
        st.scroll.page = window.scrollY;
        return st;
    }
    function saveState() {
        var st = captureState();
        try { sessionStorage.setItem('__devState', JSON.stringify(st)); } catch (e) {}
    }
    // 쿠폰 목록은 서버에서 늦게(그리고 여러 번) 불러오므로, 목록이 생긴 뒤에 선택을 되살리고
    // 목록이 다시 그려져 선택이 풀리면 몇 초 동안 다시 적용한 뒤 금액을 다시 계산한다
    function restoreCoupon(val) {
        if (!val || val === 'none') return;
        var n = 0;
        (function wait() {
            var el = document.getElementById('booking-coupon');
            var has = el && Array.prototype.some.call(el.options, function (o) { return o.value === val; });
            if (!has && n % 25 === 5 && typeof loadMyCoupons === 'function') { try { loadMyCoupons(); } catch (e) {} } // 로그인 복원 전에 조회가 끝났다면 다시 불러온다
            if (has && el.value !== val) { el.value = val; if (typeof calculatePrice === 'function') calculatePrice(); }
            if (n++ < 150) setTimeout(wait, 100);
        })();
    }
    function restoreState() {
        var raw; try { raw = sessionStorage.getItem('__devState'); sessionStorage.removeItem('__devState'); } catch (e) {}
        if (!raw) return; var st; try { st = JSON.parse(raw); } catch (e) { return; }
        if (Date.now() - st.ts > 20000) return;
        applyState(st, false);
    }
    // soft=true: 화면 일부만 새로 갈아 끼운 직후. 팝업은 이미 열려 있으므로 다시 열지 않고,
    // 갈아 끼우면서 초기값(0원 등)으로 돌아간 계산 결과·달력·시간표를 현재 선택 상태로 다시 그린다
    function applyState(st, soft) {
        var tries = 0;
        (function go() {
            // 페이지 스크립트가 준비될 때까지 기다렸다가 한 번에 복원
            var ready = document.getElementById('calendar-grid') && (typeof openModal === 'function') && (typeof renderCalendar === 'function');
            if (!ready && tries++ < 60) { setTimeout(go, 100); return; }
            try {
                if (!soft) (st.open || []).forEach(function (id) { try { openModal(id); } catch (e) {} });
                if (st.date) {
                    var y = st.date[0], m = st.date[1], d = st.date[2];
                    try { currentCalDate = new Date(y, m, 1); renderCalendar(currentCalDate); } catch (e) {}
                    var cell = Array.prototype.find.call(document.querySelectorAll('.cal-day:not(.disabled)'), function (c) { return c.textContent.trim() === String(d); });
                    if (cell) cell.click();
                }
                if (st.btype && typeof setBookingType === 'function') setBookingType(st.btype);
                if (st.mode && typeof setReservationMode === 'function') setReservationMode(st.mode);
                ['booking-package', 'guest-count', 'review-promise', 'opt-partition', 'opt-cleaning'].forEach(function (id) {
                    var el = document.getElementById(id); if (!el || !(id in st.vals)) return;
                    if (el.type === 'checkbox') el.checked = st.vals[id]; else el.value = st.vals[id];
                });
                if (st.hourly && typeof hourlySelection !== 'undefined') {
                    hourlySelection.start = st.hourly.start; hourlySelection.end = st.hourly.end;
                    if (typeof renderHourlyTimeline === 'function') renderHourlyTimeline();
                }
                if (typeof calculatePrice === 'function') calculatePrice();
                restoreCoupon(st.vals['booking-coupon']);
                var inner = document.getElementById('booking-steps-inner');
                if (st.step2 && inner) { inner.classList.add('step-2'); var t = document.getElementById('booking-modal-title'); if (t) t.textContent = '예약자 정보 입력'; }
                if (!soft) Object.keys(st.vals || {}).forEach(function (id) {
                    var el = document.getElementById(id); if (!el || id === 'booking-coupon') return;
                    if (el.type === 'checkbox' || el.type === 'radio') el.checked = st.vals[id]; else el.value = st.vals[id];
                });
            } catch (e) {}
            // 팝업 안 내용이 그려진 뒤 스크롤 위치 복원
            [150, 500, 1100].forEach(function (ms) {
                setTimeout(function () {
                    var mc = document.querySelector('.booking-modal-container'); if (mc && st.scroll) mc.scrollTop = st.scroll.modal || 0;
                    if (!soft && st.scroll) window.scrollTo(0, st.scroll.page || 0);
                }, ms);
            });
        })();
    }
    function fullReload() { saveState(); location.reload(); }

    // ── CSS 만 교체 ──
    function swapCss() {
        Array.prototype.forEach.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) {
            var href = l.getAttribute('href'); if (!href || /^https?:|^\/\//.test(href)) return;
            var nh = href.replace(/([?&])_t=\d+/, '').replace(/[?&]$/, '') + (href.indexOf('?') > -1 ? '&' : '?') + '_t=' + Date.now();
            var n = l.cloneNode(); n.setAttribute('href', nh);
            n.onload = function () { l.remove(); };
            l.parentNode.insertBefore(n, l.nextSibling);
        });
    }

    // ── HTML 바뀐 요소만 교체 ──
    function patchHtml() {
        return fetchDoc().then(function (newDoc) {
            if (!prevDoc) { prevDoc = newDoc; return; }
            if (scriptsSig(prevDoc) !== scriptsSig(newDoc)) { fullReload(); return; }
            // id 없는 영역이 바뀐 경우는 부분 교체가 어려워 전체 새로고침
            if (ownSig(prevDoc.body) !== ownSig(newDoc.body)) { fullReload(); return; }
            var changed = [];
            Array.prototype.forEach.call(newDoc.querySelectorAll('[id]'), function (n) {
                var o = prevDoc.getElementById(n.id);
                if (!o || ownSig(o) !== ownSig(n)) changed.push(n.id);
            });
            var removed = [];
            Array.prototype.forEach.call(prevDoc.querySelectorAll('[id]'), function (o) { if (!newDoc.getElementById(o.id)) removed.push(o.id); });
            if (removed.length) { fullReload(); return; }
            var set = {}; changed.forEach(function (id) { set[id] = true; });
            var before = changed.length ? captureState() : null;
            for (var i = 0; i < changed.length; i++) {
                var id = changed[i], live = document.getElementById(id), fresh = newDoc.getElementById(id);
                if (!live || !fresh) { fullReload(); return; }
                var imp = document.importNode(fresh, true);
                var liveKids = {};
                Array.prototype.forEach.call(live.querySelectorAll('[id]'), function (d) { liveKids[d.id] = d; });
                Array.prototype.forEach.call(imp.querySelectorAll('[id]'), function (d) {
                    if (!imp.contains(d) || set[d.id] || !liveKids[d.id]) return;
                    d.replaceWith(liveKids[d.id]);
                });
                // 입력 중이던 값은 유지
                var vals = {};
                Array.prototype.forEach.call(live.querySelectorAll('input[id], textarea[id], select[id]'), function (el) {
                    vals[el.id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
                });
                live.replaceWith(imp);
                Object.keys(vals).forEach(function (k) {
                    var el = document.getElementById(k); if (!el || set[k]) return;
                    if (el.type === 'checkbox' || el.type === 'radio') el.checked = vals[k]; else el.value = vals[k];
                });
            }
            prevDoc = newDoc;
            if (before) applyState(before, true);
        }).catch(function () { fullReload(); });
    }

    function check() {
        if (busy) return;
        fetch('/__dev/mtime', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
            var cur = t.split(',');
            if (last === null) { last = cur; return; }
            var cssChanged = cur[0] !== last[0], htmlChanged = cur[1] !== last[1], jsChanged = cur[2] !== last[2];
            last = cur;
            if (jsChanged) { fullReload(); return; }
            if (cssChanged) swapCss();
            if (htmlChanged) { busy = true; patchHtml().then(function () { busy = false; }); }
        }).catch(function () {});
    }
    restoreState();
    window.addEventListener('load', function () { fetchDoc().then(function (d) { prevDoc = d; }); });
    check(); setInterval(check, 800);
})();
</script>
"""

def html_response(path: str):
    with open(path, encoding="utf-8") as f:
        html = f.read()
    if "</body>" in html:
        html = html.replace("</body>", DEV_RELOAD_SNIPPET + "</body>", 1)
    else:
        html += DEV_RELOAD_SNIPPET
    return Response(content=html, media_type="text/html; charset=utf-8", headers=NO_CACHE)

@app.get("/__dev/mtime")
def dev_mtime():
    return Response(content=_mtimes(), media_type="text/plain", headers=NO_CACHE)

# 브라우저 접속 시 index.html 화면을 바로 띄워줌
@app.get("/")
def read_root():
    return html_response("index.html")

# 2024년 대한민국 공휴일 (대체공휴일 포함)
PUBLIC_HOLIDAYS_2024 = {
    '2024-01-01',  # 신정
    '2024-02-09',  # 설날 연휴
    '2024-02-10',  # 설날
    '2024-02-11',  # 설날 연휴
    '2024-02-12',  # 대체공휴일
    '2024-03-01',  # 삼일절
    '2024-04-10',  # 제22대 국회의원 선거
    '2024-05-05',  # 어린이날
    '2024-05-06',  # 대체공휴일
    '2024-05-15',  # 부처님오신날
    '2024-06-06',  # 현충일
    '2024-08-15',  # 광복절
    '2024-09-16',  # 추석 연휴
    '2024-09-17',  # 추석
    '2024-09-18',  # 추석 연휴
    '2024-10-03',  # 개천절
    '2024-10-09',  # 한글날
    '2024-12-25',  # 성탄절
}

def get_hourly_price(date_str: str) -> int:
    """날짜에 따라 시간당 가격을 반환합니다 (주말/공휴일: 30000, 평일: 20000)"""
    try:
        date_obj = datetime.strptime(date_str, "%Y-%m-%d").date()
        # 주말(토:5, 일:6) 확인
        if date_obj.weekday() >= 5 or date_str in PUBLIC_HOLIDAYS_2024:
            return 30000
        return 20000
    except ValueError:
        # 날짜 형식이 잘못된 경우 기본 평일 가격 반환
        return 20000

@app.post("/reserve")
def make_reservation(res: Reservation):
    try:
        start_dt = datetime.strptime(res.start_time, "%H:%M")
        end_dt = datetime.strptime(res.end_time, "%H:%M")
        diff_hours = (end_dt - start_dt).total_seconds() / 3600
        if diff_hours <= 0:
            raise ValueError("종료 시간이 시작 시간보다 늦어야 합니다.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    conn = sqlite3.connect("monory.db")
    cursor = conn.cursor()

    cursor.execute("""
        SELECT id FROM reservations 
        WHERE date = ? AND (start_time < ? AND end_time > ?)
    """, (res.date, res.end_time, res.start_time))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=409, detail="이미 해당 시간에 예약이 존재합니다.")

    cursor.execute("INSERT INTO reservations (name, date, start_time, end_time, amount) VALUES (?, ?, ?, ?, ?)",
                   (res.name, res.date, res.start_time, res.end_time, res.amount))
    conn.commit()
    conn.close()
    return {"status": "success", "message": f"{res.name}님 예약 완료! 결제 금액: {res.amount:,}원"}

@app.get("/list")
def list_reservations():
    conn = sqlite3.connect("monory.db")
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM reservations")
    rows = cursor.fetchall()
    conn.close()
    return {"reservations": rows}

@app.get("/booked-times/{date}")
def get_booked_times(date: str):
    conn = sqlite3.connect("monory.db")
    cursor = conn.cursor()
    cursor.execute("SELECT start_time, end_time FROM reservations WHERE date = ?", (date,))
    rows = cursor.fetchall()
    conn.close()
    
    booked_slots = []
    for start_time_str, end_time_str in rows:
        booked_slots.append({"start_time": start_time_str, "end_time": end_time_str})
    return {"booked_slots": booked_slots}

@app.get("/holidays")
def get_holidays():
    return list(PUBLIC_HOLIDAYS_2024)

@app.get("/admin")
def read_admin():
    return html_response("admin.html")

@app.get("/admin-data")
def get_admin_data():
    conn = sqlite3.connect("monory.db")
    cursor = conn.cursor()
    # 가장 최근 예약이 위로 올라오도록 내림차순(DESC) 정렬
    cursor.execute("SELECT * FROM reservations ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()
    return {"reservations": rows}

app.mount("/assets", StaticFiles(directory="assets"), name="assets")

# 로컬 개발용: Firebase Hosting 예약 경로(/__/firebase/*)를 운영 호스팅에서 그대로 가져온다.
# (주의) 로컬에서도 운영 Firebase(DB/Auth)에 연결되므로 읽기/쓰기가 실제 데이터에 반영된다.
_fb_cache = {}

@app.get("/__/firebase/{path:path}")
def firebase_reserved(path: str):
    if path not in _fb_cache:
        import ssl, urllib.request, urllib.error
        try:
            import certifi
            ctx = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            ctx = None
        try:
            with urllib.request.urlopen(f"https://monory-web.web.app/__/firebase/{path}", timeout=10, context=ctx) as r:
                _fb_cache[path] = (r.read(), r.headers.get_content_type())
        except urllib.error.URLError:
            raise HTTPException(status_code=404, detail="Firebase file not found")
    body, ctype = _fb_cache[path]
    return Response(content=body, media_type=ctype)

@app.get("/{filename}.css")
def get_css(filename: str):
    if os.path.exists(f"{filename}.css"):
        return FileResponse(f"{filename}.css", headers=NO_CACHE)
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/{filename}.html")
def get_html(filename: str):
    if os.path.exists(f"{filename}.html"):
        return html_response(f"{filename}.html")
    raise HTTPException(status_code=404, detail="File not found")

@app.get("/{filename}.js")
def get_js(filename: str):
    if os.path.exists(f"{filename}.js"):
        return FileResponse(f"{filename}.js", headers=NO_CACHE)
    raise HTTPException(status_code=404, detail="File not found")
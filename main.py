from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import sqlite3
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

# 브라우저 접속 시 index.html 화면을 바로 띄워줌
@app.get("/")
def read_root():
    return FileResponse("index.html")

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
    return FileResponse("admin.html")

@app.get("/admin-data")
def get_admin_data():
    conn = sqlite3.connect("monory.db")
    cursor = conn.cursor()
    # 가장 최근 예약이 위로 올라오도록 내림차순(DESC) 정렬
    cursor.execute("SELECT * FROM reservations ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()
    return {"reservations": rows}
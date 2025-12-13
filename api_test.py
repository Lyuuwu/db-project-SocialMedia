import os
import re
from typing import Any, Dict
from dotenv import load_dotenv

import bcrypt
import pyodbc
from flask import Flask, jsonify, request

load_dotenv()

def build_conn_str() -> str:
    driver = os.environ['DRIVER']
    server = os.environ['SERVER']
    database = os.environ['DATABASE']
    uid = os.environ['UID']
    pwd = os.environ['PWD']
    encrypt = os.environ['ENCRYPT']
    
    conn_str = (
        f'DRIVER={{{driver}}};'
        f'SERVER={server};'
        f'DATABASE={database};'
        f'UID={uid};'
        f'PWD={pwd};'
        f'Encrypt={encrypt};'
    )
    
    return conn_str

CONN_STR = build_conn_str()

app = Flask(__name__)

def get_conn() -> pyodbc.Connection:
    return pyodbc.connect(CONN_STR, timeout=5)

def is_valid_email(email: str) -> bool:
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email))

@app.get("/db_test")
def db_test():
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT @@SERVERNAME, DB_NAME(), SUSER_SNAME()")
            server_name, db_name, login_name = cur.fetchone()
        return jsonify({"ok": True, "server": server_name, "db": db_name, "login": login_name})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    
@app.post("/api/register")
def register():
    """
    註冊：POST JSON
    {
      "email": "...",
      "password": "...",
      "user_name": "...",
      "bio": "...",          (optional)
      "profile_pic": "..."   (optional)
    }
    """
    data: Dict[str, Any] = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    user_name = (data.get("user_name") or "").strip()
    bio = data.get("bio")
    profile_pic = data.get("profile_pic")

    if not email or not password or not user_name:
        return jsonify({"ok": False, "error": "email/password/user_name are required"}), 400
    if not is_valid_email(email):
        return jsonify({"ok": False, "error": "invalid email"}), 400
    if len(user_name) > 50:
        return jsonify({"ok": False, "error": "user_name too long"}), 400
    if len(password) < 6:
        return jsonify({"ok": False, "error": "password too short (>=6)"}), 400

    # bcrypt hash 後存進 users.pwd
    pwd_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 先檢查 email / user_name 是否已存在
            cur.execute("SELECT 1 FROM dbo.users WHERE Email = ?", (email,))
            if cur.fetchone():
                return jsonify({"ok": False, "error": "email already exists"}), 409

            cur.execute("SELECT 1 FROM dbo.users WHERE user_name = ?", (user_name,))
            if cur.fetchone():
                return jsonify({"ok": False, "error": "user_name already exists"}), 409

            # 新增
            cur.execute(
                """
                INSERT INTO dbo.[users] (Email, pwd, bio, profile_pic, user_name)
                OUTPUT INSERTED.user_id
                VALUES (?, ?, ?, ?, ?);
                """,
                (email, pwd_hash, bio, profile_pic, user_name),
            )

            row = cur.fetchone()
            new_id = int(row[0])
            conn.commit()
        
        return jsonify({"ok": True, "user_id": new_id}), 201

    except pyodbc.IntegrityError as e:
        # 若你保留 UQ_users_pwd unique(pwd) 或其他 unique，可能會跑到這裡
        return jsonify({"ok": False, "error": f"integrity error: {str(e)}"}), 409
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    
@app.post("/api/login")
def login():
    """
    登入：POST JSON
    { "email": "...", "password": "..." }
    """
    data: Dict[str, Any] = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip()
    password = data.get("password") or ""

    if not email or not password:
        return jsonify({"ok": False, "error": "email/password are required"}), 400

    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT user_id, pwd, user_name FROM dbo.users WHERE Email = ?", (email,))
            row = cur.fetchone()

        if not row:
            return jsonify({"ok": False, "error": "invalid credentials"}), 401

        user_id, stored_hash, user_name = row[0], row[1], row[2]
        ok = bcrypt.checkpw(password.encode("utf-8"), str(stored_hash).encode("utf-8"))

        if not ok:
            return jsonify({"ok": False, "error": "invalid credentials"}), 401

        # 專題測試先回 user 資訊；正式系統會改成 session/JWT
        return jsonify({"ok": True, "user_id": int(user_id), "user_name": user_name}), 200

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500    

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
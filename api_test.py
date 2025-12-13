from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import bcrypt
import jwt
import pyodbc
from dotenv import load_dotenv
from flask import Flask, jsonify, request


SAFE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def api_error(
    http_status: int,
    code: str,
    message: str,
    details: Optional[List[Dict[str, str]]] = None,
):
    payload = {
        "error": {
            "code": code,
            "message": message,
            "details": details or [],
        }
    }
    return jsonify(payload), http_status


def build_conn_str() -> str:
    load_dotenv()

    driver = os.environ["DRIVER"]
    server = os.environ["SERVER"]
    database = os.environ["DATABASE"]
    uid = os.environ["UID"]
    pwd = os.environ["PWD"]
    encrypt = os.environ.get("ENCRYPT", "no")
    trust = os.environ.get("TRUST_SERVER_CERT", "yes")

    conn_str = (
        f"DRIVER={{{driver}}};"
        f"SERVER={server};"
        f"DATABASE={database};"
        f"UID={uid};"
        f"PWD={pwd};"
        f"Encrypt={encrypt};"
        f"TrustServerCertificate={trust};"
    )
    return conn_str


CONN_STR = build_conn_str()
API_PREFIX = "/api/v1"

JWT_SECRET = os.environ.get("JWT_SECRET", "change_me")
JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "120"))

DB_SCHEMA = os.environ.get("SCHEMA", "dbo")
if not SAFE_IDENT_RE.match(DB_SCHEMA):
    raise RuntimeError("Invalid SCHEMA in env. Use only letters/numbers/underscore.")


def tbl(name: str) -> str:
    if not SAFE_IDENT_RE.match(name):
        raise RuntimeError("Invalid table name.")
    return f"[{DB_SCHEMA}].[{name}]"


app = Flask(__name__)


def get_conn() -> pyodbc.Connection:
    return pyodbc.connect(CONN_STR, timeout=5)


def is_valid_email(email: str) -> bool:
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email))


def now_iso8601() -> str:
    # 合約說 ISO 8601；這裡用 +08:00
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz=tz).replace(microsecond=0).isoformat()


def make_user_json(row: Tuple[Any, ...]) -> Dict[str, Any]:
    # row: (user_id, Email, user_name, bio, profile_pic)
    return {
        "userId": int(row[0]),
        "email": row[1],
        "userName": row[2],
        "bio": row[3],
        "profilePic": row[4],
        # 你的 users table 沒有 createdAt 欄位，所以這裡先回傳伺服器時間
        # 若你之後加 users.created_at (datetime2 default sysdatetime)，改成查欄位回來即可
        "createdAt": now_iso8601(),
    }


def create_access_token(user_id: int) -> str:
    utc_now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": int(utc_now.timestamp()),
        "exp": int((utc_now + timedelta(minutes=JWT_EXPIRE_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def get_bearer_token() -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    if not auth:
        return None
    parts = auth.split(" ", 1)
    if len(parts) != 2:
        return None
    if parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def require_auth_user_id() -> int:
    token = get_bearer_token()
    if not token:
        raise PermissionError("missing_token")

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise PermissionError("token_expired")
    except jwt.InvalidTokenError:
        raise PermissionError("invalid_token")

    sub = payload.get("sub")
    if not sub:
        raise PermissionError("invalid_token")

    try:
        return int(sub)
    except ValueError:
        raise PermissionError("invalid_token")


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


# ---------------------------
# Auth
# ---------------------------

@app.post(f"{API_PREFIX}/auth/register")
def register_v1():
    data: Dict[str, Any] = request.get_json(silent=True) or {}

    email = (data.get("email") or "").strip()
    password = data.get("password") or ""
    user_name = (data.get("userName") or "").strip()

    details: List[Dict[str, str]] = []
    if not email:
        details.append({"field": "email", "reason": "required"})
    elif not is_valid_email(email):
        details.append({"field": "email", "reason": "invalid_format"})

    if not password:
        details.append({"field": "password", "reason": "required"})
    elif len(password) < 6:
        details.append({"field": "password", "reason": "too_short"})

    if not user_name:
        details.append({"field": "userName", "reason": "required"})
    elif len(user_name) > 50:
        details.append({"field": "userName", "reason": "too_long"})

    if details:
        return api_error(400, "VALIDATION_ERROR", "Invalid request body.", details)

    pwd_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # email unique
            cur.execute(f"SELECT 1 FROM {tbl('users')} WHERE Email = ?", (email,))
            if cur.fetchone():
                return api_error(409, "CONFLICT", "Email already used.", [{"field": "email", "reason": "already_used"}])

            # username unique
            cur.execute(f"SELECT 1 FROM {tbl('users')} WHERE user_name = ?", (user_name,))
            if cur.fetchone():
                return api_error(409, "CONFLICT", "UserName already used.", [{"field": "userName", "reason": "already_used"}])

            cur.execute(
                f"""
                INSERT INTO {tbl('users')} (Email, pwd, bio, profile_pic, user_name)
                OUTPUT INSERTED.user_id
                VALUES (?, ?, NULL, NULL, ?);
                """,
                (email, pwd_hash, user_name),
            )
            row = cur.fetchone()
            if not row or row[0] is None:
                conn.rollback()
                return api_error(500, "INTERNAL_ERROR", "Failed to create user.")
            new_id = int(row[0])
            conn.commit()

            # fetch user
            cur.execute(
                f"SELECT user_id, Email, user_name, bio, profile_pic FROM {tbl('users')} WHERE user_id = ?",
                (new_id,),
            )
            user_row = cur.fetchone()

        access_token = create_access_token(new_id)
        return jsonify({"accessToken": access_token, "user": make_user_json(user_row)}), 201

    except pyodbc.IntegrityError:
        return api_error(409, "CONFLICT", "Conflict.")
    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@app.post(f"{API_PREFIX}/auth/login")
def login_v1():
    data: Dict[str, Any] = request.get_json(silent=True) or {}

    email = (data.get("email") or "").strip()
    password = data.get("password") or ""

    if not email or not password:
        details = []
        if not email:
            details.append({"field": "email", "reason": "required"})
        if not password:
            details.append({"field": "password", "reason": "required"})
        return api_error(400, "VALIDATION_ERROR", "Invalid request body.", details)

    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT user_id, Email, user_name, bio, profile_pic, pwd FROM {tbl('users')} WHERE Email = ?",
                (email,),
            )
            row = cur.fetchone()

        if not row:
            return api_error(401, "UNAUTHORIZED", "Invalid credentials.")

        user_id = int(row[0])
        stored_hash = str(row[5])

        ok = bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
        if not ok:
            return api_error(401, "UNAUTHORIZED", "Invalid credentials.")

        access_token = create_access_token(user_id)
        user_json = make_user_json((row[0], row[1], row[2], row[3], row[4]))

        return jsonify({"accessToken": access_token, "user": user_json}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


# ---------------------------
# Users
# ---------------------------

@app.get(f"{API_PREFIX}/users/me")
def users_me_get():
    try:
        me = require_auth_user_id()
    except PermissionError as pe:
        reason = str(pe)
        msg = "Unauthorized."
        if reason == "token_expired":
            msg = "Token expired."
        return api_error(401, "UNAUTHORIZED", msg)

    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT user_id, Email, user_name, bio, profile_pic FROM {tbl('users')} WHERE user_id = ?",
                (me,),
            )
            row = cur.fetchone()

        if not row:
            return api_error(404, "NOT_FOUND", "User not found.")

        return jsonify(make_user_json(row)), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@app.patch(f"{API_PREFIX}/users/me")
def users_me_patch():
    try:
        me = require_auth_user_id()
    except PermissionError as pe:
        reason = str(pe)
        msg = "Unauthorized."
        if reason == "token_expired":
            msg = "Token expired."
        return api_error(401, "UNAUTHORIZED", msg)

    data: Dict[str, Any] = request.get_json(silent=True) or {}

    new_user_name = data.get("userName")
    new_bio = data.get("bio")
    new_profile_pic = data.get("profilePic")

    details: List[Dict[str, str]] = []
    if new_user_name is not None:
        if not isinstance(new_user_name, str) or not new_user_name.strip():
            details.append({"field": "userName", "reason": "invalid"})
        elif len(new_user_name.strip()) > 50:
            details.append({"field": "userName", "reason": "too_long"})

    if new_bio is not None:
        if not isinstance(new_bio, str):
            details.append({"field": "bio", "reason": "invalid"})

    if new_profile_pic is not None:
        if not isinstance(new_profile_pic, str):
            details.append({"field": "profilePic", "reason": "invalid"})

    if details:
        return api_error(400, "VALIDATION_ERROR", "Invalid request body.", details)

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            if new_user_name is not None:
                nu = new_user_name.strip()
                cur.execute(
                    f"SELECT 1 FROM {tbl('users')} WHERE user_name = ? AND user_id <> ?",
                    (nu, me),
                )
                if cur.fetchone():
                    return api_error(409, "CONFLICT", "UserName already used.", [{"field": "userName", "reason": "already_used"}])

            fields = []
            params = []

            if new_user_name is not None:
                fields.append("user_name = ?")
                params.append(new_user_name.strip())
            if new_bio is not None:
                fields.append("bio = ?")
                params.append(new_bio)
            if new_profile_pic is not None:
                fields.append("profile_pic = ?")
                params.append(new_profile_pic)

            if fields:
                params.append(me)
                sql = f"UPDATE {tbl('users')} SET " + ", ".join(fields) + " WHERE user_id = ?"
                cur.execute(sql, tuple(params))
                conn.commit()

            cur.execute(
                f"SELECT user_id, Email, user_name, bio, profile_pic FROM {tbl('users')} WHERE user_id = ?",
                (me,),
            )
            row = cur.fetchone()

        if not row:
            return api_error(404, "NOT_FOUND", "User not found.")

        return jsonify(make_user_json(row)), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@app.get(f"{API_PREFIX}/users/<int:user_id>")
def users_get(user_id: int):
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                f"SELECT user_id, Email, user_name, bio, profile_pic FROM {tbl('users')} WHERE user_id = ?",
                (user_id,),
            )
            row = cur.fetchone()

        if not row:
            return api_error(404, "NOT_FOUND", "User not found.")

        return jsonify(make_user_json(row)), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

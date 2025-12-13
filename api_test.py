from __future__ import annotations

import os
import re
import uuid

from werkzeug.utils import secure_filename
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

import bcrypt
import jwt
import pyodbc
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory


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

ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}

app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024  # 10MB

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

def get_optional_auth_user_id() -> Optional[int]:
    token = get_bearer_token()
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        sub = payload.get("sub")
        return int(sub) if sub is not None else None
    except Exception:
        return None

@app.get("/")
def index():
    return send_from_directory("static", "index.html")

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


# ---------------------------
# Post
# ---------------------------

def dt_to_iso(dt: datetime | None) -> str:
    tz = timezone(timedelta(hours=8))
    if dt is None:
        return datetime.now(tz).replace(microsecond=0).isoformat()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.replace(microsecond=0).isoformat()

def make_post_json(row) -> dict:
    # row: post_id, picture, content, likes, created_at, author_id, author_name, author_pic, (optional) likedByMe
    liked = bool(row[8]) if len(row) >= 9 else False

    return {
        "postId": int(row[0]),
        "author": {
            "userId": int(row[5]),
            "userName": row[6],
            "profilePic": row[7],
        },
        "picture": row[1],
        "content": row[2],
        "likes": int(row[3] or 0),
        "createdAt": dt_to_iso(row[4]),
        "likedByMe": liked,
    }

@app.get(f"{API_PREFIX}/posts")
def posts_list():
    # /api/v1/posts?page=1&pageSize=20
    try:
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("pageSize", 20))
    except ValueError:
        return api_error(400, "VALIDATION_ERROR", "Invalid pagination.", [])

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 20
    if page_size > 100:
        page_size = 100

    offset = (page - 1) * page_size
    me = get_optional_auth_user_id()

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # total
            cur.execute(f"SELECT COUNT(*) FROM {tbl('post')}")
            total = int(cur.fetchone()[0])

            # items (join users)
            if me is None:
                cur.execute(
                    """
                    SELECT
                    p.post_id, p.picture, p.content, p.likes, p.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CAST(0 AS bit) AS likedByMe
                    FROM dbo.[post] p
                    JOIN dbo.[users] u ON u.user_id = p.user_id
                    ORDER BY p.created_at DESC
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                    """,
                    (offset, page_size),
                )
            else:
                cur.execute(
                    f"""
                    SELECT
                    p.post_id, p.picture, p.content, p.likes, p.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM {tbl('likes')} l
                        WHERE l.post_id = p.post_id AND l.user_id = ?
                    ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS likedByMe
                    FROM {tbl('post')} p
                    JOIN {tbl('users')} u ON u.user_id = p.user_id
                    ORDER BY p.created_at DESC
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                    """,
                    (me, offset, page_size),
                )

            rows = cur.fetchall()

        items = [make_post_json(r) for r in rows]
        return jsonify({"items": items, "page": page, "pageSize": page_size, "total": total}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

@app.post(f"{API_PREFIX}/posts")
def posts_create():
    # Auth required
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    data: Dict[str, Any] = request.get_json(silent=True) or {}
    picture = (data.get("picture") or "").strip() or None
    content = (data.get("content") or "").strip()

    details = []
    if not content:
        details.append({"field": "content", "reason": "required"})
    elif len(content) > 500:
        details.append({"field": "content", "reason": "too_long"})
    if picture is not None and len(picture) > 1024:
        details.append({"field": "picture", "reason": "too_long"})
    if details:
        return api_error(400, "VALIDATION_ERROR", "Invalid request body.", details)

    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                f"""
                INSERT INTO {tbl('post')}(user_id, picture, content)
                OUTPUT INSERTED.post_id
                VALUES (?, ?, ?);
                """,
                (me, picture, content),
            )
            new_post_id = int(cur.fetchone()[0])
            conn.commit()

            # fetch new post with author
            cur.execute(
                f"""
                SELECT
                    p.post_id, p.picture, p.content, p.likes, p.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CAST(0 AS bit) AS likedByMe
                FROM {tbl('post')} AS p
                JOIN {tbl('users')} AS u ON u.user_id = p.user_id
                WHERE p.post_id = ?;
                """,
                (new_post_id,),
            )
            row = cur.fetchone()

        return jsonify(make_post_json(row)), 201

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

@app.post(f"{API_PREFIX}/posts/<int:post_id>/like")
def like_post(post_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # idempotent：已按讚就直接回 liked=true
            cur.execute(f"SELECT 1 FROM {tbl('likes')} WHERE post_id=? AND user_id=?", (post_id, me))
            if cur.fetchone():
                cur.execute(f"SELECT likes FROM {tbl('post')} WHERE post_id=?", (post_id,))
                r = cur.fetchone()
                if not r:
                    return api_error(404, "NOT_FOUND", "Post not found.")
                return jsonify({"liked": True, "likes": int(r[0])}), 200

            # insert like + likes+1
            cur.execute(f"INSERT INTO {tbl('likes')}(post_id, user_id) VALUES (?, ?)", (post_id, me))
            cur.execute(f"UPDATE {tbl('post')} SET likes = likes + 1 WHERE post_id=?", (post_id,))
            if cur.rowcount == 0:
                conn.rollback()
                return api_error(404, "NOT_FOUND", "Post not found.")

            cur.execute(f"SELECT likes FROM {tbl('post')} WHERE post_id=?", (post_id,))
            likes_now = int(cur.fetchone()[0])
            conn.commit()

        return jsonify({"liked": True, "likes": likes_now}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@app.delete(f"{API_PREFIX}/posts/<int:post_id>/like")
def unlike_post(post_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 先刪 like
            cur.execute(f"DELETE FROM {tbl('likes')} WHERE post_id=? AND user_id=?", (post_id, me))
            deleted = cur.rowcount

            # 若真的有刪到，likes-1（保護不低於 0）
            if deleted:
                cur.execute(
                    f"UPDATE {tbl('post')} SET likes = CASE WHEN likes>0 THEN likes-1 ELSE 0 END WHERE post_id=?",
                    (post_id,),
                )
                if cur.rowcount == 0:
                    conn.rollback()
                    return api_error(404, "NOT_FOUND", "Post not found.")

            cur.execute(f"SELECT likes FROM {tbl('post')} WHERE post_id=?", (post_id,))
            r = cur.fetchone()
            if not r:
                conn.rollback()
                return api_error(404, "NOT_FOUND", "Post not found.")
            likes_now = int(r[0])

            conn.commit()

        return jsonify({"liked": False, "likes": likes_now}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

# ---------------------------
# Upload
# ---------------------------

def allowed_file(filename: str) -> bool:
    if "." not in filename:
        return False
    ext = filename.rsplit(".", 1)[1].lower()
    return ext in ALLOWED_EXT

@app.post("/api/upload")
def upload_image():
    f = request.files.get("file")
    if not f or not f.filename:
        return api_error(400, "VALIDATION_ERROR", "No file uploaded.", [{"field": "file", "reason": "required"}])

    # 1) 先從「原始檔名」抓副檔名（中文檔名也沒問題）
    suffix = Path(f.filename).suffix.lower()  # e.g. ".png"
    ext = suffix[1:] if suffix.startswith(".") else ""

    # 2) 若抓不到/不合法，再用 mimetype 補
    if ext not in ALLOWED_EXT:
        ext = MIME_TO_EXT.get((f.mimetype or "").lower(), "")

    if ext not in ALLOWED_EXT:
        return api_error(400, "VALIDATION_ERROR", "Unsupported file type.", [{"field": "file", "reason": "invalid_type"}])

    # 3) 用 UUID 存檔，完全避開中文/特殊字元問題
    new_name = f"{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(UPLOAD_DIR, new_name)
    f.save(save_path)

    return jsonify({"url": f"/uploads/{new_name}"}), 201

@app.get("/uploads/<path:filename>")
def serve_upload(filename: str):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

from flask import Blueprint, jsonify, request
import bcrypt
import pyodbc

from ..errors import api_error
from ..db import get_conn, tbl
from ..auth_utils import (
    create_access_token,
    create_refresh_token,
    get_refresh_token,
    verify_refresh_token,
    set_refresh_cookie,
    clear_refresh_cookie
)
from ..serializers import make_user_json
from ..validators import is_valid_email
from typing import Any, Dict, List

from ..config import Config

bp = Blueprint("auth", __name__, url_prefix=f"{Config.API_PREFIX}/auth")

@bp.post("/register")
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
                INSERT INTO {tbl('users')} (Email, pwd, bio, profile_pic, banner_pic, user_name)
                OUTPUT INSERTED.user_id
                VALUES (?, ?, NULL, NULL, NULL, ?);
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
                f"SELECT user_id, Email, user_name, bio, profile_pic, banner_pic FROM {tbl('users')} WHERE user_id = ?",
                (new_id,),
            )
            user_row = cur.fetchone()

        access_token = create_access_token(new_id)
        refresh_token = create_refresh_token(new_id)
        
        resp = jsonify({"accessToken": access_token, "user": make_user_json(user_row)})
        set_refresh_cookie(resp, refresh_token)
        
        return resp, 201

    except pyodbc.IntegrityError:
        return api_error(409, "CONFLICT", "Conflict.")
    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

@bp.post("/login")
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
                f"SELECT user_id, Email, user_name, bio, profile_pic, banner_pic, pwd FROM {tbl('users')} WHERE Email = ?",
                (email,),
            )
            row = cur.fetchone()

        if not row:
            return api_error(401, "UNAUTHORIZED", "Invalid credentials.")

        user_id = int(row[0])
        stored_hash = str(row[6])

        ok = bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
        if not ok:
            return api_error(401, "UNAUTHORIZED", "Invalid credentials.")

        access_token = create_access_token(user_id)
        refresh_token = create_refresh_token(user_id)
        user_json = make_user_json((row[0], row[1], row[2], row[3], row[4], row[5]))

        resp = jsonify({"accessToken": access_token, "user": user_json})
        set_refresh_cookie(resp, refresh_token)

        return resp, 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))
    
@bp.post("/refresh")
def refresh_access_token():
    """用 refresh cookie 交換新的 access token（前端在遇到 401 時可自動呼叫）。"""
    token = get_refresh_token()
    if not token:
        return api_error(401, "UNAUTHORIZED", "Missing refresh token.")

    try:
        user_id = verify_refresh_token(token)
    except PermissionError as pe:
        reason = str(pe)
        msg = "Invalid refresh token."
        if reason == "refresh_expired":
            msg = "Refresh token expired."
        return api_error(401, "UNAUTHORIZED", msg)

    # rotation：每次 refresh 都換一張新的 refresh token
    new_access = create_access_token(user_id)
    new_refresh = create_refresh_token(user_id)

    resp = jsonify({"accessToken": new_access})
    set_refresh_cookie(resp, new_refresh)
    return resp, 200


@bp.post("/logout")
def logout_v1():
    resp = jsonify({"ok": True})
    clear_refresh_cookie(resp)
    return resp, 200
from flask import Blueprint, jsonify, request

from ..errors import api_error
from ..db import get_conn, tbl
from ..auth_utils import require_auth_user_id
from ..serializers import make_user_json
from typing import Any, Dict, List

from ..config import Config

bp = Blueprint("users", __name__, url_prefix=f"{Config.API_PREFIX}/users")

@bp.get('/me')
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
    

@bp.patch('/me')
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

@bp.get('<int:user_id>')
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
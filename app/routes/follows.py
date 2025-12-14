from flask import Blueprint, jsonify

from ..config import Config
from ..db import get_conn, tbl
from ..errors import api_error
from ..auth_utils import require_auth_user_id, get_optional_auth_user_id

bp = Blueprint("follows", __name__, url_prefix=f"{Config.API_PREFIX}/follows")


def _ensure_user_exists(cur, user_id: int):
    cur.execute(f"SELECT 1 FROM {tbl('users')} WHERE user_id = ?", (user_id,))
    return cur.fetchone() is not None

@bp.get("/<int:target_user_id>")
def follow_status(target_user_id: int):
    """
    回傳目前登入者是否追蹤 target_user_id
    未登入 -> followedByMe = False
    """
    me = get_optional_auth_user_id()

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            if not _ensure_user_exists(cur, target_user_id):
                return api_error(404, "NOT_FOUND", "User not found.")

            if me is None:
                return jsonify({"userId": target_user_id, "followedByMe": False}), 200

            cur.execute(
                f"""
                SELECT CASE WHEN EXISTS (
                    SELECT 1 FROM {tbl('follow')}
                    WHERE follower_id = ? AND followee_id = ?
                ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END
                """,
                (me, target_user_id),
            )
            followed = bool(cur.fetchone()[0])

        return jsonify({"userId": target_user_id, "followedByMe": followed}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@bp.post("/<int:target_user_id>")
def follow_user(target_user_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    if me == target_user_id:
        return api_error(400, "VALIDATION_ERROR", "Cannot follow yourself.", [])

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            if not _ensure_user_exists(cur, target_user_id):
                return api_error(404, "NOT_FOUND", "User not found.")

            # idempotent：已追蹤就直接回 followed=true
            cur.execute(
                f"SELECT 1 FROM {tbl('follow')} WHERE follower_id=? AND followee_id=?",
                (me, target_user_id),
            )
            if cur.fetchone():
                return jsonify({"followed": True}), 200

            cur.execute(
                f"INSERT INTO {tbl('follow')}(follower_id, followee_id) VALUES (?, ?)",
                (me, target_user_id),
            )
            conn.commit()

        return jsonify({"followed": True}), 201

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

@bp.delete("/<int:target_user_id>")
def unfollow_user(target_user_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    if me == target_user_id:
        return api_error(400, "VALIDATION_ERROR", "Cannot unfollow yourself.", [])

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            if not _ensure_user_exists(cur, target_user_id):
                return api_error(404, "NOT_FOUND", "User not found.")

            cur.execute(
                f"DELETE FROM {tbl('follow')} WHERE follower_id=? AND followee_id=?",
                (me, target_user_id),
            )
            conn.commit()

        # idempotent：刪不到也當作已是 unfollow 狀態
        return jsonify({"followed": False}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

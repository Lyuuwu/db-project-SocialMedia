from flask import Blueprint, jsonify, request
from datetime import datetime, timedelta, timezone

from ..errors import api_error
from ..db import get_conn, tbl
from ..auth_utils import require_auth_user_id, get_optional_auth_user_id
from ..serializers import make_user_json, make_comment_json, make_post_json
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
    
def _parse_pagination(default_size: int = 20, max_size: int = 100):
    try:
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("pageSize", default_size))
    except ValueError:
        return None, None, None, api_error(400, "VALIDATION_ERROR", "Invalid pagination.", [])

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = default_size
    if page_size > max_size:
        page_size = max_size

    offset = (page - 1) * page_size
    return page, page_size, offset, None


def _dt_to_iso(dt: datetime | None) -> str:
    tz = timezone(timedelta(hours=8))
    if dt is None:
        return datetime.now(tz).replace(microsecond=0).isoformat()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.replace(microsecond=0).isoformat()


@bp.get("/<int:user_id>/posts")
def user_posts(user_id: int):
    page, page_size, offset, err = _parse_pagination(default_size=20, max_size=100)
    if err:
        return err

    viewer = get_optional_auth_user_id()

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # user exists?
            cur.execute(f"SELECT 1 FROM {tbl('users')} WHERE user_id = ?", (user_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "User not found.")

            cur.execute(f"SELECT COUNT(*) FROM {tbl('post')} WHERE user_id = ?", (user_id,))
            total = int(cur.fetchone()[0])

            if viewer is None:
                cur.execute(
                    f"""
                    SELECT
                        p.post_id, p.picture, p.content, p.likes, p.created_at,
                        u.user_id, u.user_name, u.profile_pic,
                        CAST(0 AS bit) AS likedByMe,
                        (SELECT COUNT(*) FROM {tbl('comment')} c WHERE c.post_id = p.post_id) AS commentCount
                    FROM {tbl('post')} p
                    JOIN {tbl('users')} u ON u.user_id = p.user_id
                    WHERE p.user_id = ?
                    ORDER BY p.created_at DESC
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                    """,
                    (user_id, offset, page_size),
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
                        ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS likedByMe,
                        (SELECT COUNT(*) FROM {tbl('comment')} c WHERE c.post_id = p.post_id) AS commentCount
                    FROM {tbl('post')} p
                    JOIN {tbl('users')} u ON u.user_id = p.user_id
                    WHERE p.user_id = ?
                    ORDER BY p.created_at DESC
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                    """,
                    (viewer, user_id, offset, page_size),
                )

            rows = cur.fetchall()

        items = [make_post_json(r) for r in rows]
        return jsonify({"items": items, "page": page, "pageSize": page_size, "total": total}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@bp.get("/<int:user_id>/likes")
def user_liked_posts(user_id: int):
    page, page_size, offset, err = _parse_pagination(default_size=20, max_size=100)
    if err:
        return err

    viewer = get_optional_auth_user_id()

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # user exists?
            cur.execute(f"SELECT 1 FROM {tbl('users')} WHERE user_id = ?", (user_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "User not found.")

            cur.execute(f"SELECT COUNT(*) FROM {tbl('likes')} WHERE user_id = ?", (user_id,))
            total = int(cur.fetchone()[0])

            # 沒有 likes 的 created_at，所以用 post.created_at 排序
            if viewer is None:
                cur.execute(
                    f"""
                    SELECT
                        p.post_id, p.picture, p.content, p.likes, p.created_at,
                        u.user_id, u.user_name, u.profile_pic,
                        CAST(0 AS bit) AS likedByMe,
                        (SELECT COUNT(*) FROM {tbl('comment')} c WHERE c.post_id = p.post_id) AS commentCount
                    FROM {tbl('likes')} l
                    JOIN {tbl('post')} p ON p.post_id = l.post_id
                    JOIN {tbl('users')} u ON u.user_id = p.user_id
                    WHERE l.user_id = ?
                    ORDER BY p.created_at DESC
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                    """,
                    (user_id, offset, page_size),
                )
            else:
                cur.execute(
                    f"""
                    SELECT
                        p.post_id, p.picture, p.content, p.likes, p.created_at,
                        u.user_id, u.user_name, u.profile_pic,
                        CASE WHEN EXISTS (
                            SELECT 1 FROM {tbl('likes')} l2
                            WHERE l2.post_id = p.post_id AND l2.user_id = ?
                        ) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS likedByMe,
                        (SELECT COUNT(*) FROM {tbl('comment')} c WHERE c.post_id = p.post_id) AS commentCount
                    FROM {tbl('likes')} l
                    JOIN {tbl('post')} p ON p.post_id = l.post_id
                    JOIN {tbl('users')} u ON u.user_id = p.user_id
                    WHERE l.user_id = ?
                    ORDER BY p.created_at DESC
                    OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                    """,
                    (viewer, user_id, offset, page_size),
                )

            rows = cur.fetchall()

        items = [make_post_json(r) for r in rows]
        return jsonify({"items": items, "page": page, "pageSize": page_size, "total": total}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@bp.get("/<int:user_id>/comments")
def user_comments(user_id: int):
    page, page_size, offset, err = _parse_pagination(default_size=50, max_size=200)
    if err:
        return err

    viewer = get_optional_auth_user_id()

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # user exists?
            cur.execute(f"SELECT 1 FROM {tbl('users')} WHERE user_id = ?", (user_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "User not found.")

            cur.execute(f"SELECT COUNT(*) FROM {tbl('comment')} WHERE user_id = ?", (user_id,))
            total = int(cur.fetchone()[0])

            # 回傳：comment + 所屬 post 的摘要（讓前端能「查看貼文」）
            cur.execute(
                f"""
                SELECT
                    c.comment_id, c.post_id, c.content, c.created_at, c.updated_at,
                    au.user_id, au.user_name, au.profile_pic,
                    CASE WHEN ? IS NOT NULL AND c.user_id = ? THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS editableByMe,

                    p.content AS post_content,
                    p.created_at AS post_created_at,
                    pu.user_id AS post_author_id,
                    pu.user_name AS post_author_name,
                    pu.profile_pic AS post_author_pic
                FROM {tbl('comment')} c
                JOIN {tbl('users')} au ON au.user_id = c.user_id
                JOIN {tbl('post')} p ON p.post_id = c.post_id
                JOIN {tbl('users')} pu ON pu.user_id = p.user_id
                WHERE c.user_id = ?
                ORDER BY c.created_at DESC, c.comment_id DESC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                """,
                (viewer, viewer, user_id, offset, page_size),
            )
            rows = cur.fetchall()

        items = []
        for r in rows:
            # 前 9 欄符合 make_comment_json
            c = make_comment_json(r[:9])
            c["post"] = {
                "postId": int(r[1]),
                "content": (r[9] or ""),
                "createdAt": _dt_to_iso(r[10]),
                "author": {
                    "userId": int(r[11]),
                    "userName": r[12],
                    "profilePic": r[13],
                },
            }
            items.append(c)

        return jsonify({"items": items, "page": page, "pageSize": page_size, "total": total}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

from __future__ import annotations

from typing import Any, Dict, List

from flask import Blueprint, jsonify, request

from ..auth_utils import get_optional_auth_user_id, require_auth_user_id
from ..config import Config
from ..db import get_conn, tbl
from ..errors import api_error
from ..serializers import make_comment_json


bp = Blueprint("comments", __name__, url_prefix=Config.API_PREFIX)


def _validate_comment_content(data: Dict[str, Any]) -> tuple[str, List[Dict[str, str]]]:
    content = (data.get("content") or "").strip()
    details: List[Dict[str, str]] = []

    if not content:
        details.append({"field": "content", "reason": "required"})
    elif len(content) > 1024:
        details.append({"field": "content", "reason": "too_long"})

    return content, details


@bp.get("/posts/<int:post_id>/comments")
def comments_list(post_id: int):
    """
    GET /api/v1/posts/<post_id>/comments?page=1&pageSize=50
    排序：舊 -> 新（created_at ASC）
    """

    try:
        page = int(request.args.get("page", 1))
        page_size = int(request.args.get("pageSize", 50))
    except ValueError:
        return api_error(400, "VALIDATION_ERROR", "Invalid pagination.", [])

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = 50
    if page_size > 200:
        page_size = 200

    offset = (page - 1) * page_size

    me = get_optional_auth_user_id()
    me_for_case = me if me is not None else -1

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 先確認 post 存在
            cur.execute(f"SELECT 1 FROM {tbl('post')} WHERE post_id = ?", (post_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "Post not found.")

            # total
            cur.execute(f"SELECT COUNT(*) FROM {tbl('comment')} WHERE post_id = ?", (post_id,))
            total = int(cur.fetchone()[0])

            cur.execute(
                f"""
                SELECT
                    c.comment_id, c.post_id, c.content, c.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CASE WHEN c.user_id = ? THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS editableByMe
                FROM {tbl('comment')} c
                JOIN {tbl('users')} u ON u.user_id = c.user_id
                WHERE c.post_id = ?
                ORDER BY c.created_at ASC, c.comment_id ASC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                """,
                (me_for_case, post_id, offset, page_size),
            )

            rows = cur.fetchall()

        items = [make_comment_json(r) for r in rows]
        return jsonify({"items": items, "total": total, "page": page, "pageSize": page_size}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@bp.post("/posts/<int:post_id>/comments")
def comments_create(post_id: int):
    """POST /api/v1/posts/<post_id>/comments"""

    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    data: Dict[str, Any] = request.get_json(silent=True) or {}
    content, details = _validate_comment_content(data)
    if details:
        return api_error(400, "VALIDATION_ERROR", "Invalid request body.", details)

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 確認 post 存在
            cur.execute(f"SELECT 1 FROM {tbl('post')} WHERE post_id = ?", (post_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "Post not found.")

            cur.execute(
                f"""
                INSERT INTO {tbl('comment')}(user_id, post_id, content)
                OUTPUT INSERTED.comment_id
                VALUES (?, ?, ?);
                """,
                (me, post_id, content),
            )
            new_comment_id = int(cur.fetchone()[0])
            conn.commit()

            cur.execute(
                f"""
                SELECT
                    c.comment_id, c.post_id, c.content, c.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CAST(1 AS bit) AS editableByMe
                FROM {tbl('comment')} c
                JOIN {tbl('users')} u ON u.user_id = c.user_id
                WHERE c.comment_id = ?;
                """,
                (new_comment_id,),
            )
            row = cur.fetchone()

        return jsonify(make_comment_json(row)), 201

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@bp.patch("/comments/<int:comment_id>")
def comments_edit(comment_id: int):
    """PATCH /api/v1/comments/<comment_id> (只能編輯自己的留言)"""

    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    data: Dict[str, Any] = request.get_json(silent=True) or {}
    content, details = _validate_comment_content(data)
    if details:
        return api_error(400, "VALIDATION_ERROR", "Invalid request body.", details)

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            cur.execute(
                f"SELECT user_id FROM {tbl('comment')} WHERE comment_id = ?",
                (comment_id,),
            )
            r = cur.fetchone()
            if not r:
                return api_error(404, "NOT_FOUND", "Comment not found.")

            owner_id = int(r[0])
            if owner_id != me:
                return api_error(403, "FORBIDDEN", "You can only edit your own comment.")

            cur.execute(
                f"UPDATE {tbl('comment')} SET content = ? WHERE comment_id = ?",
                (content, comment_id),
            )
            conn.commit()

            cur.execute(
                f"""
                SELECT
                    c.comment_id, c.post_id, c.content, c.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CAST(1 AS bit) AS editableByMe
                FROM {tbl('comment')} c
                JOIN {tbl('users')} u ON u.user_id = c.user_id
                WHERE c.comment_id = ?;
                """,
                (comment_id,),
            )
            row = cur.fetchone()

        return jsonify(make_comment_json(row)), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

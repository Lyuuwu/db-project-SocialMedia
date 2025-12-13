from flask import Blueprint, jsonify, request

from ..errors import api_error
from ..db import get_conn, tbl
from ..auth_utils import require_auth_user_id, get_optional_auth_user_id
from ..serializers import make_like_user_json, make_post_json
from typing import Any, Dict

from ..config import Config

bp = Blueprint("posts", __name__, url_prefix=f"{Config.API_PREFIX}/posts")

@bp.get('')
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

@bp.post('')
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

@bp.post('/<int:post_id>/like')
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

@bp.delete('/<int:post_id>/like')
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

@bp.get('/<int:post_id>/likes')
def post_likes_list(post_id: int):
    """
    用法：
      - Hover 預覽：GET /api/v1/posts/<post_id>/likes?limit=5
      - Modal 全部：GET /api/v1/posts/<post_id>/likes?page=1&pageSize=200
        （前端會自動翻頁直到拿完）
    """
    # 參數（兩種模式：limit 或 page/pageSize）
    limit_q = request.args.get("limit")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 先確認 post 存在（避免 post_id 打錯時回空陣列讓人困惑）
            cur.execute(f"SELECT 1 FROM {tbl('post')} WHERE post_id = ?", (post_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "Post not found.")

            # 總數
            cur.execute(f"SELECT COUNT(*) FROM {tbl('likes')} WHERE post_id = ?", (post_id,))
            total = int(cur.fetchone()[0])

            if limit_q is not None:
                # Hover 預覽模式
                try:
                    limit = int(limit_q)
                except ValueError:
                    return api_error(400, "VALIDATION_ERROR", "Invalid limit.", [])
                if limit < 1:
                    limit = 5
                if limit > 50:
                    limit = 50

                cur.execute(
                    f"""
                    SELECT TOP (?) u.user_id, u.user_name, u.profile_pic
                    FROM {tbl('likes')} l
                    JOIN {tbl('users')} u ON u.user_id = l.user_id
                    WHERE l.post_id = ?
                    ORDER BY u.user_name ASC;
                    """,
                    (limit, post_id),
                )
                rows = cur.fetchall()
                return jsonify({"items": [make_like_user_json(r) for r in rows], "total": total, "limit": limit}), 200

            # Modal（可分頁拿全部）
            try:
                page = int(request.args.get("page", 1))
                page_size = int(request.args.get("pageSize", 200))
            except ValueError:
                return api_error(400, "VALIDATION_ERROR", "Invalid pagination.", [])

            if page < 1:
                page = 1
            if page_size < 1:
                page_size = 50
            if page_size > 200:
                page_size = 200

            offset = (page - 1) * page_size

            cur.execute(
                f"""
                SELECT u.user_id, u.user_name, u.profile_pic
                FROM {tbl('likes')} l
                JOIN {tbl('users')} u ON u.user_id = l.user_id
                WHERE l.post_id = ?
                ORDER BY u.user_name ASC
                OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
                """,
                (post_id, offset, page_size),
            )
            rows = cur.fetchall()

        return jsonify(
            {
                "items": [make_like_user_json(r) for r in rows],
                "total": total,
                "page": page,
                "pageSize": page_size,
            }
        ), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

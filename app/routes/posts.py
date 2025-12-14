from __future__ import annotations

import difflib
import re

from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from ..auth_utils import get_optional_auth_user_id, require_auth_user_id
from ..config import Config
from ..db import get_conn, tbl
from ..errors import api_error
from ..serializers import make_like_user_json, make_post_json


bp = Blueprint("posts", __name__, url_prefix=f"{Config.API_PREFIX}/posts")


@bp.get("")
@bp.get("/")
def posts_list():
    # GET /api/v1/posts?page=1&pageSize=20
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

    # optional filter: authorIds=1,2,3
    raw_author_ids = (request.args.get("authorIds") or "").strip()
    author_ids: List[int] = []
    if raw_author_ids:
        for part in raw_author_ids.split(','):
            part = part.strip()
            if not part:
                continue
            try:
                author_ids.append(int(part))
            except ValueError:
                continue
        # unique & keep order
        seen = set()
        author_ids = [x for x in author_ids if (x not in seen and not seen.add(x))]
        author_ids = author_ids[:50]
    me = get_optional_auth_user_id()
    me_for_case = me if me is not None else -1

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            if author_ids:
                placeholders = ",".join(["?"] * len(author_ids))
                cur.execute(f"SELECT COUNT(*) FROM {tbl('post')} WHERE user_id IN ({placeholders})", tuple(author_ids))
            else:
                cur.execute(f"SELECT COUNT(*) FROM {tbl('post')}")
            total = int(cur.fetchone()[0])

            # NOTE: commentCount 用 correlated subquery（小專案量級 OK）
            base_select = f"""
                SELECT
                    p.post_id, p.picture, p.content, p.likes, p.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    {{LIKED_BY_ME}} AS likedByMe,
                    (
                        SELECT COUNT(*)
                        FROM {tbl('comment')} c
                        WHERE c.post_id = p.post_id
                    ) AS commentCount
                FROM {tbl('post')} p
                JOIN {tbl('users')} u ON u.user_id = p.user_id
            """

            where_sql = ""
            where_params: List[Any] = []
            if author_ids:
                where_sql = " WHERE p.user_id IN (" + ",".join(["?"] * len(author_ids)) + ") "
                where_params.extend(author_ids)


            if me is None:
                sql = (
                    base_select.replace("{LIKED_BY_ME}", "CAST(0 AS bit)")
                    + where_sql
                    + " ORDER BY p.created_at DESC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;"
                )
                cur.execute(sql, tuple(where_params + [offset, page_size]))
            else:
                sql = (
                    base_select.replace(
                        "{LIKED_BY_ME}",
                        f"CASE WHEN EXISTS (\n"
                        f"    SELECT 1 FROM {tbl('likes')} l\n"
                        f"    WHERE l.post_id = p.post_id AND l.user_id = ?\n"
                        f") THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END",
                    )
                    + where_sql
                    + " ORDER BY p.created_at DESC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;"
                )
                cur.execute(sql, tuple([me_for_case] + where_params + [offset, page_size]))

            rows = cur.fetchall()

        items = [make_post_json(r) for r in rows]
        return jsonify({"items": items, "page": page, "pageSize": page_size, "total": total}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

# ===== post search (title + content, fuzzy match) =====
def _norm(s: str) -> str:
    return (s or "").strip().lower()

def _best_match(query: str, text: str):
    q = _norm(query)
    if not q:
        return None
    t = (text or "")
    tl = t.lower()

    idx = tl.find(q)
    if idx != -1:
        score = 1.0 + max(0.0, 0.4 - (idx / max(1, len(tl))) * 0.4)
        matched = t[idx: idx + len(q)] if len(t) >= idx + len(q) else q
        return (score, "content", matched)

    ratio = difflib.SequenceMatcher(None, q, tl).ratio()
    if ratio >= 0.72:
        return (ratio, "content", q)

    return None

@bp.get("/search")
def posts_search():
    """
    搜尋貼文（第二種搜尋：內文）
    GET /api/v1/posts/search?query=xxx&page=1&pageSize=20&followOnly=0|1
    
    - 回傳 items 依 relevance score 排序（同分再依 created_at 新到舊）
    """
    query = (request.args.get("query") or request.args.get("q") or "").strip()
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

    follow_only_raw = (request.args.get("followOnly") or "").strip().lower()
    follow_only = follow_only_raw in ("1", "true", "yes", "y", "on")

    # optional filter: authorIds=1,2,3 (沿用搜尋用戶後的行為，也可單獨用)
    raw_author_ids = (request.args.get("authorIds") or "").strip()
    author_ids: List[int] = []
    if raw_author_ids:
        for part in raw_author_ids.split(','):
            part = part.strip()
            if not part:
                continue
            try:
                author_ids.append(int(part))
            except ValueError:
                continue
        seen = set()
        author_ids = [x for x in author_ids if (x not in seen and not seen.add(x))]
        author_ids = author_ids[:50]

    me = get_optional_auth_user_id()
    me_for_case = me if me is not None else -1

    if not query:
        return jsonify({"items": [], "page": page, "pageSize": page_size, "total": 0, "query": ""}), 200

    ql = _norm(query)
    tokens = [t for t in re.split(r"\s+", ql) if t][:6]

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            base_select = f"""
                SELECT
                    p.post_id, p.picture, p.content, p.likes, p.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    {{LIKED_BY_ME}} AS likedByMe,
                    (
                        SELECT COUNT(*)
                        FROM {tbl('comment')} c
                        WHERE c.post_id = p.post_id
                    ) AS commentCount
                FROM {tbl('post')} p
                JOIN {tbl('users')} u ON u.user_id = p.user_id
            """

            where_parts: List[str] = []
            params: List[Any] = []

            if author_ids:
                where_parts.append("p.user_id IN (" + ",".join(["?"] * len(author_ids)) + ")")
                params.extend(author_ids)

            if follow_only and me is not None:
                # 自己 or 追蹤的人
                where_parts.append(
                    f"(p.user_id = ? OR EXISTS (SELECT 1 FROM {tbl('follow')} f WHERE f.follower_id = ? AND f.followee_id = p.user_id))"
                )
                params.extend([me, me])

            # 粗篩：只用 content LIKE（title 是 content 的第一行）
            like_parts: List[str] = []
            like_params: List[str] = []
            for t in tokens:
                like_parts.append("LOWER(p.content) LIKE ?")
                like_params.append(f"%{t}%")
            if like_parts:
                where_parts.append("(" + " OR ".join(like_parts) + ")")
                params.extend(like_params)

            where_sql = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

            # 先用 LIKE 粗篩；若太少，fallback 抓最近貼文做 fuzzy
            sql1 = (
                base_select.replace("SELECT", "SELECT TOP 500", 1)
                .replace("{LIKED_BY_ME}", "CAST(0 AS bit)" if me is None else
                         f"CASE WHEN EXISTS (SELECT 1 FROM {tbl('likes')} l WHERE l.post_id = p.post_id AND l.user_id = ?) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END")
                + where_sql
                + " ORDER BY p.created_at DESC;"
            )

            if me is None:
                cur.execute(sql1, tuple(params))
            else:
                cur.execute(sql1, tuple([me_for_case] + params))
            rows = cur.fetchall()

            # fallback：LIKE 找不到就抓最近 500 篇（仍套用 followOnly/authorIds）
            if not rows:
                where_parts2: List[str] = []
                params2: List[Any] = []

                if author_ids:
                    where_parts2.append("p.user_id IN (" + ",".join(["?"] * len(author_ids)) + ")")
                    params2.extend(author_ids)
                if follow_only and me is not None:
                    where_parts2.append(
                        f"(p.user_id = ? OR EXISTS (SELECT 1 FROM {tbl('follow')} f WHERE f.follower_id = ? AND f.followee_id = p.user_id))"
                    )
                    params2.extend([me, me])
                where_sql2 = (" WHERE " + " AND ".join(where_parts2)) if where_parts2 else ""

                sql2 = (
                    base_select.replace("SELECT", "SELECT TOP 500", 1)
                    .replace("{LIKED_BY_ME}", "CAST(0 AS bit)" if me is None else
                             f"CASE WHEN EXISTS (SELECT 1 FROM {tbl('likes')} l WHERE l.post_id = p.post_id AND l.user_id = ?) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END")
                    + where_sql2
                    + " ORDER BY p.created_at DESC;"
                )
                if me is None:
                    cur.execute(sql2, tuple(params2))
                else:
                    cur.execute(sql2, tuple([me_for_case] + params2))
                rows = cur.fetchall()

        # Python 端做 fuzzy + relevance 排序
        hits = []
        for r in rows:
            content = r[2] or ""
            m = _best_match(query, content)
            if not m:
                continue
            score, field, mtext = m
            payload = make_post_json(r)
            
            # make_post_json 已含 title，但保險起見再覆蓋
            payload["match"] = {"field": field, "text": mtext, "score": float(score)}
            hits.append((float(score), r[4], payload))

        # relevance desc, created_at desc
        hits.sort(key=lambda x: (x[0], x[1]), reverse=True)
        total = len(hits)

        start = (page - 1) * page_size
        end = start + page_size
        items = [x[2] for x in hits[start:end]]

        return jsonify({"items": items, "page": page, "pageSize": page_size, "total": total, "query": query}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

@bp.post("")
@bp.post("/")
def posts_create():
    # POST /api/v1/posts
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    data: Dict[str, Any] = request.get_json(silent=True) or {}
    picture = (data.get("picture") or "").strip() or None
    content = (data.get("content") or "").strip()

    details: List[Dict[str, str]] = []
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

            cur.execute(
                f"""
                SELECT
                    p.post_id, p.picture, p.content, p.likes, p.created_at,
                    u.user_id, u.user_name, u.profile_pic,
                    CAST(0 AS bit) AS likedByMe,
                    CAST(0 AS int) AS commentCount
                FROM {tbl('post')} p
                JOIN {tbl('users')} u ON u.user_id = p.user_id
                WHERE p.post_id = ?;
                """,
                (new_post_id,),
            )
            row = cur.fetchone()

        return jsonify(make_post_json(row)), 201

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

@bp.delete("/<int:post_id>")
def posts_delete(post_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 確認貼文存在 + 找作者
            cur.execute(f"SELECT user_id FROM {tbl('post')} WHERE post_id = ?", (post_id,))
            row = cur.fetchone()
            if not row:
                return api_error(404, "NOT_FOUND", "Post not found.")

            author_id = int(row[0])
            if author_id != me:
                return api_error(403, "FORBIDDEN", "You can only delete your own post.")

            # 刪除貼文（你的 schema 已設 on delete cascade：likes/comment 會一起被刪）
            cur.execute(f"DELETE FROM {tbl('post')} WHERE post_id = ? AND user_id = ?", (post_id, me))
            conn.commit()

        return jsonify({"deleted": True, "postId": post_id}), 200

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))


@bp.post("/<int:post_id>/like")
def like_post(post_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # idempotent：已按讚就直接回 liked=true
            cur.execute(
                f"SELECT 1 FROM {tbl('likes')} WHERE post_id=? AND user_id=?",
                (post_id, me),
            )
            if cur.fetchone():
                cur.execute(f"SELECT likes FROM {tbl('post')} WHERE post_id=?", (post_id,))
                r = cur.fetchone()
                if not r:
                    return api_error(404, "NOT_FOUND", "Post not found.")
                return jsonify({"liked": True, "likes": int(r[0])}), 200

            # insert like + likes+1
            cur.execute(
                f"INSERT INTO {tbl('likes')}(post_id, user_id) VALUES (?, ?)",
                (post_id, me),
            )
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


@bp.delete("/<int:post_id>/like")
def unlike_post(post_id: int):
    try:
        me = require_auth_user_id()
    except PermissionError:
        return api_error(401, "UNAUTHORIZED", "Unauthorized.")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            # 先刪 like
            cur.execute(
                f"DELETE FROM {tbl('likes')} WHERE post_id=? AND user_id=?",
                (post_id, me),
            )
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


@bp.get("/<int:post_id>/likes")
def post_likes_list(post_id: int):
    """
    用法：
      - Hover 預覽：GET /api/v1/posts/<post_id>/likes?limit=8
      - Modal 全部：GET /api/v1/posts/<post_id>/likes?page=1&pageSize=200
    """
    limit_q = request.args.get("limit")

    try:
        with get_conn() as conn:
            cur = conn.cursor()

            cur.execute(f"SELECT 1 FROM {tbl('post')} WHERE post_id = ?", (post_id,))
            if not cur.fetchone():
                return api_error(404, "NOT_FOUND", "Post not found.")

            cur.execute(f"SELECT COUNT(*) FROM {tbl('likes')} WHERE post_id = ?", (post_id,))
            total = int(cur.fetchone()[0])

            if limit_q is not None:
                try:
                    limit = int(limit_q)
                except ValueError:
                    return api_error(400, "VALIDATION_ERROR", "Invalid limit.", [])

                if limit < 1:
                    limit = 8
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
                return (
                    jsonify({"items": [make_like_user_json(r) for r in rows], "total": total, "limit": limit}),
                    200,
                )

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

        return (
            jsonify(
                {
                    "items": [make_like_user_json(r) for r in rows],
                    "total": total,
                    "page": page,
                    "pageSize": page_size,
                }
            ),
            200,
        )

    except Exception as e:
        return api_error(500, "INTERNAL_ERROR", str(e))

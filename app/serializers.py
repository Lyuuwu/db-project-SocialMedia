from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Tuple

def now_iso8601() -> str:
    # 合約說 ISO 8601；這裡用 +08:00
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz=tz).replace(microsecond=0).isoformat()

def dt_to_iso(dt: datetime | None) -> str:
    tz = timezone(timedelta(hours=8))
    if dt is None:
        return datetime.now(tz).replace(microsecond=0).isoformat()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.replace(microsecond=0).isoformat()

def make_user_json(row: Tuple[Any, ...]) -> Dict[str, Any]:
    # row: (user_id, Email, user_name, bio, profile_pic, banner_pic?)
    banner_pic = row[5] if len(row) >= 6 else None
    return {
        "userId": int(row[0]),
        "email": row[1],
        "userName": row[2],
        "bio": row[3],
        "profilePic": row[4],
        "bannerPic": banner_pic,
        # 你的 users table 沒有 createdAt 欄位，所以這裡先回傳伺服器時間
        # 若你之後加 users.created_at (datetime2 default sysdatetime)，改成查欄位回來即可
        "createdAt": now_iso8601(),
    }

def make_post_json(row) -> dict:
    # row: post_id, picture, content, likes, created_at, author_id, author_name, author_pic,
    #      (optional) likedByMe, (optional) commentCount
    liked = bool(row[8]) if len(row) >= 9 else False
    comment_count = int(row[9]) if len(row) >= 10 and row[9] is not None else 0

    content = row[2] or ""

    return {
        "postId": int(row[0]),
        "author": {
            "userId": int(row[5]),
            "userName": row[6],
            "profilePic": row[7],
        },
        "picture": row[1],
        "content": content,
        "likes": int(row[3] or 0),
        "createdAt": dt_to_iso(row[4]),
        "likedByMe": liked,
        "commentCount": comment_count,
    }
    
def make_like_user_json(row) -> Dict[str, Any]:
    # row: (user_id, user_name, profile_pic)
    
    payload = {
        "userId": int(row[0]),
        "userName": row[1],
        "profilePic": row[2]
    }
    
    if len(row) >= 4:
        payload["followedByMe"] = bool(row[3])
    
    return payload


def make_comment_json(row) -> Dict[str, Any]:
    # row: comment_id, post_id, content, created_at, updated_at, author_id, author_name, author_pic, (optional) editableByMe
    can_edit = bool(row[8]) if len(row) >= 9 else False
    updated_at = row[4] if len(row) >= 5 else None
    edited = updated_at is not None

    return {
        "commentId": int(row[0]),
        "postId": int(row[1]),
        "content": row[2],
        "createdAt": dt_to_iso(row[3]),
        "updatedAt": dt_to_iso(updated_at) if updated_at is not None else None,
        "edited": edited,
        "author": {
            "userId": int(row[5]),
            "userName": row[6],
            "profilePic": row[7],
        },
        "editableByMe": can_edit,
    }

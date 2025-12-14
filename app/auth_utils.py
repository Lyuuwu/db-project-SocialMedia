from .config import Config

from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid

import jwt
from flask import request

JWT_SECRET = Config.JWT_SECRET
ACCESS_TOKEN_MINUTES = Config.ACCESS_TOKEN_MINUTES
REFRESH_TOKEN_DAYS = Config.REFRESH_TOKEN_DAYS
REFRESH_COOKIE_NAME = Config.REFRESH_COOKIE_NAME

# 只讓 refresh cookie 出現在 auth 路徑下
REFRESH_COOKIE_PATH = f"{Config.API_PREFIX}/auth"

def create_access_token(user_id: int) -> str:
    utc_now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user_id),
        "typ": "access",
        "iat": int(utc_now.timestamp()),
        "exp": int((utc_now + timedelta(minutes=ACCESS_TOKEN_MINUTES)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def create_refresh_token(user_id: int) -> str:
    """長效 refresh token：放在 HttpOnly cookie。"""
    utc_now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user_id),
        "typ": "refresh",
        "jti": uuid.uuid4().hex,  # 用於 rotation（每次 refresh 都換一張新的）
        "iat": int(utc_now.timestamp()),
        "exp": int((utc_now + timedelta(days=REFRESH_TOKEN_DAYS)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def _decode_jwt(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise PermissionError("token_expired")
    except jwt.InvalidTokenError:
        raise PermissionError("invalid_token")

def require_auth_user_id() -> int:
    """給需要登入的 API 用：抓 Authorization Bearer token。"""
    auth = request.headers.get("Authorization") or ""
    parts = auth.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise PermissionError("missing_token")

    payload = _decode_jwt(parts[1])
    if payload.get("typ") != "access":
        raise PermissionError("invalid_token")

    sub = payload.get("sub")
    if not sub:
        raise PermissionError("invalid_token")

    return int(sub)

def get_optional_auth_user_id() -> Optional[int]:
    """給可登入可不登入的 API 用：有 token 就嘗試解析，壞掉就當沒登入。"""
    auth = request.headers.get("Authorization") or ""
    parts = auth.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    try:
        payload = _decode_jwt(parts[1])
        if payload.get("typ") != "access":
            return None
        return int(payload.get("sub") or 0) or None
    except PermissionError:
        return None

# ===== Refresh cookie helpers =====

def get_refresh_token() -> Optional[str]:
    return request.cookies.get(REFRESH_COOKIE_NAME)


def verify_refresh_token(token: str) -> int:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise PermissionError("refresh_expired")
    except jwt.InvalidTokenError:
        raise PermissionError("invalid_refresh")

    if payload.get("typ") != "refresh":
        raise PermissionError("invalid_refresh")

    sub = payload.get("sub")
    if not sub:
        raise PermissionError("invalid_refresh")

    return int(sub)


def set_refresh_cookie(resp, token: str) -> None:
    # request.is_secure 會受 ProxyFix + X-Forwarded-Proto 影響（ngrok https 時會是 True）
    secure = bool(getattr(request, "is_secure", False))
    max_age = int(REFRESH_TOKEN_DAYS * 24 * 60 * 60)

    resp.set_cookie(
        REFRESH_COOKIE_NAME,
        token,
        max_age=max_age,
        httponly=True,
        samesite="Lax",
        secure=secure,
        path=REFRESH_COOKIE_PATH,
    )


def clear_refresh_cookie(resp) -> None:
    resp.delete_cookie(REFRESH_COOKIE_NAME, path=REFRESH_COOKIE_PATH)
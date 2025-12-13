from .config import Config

from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from flask import request

JWT_SECRET = Config.JWT_SECRET
JWT_EXPIRE_MINUTES = Config.JWT_EXPIRE_MINUTES

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
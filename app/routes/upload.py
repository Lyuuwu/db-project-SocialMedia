import os
import uuid
from pathlib import Path
from flask import Blueprint, jsonify, request, send_from_directory, current_app

from ..errors import api_error

bp = Blueprint("upload", __name__)

ALLOWED_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}

def get_upload_dir() -> str:
    # 放在 app/uploads
    base = os.path.dirname(os.path.dirname(__file__))  # .../app
    upload_dir = os.path.join(base, "uploads")
    os.makedirs(upload_dir, exist_ok=True)
    return upload_dir

@bp.post("/api/upload")
def upload_image():
    f = request.files.get("file")
    if not f or not f.filename:
        return api_error(400, "VALIDATION_ERROR", "No file uploaded.", [{"field": "file", "reason": "required"}])

    suffix = Path(f.filename).suffix.lower()
    ext = suffix[1:] if suffix.startswith(".") else ""
    if ext not in ALLOWED_EXT:
        ext = MIME_TO_EXT.get((f.mimetype or "").lower(), "")
    if ext not in ALLOWED_EXT:
        return api_error(400, "VALIDATION_ERROR", "Unsupported file type.", [{"field": "file", "reason": "invalid_type"}])

    new_name = f"{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(get_upload_dir(), new_name)
    f.save(save_path)
    return jsonify({"url": f"/uploads/{new_name}"}), 201

@bp.get("/uploads/<path:filename>")
def serve_upload(filename: str):
    return send_from_directory(get_upload_dir(), filename)

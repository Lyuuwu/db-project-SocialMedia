from flask import Blueprint, current_app


bp = Blueprint("pages", __name__)


@bp.get("/")
def index():
    return current_app.send_static_file("index.html")

@bp.get("/u/<int:user_id>")
def profile_page(user_id: int):
    return current_app.send_static_file("profile.html")

@bp.get("/create")
def create_page():
    return current_app.send_static_file("create.html")

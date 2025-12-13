from flask import Blueprint, current_app


bp = Blueprint("pages", __name__)


@bp.get("/")
def index():
    # 直接走 Flask 的 static_folder（預設是 app/static）
    # 這樣 index.html / app.js / app.css 都會由 /static/... 提供
    return current_app.send_static_file("index.html")

from flask import Blueprint, send_from_directory

bp = Blueprint("pages", __name__)

@bp.get("/")
def index():
    return send_from_directory("static", "index.html")

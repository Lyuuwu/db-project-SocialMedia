from flask import Blueprint, jsonify
from ..db import get_conn

bp = Blueprint("health", __name__)

@bp.get("/db_test")
def db_test():
    try:
        with get_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT @@SERVERNAME, DB_NAME(), SUSER_SNAME()")
            server_name, db_name, login_name = cur.fetchone()
        return jsonify({"ok": True, "server": server_name, "db": db_name, "login": login_name})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

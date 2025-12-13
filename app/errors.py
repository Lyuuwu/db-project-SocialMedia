from typing import Dict, List, Optional
from flask import jsonify

def api_error(http_status: int, code: str, message: str, details: Optional[List[Dict[str, str]]] = None):
    payload = {"error": {"code": code, "message": message, "details": details or []}}
    return jsonify(payload), http_status

import re
import pyodbc
from .config import Config

SAFE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

if not SAFE_IDENT_RE.match(Config.DB_SCHEMA):
    raise RuntimeError("Invalid SCHEMA in env. Use only letters/numbers/underscore.")

def tbl(name: str) -> str:
    if not SAFE_IDENT_RE.match(name):
        raise RuntimeError("Invalid table name.")
    return f"[{Config.DB_SCHEMA}].[{name}]"

def build_conn_str() -> str:
    return (
        f"DRIVER={{{Config.DRIVER}}};"
        f"SERVER={Config.SERVER};"
        f"DATABASE={Config.DATABASE};"
        f"UID={Config.UID};"
        f"PWD={Config.PWD};"
        f"Encrypt={Config.ENCRYPT};"
        f"TrustServerCertificate={Config.TRUST_SERVER_CERT};"
    )

CONN_STR = build_conn_str()

def get_conn() -> pyodbc.Connection:
    return pyodbc.connect(CONN_STR, timeout=5)

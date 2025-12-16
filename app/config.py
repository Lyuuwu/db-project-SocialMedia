import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    API_PREFIX = "/api/v1"

    DRIVER = os.environ.get("DRIVER", "ODBC Driver 17 for SQL Server")
    SERVER = os.environ.get("SERVER", "localhost")
    DATABASE = os.environ.get("DATABASE", "test")
    UID = os.environ.get("UID", "sa")
    PWD = os.environ.get("PWD", "59576680")
    ENCRYPT = os.environ.get("ENCRYPT", "no")
    TRUST_SERVER_CERT = os.environ.get("TRUST_SERVER_CERT", "yes")

    JWT_SECRET = os.environ.get("JWT_SECRET", "change_me")
    ACCESS_TOKEN_MINUTES = int(os.environ.get("ACCESS_TOKEN_MINUTES", os.environ.get("JWT_EXPIRE_MINUTES", "120")))

    REFRESH_TOKEN_DAYS = int(os.environ.get("REFRESH_TOKEN_DAYS", "14"))
    REFRESH_COOKIE_NAME = os.environ.get("REFRESH_COOKIE_NAME", "miniig_refresh")
    
    UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")

    DB_SCHEMA = os.environ.get("SCHEMA", "dbo")

    MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 10MB

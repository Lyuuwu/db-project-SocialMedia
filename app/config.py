import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    API_PREFIX = "/api/v1"

    DRIVER = os.environ["DRIVER"]
    SERVER = os.environ["SERVER"]
    DATABASE = os.environ["DATABASE"]
    UID = os.environ["UID"]
    PWD = os.environ["PWD"]
    ENCRYPT = os.environ.get("ENCRYPT", "no")
    TRUST_SERVER_CERT = os.environ.get("TRUST_SERVER_CERT", "yes")

    JWT_SECRET = os.environ.get("JWT_SECRET", "change_me")
    JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "120"))

    DB_SCHEMA = os.environ.get("SCHEMA", "dbo")

    MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 10MB

from flask import Flask
from .config import Config
from .routes.pages import bp as pages_bp
from .routes.health import bp as health_bp
from .routes.auth import bp as auth_bp
from .routes.users import bp as users_bp
from .routes.posts import bp as posts_bp
from .routes.comments import bp as comments_bp
from .routes.upload import bp as upload_bp

def create_app():
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.config.from_object(Config)

    # routes
    app.register_blueprint(pages_bp)
    app.register_blueprint(health_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(users_bp)
    app.register_blueprint(posts_bp)
    app.register_blueprint(comments_bp)
    app.register_blueprint(upload_bp)

    return app

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from app.core.config import get_settings

settings = get_settings()
# MedSync ORM models use unqualified table names (schema "medsync"); DischargeLoop SQL is always schema-qualified.
connect_args = ({"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite")
                else {"options": "-c search_path=medsync,dischargeloop,public"})
engine = create_engine(settings.DATABASE_URL, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

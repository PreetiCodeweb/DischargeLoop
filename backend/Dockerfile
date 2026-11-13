# Build context is the repository root (see docker-compose.yml) so the image carries db/ for migrations.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MIGRATIONS_DIR=/app/db
WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --default-timeout=100 --no-cache-dir -r requirements.txt

# Run as an unprivileged user; only the model artifact directory needs to be writable.
RUN useradd --system --uid 10001 --create-home --home-dir /home/app app
COPY backend/app ./app
COPY db ./db
RUN mkdir -p /app/data/models && chown -R app:app /app/data

USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]

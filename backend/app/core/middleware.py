from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import IntegrityError
from starlette.middleware.base import BaseHTTPMiddleware
import logging

logger = logging.getLogger(__name__)

class ErrorHandlingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        try:
            response = await call_next(request)
            return response
        # Log exception *types* only: messages from validation and database errors can contain patient data.
        except RequestValidationError as exc:
            logger.warning("Validation error", extra={"route": request.url.path})
            return JSONResponse(
                status_code=422,
                content={
                    "error": "Validation error",
                    "details": [{"field": str(e.get("loc", []))[-1], "message": e.get("msg", "")} for e in exc.errors()],
                },
            )
        except IntegrityError:
            logger.error("Database integrity error", extra={"route": request.url.path})
            return JSONResponse(
                status_code=409,
                content={"error": "Conflict", "message": "A resource with this identifier already exists."},
            )
        except ValueError as exc:
            logger.warning("Value error", extra={"route": request.url.path})
            return JSONResponse(status_code=400, content={"error": "Bad request", "message": str(exc)})
        except Exception as exc:
            logger.error("Unhandled error %s", type(exc).__name__, extra={"route": request.url.path})
            return JSONResponse(
                status_code=500,
                content={"error": "Internal server error", "message": "An unexpected error occurred."},
            )

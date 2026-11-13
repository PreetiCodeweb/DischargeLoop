from dataclasses import asdict

from sqlalchemy.orm import Session
from app.models.models import DepartmentType
from app.ml.data_utils import load_history
from app.ml.predictor import ForecastResult, get_predictor
from app.schemas.schemas import ForecastPoint, ForecastResponse, FullForecastResponse


def to_forecast_response(forecast: ForecastResult) -> ForecastResponse:
    # The predictor returns dataclasses; Pydantic v2 does not coerce arbitrary objects into
    # nested models, so the points are converted explicitly.
    return ForecastResponse(
        model_name=forecast.model_name,
        current_value=forecast.current_value,
        points=[ForecastPoint(**asdict(point)) for point in forecast.points],
        training_rows=forecast.training_rows,
        mae=forecast.mae,
    )


def run_forecast(db: Session, department_type: DepartmentType, metric: str, horizon_hours: int) -> ForecastResponse:
    history = load_history(db, department_type)
    result = get_predictor(department_type, metric)
    result.train(history)
    return to_forecast_response(result.forecast(history, horizon_hours))

def run_full_forecast(db: Session, department_type: DepartmentType, horizon_hours: int) -> FullForecastResponse:
    response = run_forecast(db, department_type, "occupancy_pct", horizon_hours)
    return FullForecastResponse(department_type=department_type, metric="occupancy_pct", **response.model_dump())

from datetime import datetime, timezone

from app.ml.predictor import ForecastPointResult, ForecastResult
from app.services.forecasting import to_forecast_response


def test_forecast_response_accepts_predictor_dataclasses():
    point = ForecastPointResult(
        timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
        value=70.0,
        lower_bound=65.0,
        upper_bound=75.0,
    )
    forecast = ForecastResult(model_name="baseline", current_value=68.0, points=[point], training_rows=100, mae=1.5)

    response = to_forecast_response(forecast)

    assert response.points[0].value == 70.0
    assert response.points[0].upper_bound == 75.0
    assert response.training_rows == 100

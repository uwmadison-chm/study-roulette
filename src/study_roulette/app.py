import json
import logging
import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from .redirect import get_or_create_redirect
from .settings import Settings
from .studies import (
    Fallback,
    StudiesFileError,
    Study,
    eligible_studies,
    parse_studies_file,
)

logger = logging.getLogger(__name__)


class HealthStatus(str, Enum):
    OK = "ok"
    ERROR = "error"

    @property
    def http_status_code(self) -> int:
        return 200 if self == HealthStatus.OK else 500


class NoParamsError(LookupError):
    """Used if _no_ URL params are passed"""

    pass


@dataclass
class StudyRoulette:
    """
    Core application state after checking all dependencies.

    Use `build_and_check()` to create an instance - it never raises,
    instead capturing any errors in the `errors` list.
    """

    status: HealthStatus
    errors: list[str]
    studies: list[Study]
    fallback: Fallback | None
    lookup_dir: Path
    studies_file: Path

    @classmethod
    def from_settings(cls, settings: Settings) -> "StudyRoulette":
        return cls.build_and_check(settings.lookup_dir, settings.studies_file)

    @classmethod
    def build_and_check(cls, lookup_dir: Path, studies_file: Path) -> "StudyRoulette":
        """
        Build a StudyRoulette, checking all dependencies.

        This method never raises - all errors are captured in the returned object.
        """
        logger.debug(
            "Building StudyRoulette with lookup_dir=%s, studies_file=%s",
            lookup_dir,
            studies_file,
        )
        errors: list[str] = []
        studies: list[Study] = []
        fallback: Fallback | None = None

        # Check/create lookup_dir
        if not lookup_dir.exists():
            logger.debug(
                "lookup_dir %s does not exist, attempting to create", lookup_dir
            )
            try:
                lookup_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                errors.append(f"Cannot create LOOKUP_DIR: {e}")

        if lookup_dir.exists():
            if not os.access(lookup_dir, os.R_OK):
                errors.append(f"LOOKUP_DIR is not readable: {lookup_dir}")
            if not os.access(lookup_dir, os.W_OK):
                errors.append(f"LOOKUP_DIR is not writable: {lookup_dir}")

            try:
                test_file = lookup_dir / ".health_check"
                test_file.write_text("test")
                test_file.read_text()
                test_file.unlink()
            except OSError as e:
                errors.append(f"Cannot read/write in LOOKUP_DIR: {e}")

        try:
            result = parse_studies_file(studies_file)
            studies = result.studies
            fallback = result.fallback
            errors.extend(result.errors)
        except StudiesFileError as e:
            errors.append(str(e))

        status = HealthStatus.ERROR if errors else HealthStatus.OK

        if errors:
            logger.debug("StudyRoulette found errors: %s", errors)
        else:
            logger.debug("StudyRoulette ready with %d studies", len(studies))

        return cls(
            status=status,
            errors=errors,
            studies=studies,
            fallback=fallback,
            lookup_dir=lookup_dir,
            studies_file=studies_file,
        )

    def health_content(
        self, params: dict[str, list[str]] | None = None
    ) -> dict[str, Any]:
        """
        The JSON-able content for /health.

        Without params, studies show their raw weight but no percent -- percent
        isn't computable in general, since it depends on which studies a given
        URL is eligible for. With params, each study gets an eligible_for_params
        boolean, and eligible studies get a percent normalized over the
        eligible set.
        """
        content: dict[str, Any] = {
            "status": self.status.value,
            "errors": self.errors,
            "studies": [self._study_info(s, params) for s in self.studies],
        }
        if self.fallback is not None:
            fallback_info: dict[str, Any] = {"url": self.fallback.url}
            if self.fallback.note is not None:
                fallback_info["note"] = self.fallback.note
            content["fallback"] = fallback_info
        return content

    def _study_info(
        self, study: Study, params: dict[str, list[str]] | None
    ) -> dict[str, Any]:
        info: dict[str, Any] = {
            "url": study.url,
            "weight": study.weight,
            "required_params": study.required_params,
        }
        if study.key_params is not None:
            info["key_params"] = study.key_params
        if study.note is not None:
            info["note"] = study.note

        if params is not None:
            eligible = all(p in params for p in study.required_params)
            info["eligible_for_params"] = eligible
            if eligible:
                total = sum(s.weight for s in eligible_studies(self.studies, params))
                percent = round(100 * study.weight / total, 2) if total > 0 else 0.0
                info["percent"] = percent

        return info

    def get_or_create_redirect(self, params: dict[str, list[str]]) -> str:
        """Get or create a redirect URL for the given parameters."""
        if len(params.keys()) == 0:
            raise NoParamsError("No parameters specified")
        if self.fallback is None:
            raise ValueError("No fallback configured")

        return get_or_create_redirect(
            self.lookup_dir, self.studies, self.fallback, params
        )

    def with_error(self, error: str) -> "StudyRoulette":
        """Return a new StudyRoulette with an additional error."""
        return StudyRoulette(
            status=HealthStatus.ERROR,
            errors=[*self.errors, error],
            studies=self.studies,
            fallback=self.fallback,
            lookup_dir=self.lookup_dir,
            studies_file=self.studies_file,
        )


class PrettyJSONResponse(JSONResponse):
    """
    A human looking at the /health output is actually a normal thing to do
    with this application, so we do want it to be readable
    """

    def render(self, content: Any) -> bytes:
        return json.dumps(content, ensure_ascii=False, indent=2).encode()


class HealthResponse(PrettyJSONResponse):
    """JSON response for health check and error conditions."""

    def __init__(
        self,
        roulette: StudyRoulette,
        params: dict[str, list[str]] | None = None,
        **kwargs: Any,
    ):
        super().__init__(
            content=roulette.health_content(params),
            status_code=roulette.status.http_status_code,
            **kwargs,
        )


def query_params(request: Request) -> dict[str, list[str]]:
    params: dict[str, list[str]] = {}
    for key, value in request.query_params.multi_items():
        if key not in params:
            params[key] = []
        params[key].append(value)
    return params


def build_app(settings: Settings | None = None) -> FastAPI:
    if settings is None:
        settings = Settings()  # type: ignore[call-arg]
    settings.configure_logging()
    app = FastAPI(
        title="Study Roulette", docs_url=None, redoc_url=None, openapi_url=None
    )

    @app.api_route("/health", methods=["GET", "HEAD"])
    def health(request: Request) -> Response:
        roulette = StudyRoulette.build_and_check(
            settings.lookup_dir, settings.studies_file
        )
        if request.method == "HEAD":
            return Response(status_code=roulette.status.http_status_code)
        return HealthResponse(roulette, query_params(request) or None)

    @app.get("/")
    def redirect(request: Request) -> Response:
        logger.debug(
            "Received redirect request with query string: %s", request.url.query
        )
        roulette = StudyRoulette.build_and_check(
            settings.lookup_dir, settings.studies_file
        )

        if roulette.fallback is None:
            return HealthResponse(roulette)

        params = query_params(request)
        logger.debug(f"Parsed parameters: {params}")

        try:
            destination = roulette.get_or_create_redirect(params)
            logger.debug(
                f"Redirecting to: {destination}",
            )
            return RedirectResponse(url=destination, status_code=302)
        except NoParamsError as e:
            return JSONResponse({"errors": [str(e)]}, status_code=404)
        except Exception as e:
            logger.debug(f"Redirect failed with error: {e}")
            return HealthResponse(roulette.with_error(str(e)))

    return app

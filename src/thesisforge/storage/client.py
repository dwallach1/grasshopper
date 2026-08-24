"""Small server-only client for the Supabase Storage REST API."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from urllib.parse import quote

from thesisforge.db.connection import load_local_env

RESEARCH_BUCKET = "research-originals"
MAX_FILE_SIZE = 50 * 1024 * 1024


class StorageError(RuntimeError):
    """A Supabase Storage request failed."""

    def __init__(self, method: str, path: str, status: int | None, detail: str):
        self.method = method
        self.path = path
        self.status = status
        self.detail = detail
        suffix = f" ({status})" if status is not None else ""
        super().__init__(f"Supabase Storage {method} {path} failed{suffix}: {detail}")


class StorageClient:
    """Trusted-client Storage operations using a server-only secret key."""

    def __init__(self, url: str | None = None, secret_key: str | None = None):
        load_local_env()
        self.url = (url or os.environ.get("SUPABASE_URL") or "").rstrip("/")
        self.secret_key = secret_key or os.environ.get("SUPABASE_SECRET_KEY") or ""
        if not self.url or not self.secret_key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY are required for research Storage")

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        content_type: str | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> tuple[int, bytes]:
        headers = {
            "apikey": self.secret_key,
            "Authorization": f"Bearer {self.secret_key}",
            "User-Agent": "ThesisForge/0.1 research-archive",
        }
        if content_type:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            f"{self.url}/storage/v1{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status = int(response.status)
                payload = response.read()
        except urllib.error.HTTPError as exc:
            status = int(exc.code)
            payload = exc.read()
        except Exception as exc:
            raise StorageError(method, path, None, f"{type(exc).__name__}: {exc}") from exc
        if status not in expected:
            detail = payload.decode("utf-8", errors="replace")[:1000]
            raise StorageError(method, path, status, detail)
        return status, payload

    def get_bucket(self, bucket: str) -> dict | None:
        encoded = quote(bucket, safe="")
        try:
            status, payload = self._request("GET", f"/bucket/{encoded}", expected=(200, 404))
        except StorageError as exc:
            # Hosted Storage currently reports a missing bucket as HTTP 400
            # with code=NoSuchBucket, rather than HTTP 404.
            if exc.status == 400 and ("NoSuchBucket" in exc.detail or "Bucket not found" in exc.detail):
                return None
            raise
        return None if status == 404 else json.loads(payload or b"{}")

    def ensure_private_bucket(self, bucket: str = RESEARCH_BUCKET) -> dict:
        """Create or reconcile the private 50 MiB research bucket."""
        existing = self.get_bucket(bucket)
        desired = {"public": False, "file_size_limit": MAX_FILE_SIZE}
        if existing is None:
            payload = json.dumps({"id": bucket, "name": bucket, **desired}).encode()
            self._request("POST", "/bucket/", body=payload, content_type="application/json")
        elif existing.get("public") is not False or existing.get("file_size_limit") != MAX_FILE_SIZE:
            payload = json.dumps(desired).encode()
            self._request(
                "PUT",
                f"/bucket/{quote(bucket, safe='')}",
                body=payload,
                content_type="application/json",
            )
        reconciled = self.get_bucket(bucket)
        if reconciled is None or reconciled.get("public") is not False:
            raise StorageError("GET", f"/bucket/{bucket}", None, "private bucket verification failed")
        return reconciled

    def upload_immutable(self, bucket: str, path: str, data: bytes, mime_type: str) -> bool:
        """Upload once; return False when the content-addressed object already exists."""
        if len(data) > MAX_FILE_SIZE:
            raise ValueError(f"Research original exceeds the {MAX_FILE_SIZE}-byte bucket limit")
        encoded_bucket = quote(bucket, safe="")
        encoded_path = quote(path, safe="/")
        try:
            self._request(
                "POST",
                f"/object/{encoded_bucket}/{encoded_path}",
                body=data,
                content_type=mime_type,
            )
            return True
        except StorageError as exc:
            if exc.status == 409:
                return False
            raise

    def download(self, bucket: str, path: str) -> bytes:
        encoded_bucket = quote(bucket, safe="")
        encoded_path = quote(path, safe="/")
        return self._request("GET", f"/object/{encoded_bucket}/{encoded_path}")[1]

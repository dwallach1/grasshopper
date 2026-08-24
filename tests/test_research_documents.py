from __future__ import annotations

import unittest

from thesisforge.research.documents import (
    clean_html,
    document_type_for,
    extract_text,
    object_path_for,
    parse_entity,
)
from thesisforge.storage.client import MAX_FILE_SIZE, StorageClient, StorageError


class ResearchDocumentTests(unittest.TestCase):
    def test_html_extraction_removes_navigation_and_scripts(self) -> None:
        title, text = clean_html(
            "<html><title>Grid &amp; Power</title><nav>menu</nav>"
            "<script>ignore()</script><main><h1>Demand</h1><p>Rising fast.</p></main></html>"
        )
        self.assertEqual(title, "Grid & Power")
        self.assertIn("Demand", text)
        self.assertIn("Rising fast.", text)
        self.assertNotIn("ignore", text)
        self.assertNotIn("menu", text)

    def test_plain_text_is_searchable_and_binary_is_not(self) -> None:
        extracted = extract_text(b"bullish grid demand", "text/plain; charset=utf-8")
        self.assertEqual(extracted.status, "complete")
        self.assertEqual(extracted.text, "bullish grid demand")
        unsupported = extract_text(b"\x00\x01", "application/octet-stream")
        self.assertEqual(unsupported.status, "unsupported")
        self.assertIsNone(unsupported.text)

    def test_content_addressed_path_is_stable_and_not_sentiment_based(self) -> None:
        checksum = "a" * 64
        path = object_path_for(
            checksum,
            "filing",
            "2026-08-24T12:00:00+00:00",
            "application/pdf",
            "https://example.com/10-q.pdf",
        )
        self.assertEqual(path, f"filing/2026/08/{checksum}.pdf")
        self.assertNotIn("bullish", path)

    def test_document_type_and_entity_annotation_parsing(self) -> None:
        self.assertEqual(document_type_for("application/pdf", "report.pdf"), "pdf")
        self.assertEqual(parse_entity("NVDA:bullish:75"), ("NVDA", "bullish", 75))
        with self.assertRaises(Exception):
            parse_entity("NVDA:excited")


class FakeStorageClient(StorageClient):
    def __init__(self, existing: dict | None):
        super().__init__("https://project.supabase.co", "server-secret")
        self.existing = existing
        self.calls: list[tuple[str, str]] = []

    def get_bucket(self, bucket: str) -> dict | None:
        return self.existing

    def _request(self, method: str, path: str, **kwargs):
        self.calls.append((method, path))
        if method == "POST" and path == "/bucket/":
            self.existing = {
                "id": "research-originals",
                "public": False,
                "file_size_limit": MAX_FILE_SIZE,
            }
        elif method == "PUT":
            self.existing = {
                **(self.existing or {}),
                "public": False,
                "file_size_limit": MAX_FILE_SIZE,
            }
        return 200, b"{}"


class StorageClientTests(unittest.TestCase):
    def test_get_bucket_accepts_hosted_no_such_bucket_response(self) -> None:
        client = StorageClient("https://project.supabase.co", "server-secret")

        def missing(method: str, path: str, **kwargs):
            raise StorageError(method, path, 400, '{"code":"NoSuchBucket","message":"Bucket not found"}')

        client._request = missing  # type: ignore[method-assign]
        self.assertIsNone(client.get_bucket("research-originals"))

    def test_setup_creates_private_bucket_through_api(self) -> None:
        client = FakeStorageClient(None)
        bucket = client.ensure_private_bucket()
        self.assertFalse(bucket["public"])
        self.assertIn(("POST", "/bucket/"), client.calls)

    def test_setup_reconciles_public_or_misconfigured_bucket(self) -> None:
        client = FakeStorageClient(
            {"id": "research-originals", "public": True, "file_size_limit": 1000}
        )
        bucket = client.ensure_private_bucket()
        self.assertFalse(bucket["public"])
        self.assertIn(("PUT", "/bucket/research-originals"), client.calls)

    def test_immutable_upload_treats_conflict_as_existing(self) -> None:
        client = FakeStorageClient(None)

        def conflict(method: str, path: str, **kwargs):
            raise StorageError(method, path, 409, "already exists")

        client._request = conflict  # type: ignore[method-assign]
        self.assertFalse(client.upload_immutable("research-originals", "pdf/a.pdf", b"pdf", "application/pdf"))


if __name__ == "__main__":
    unittest.main()

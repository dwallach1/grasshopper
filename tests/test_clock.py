from __future__ import annotations

import unittest

from thesisforge.clock import utc_now_iso


class ClockTests(unittest.TestCase):
    def test_zulu_format_is_the_default(self) -> None:
        self.assertTrue(utc_now_iso().endswith("Z"))

    def test_offset_format_remains_available(self) -> None:
        self.assertTrue(utc_now_iso(zulu=False).endswith("+00:00"))


if __name__ == "__main__":
    unittest.main()

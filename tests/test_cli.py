from __future__ import annotations

import contextlib
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from thesisforge import cli


class CliTests(unittest.TestCase):
    def test_help_lists_unified_commands(self) -> None:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            cli.main(["--help"])
        self.assertIn("bookmarks ingest", output.getvalue())
        self.assertIn("ontology refresh", output.getvalue())
        self.assertIn("research capture", output.getvalue())

    def test_dispatch_forwards_remaining_arguments(self) -> None:
        received_argv = []
        module = SimpleNamespace(main=lambda: received_argv.append(list(cli.sys.argv)))
        with patch.object(cli.sys, "argv", []):
            with patch("thesisforge.cli.importlib.import_module", return_value=module):
                cli.main(["articles", "fetch", "--limit", "5"])
            self.assertEqual(received_argv, [["thesisforge articles fetch", "--limit", "5"]])
            self.assertEqual(cli.sys.argv, [])

    def test_unknown_command_exits_with_usage(self) -> None:
        with self.assertRaisesRegex(SystemExit, "Unknown command"):
            cli.main(["missing"])


if __name__ == "__main__":
    unittest.main()

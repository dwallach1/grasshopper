import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "config" / "trade_policy.json"


def walk_keys(value, prefix=()):
    if isinstance(value, dict):
        for key, child in value.items():
            path = (*prefix, key)
            yield path
            yield from walk_keys(child, path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk_keys(child, (*prefix, str(index)))


class TradePolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = json.loads(POLICY_PATH.read_text())
        cls.paths = list(walk_keys(cls.policy))

    def test_policy_contains_no_account_identity_or_dollar_caps(self):
        forbidden_keys = {
            "account_number",
            "account_label",
            "starting_cash",
            "target_allocation_percent_of_account",
            "approved_symbol_overrides_percent_of_equity",
        }
        keys = {path[-1] for path in self.paths}
        self.assertTrue(forbidden_keys.isdisjoint(keys))
        self.assertFalse([path for path in self.paths if path[-1].endswith("_usd")])

    def test_policy_contains_no_ticker_specific_sizing(self):
        sizing_paths = [path for path in self.paths if path and path[0] == "sizing"]
        self.assertFalse(
            [path for path in sizing_paths if "symbol" in path[-1] or "ticker" in path[-1]]
        )

    def test_sizing_requires_fresh_supabase_backed_broker_state(self):
        state = self.policy["account_state"]
        self.assertEqual(state["source"], "robinhood")
        self.assertTrue(state["refresh_before_sizing"])
        self.assertTrue(state["reject_if_unavailable_or_stale"])
        self.assertEqual(state["persist_account_snapshots_to"], "supabase.account_snapshots")
        self.assertEqual(state["persist_positions_to"], "supabase.portfolio_exposure")

        sizing = self.policy["sizing"]
        self.assertEqual(state["sizing_portfolio_value_field"], "total_value")
        self.assertIn("max_total_deployed_percent_of_portfolio_value", sizing)
        self.assertIn("max_single_trade_percent_of_portfolio_value", sizing)


if __name__ == "__main__":
    unittest.main()

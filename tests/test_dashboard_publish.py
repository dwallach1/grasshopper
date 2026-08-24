import unittest

from thesisforge.dashboard.publish import POLICY_PATH, trade_policy


class DashboardPublishTests(unittest.TestCase):
    def test_dashboard_uses_canonical_trade_policy(self):
        policy = trade_policy()

        self.assertTrue(POLICY_PATH.is_file())
        self.assertEqual(policy["sizing"]["max_single_trade_percent_of_portfolio_value"], 10)
        self.assertEqual(policy["sizing"]["tactical_swing_sleeve"]["target_percent_of_portfolio_value"], 20)


if __name__ == "__main__":
    unittest.main()

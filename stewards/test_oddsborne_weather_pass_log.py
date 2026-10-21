"""ODDSBORNE weather pass log: observation and skip reason on every row. No network."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "weather_pass_log", Path(__file__).resolve().parent / "oddsborne" / "weather_pass_log.py")
W = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(W)

SLUGS = [
    "temp-nychigh-2026-10-21-gte64lt65f",
    "temp-nychigh-2026-10-21-gte66lt67f",
    "temp-nychigh-2026-10-21-gte70f",
]
FAV = {"slug": SLUGS[2], "bid": 0.52, "ask": 0.58, "mid": 0.55}
OBS = {
    "station": "KNYC",
    "observed_at": "2026-10-21T14:51:00+00:00",
    "temp_f": 71.0,
    "raw_metar": "METAR KNYC 211451Z 18010KT 10SM FEW050 22/10 A3010",
    "source": W.OBS_SOURCE,
    "max_so_far": 71.0,
}


def rows(**kw):
    args = dict(date="2026-10-21", city="NYC", slugs=SLUGS, favorite=FAV, nws=65, hmax=65,
                observed_at="2026-10-21T15:00:00+00:00", basis="live_bbo", obs=OBS, obs_missing_reason=None)
    args.update(kw)
    return W.build_rows(**args)


class WeatherPassLogTests(unittest.TestCase):
    def test_obs_present_names_the_reading_and_the_forecast_skip(self):
        built = rows()
        self.assertEqual([r["side"] for r in built], ["yes", "no"])
        meta = built[0]["meta"]
        self.assertEqual(meta["skip_reason"], "forecast_below_favorite")
        self.assertEqual(meta["obs"]["station"], "KNYC")
        self.assertEqual(meta["obs"]["observed_at"], "2026-10-21T14:51:00+00:00")
        self.assertEqual(meta["obs"]["temp_f"], 71.0)
        self.assertIn("METAR KNYC", meta["obs"]["raw_metar"])
        self.assertEqual(meta["obs"]["source"], W.OBS_SOURCE)
        self.assertEqual(meta["obs"]["max_so_far"], 71.0)
        self.assertNotIn("obs_missing_reason", meta)
        self.assertIn("obs KNYC 14:51Z 71F", built[0]["reason"])
        self.assertIn("forecast", meta["mismatch_reason"])

    def test_obs_missing_and_the_other_skip_reasons(self):
        missing = rows(nws=71, hmax=71, obs=None, obs_missing_reason="latest_missing_temperature")
        self.assertIsNone(missing[0]["meta"]["obs"])
        self.assertEqual(missing[0]["meta"]["obs_missing_reason"], "latest_missing_temperature")
        self.assertEqual(missing[0]["meta"]["skip_reason"], "obs_unavailable")
        self.assertIn("obs missing", missing[0]["reason"])
        both = rows(obs=None, obs_missing_reason="latest_missing_temperature")
        self.assertEqual(both[0]["meta"]["skip_reason"], "forecast_below_favorite")
        self.assertIsNone(both[0]["meta"]["obs"])

        grid = rows(nws=71, hmax=60)
        self.assertEqual(grid[0]["meta"]["skip_reason"], "station_grid_disagree")
        self.assertIn("grid vs station disagree", grid[0]["meta"]["mismatch_reason"])

        flat = rows(nws=71, hmax=71)
        self.assertEqual(flat[0]["meta"]["skip_reason"], "no_edge_at_market_mid")
        self.assertNotIn("mismatch_reason", flat[0]["meta"])

        above = rows(nws=80, hmax=80, favorite={"slug": SLUGS[0], "bid": 0.4, "ask": 0.46, "mid": 0.43})
        self.assertEqual(above[0]["meta"]["skip_reason"], "forecast_above_favorite")

        self.assertEqual(W.skip_reason_for(apart=None, nws=None, hmax=None, obs=None, quoted=False), "book_missing_side")
        one_side = rows(favorite={"slug": SLUGS[2], "bid": None, "ask": 0.58, "mid": 0.55})
        self.assertEqual([r["side"] for r in one_side], ["yes"])

    def test_nws_observation_uses_the_api_and_does_not_invent(self):
        calls = []

        def fake(url):
            calls.append(url)
            if url.endswith("/observations/latest"):
                return {"properties": {
                    "timestamp": "2026-10-21T14:51:00+00:00",
                    "temperature": {"unitCode": "wmoUnit:degC", "value": 22},
                    "rawMessage": "METAR KNYC 211451Z",
                }}
            return {"features": [
                {"properties": {
                    "timestamp": "2026-10-21T14:51:00+00:00",
                    "temperature": {"unitCode": "wmoUnit:degF", "value": 71.6},
                    "rawMessage": "METAR KNYC 211451Z",
                }},
                {"properties": {
                    "timestamp": "2026-10-21T12:51:00+00:00",
                    "temperature": {"unitCode": "wmoUnit:degF", "value": 68},
                    "rawMessage": "METAR KNYC 211251Z",
                }},
                {"properties": {
                    "timestamp": "2026-10-20T23:51:00+00:00",
                    "temperature": {"unitCode": "wmoUnit:degF", "value": 90},
                    "rawMessage": "METAR KNYC 202351Z",
                }},
            ]}

        W.http_json = fake
        obs, missing = W.nws_observation("KNYC", "2026-10-21", "America/New_York")
        self.assertIsNone(missing)
        self.assertEqual(obs["temp_f"], 71.6)  # 22C, not a guessed whole number
        self.assertEqual(obs["raw_metar"], "METAR KNYC 211451Z")
        self.assertEqual(obs["max_so_far"], 71.6)
        self.assertTrue(any(url.endswith("/observations/latest") for url in calls))

        def blank(url):
            return {"properties": {"timestamp": "2026-10-21T14:51:00Z", "temperature": {"value": None}}}

        W.http_json = blank
        obs, missing = W.nws_observation("KNYC", "2026-10-21", "America/New_York")
        self.assertIsNone(obs)
        self.assertEqual(missing, "latest_missing_temperature")

        def down(url):
            raise TimeoutError("offline")

        W.http_json = down
        obs, missing = W.nws_observation("KLGA", "2026-10-21", "America/New_York")
        self.assertIsNone(obs)
        self.assertEqual(missing, "latest_fetch_failed:TimeoutError")

    def test_truncated_observation_page_does_not_invent_a_max(self):
        def fake(url):
            if url.endswith("/observations/latest"):
                return {"properties": {
                    "timestamp": "2026-10-21T14:51:00Z",
                    "temperature": {"unitCode": "wmoUnit:degF", "value": 71},
                    "rawMessage": "METAR KNYC 211451Z",
                }}
            return {"features": [
                {"properties": {"timestamp": "2026-10-21T14:51:00Z", "temperature": {"unitCode": "wmoUnit:degF", "value": 71}}},
                {"properties": {"timestamp": "2026-10-21T14:00:00Z", "temperature": {"unitCode": "wmoUnit:degF", "value": 70}}},
            ]}

        W.http_json = fake
        old = W.OBS_LIST_LIMIT
        W.OBS_LIST_LIMIT = 2
        try:
            obs, missing = W.nws_observation("KNYC", "2026-10-21", "America/New_York")
        finally:
            W.OBS_LIST_LIMIT = old
        self.assertIsNone(missing)
        self.assertEqual(obs["temp_f"], 71)
        self.assertIsNone(obs["max_so_far"])
        self.assertEqual(obs["max_so_far_missing_reason"], "observations_page_truncated")

    def test_session_records_obs_only_when_the_file_has_it(self):
        def explode(url):
            raise AssertionError(url)

        W.http_json = explode
        weather = {
            "city": "NYC", "day": "2026-10-21", "nws": 65, "hmax": 65,
            "buckets": [
                {"slug": SLUGS[0], "bid": 0.2, "ask": 0.3, "mid": 0.25},
                {"slug": SLUGS[1], "bid": 0.2, "ask": 0.3, "mid": 0.25},
                {"slug": SLUGS[2], "bid": 0.52, "ask": 0.58, "mid": 0.55},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.json"
            path.write_text(json.dumps({"at": "2026-10-21T15:00:00+00:00", "weather": [weather]}))
            built, problems = W.session_rows(path, None)
            self.assertEqual(problems, [])
            self.assertIsNone(built[0]["meta"]["obs"])
            self.assertEqual(built[0]["meta"]["obs_missing_reason"], "not_recorded_in_session")
            self.assertEqual(built[0]["meta"]["skip_reason"], "forecast_below_favorite")

            weather["obs"] = OBS
            path.write_text(json.dumps({"at": "2026-10-21T15:00:00+00:00", "weather": [weather]}))
            built, problems = W.session_rows(path, None)
        self.assertEqual(problems, [])
        self.assertEqual(built[0]["meta"]["obs"]["station"], "KNYC")
        self.assertEqual(built[0]["meta"]["obs"]["temp_f"], 71.0)
        self.assertEqual(built[0]["meta"]["obs"]["raw_metar"], OBS["raw_metar"])
        self.assertNotIn("obs_missing_reason", built[0]["meta"])
        self.assertIn("obs KNYC 14:51Z 71F", built[0]["reason"])


if __name__ == "__main__":
    unittest.main()

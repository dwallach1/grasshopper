"""Unit tests for oddsborne/maker_fee.py two-way de-vig (proportional, power, Shin) and the conservative fair."""
from __future__ import annotations

import importlib.util
import math
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location("maker_fee", Path(__file__).resolve().parent / "oddsborne" / "maker_fee.py")
MF = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(MF)

LINES = [(-110, -110), (-300, 240), (-150, 130), (-200, 170), (-1000, 600), (120, -140), (-105, -115)]


def shin_closed_form_z(pa, pb):
    """Two-outcome Shin z, closed form (Jullien-Salanie): z = ((s-1)(d^2 - s)) / (s(d^2 - 1)), d = pa - pb."""
    s, d = pa + pb, pa - pb
    if abs(d) < 1e-12:
        return None
    return ((s - 1.0) * (d * d - s)) / (s * (d * d - 1.0))


class DevigTests(unittest.TestCase):
    def implied(self, a, b):
        return MF.am_to_implied(a), MF.am_to_implied(b)

    def test_american_to_implied(self):
        self.assertAlmostEqual(MF.am_to_implied(-110), 110 / 210)
        self.assertAlmostEqual(MF.am_to_implied("+240"), 100 / 340)
        self.assertAlmostEqual(MF.am_to_implied("\u2212300"), 0.75)
        self.assertIsNone(MF.am_to_implied("EVEN"))
        self.assertIsNone(MF.am_to_implied(0))

    def test_symmetric_line_is_half(self):
        pa, pb = self.implied(-110, -110)
        for fn in (MF.devig_proportional, MF.devig_power, MF.devig_shin):
            a, b = fn(pa, pb)
            self.assertAlmostEqual(a, 0.5, places=9)
            self.assertAlmostEqual(b, 0.5, places=9)

    def test_power_definition(self):
        for la, lb in LINES:
            pa, pb = self.implied(la, lb)
            a, b = MF.devig_power(pa, pb)
            self.assertAlmostEqual(a + b, 1.0, places=9)
            k = math.log(a) / math.log(pa)  # a = pa**k
            self.assertGreaterEqual(k, 1.0)
            self.assertAlmostEqual(pb ** k, b, places=7)
            self.assertAlmostEqual(pa ** k + pb ** k, 1.0, places=7)

    def test_power_known_value(self):
        # -300/+240: k solves 0.75^k + (100/340)^k = 1 -> k ~ 1.0786
        a, b = MF.devig_power(*self.implied(-300, 240))
        self.assertAlmostEqual(a, 0.733084, places=5)

    def test_shin_matches_closed_form(self):
        for la, lb in LINES:
            pa, pb = self.implied(la, lb)
            if abs(pa - pb) < 1e-9:
                continue
            z = shin_closed_form_z(pa, pb)
            s = pa + pb
            exp = (math.sqrt(z * z + 4 * (1 - z) * pa * pa / s) - z) / (2 * (1 - z))
            a, b = MF.devig_shin(pa, pb)
            self.assertAlmostEqual(a, exp, places=7, msg=(la, lb))
            self.assertAlmostEqual(a + b, 1.0, places=9)
            self.assertTrue(0 < z < 1)

    def test_shin_known_value(self):
        a, _ = MF.devig_shin(*self.implied(-300, 240))
        self.assertAlmostEqual(a, 0.727941, places=5)

    def test_favourite_longshot_ordering(self):
        """Power and Shin move probability from the underdog to the favourite vs proportional."""
        for la, lb in LINES:
            pa, pb = self.implied(la, lb)
            if abs(pa - pb) < 1e-9:
                continue
            fav_first = pa > pb
            pr, pw, sh = MF.devig_proportional(pa, pb), MF.devig_power(pa, pb), MF.devig_shin(pa, pb)
            fi, di = (0, 1) if fav_first else (1, 0)
            self.assertGreater(pw[fi], pr[fi]); self.assertGreater(sh[fi], pr[fi])
            self.assertLess(pw[di], pr[di]); self.assertLess(sh[di], pr[di])

    def test_no_overround_falls_back(self):
        self.assertEqual(MF.devig_power(0.4, 0.5), MF.devig_proportional(0.4, 0.5))
        self.assertEqual(MF.devig_shin(0.4, 0.5), MF.devig_proportional(0.4, 0.5))

    def test_conservative_min_both_sides(self):
        for la, lb in LINES:
            d = MF.devig_methods({"A": {"american": la}, "B": {"american": lb}})
            a = d["A"]
            for side in ("yes", "no"):
                cf = MF.conservative_fair(side, a["power"], a["shin"], a["prop"])
                cands = [a["prop"], a["power"], a["shin"]] if side == "yes" else [1 - a["prop"], 1 - a["power"], 1 - a["shin"]]
                self.assertAlmostEqual(cf["used"], min(cands), places=6)
                self.assertLessEqual(cf["used"], cf["prop"] + 1e-9)  # never above proportional
            # NO on A equals YES on B for each method (two-way consistency)
            no_a = MF.conservative_fair("no", a["power"], a["shin"], a["prop"])["used"]
            b = d["B"]
            yes_b = MF.conservative_fair("yes", b["power"], b["shin"], b["prop"])["used"]
            self.assertAlmostEqual(no_a, yes_b, places=5)

    def test_favourite_and_underdog_cases(self):
        d = MF.devig_methods({"F": {"american": -300}, "D": {"american": "+240"}})
        fav = MF.conservative_fair("yes", d["F"]["power"], d["F"]["shin"], d["F"]["prop"])
        dog = MF.conservative_fair("yes", d["D"]["power"], d["D"]["shin"], d["D"]["prop"])
        self.assertEqual(fav["method"], "prop")          # favourite: proportional is lowest
        self.assertEqual(dog["method"], "power")         # underdog: power shades it hardest here
        self.assertAlmostEqual(fav["used"], 0.71831, places=5)
        # ODDSBORNE's -300 YES @0.70 example: raw +2.09c, gate (0.59c haircut) +1.50c, clears the 1c bar
        self.assertAlmostEqual(MF.post_fee_maker_raw(fav["used"], 0.70), 0.020935, places=5)
        self.assertAlmostEqual(MF.post_fee_maker_gate(fav["used"], 0.70, 0.0059), 0.015035, places=5)

    def test_devig_methods_requires_clean_two_way(self):
        self.assertEqual(MF.devig_methods({"A": {"american": -110}}), {})
        self.assertEqual(MF.devig_methods({"A": {"american": -110}, "B": {"american": None}}), {})
        self.assertEqual(MF.devig_methods({"A": {"american": -110}, "B": {"american": 100}, "C": {"american": 300}}), {})
        self.assertEqual(MF.devig_methods(None), {})
        with self.assertRaises(ValueError):
            MF.conservative_fair("maybe", 0.5, 0.5, 0.5)


if __name__ == "__main__":
    unittest.main()

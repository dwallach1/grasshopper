-- Retired stewards (oddsborne, bandit) do not get the new close-lesson match helpers.
-- Revoke only; QUANTANAMO and service_role keep execute. Does not change confidence, a lesson, or a rule.
revoke execute on function private.lesson_mentions_symbol(text, text) from oddsborne_worker, bandit_worker;
revoke execute on function private.close_lot_symbol(jsonb) from oddsborne_worker, bandit_worker;
revoke execute on function private.match_trade_close_lesson(text, timestamptz, text, uuid) from oddsborne_worker, bandit_worker;
revoke execute on function private.match_belief_for_lesson(bigint) from oddsborne_worker, bandit_worker;

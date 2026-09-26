# <Rule title>

Add the rule to `tools/court/rules_data.py`; don't hand-edit the generated file. Fields:

- `id`, `title`, `status` / `status_after` (`in_force` | `repealed` | `proposed`), `verdict` (`uphold` | `amend` | `strike`), `needs_david`
- `purpose`: the failure it prevents
- `mechanism`, `paths`: the owner code paths
- `growth`, `ruin`, `statistics`, `incentives`: the four opinions, quantified with tools/court where possible
- `evidence`, `ruling`, `amendment` (exact), `growth_cost`, `ruin_reduction`, `interactions`, `next_review`

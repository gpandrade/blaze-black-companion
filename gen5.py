#!/usr/bin/env python3
"""
gen5.py -- the Generation 5 type chart, and effectiveness helpers.

WHY THIS EXISTS
---------------
The wiki's per-species "## Defenses" tables were generated from a modern
Pokemon dataset and use the **Gen 6+ type chart**. Blaze Black is a Gen 5 ROM
hack, so those tables are wrong in two systematic ways:

  1. Gen 6 removed Steel's resistance to Ghost and to Dark. In Gen 5 Steel
     still resists both at x1/2. Every Steel-type's defensive profile in the
     wiki is therefore wrong by two entries -- this is systematic, not a pair
     of bad rows.
  2. Gen 6 added the Fairy type, which does not exist in this game at all.

Never read effectiveness off the wiki. Compute it here instead.

TYPE ORDER
----------
TYPES is written in the Gen 5 internal type-id order, so index == the type id
stored in the ROM's personal table. That ordering is asserted against the ROM
by extract_personal.py rather than trusted -- see its validation section.
"""

from __future__ import annotations

TYPES = (
    "normal", "fighting", "flying", "poison", "ground", "rock", "bug",
    "ghost", "steel", "fire", "water", "grass", "electric", "psychic",
    "ice", "dragon", "dark",
)
TYPE_INDEX = {name: i for i, name in enumerate(TYPES)}

# attacker -> {defender: multiplier}. Anything unlisted is x1.
# Gen 5 chart: no Fairy, and Steel still resists Ghost and Dark.
TYPE_CHART: dict[str, dict[str, float]] = {
    "normal":   {"rock": 0.5, "ghost": 0.0, "steel": 0.5},
    "fighting": {"normal": 2, "rock": 2, "steel": 2, "ice": 2, "dark": 2,
                 "flying": 0.5, "poison": 0.5, "bug": 0.5, "psychic": 0.5,
                 "ghost": 0.0},
    "flying":   {"fighting": 2, "bug": 2, "grass": 2,
                 "rock": 0.5, "steel": 0.5, "electric": 0.5},
    "poison":   {"grass": 2,
                 "poison": 0.5, "ground": 0.5, "rock": 0.5, "ghost": 0.5,
                 "steel": 0.0},
    "ground":   {"poison": 2, "rock": 2, "steel": 2, "fire": 2, "electric": 2,
                 "bug": 0.5, "grass": 0.5, "flying": 0.0},
    "rock":     {"flying": 2, "bug": 2, "fire": 2, "ice": 2,
                 "fighting": 0.5, "ground": 0.5, "steel": 0.5},
    "bug":      {"grass": 2, "psychic": 2, "dark": 2,
                 "fighting": 0.5, "flying": 0.5, "poison": 0.5, "ghost": 0.5,
                 "steel": 0.5, "fire": 0.5},
    "ghost":    {"ghost": 2, "psychic": 2,
                 "steel": 0.5, "dark": 0.5, "normal": 0.0},
    "steel":    {"rock": 2, "ice": 2,
                 "steel": 0.5, "fire": 0.5, "water": 0.5, "electric": 0.5},
    "fire":     {"bug": 2, "steel": 2, "grass": 2, "ice": 2,
                 "rock": 0.5, "fire": 0.5, "water": 0.5, "dragon": 0.5},
    "water":    {"ground": 2, "rock": 2, "fire": 2,
                 "water": 0.5, "grass": 0.5, "dragon": 0.5},
    "grass":    {"ground": 2, "rock": 2, "water": 2,
                 "flying": 0.5, "poison": 0.5, "bug": 0.5, "steel": 0.5,
                 "fire": 0.5, "grass": 0.5, "dragon": 0.5},
    "electric": {"flying": 2, "water": 2,
                 "grass": 0.5, "electric": 0.5, "dragon": 0.5, "ground": 0.0},
    "psychic":  {"fighting": 2, "poison": 2,
                 "steel": 0.5, "psychic": 0.5, "dark": 0.0},
    "ice":      {"flying": 2, "ground": 2, "grass": 2, "dragon": 2,
                 "steel": 0.5, "fire": 0.5, "water": 0.5, "ice": 0.5},
    "dragon":   {"dragon": 2, "steel": 0.5},
    "dark":     {"ghost": 2, "psychic": 2,
                 "fighting": 0.5, "steel": 0.5, "dark": 0.5},
}

# The two Gen 5 -> Gen 6 chart changes, kept explicit so the reason this file
# exists stays legible (and testable).
GEN6_CHART_CHANGES = (
    ("ghost", "steel", 0.5, 1.0),
    ("dark", "steel", 0.5, 1.0),
)


def effectiveness(attacking: str, defending: tuple[str, ...] | list[str]) -> float:
    """Damage multiplier of one attacking type against a defender's type(s)."""
    attacking = attacking.lower()
    if attacking not in TYPE_CHART:
        raise ValueError(f"not a Gen 5 type: {attacking!r}")
    row = TYPE_CHART[attacking]
    result = 1.0
    seen = set()
    for d in defending:
        d = d.lower()
        if d not in TYPE_INDEX:
            raise ValueError(f"not a Gen 5 type: {d!r}")
        if d in seen:          # a mono-type stored as (t, t) must not square
            continue
        seen.add(d)
        result *= row.get(d, 1.0)
    return result


def defensive_profile(defending: tuple[str, ...] | list[str]) -> dict[str, float]:
    """How every attacking type fares against this defender. Keyed by attacker."""
    return {atk: effectiveness(atk, defending) for atk in TYPES}


def weaknesses(defending, threshold: float = 2.0) -> list[str]:
    prof = defensive_profile(defending)
    return sorted((t for t, m in prof.items() if m >= threshold),
                  key=lambda t: (-prof[t], t))


def resistances(defending) -> list[str]:
    prof = defensive_profile(defending)
    return sorted((t for t, m in prof.items() if 0 < m < 1),
                  key=lambda t: (prof[t], t))


def immunities(defending) -> list[str]:
    return sorted(t for t, m in defensive_profile(defending).items() if m == 0)


def _self_check() -> None:
    """Invariants that would catch a mangled chart."""
    assert len(TYPES) == 17 and "fairy" not in TYPES
    for atk, row in TYPE_CHART.items():
        assert atk in TYPE_INDEX, atk
        for d in row:
            assert d in TYPE_INDEX, (atk, d)
    # The whole point: Steel resists Ghost and Dark in Gen 5.
    assert effectiveness("ghost", ("steel",)) == 0.5
    assert effectiveness("dark", ("steel",)) == 0.5
    # Skarmory (Steel/Flying) -- the example the wiki gets wrong.
    assert effectiveness("ghost", ("steel", "flying")) == 0.5
    assert effectiveness("dark", ("steel", "flying")) == 0.5
    assert effectiveness("fire", ("steel", "flying")) == 2.0
    assert effectiveness("electric", ("steel", "flying")) == 2.0
    assert effectiveness("ground", ("steel", "flying")) == 0.0
    assert effectiveness("grass", ("steel", "flying")) == 0.25
    # Mono-type must not double-apply.
    assert effectiveness("water", ("fire", "fire")) == 2.0
    # Chart symmetry sanity: every type appears as both attacker and defender.
    for t in TYPES:
        assert t in TYPE_CHART


_self_check()

if __name__ == "__main__":
    import sys
    args = [a.lower() for a in sys.argv[1:]]
    if not args:
        print(__doc__.strip())
        print("\nusage: python3 gen5.py <type> [type2]   # defensive profile")
        sys.exit(0)
    prof = defensive_profile(tuple(args))
    print(f"Defensive profile for {'/'.join(args)} (Gen 5 chart):")
    for label, keep in (("x4", lambda m: m == 4), ("x2", lambda m: m == 2),
                        ("x1", lambda m: m == 1), ("x1/2", lambda m: m == 0.5),
                        ("x1/4", lambda m: m == 0.25), ("x0", lambda m: m == 0)):
        hits = sorted(t for t, m in prof.items() if keep(m))
        if hits:
            print(f"  {label:<5} {', '.join(hits)}")

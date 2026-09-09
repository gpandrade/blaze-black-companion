#!/usr/bin/env python3
"""
parse_save.py -- read-only parser for Pokemon Blaze Black v3.1 (NDS, Gen 5 BW engine).

=============================================================================
READ-ONLY CONTRACT
=============================================================================
The save file is opened with mode 'rb' and nothing else, in exactly one place
(`read_save`).  There is no code path in this module that writes, truncates,
renames, moves or deletes the save.  The only files this program writes are
under the project's own state/ directory.

=============================================================================
SAVE FILE FORMAT
=============================================================================
All offsets below were verified empirically against a real Blaze Black save,
not taken on faith from documentation.

FILE LAYOUT
    The file is 0x80000 bytes, but only the first 0x48000 is live; the region
    0x48000..0x7FFFF is erased flash (all 0xFF).

    Two save slots, each 0x24000 bytes:
        slot 0 -> 0x00000
        slot 1 -> 0x24000
    (Not two 0x40000 halves.  Confirmed by locating the same PK5 record at
    0x18E08 and 0x3CE08 -- a delta of exactly 0x24000.)

SLOT-RELATIVE OFFSETS
    0x00000  box names + wallpapers, length 0x3E0
             24 box names at stride 0x28, UTF-16LE, 0xFFFF-terminated
             ("BOX 1".."BOX 24"), then 24 wallpaper bytes at 0x3C0.
    0x00400  PC box N (0-indexed) at 0x400 + N*0x1000.
             30 slots x 136 bytes = 0xFF0 used; 0x10 bytes padding per box.
    0x18E00  party block, length 0x534.
             +0x00 u32 (constant 6, slot capacity)
             +0x04 u32 party count
             +0x08 first party slot; stride 220 bytes, 6 slots
    0x23F00  checksum table: u16 CRC16-CCITT per block, 70 entries.
    0x23F8C  slot footer:
             +0x00 u32 save counter
             +0x04 u32 block length (0x23F9C)
             +0x08 u32 magic 0x31053527
             +0x0C u16 padding
             +0x0E u16 CRC

CHECKSUM TABLE ENTRY MAPPING
    entry  0      box names + wallpapers   (0x00000, len 0x3E0)
    entry  1..24  PC boxes 1..24           (0x400 + N*0x1000, len 0xFF0)
    entry 25      Inventory / the Bag      (0x18400, len 0x09C0)
                  Named by PKHeX's Gen 5 block table and confirmed here three
                  ways: the computed CRC, the block's own inline checksum, and
                  central table entry 25 all agree.  The parser does not read
                  the bag, so it does not validate this entry.
    entry 26      party block              (0x18E00, len 0x534)
    entry 49      BATTLE BOX               (0x20A00, len 0x35C)
                  Six PK5 records in BOX format (136 bytes, no party extra
                  block).  This parser does not read it, and that caused a
                  real scare: six Pokemon "vanished" from every box because
                  they had been parked here.  build_sheet.py reads it; if you
                  ever cannot find a Pokemon that should exist, look here
                  before concluding it was released.
    entry 27+     trainer card and other blocks this parser does not read.

    Each block ALSO stores its own checksum inline, two bytes past its end
    (bag -> 0x18DC2, party -> 0x19336), duplicating the central table.  The
    parser validates via the central table only.

    Only entries 0, 1..24 and 26 are validated, because those are the only
    blocks read.

FOOTER CRC -- GUARDS THE CHECKSUM TABLE
    The footer's u16 at FOOTER+0x0E is CRC16-CCITT over [0x23F00, 0x23F8C):
    the checksum table itself, all 70 entries, and nothing else.

    This was found the hard way.  An earlier edit rewrote two table entries
    (a box CRC and the party CRC), refreshed every block's inline checksum,
    and left the footer alone -- every check this parser knew about passed,
    and the game still declared the save corrupt and offered to delete it.
    Recovering the range was then a search over candidate (start, end) pairs
    against a known-good save; exactly one pair reproduces the stored value.

    So the save has three tiers of integrity check, and a writer must update
    all three or the game rejects it:
        1. each block's inline checksum, two bytes past the block
        2. the matching entry in the central table at 0x23F00
        3. this footer CRC over the table

    This parser is read-only and never needs it, but anything that writes
    does.  Do not remove this note.

PK5 RECORD (136 bytes stored, 220 in a party slot)
    0x00  u32 PID
    0x04  u16 sanity
    0x06  u16 checksum
    0x08  four 32-byte blocks, encrypted and shuffled

    Decrypt: LCRNG seeded with the *checksum*.  Per u16,
        seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
        plaintext = ciphertext ^ (seed >> 16)
    Unshuffle: ((PID & 0x3E000) >> 13) % 24 indexes the 24 permutations of
    "ABCD" in lexicographic order; that permutation gives the stored order.
    Verify: the stored checksum must equal the sum of the 64 decrypted u16s.

    A party slot carries an extra 84 bytes at 0x88, encrypted separately with
    the *PID* as the LCRNG seed.  Level lives at 0x8C, i.e. +0x04 into it.

    Field offsets, after unshuffling into ABCD order (see B_* constants).

STAT ORDERING -- READ THIS BEFORE TOUCHING STAT CODE
    Two different orderings are in play and they do not match:
        save order  = HP, Atk, Def, Spe, SpA, SpD   (EV bytes and IV bitfield)
        wiki order  = HP, Atk, Def, SAtk, SDef, Spd (wiki base-stat tables)
    Speed is in position 4 in the save and position 6 in the wiki.  To keep
    that from ever becoming a silent bug, positional stat tuples are converted
    to named keys at the point of decoding and never travel as bare lists.
    Every stat in the JSON output is a dict keyed hp/atk/def/spa/spd/spe.

DATA PROVENANCE
    Blaze Black's Full patch rewrote species data, so anything hack-specific is
    read from wiki/ at runtime:
        species names   wiki/docs/pokemon/<NNN>.md   (H1 heading)
        ability names   wiki/docs/includes/abilities.md (line N == ability ID N)
    Three tables are embedded here because the wiki has no ID-indexed source
    for them: natures, move names, item names.  Blaze Black adds no new moves
    or items, so ID -> name is safe.  It DOES rebalance move power/accuracy and
    item effects, so this file carries names ONLY.  Never quote move power,
    accuracy, type or effect from here -- that comes from wiki/ alone.

    Experience curves are the one genuinely uncertain embedded table: the Full
    patch readme states experience rate was edited.  See CURVE PINNING below.

CURVE PINNING
    Box records store EXP but not level, so level must be derived from a
    species' experience curve.  Rather than trust the vanilla table, every
    party member is treated as a labeled (species, EXP, level) observation,
    because party slots store level directly.  For each observation the set of
    curves consistent with it is computed and intersected with what was learned
    before, narrowing toward a single curve.  Results accumulate in
    state/curve_observations.json.  A species whose observations rule out its
    vanilla curve produces a loud warning and the correction is recorded.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import paths

ROOT = Path(__file__).resolve().parent
DEFAULT_SAVE = paths.SAVE
WIKI_DOCS = ROOT / "wiki" / "docs"
STATE_DIR = ROOT / "state"

# --------------------------------------------------------------------------
# File / slot geometry
# --------------------------------------------------------------------------
SAVE_SIZE = 524288
MIN_MTIME_AGE = 2.0

SLOT_SIZE = 0x24000
SLOT_OFFSETS = (0x00000, 0x24000)

BOXNAME_BLOCK, BOXNAME_LEN, BOXNAME_STRIDE = 0x00000, 0x3E0, 0x28
# The block does NOT start with the names.  Its layout is:
#   +0x000  u32  currently-selected box, 0-indexed
#   +0x004  24 names, stride 0x28, UTF-16LE, 0xFFFF-terminated
#   +0x3C4  24 wallpaper bytes
#   +0x3DD  u8   NUMBER OF BOXES THE GAME EXPOSES.  Ships as 8, which is why
#                anything written to boxes 9+ was invisible in game.
BOXNAME_FIRST = 0x004
BOX_CAPACITY_OFF = 0x3DD
BOX_BASE, BOX_STRIDE, BOX_DATA_LEN = 0x400, 0x1000, 0xFF0
BOX_COUNT, BOX_SLOTS = 24, 30

PARTY_BLOCK, PARTY_LEN = 0x18E00, 0x534
PARTY_COUNT_OFF, PARTY_FIRST, PARTY_SLOTS = 0x04, 0x08, 6

PK5_BOX_SIZE, PK5_PARTY_SIZE = 136, 220
PARTY_EXTRA_OFF, PARTY_EXTRA_LEN = 0x88, 84
PARTY_LEVEL_OFF = 0x04  # within the decrypted party extra block

CHECKSUM_TABLE = 0x23F00
CHK_BOXNAMES, CHK_BOX_FIRST, CHK_PARTY = 0, 1, 26

FOOTER = 0x23F8C
FOOTER_MAGIC = 0x31053527

# --------------------------------------------------------------------------
# PK5 field offsets, relative to the 128-byte decrypted+unshuffled body.
# Body index == record offset - 8.
# --------------------------------------------------------------------------
B_SPECIES, B_ITEM, B_TID, B_SID = 0x00, 0x02, 0x04, 0x06
B_EXP, B_FRIENDSHIP, B_ABILITY = 0x08, 0x0C, 0x0D
B_EVS = 0x10          # 6 bytes, save order
B_MOVES = 0x20        # 4 x u16
B_IVS = 0x30          # u32 bitfield, save order, + egg/nicknamed flags
B_NATURE = 0x39
B_NICKNAME, B_NICKNAME_LEN = 0x40, 11
B_OT_NAME, B_OT_NAME_LEN = 0x60, 8

SAVE_STAT_ORDER = ("hp", "atk", "def", "spe", "spa", "spd")
WIKI_STAT_ORDER = ("hp", "atk", "def", "spa", "spd", "spe")
OUTPUT_STAT_ORDER = ("hp", "atk", "def", "spa", "spd", "spe")

# Nature index maps to these stats: raised = id // 5, lowered = id % 5.
NATURE_STAT_ORDER = ("atk", "def", "spe", "spa", "spd")

PARTY_CURHP_OFF = 0x06   # within the decrypted party extra block
PARTY_STATS_OFF = 0x08   # six u16s in SAVE_STAT_ORDER

# --------------------------------------------------------------------------
# Embedded name tables (names only -- never battle data)
# --------------------------------------------------------------------------
NATURES = (
    "Hardy", "Lonely", "Brave", "Adamant", "Naughty",
    "Bold", "Docile", "Relaxed", "Impish", "Lax",
    "Timid", "Hasty", "Serious", "Jolly", "Naive",
    "Modest", "Mild", "Quiet", "Bashful", "Rash",
    "Calm", "Gentle", "Sassy", "Careful", "Quirky",
)

MOVE_NAMES = ("(none)",) + tuple("""
Pound|Karate Chop|Double Slap|Comet Punch|Mega Punch|Pay Day|Fire Punch|Ice Punch|Thunder Punch|
Scratch|Vice Grip|Guillotine|Razor Wind|Swords Dance|Cut|Gust|Wing Attack|Whirlwind|Fly|Bind|Slam|
Vine Whip|Stomp|Double Kick|Mega Kick|Jump Kick|Rolling Kick|Sand Attack|Headbutt|Horn Attack|
Fury Attack|Horn Drill|Tackle|Body Slam|Wrap|Take Down|Thrash|Double-Edge|Tail Whip|Poison Sting|
Twineedle|Pin Missile|Leer|Bite|Growl|Roar|Sing|Supersonic|Sonic Boom|Disable|Acid|Ember|
Flamethrower|Mist|Water Gun|Hydro Pump|Surf|Ice Beam|Blizzard|Psybeam|Bubble Beam|Aurora Beam|
Hyper Beam|Peck|Drill Peck|Submission|Low Kick|Counter|Seismic Toss|Strength|Absorb|Mega Drain|
Leech Seed|Growth|Razor Leaf|Solar Beam|Poison Powder|Stun Spore|Sleep Powder|Petal Dance|
String Shot|Dragon Rage|Fire Spin|Thunder Shock|Thunderbolt|Thunder Wave|Thunder|Rock Throw|
Earthquake|Fissure|Dig|Toxic|Confusion|Psychic|Hypnosis|Meditate|Agility|Quick Attack|Rage|
Teleport|Night Shade|Mimic|Screech|Double Team|Recover|Harden|Minimize|Smokescreen|Confuse Ray|
Withdraw|Defense Curl|Barrier|Light Screen|Haze|Reflect|Focus Energy|Bide|Metronome|Mirror Move|
Self-Destruct|Egg Bomb|Lick|Smog|Sludge|Bone Club|Fire Blast|Waterfall|Clamp|Swift|Skull Bash|
Spike Cannon|Constrict|Amnesia|Kinesis|Soft-Boiled|High Jump Kick|Glare|Dream Eater|Poison Gas|
Barrage|Leech Life|Lovely Kiss|Sky Attack|Transform|Bubble|Dizzy Punch|Spore|Flash|Psywave|Splash|
Acid Armor|Crabhammer|Explosion|Fury Swipes|Bonemerang|Rest|Rock Slide|Hyper Fang|Sharpen|
Conversion|Tri Attack|Super Fang|Slash|Substitute|Struggle|Sketch|Triple Kick|Thief|Spider Web|
Mind Reader|Nightmare|Flame Wheel|Snore|Curse|Flail|Conversion 2|Aeroblast|Cotton Spore|Reversal|
Spite|Powder Snow|Protect|Mach Punch|Scary Face|Feint Attack|Sweet Kiss|Belly Drum|Sludge Bomb|
Mud-Slap|Octazooka|Spikes|Zap Cannon|Foresight|Destiny Bond|Perish Song|Icy Wind|Detect|Bone Rush|
Lock-On|Outrage|Sandstorm|Giga Drain|Endure|Charm|Rollout|False Swipe|Swagger|Milk Drink|Spark|
Fury Cutter|Steel Wing|Mean Look|Attract|Sleep Talk|Heal Bell|Return|Present|Frustration|Safeguard|
Pain Split|Sacred Fire|Magnitude|Dynamic Punch|Megahorn|Dragon Breath|Baton Pass|Encore|Pursuit|
Rapid Spin|Sweet Scent|Iron Tail|Metal Claw|Vital Throw|Morning Sun|Synthesis|Moonlight|
Hidden Power|Cross Chop|Twister|Rain Dance|Sunny Day|Crunch|Mirror Coat|Psych Up|Extreme Speed|
Ancient Power|Shadow Ball|Future Sight|Rock Smash|Whirlpool|Beat Up|Fake Out|Uproar|Stockpile|
Spit Up|Swallow|Heat Wave|Hail|Torment|Flatter|Will-O-Wisp|Memento|Facade|Focus Punch|
Smelling Salts|Follow Me|Nature Power|Charge|Taunt|Helping Hand|Trick|Role Play|Wish|Assist|
Ingrain|Superpower|Magic Coat|Recycle|Revenge|Brick Break|Yawn|Knock Off|Endeavor|Eruption|
Skill Swap|Imprison|Refresh|Grudge|Snatch|Secret Power|Dive|Arm Thrust|Camouflage|Tail Glow|
Luster Purge|Mist Ball|Feather Dance|Teeter Dance|Blaze Kick|Mud Sport|Ice Ball|Needle Arm|
Slack Off|Hyper Voice|Poison Fang|Crush Claw|Blast Burn|Hydro Cannon|Meteor Mash|Astonish|
Weather Ball|Aromatherapy|Fake Tears|Air Cutter|Overheat|Odor Sleuth|Rock Tomb|Silver Wind|
Metal Sound|Grass Whistle|Tickle|Cosmic Power|Water Spout|Signal Beam|Shadow Punch|Extrasensory|
Sky Uppercut|Sand Tomb|Sheer Cold|Muddy Water|Bullet Seed|Aerial Ace|Icicle Spear|Iron Defense|
Block|Howl|Dragon Claw|Frenzy Plant|Bulk Up|Bounce|Mud Shot|Poison Tail|Covet|Volt Tackle|
Magical Leaf|Water Sport|Calm Mind|Leaf Blade|Dragon Dance|Rock Blast|Shock Wave|Water Pulse|
Doom Desire|Psycho Boost|Roost|Gravity|Miracle Eye|Wake-Up Slap|Hammer Arm|Gyro Ball|Healing Wish|
Brine|Natural Gift|Feint|Pluck|Tailwind|Acupressure|Metal Burst|U-turn|Close Combat|Payback|
Assurance|Embargo|Fling|Psycho Shift|Trump Card|Heal Block|Wring Out|Power Trick|Gastro Acid|
Lucky Chant|Me First|Copycat|Power Swap|Guard Swap|Punishment|Last Resort|Worry Seed|Sucker Punch|
Toxic Spikes|Heart Swap|Aqua Ring|Magnet Rise|Flare Blitz|Force Palm|Aura Sphere|Rock Polish|
Poison Jab|Dark Pulse|Night Slash|Aqua Tail|Seed Bomb|Air Slash|X-Scissor|Bug Buzz|Dragon Pulse|
Dragon Rush|Power Gem|Drain Punch|Vacuum Wave|Focus Blast|Energy Ball|Brave Bird|Earth Power|
Switcheroo|Giga Impact|Nasty Plot|Bullet Punch|Avalanche|Ice Shard|Shadow Claw|Thunder Fang|
Ice Fang|Fire Fang|Shadow Sneak|Mud Bomb|Psycho Cut|Zen Headbutt|Mirror Shot|Flash Cannon|
Rock Climb|Defog|Trick Room|Draco Meteor|Discharge|Lava Plume|Leaf Storm|Power Whip|Rock Wrecker|
Cross Poison|Gunk Shot|Iron Head|Magnet Bomb|Stone Edge|Captivate|Stealth Rock|Grass Knot|Chatter|
Judgment|Bug Bite|Charge Beam|Wood Hammer|Aqua Jet|Attack Order|Defend Order|Heal Order|
Head Smash|Double Hit|Roar of Time|Spacial Rend|Lunar Dance|Crush Grip|Magma Storm|Dark Void|
Seed Flare|Ominous Wind|Shadow Force|Hone Claws|Wide Guard|Guard Split|Power Split|Wonder Room|
Psyshock|Venoshock|Autotomize|Rage Powder|Telekinesis|Magic Room|Smack Down|Storm Throw|
Flame Burst|Sludge Wave|Quiver Dance|Heavy Slam|Synchronoise|Electro Ball|Soak|Flame Charge|Coil|
Low Sweep|Acid Spray|Foul Play|Simple Beam|Entrainment|After You|Round|Echoed Voice|Chip Away|
Clear Smog|Stored Power|Quick Guard|Ally Switch|Scald|Shell Smash|Heal Pulse|Hex|Sky Drop|
Shift Gear|Circle Throw|Incinerate|Quash|Acrobatics|Reflect Type|Retaliate|Final Gambit|Bestow|
Inferno|Water Pledge|Fire Pledge|Grass Pledge|Volt Switch|Struggle Bug|Bulldoze|Frost Breath|
Dragon Tail|Work Up|Electroweb|Wild Charge|Drill Run|Dual Chop|Heart Stamp|Horn Leech|
Sacred Sword|Razor Shell|Heat Crash|Leaf Tornado|Steamroller|Cotton Guard|Night Daze|Psystrike|
Tail Slap|Hurricane|Head Charge|Gear Grind|Searing Shot|Techno Blast|Relic Song|Secret Sword|
Glaciate|Bolt Strike|Blue Flare|Fiery Dance|Freeze Shock|Ice Burn|Snarl|Icicle Crash|V-create|
Fusion Flare|Fusion Bolt
""".replace("\n", "").split("|"))

ITEM_NAMES = ("(none)",) + tuple("""
Master Ball|Ultra Ball|Great Ball|Poke Ball|Safari Ball|Net Ball|Dive Ball|Nest Ball|Repeat Ball|
Timer Ball|Luxury Ball|Premier Ball|Dusk Ball|Heal Ball|Quick Ball|Cherish Ball|Potion|Antidote|
Burn Heal|Ice Heal|Awakening|Paralyze Heal|Full Restore|Max Potion|Hyper Potion|Super Potion|
Full Heal|Revive|Max Revive|Fresh Water|Soda Pop|Lemonade|Moomoo Milk|Energy Powder|Energy Root|
Heal Powder|Revival Herb|Ether|Max Ether|Elixir|Max Elixir|Lava Cookie|Berry Juice|Sacred Ash|
HP Up|Protein|Iron|Carbos|Calcium|Rare Candy|PP Up|Zinc|PP Max|Old Gateau|Guard Spec.|Dire Hit|
X Attack|X Defense|X Speed|X Accuracy|X Sp. Atk|X Sp. Def|Poke Doll|Fluffy Tail|Blue Flute|
Yellow Flute|Red Flute|Black Flute|White Flute|Shoal Salt|Shoal Shell|Red Shard|Blue Shard|
Yellow Shard|Green Shard|Super Repel|Max Repel|Escape Rope|Repel|Sun Stone|Moon Stone|Fire Stone|
Thunder Stone|Water Stone|Leaf Stone|Tiny Mushroom|Big Mushroom|Pearl|Big Pearl|Stardust|
Star Piece|Nugget|Heart Scale|Honey|Growth Mulch|Damp Mulch|Stable Mulch|Gooey Mulch|Root Fossil|
Claw Fossil|Helix Fossil|Dome Fossil|Old Amber|Armor Fossil|Skull Fossil|Rare Bone|Shiny Stone|
Dusk Stone|Dawn Stone|Oval Stone|Odd Keystone|Griseous Orb|?113|?114|?115|Douse Drive|Shock Drive|
Burn Drive|Chill Drive|?120|?121|?122|?123|?124|?125|?126|?127|?128|?129|?130|?131|?132|?133|?134|
Sweet Heart|Adamant Orb|Lustrous Orb|Greet Mail|Favored Mail|RSVP Mail|Thanks Mail|Inquiry Mail|
Like Mail|Reply Mail|Bridge Mail S|Bridge Mail D|Bridge Mail T|Bridge Mail V|Bridge Mail M|
Cheri Berry|Chesto Berry|Pecha Berry|Rawst Berry|Aspear Berry|Leppa Berry|Oran Berry|Persim Berry|
Lum Berry|Sitrus Berry|Figy Berry|Wiki Berry|Mago Berry|Aguav Berry|Iapapa Berry|Razz Berry|
Bluk Berry|Nanab Berry|Wepear Berry|Pinap Berry|Pomeg Berry|Kelpsy Berry|Qualot Berry|Hondew Berry|
Grepa Berry|Tamato Berry|Cornn Berry|Magost Berry|Rabuta Berry|Nomel Berry|Spelon Berry|
Pamtre Berry|Watmel Berry|Durin Berry|Belue Berry|Occa Berry|Passho Berry|Wacan Berry|Rindo Berry|
Yache Berry|Chople Berry|Kebia Berry|Shuca Berry|Coba Berry|Payapa Berry|Tanga Berry|Charti Berry|
Kasib Berry|Haban Berry|Colbur Berry|Babiri Berry|Chilan Berry|Liechi Berry|Ganlon Berry|
Salac Berry|Petaya Berry|Apicot Berry|Lansat Berry|Starf Berry|Enigma Berry|Micle Berry|
Custap Berry|Jaboca Berry|Rowap Berry|Bright Powder|White Herb|Macho Brace|Exp. Share|Quick Claw|
Soothe Bell|Mental Herb|Choice Band|King's Rock|Silver Powder|Amulet Coin|Cleanse Tag|Soul Dew|
Deep Sea Tooth|Deep Sea Scale|Smoke Ball|Everstone|Focus Band|Lucky Egg|Scope Lens|Metal Coat|
Leftovers|Dragon Scale|Light Ball|Soft Sand|Hard Stone|Miracle Seed|Black Glasses|Black Belt|
Magnet|Mystic Water|Sharp Beak|Poison Barb|Never-Melt Ice|Spell Tag|Twisted Spoon|Charcoal|
Dragon Fang|Silk Scarf|Up-Grade|Shell Bell|Sea Incense|Lax Incense|Lucky Punch|Metal Powder|
Thick Club|Stick|Red Scarf|Blue Scarf|Pink Scarf|Green Scarf|Yellow Scarf|Wide Lens|Muscle Band|
Wise Glasses|Expert Belt|Light Clay|Life Orb|Power Herb|Toxic Orb|Flame Orb|Quick Powder|
Focus Sash|Zoom Lens|Metronome|Iron Ball|Lagging Tail|Destiny Knot|Black Sludge|Icy Rock|
Smooth Rock|Heat Rock|Damp Rock|Grip Claw|Choice Scarf|Sticky Barb|Power Bracer|Power Belt|
Power Lens|Power Band|Power Anklet|Power Weight|Shed Shell|Big Root|Choice Specs|Flame Plate|
Splash Plate|Zap Plate|Meadow Plate|Icicle Plate|Draco Plate|Dread Plate|Earth Plate|Fist Plate|
Insect Plate|Iron Plate|Mind Plate|Sky Plate|Spooky Plate|Stone Plate|Toxic Plate|Odd Incense|
Rock Incense|Full Incense|Wave Incense|Rose Incense|Luck Incense|Pure Incense|Protector|
Electirizer|Magmarizer|Dubious Disc|Reaper Cloth|Razor Claw|Razor Fang
""".replace("\n", "").split("|"))

# Item id layout, read from the ROM's own item data table (a/0/2/4) by
# extract_items.py -- see that module's docstring.  These are FACTS now, not
# derivations:
#     328..419  TM01..TM92
#     420..425  HM01..HM06
#     618..620  TM93..TM95
#
# This used to be `TM_FIRST_ID = len(ITEM_NAMES)`, which gave 329 and was
# wrong by one, because ITEM_NAMES below carries three placeholders in the
# 113..115 run where the ROM has only two unused ids.  Every name from item
# id 116 upward is therefore shifted by one in ITEM_NAMES, and the bag's
# HM01 (Cut) decoded as "TM92".
#
# ITEM_NAMES is kept only as a fallback for held items when state/items.json
# is absent.  Prefer rom_item_names(); it is exact.
TM_FIRST_ID, TM_COUNT = 328, 92
HM_FIRST_ID, HM_COUNT = 420, 6
TM93_FIRST_ID, TM93_COUNT = 618, 3
ITEM_NAME_SHIFT_FROM = 134   # ITEM_NAMES is +1 off at and above this id


_ROM_ITEM_NAMES: dict[int, str] | None = None


def rom_item_names() -> dict[int, str]:
    """Item id -> name from state/items.json, or {} when it has not been built.

    Extracted from the ROM text archive, so it is correct for the hack and
    free of the ITEM_NAMES shift described above.
    """
    global _ROM_ITEM_NAMES
    if _ROM_ITEM_NAMES is None:
        path = STATE_DIR / "items.json"
        try:
            blob = json.loads(path.read_text())
            table = {}
            for iid, rec in blob["items"].items():
                label = rec.get("tm_hm")
                table[int(iid)] = f"{label} {rec['move']}" if label else rec["name"]
            _ROM_ITEM_NAMES = table
        except (OSError, ValueError, KeyError):
            _ROM_ITEM_NAMES = {}
    return _ROM_ITEM_NAMES

# --------------------------------------------------------------------------
# Experience curves
# --------------------------------------------------------------------------
CURVE_NAMES = ("medium-fast", "erratic", "fluctuating", "medium-slow", "fast", "slow")
MEDIUM_FAST, ERRATIC, FLUCTUATING, MEDIUM_SLOW, FAST, SLOW = range(6)
MAX_LEVEL = 100

# (first_dex, last_dex, curve).  Vanilla Gen 5 assignment; treated as a prior,
# not as truth -- party observations override it.  See CURVE PINNING.
_CURVE_RUNS = (
    (1, 9, MEDIUM_SLOW), (10, 15, MEDIUM_FAST), (16, 18, MEDIUM_SLOW),
    (19, 28, MEDIUM_FAST), (29, 34, MEDIUM_SLOW), (35, 36, FAST),
    (37, 38, MEDIUM_FAST), (39, 40, FAST), (41, 42, MEDIUM_FAST),
    (43, 45, MEDIUM_SLOW), (46, 57, MEDIUM_FAST), (58, 59, SLOW),
    (60, 71, MEDIUM_SLOW), (72, 73, SLOW), (74, 76, MEDIUM_SLOW),
    (77, 89, MEDIUM_FAST), (90, 91, SLOW), (92, 94, MEDIUM_SLOW),
    (95, 101, MEDIUM_FAST), (102, 103, SLOW), (104, 110, MEDIUM_FAST),
    (111, 112, SLOW), (113, 113, FAST), (114, 119, MEDIUM_FAST),
    (120, 121, SLOW), (122, 126, MEDIUM_FAST), (127, 131, SLOW),
    (132, 141, MEDIUM_FAST), (142, 150, SLOW), (151, 151, MEDIUM_SLOW),
    (152, 160, MEDIUM_SLOW), (161, 164, MEDIUM_FAST), (165, 168, FAST),
    (169, 169, MEDIUM_FAST), (170, 171, SLOW), (172, 172, MEDIUM_FAST),
    (173, 176, FAST), (177, 178, MEDIUM_FAST), (179, 182, MEDIUM_SLOW),
    (183, 184, FAST), (185, 185, MEDIUM_FAST), (186, 189, MEDIUM_SLOW),
    (190, 190, FAST), (191, 192, MEDIUM_SLOW), (193, 197, MEDIUM_FAST),
    (198, 198, MEDIUM_SLOW), (199, 199, MEDIUM_FAST), (200, 200, FAST),
    (201, 206, MEDIUM_FAST), (207, 207, MEDIUM_SLOW), (208, 208, MEDIUM_FAST),
    (209, 211, FAST), (212, 212, MEDIUM_FAST), (213, 213, MEDIUM_SLOW),
    (214, 214, SLOW), (215, 215, MEDIUM_SLOW), (216, 219, MEDIUM_FAST),
    (220, 221, SLOW), (222, 222, FAST), (223, 224, MEDIUM_FAST),
    (225, 225, FAST), (226, 229, SLOW), (230, 233, MEDIUM_FAST),
    (234, 234, SLOW), (235, 235, FAST), (236, 240, MEDIUM_FAST),
    (241, 241, SLOW), (242, 242, FAST), (243, 250, SLOW),
    (251, 251, MEDIUM_SLOW),
    (252, 260, MEDIUM_SLOW), (261, 269, MEDIUM_FAST), (270, 277, MEDIUM_SLOW),
    (278, 279, MEDIUM_FAST), (280, 282, SLOW), (283, 284, MEDIUM_FAST),
    (285, 286, FLUCTUATING), (287, 289, SLOW), (290, 292, ERRATIC),
    (293, 295, MEDIUM_SLOW), (296, 297, FLUCTUATING), (298, 298, FAST),
    (299, 299, MEDIUM_FAST), (300, 301, FAST), (302, 302, MEDIUM_SLOW),
    (303, 303, FAST), (304, 306, SLOW), (307, 308, MEDIUM_FAST),
    (309, 310, SLOW), (311, 312, MEDIUM_FAST), (313, 313, ERRATIC),
    (314, 314, FLUCTUATING), (315, 315, MEDIUM_SLOW), (316, 317, FLUCTUATING),
    (318, 319, SLOW), (320, 321, FLUCTUATING), (322, 324, MEDIUM_FAST),
    (325, 327, FAST), (328, 332, MEDIUM_SLOW), (333, 335, ERRATIC),
    (336, 336, FLUCTUATING), (337, 338, FAST), (339, 340, MEDIUM_FAST),
    (341, 342, FLUCTUATING), (343, 344, MEDIUM_FAST), (345, 350, ERRATIC),
    (351, 351, MEDIUM_FAST), (352, 352, MEDIUM_SLOW), (353, 356, FAST),
    (357, 357, SLOW), (358, 358, FAST), (359, 359, MEDIUM_SLOW),
    (360, 362, MEDIUM_FAST), (363, 365, MEDIUM_SLOW), (366, 368, ERRATIC),
    (369, 369, SLOW), (370, 370, FAST), (371, 386, SLOW),
    (387, 398, MEDIUM_SLOW), (399, 402, MEDIUM_FAST), (403, 407, MEDIUM_SLOW),
    (408, 414, MEDIUM_FAST), (415, 416, MEDIUM_SLOW), (417, 423, MEDIUM_FAST),
    (424, 424, FAST), (425, 428, MEDIUM_FAST), (429, 429, FAST),
    (430, 430, MEDIUM_SLOW), (431, 433, FAST), (434, 439, MEDIUM_FAST),
    (440, 440, FAST), (441, 441, MEDIUM_SLOW), (442, 442, MEDIUM_FAST),
    (443, 446, SLOW), (447, 448, MEDIUM_SLOW), (449, 450, SLOW),
    (451, 455, MEDIUM_FAST), (456, 457, ERRATIC), (458, 460, SLOW),
    (461, 461, MEDIUM_SLOW), (462, 463, MEDIUM_FAST), (464, 464, SLOW),
    (465, 467, MEDIUM_FAST), (468, 468, FAST), (469, 471, MEDIUM_FAST),
    (472, 472, MEDIUM_SLOW), (473, 473, SLOW), (474, 474, MEDIUM_FAST),
    (475, 475, SLOW), (476, 476, MEDIUM_FAST), (477, 477, FAST),
    (478, 479, MEDIUM_FAST), (480, 491, SLOW), (492, 492, MEDIUM_SLOW),
    (493, 493, SLOW),
    (494, 494, SLOW), (495, 503, MEDIUM_SLOW), (504, 505, MEDIUM_FAST),
    (506, 508, MEDIUM_SLOW), (509, 516, MEDIUM_FAST), (517, 518, FAST),
    (519, 521, MEDIUM_SLOW), (522, 523, MEDIUM_FAST), (524, 526, MEDIUM_SLOW),
    (527, 530, MEDIUM_FAST), (531, 531, FAST), (532, 534, MEDIUM_SLOW),
    (535, 537, MEDIUM_FAST), (538, 545, MEDIUM_SLOW), (546, 550, MEDIUM_FAST),
    (551, 555, MEDIUM_SLOW), (556, 569, MEDIUM_FAST), (570, 571, MEDIUM_SLOW),
    (572, 573, FAST), (574, 579, MEDIUM_SLOW), (580, 581, MEDIUM_FAST),
    (582, 584, SLOW), (585, 591, MEDIUM_FAST), (592, 593, SLOW),
    (594, 594, FAST), (595, 598, MEDIUM_FAST), (599, 601, MEDIUM_SLOW),
    (602, 604, SLOW), (605, 609, MEDIUM_SLOW), (610, 612, SLOW),
    (613, 618, MEDIUM_FAST), (619, 620, MEDIUM_SLOW), (621, 626, MEDIUM_FAST),
    (627, 630, SLOW), (631, 632, MEDIUM_FAST), (633, 649, SLOW),
)

VANILLA_CURVE = {}
for _lo, _hi, _c in _CURVE_RUNS:
    for _d in range(_lo, _hi + 1):
        VANILLA_CURVE[_d] = _c


def exp_for_level(curve: int, level: int) -> int:
    """Total EXP required to reach `level` on `curve`.  Level 1 is always 0."""
    n = level
    if n <= 1:
        return 0
    if curve == MEDIUM_FAST:
        return n ** 3
    if curve == FAST:
        return (4 * n ** 3) // 5
    if curve == SLOW:
        return (5 * n ** 3) // 4
    if curve == MEDIUM_SLOW:
        return (6 * n ** 3) // 5 - 15 * n * n + 100 * n - 140
    if curve == ERRATIC:
        if n < 50:
            return (n ** 3 * (100 - n)) // 50
        if n < 68:
            return (n ** 3 * (150 - n)) // 100
        if n < 98:
            return (n ** 3 * ((1911 - 10 * n) // 3)) // 500
        return (n ** 3 * (160 - n)) // 100
    if curve == FLUCTUATING:
        if n < 15:
            return (n ** 3 * (((n + 1) // 3) + 24)) // 50
        if n < 36:
            return (n ** 3 * (n + 14)) // 50
        return (n ** 3 * ((n // 2) + 32)) // 50
    raise ValueError(f"unknown curve {curve}")


def level_for_exp(curve: int, exp: int) -> int:
    level = 1
    for n in range(2, MAX_LEVEL + 1):
        if exp_for_level(curve, n) <= exp:
            level = n
        else:
            break
    return level


def curves_consistent_with(exp: int, level: int) -> set[int]:
    """Which curves could produce `exp` at exactly `level`?"""
    out = set()
    for c in range(6):
        low = exp_for_level(c, level)
        if exp < low:
            continue
        if level >= MAX_LEVEL or exp < exp_for_level(c, level + 1):
            out.add(c)
    return out


# --------------------------------------------------------------------------
# CRC16-CCITT (poly 0x1021, init 0xFFFF, no reflection, no final xor)
# --------------------------------------------------------------------------
_CRC_TABLE = []
for _b in range(256):
    _c = _b << 8
    for _ in range(8):
        _c = ((_c << 1) ^ 0x1021) & 0xFFFF if _c & 0x8000 else (_c << 1) & 0xFFFF
    _CRC_TABLE.append(_c)


def crc16_ccitt(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc = ((crc << 8) & 0xFFFF) ^ _CRC_TABLE[(crc >> 8) ^ byte]
    return crc


# --------------------------------------------------------------------------
# PK5 crypto
# --------------------------------------------------------------------------
_BLOCK_ORDERS = None


def _block_orders() -> tuple[str, ...]:
    global _BLOCK_ORDERS
    if _BLOCK_ORDERS is None:
        from itertools import permutations
        _BLOCK_ORDERS = tuple("".join(p) for p in permutations("ABCD"))
    return _BLOCK_ORDERS


def lcrng_crypt(data: bytes, seed: int) -> bytes:
    """Symmetric: XOR each u16 with the high half of a stepped LCRNG."""
    out = bytearray(data)
    for i in range(0, len(data) & ~1, 2):
        seed = (seed * 0x41C64E6D + 0x6073) & 0xFFFFFFFF
        word = struct.unpack_from("<H", data, i)[0] ^ (seed >> 16)
        struct.pack_into("<H", out, i, word & 0xFFFF)
    return bytes(out)


def unshuffle(body: bytes, pid: int) -> bytes:
    order = _block_orders()[((pid & 0x3E000) >> 13) % 24]
    chunks = {order[i]: body[i * 32:(i + 1) * 32] for i in range(4)}
    return b"".join(chunks[c] for c in "ABCD")


def shuffle(body: bytes, pid: int) -> bytes:
    """Inverse of `unshuffle`; used only by the test suite to build fixtures."""
    order = _block_orders()[((pid & 0x3E000) >> 13) % 24]
    chunks = {c: body[i * 32:(i + 1) * 32] for i, c in enumerate("ABCD")}
    return b"".join(chunks[c] for c in order)


def pk5_checksum(body: bytes) -> int:
    return sum(struct.unpack("<64H", body)) & 0xFFFF


# --------------------------------------------------------------------------
# Wiki-sourced lookups
# --------------------------------------------------------------------------
class Wiki:
    """Hack-specific data.  Everything here comes from wiki/, never memory."""

    _SPECIES_RE = re.compile(r"^#\s*(\d+)\s*-\s*(.+?)\s*$")
    _ABILITY_RE = re.compile(r"^\*\[(.+?)\]:")

    def __init__(self, docs: Path):
        self.docs = docs
        self._species: dict[int, str] = {}
        self._abilities: list[str] | None = None
        self._base_stats: dict[int, dict | None] = {}
        self._item_slugs: set[str] | None = None
        self._move_pages: dict[int, set[str]] = {}
        self.missing: list[str] = []

    def species_name(self, dex: int) -> str | None:
        if dex in self._species:
            return self._species[dex]
        page = self.docs / "pokemon" / f"{dex:03d}.md"
        name = None
        if page.is_file():
            first = page.read_text(encoding="utf-8", errors="replace").split("\n", 1)[0]
            m = self._SPECIES_RE.match(first)
            if m and int(m.group(1)) == dex:
                name = m.group(2)
        if name is None:
            self.missing.append(f"species page for #{dex}")
        self._species[dex] = name
        return name

    def base_stats(self, dex: int) -> dict | None:
        """Hack base stats from the species page, converted to named keys.

        The wiki prints HP | Atk | Def | SAtk | SDef | Spd -- Speed LAST, unlike
        the save's ordering. Every species page has exactly one data row,
        labelled 'All'.
        """
        if dex in self._base_stats:
            return self._base_stats[dex]
        page = self.docs / "pokemon" / f"{dex:03d}.md"
        stats = None
        if page.is_file():
            in_section = False
            for line in page.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("## "):
                    in_section = line.strip() == "## Base Stats"
                    continue
                if not in_section or not line.startswith("|"):
                    continue
                cells = [c.strip() for c in line.split("|")[1:-1]]
                if len(cells) < 7 or not cells[1].isdigit():
                    continue
                stats = named_stats([int(c) for c in cells[1:7]], WIKI_STAT_ORDER)
                break
        if stats is None:
            self.missing.append(f"base stats for #{dex}")
        self._base_stats[dex] = stats
        return stats

    def ability_name(self, ability_id: int) -> str | None:
        if self._abilities is None:
            path = self.docs / "includes" / "abilities.md"
            names = []
            if path.is_file():
                for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                    m = self._ABILITY_RE.match(line)
                    if m:
                        names.append(m.group(1))
            else:
                self.missing.append("includes/abilities.md")
            self._abilities = names
        # abilities.md is 1-indexed by ability ID: line N == ability ID N.
        if 1 <= ability_id <= len(self._abilities):
            return self._abilities[ability_id - 1]
        return None

    def item_slug_known(self, name: str) -> bool | None:
        """True/False if the item image set can confirm the name; None if absent."""
        if self._item_slugs is None:
            d = self.docs / "img" / "items"
            if not d.is_dir():
                self._item_slugs = set()
            else:
                self._item_slugs = {_norm(p.stem) for p in d.glob("*.png")}
        if not self._item_slugs:
            return None
        return _norm(name) in self._item_slugs

    def species_knows_move(self, dex: int, move_name: str) -> bool | None:
        """Does this species' wiki page list `move_name` at all?  None if no page."""
        if dex not in self._move_pages:
            page = self.docs / "pokemon" / f"{dex:03d}.md"
            if not page.is_file():
                self._move_pages[dex] = set()
            else:
                text = page.read_text(encoding="utf-8", errors="replace")
                names = set()
                for line in text.splitlines():
                    if not line.startswith("|"):
                        continue
                    cells = [c.strip() for c in line.split("|")]
                    if len(cells) > 2:
                        names.add(_norm(cells[2]))
                self._move_pages[dex] = names
        known = self._move_pages[dex]
        if not known:
            return None
        return _norm(move_name) in known


class PersonalData:
    """The species table extracted straight from the ROM by extract_personal.py.

    This is the PRIMARY source for base stats, typings, abilities and
    experience curves. The wiki is a fallback only, because it was generated
    from a modern dataset and is contaminated wherever the games changed after
    Gen 5. Absent personal.json the parser still works, but
    says so in every affected field.
    """

    def __init__(self, path: Path):
        self.path = path
        self.species: dict[str, dict] = {}
        self.loaded = False
        self.meta: dict = {}
        if not path.is_file():
            return
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        self.species = doc.get("species", {})
        self.meta = doc.get("meta", {})
        self.loaded = bool(self.species)

    def _get(self, dex: int) -> dict | None:
        return self.species.get(str(dex))

    def base_stats(self, dex: int) -> dict | None:
        rec = self._get(dex)
        return rec["base_stats"] if rec else None

    def types(self, dex: int) -> list[str] | None:
        rec = self._get(dex)
        return rec["types"] if rec else None

    def abilities(self, dex: int) -> list[str] | None:
        rec = self._get(dex)
        return rec["abilities"] if rec else None

    def hidden_ability(self, dex: int) -> str | None:
        rec = self._get(dex)
        return rec.get("hidden_ability") if rec else None

    def learnset(self, dex: int) -> dict[int, int]:
        """move id -> level first learned, from the ROM's learnset NARC."""
        rec = self._get(dex)
        if not rec:
            return {}
        return {e["move_id"]: e["level"] for e in rec.get("learnset", [])}

    def curve(self, dex: int) -> int | None:
        rec = self._get(dex)
        if not rec or rec.get("growth_curve") is None:
            return None
        try:
            return CURVE_NAMES.index(rec["growth_curve"])
        except ValueError:
            return None


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower().replace("é", "e"))


def move_name(move_id: int) -> str:
    if 0 <= move_id < len(MOVE_NAMES):
        return MOVE_NAMES[move_id]
    return f"Unknown move #{move_id}"


def item_name(item_id: int) -> str:
    """Name an item id, preferring the ROM-extracted table.

    Falls back to the embedded ITEM_NAMES, which is exact below item id 116
    and shifted by one at or above it -- so the fallback flags itself rather
    than quietly returning the neighbouring item's name.
    """
    rom = rom_item_names()
    if item_id in rom:
        return rom[item_id]

    if TM_FIRST_ID <= item_id < TM_FIRST_ID + TM_COUNT:
        return f"TM{item_id - TM_FIRST_ID + 1:02d}"
    if HM_FIRST_ID <= item_id < HM_FIRST_ID + HM_COUNT:
        return f"HM{item_id - HM_FIRST_ID + 1:02d}"
    if TM93_FIRST_ID <= item_id < TM93_FIRST_ID + TM93_COUNT:
        return f"TM{93 + item_id - TM93_FIRST_ID:02d}"
    if 0 <= item_id < ITEM_NAME_SHIFT_FROM:
        return ITEM_NAMES[item_id]
    if item_id < len(ITEM_NAMES):
        return f"{ITEM_NAMES[item_id]}? (unverified: run extract_items.py)"
    return f"Unknown item #{item_id}"


# --------------------------------------------------------------------------
# Validation and slot selection
# --------------------------------------------------------------------------
class SaveError(Exception):
    """Fatal: the save could not be trusted.  Never emit partial stats."""


def read_save(path: Path, min_age: float = MIN_MTIME_AGE) -> tuple[bytes, dict]:
    """Validate size and mtime per the project rules, then read read-only."""
    if not path.is_file():
        raise SaveError(f"save file not found: {path}")

    st = path.stat()
    if st.st_size != SAVE_SIZE:
        raise SaveError(
            f"save is {st.st_size} bytes, expected exactly {SAVE_SIZE}. "
            "Refusing to parse a wrong-sized file."
        )

    age = time.time() - st.st_mtime
    if age < min_age:
        raise SaveError(
            f"save was modified {age:.2f}s ago (minimum {min_age:.0f}s). "
            "melonDS flushes the .sav shortly after an in-game save, so this "
            "read could catch a partial write. Wait a moment and re-run."
        )

    with open(path, "rb") as fh:          # read-only, the only open() of the save
        data = fh.read()

    if len(data) != SAVE_SIZE:
        raise SaveError(f"short read: got {len(data)} of {SAVE_SIZE} bytes")

    return data, {
        "path": str(path),
        "bytes": st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
        "mtime_age_seconds": round(age, 1),
    }


def slot_report(data: bytes, index: int) -> dict:
    base = SLOT_OFFSETS[index]
    table_at = base + CHECKSUM_TABLE

    def entry(i: int) -> int:
        return struct.unpack_from("<H", data, table_at + 2 * i)[0]

    names_ok = crc16_ccitt(
        data[base + BOXNAME_BLOCK: base + BOXNAME_BLOCK + BOXNAME_LEN]
    ) == entry(CHK_BOXNAMES)

    boxes_ok = []
    for n in range(BOX_COUNT):
        off = base + BOX_BASE + n * BOX_STRIDE
        boxes_ok.append(crc16_ccitt(data[off:off + BOX_DATA_LEN]) == entry(CHK_BOX_FIRST + n))

    party_ok = crc16_ccitt(
        data[base + PARTY_BLOCK: base + PARTY_BLOCK + PARTY_LEN]
    ) == entry(CHK_PARTY)

    counter, length, magic = struct.unpack_from("<III", data, base + FOOTER)
    return {
        "index": index,
        "offset": base,
        "counter": counter,
        "footer_length": length,
        "footer_magic_ok": magic == FOOTER_MAGIC,
        "box_names_crc_ok": names_ok,
        "boxes_crc_ok": sum(boxes_ok),
        "boxes_crc_total": BOX_COUNT,
        "party_crc_ok": party_ok,
        "valid": names_ok and party_ok and all(boxes_ok),
    }


def choose_slot(data: bytes, warnings: list[str]) -> tuple[int, list[dict], str]:
    reports = [slot_report(data, i) for i in range(len(SLOT_OFFSETS))]
    valid = [r for r in reports if r["valid"]]

    if not valid:
        raise SaveError(
            "neither save slot passes its block checksums. The save may be "
            "corrupt or mid-write; refusing to emit stats."
        )

    best = max(r["counter"] for r in valid)
    tied = [r for r in valid if r["counter"] == best]

    if len(tied) == 1:
        chosen = tied[0]
        reason = f"slot {chosen['index']} has the higher save counter ({best})"
    else:
        a = data[SLOT_OFFSETS[tied[0]["index"]]:SLOT_OFFSETS[tied[0]["index"]] + SLOT_SIZE]
        b = data[SLOT_OFFSETS[tied[1]["index"]]:SLOT_OFFSETS[tied[1]["index"]] + SLOT_SIZE]
        chosen = tied[0]
        if a == b:
            reason = (
                f"both slots tie at counter {best} and their contents are "
                f"byte-identical; using slot {chosen['index']}"
            )
        else:
            reason = (
                f"AMBIGUOUS: both slots tie at counter {best} but their contents "
                f"DIFFER; fell back to slot {chosen['index']}"
            )
            warnings.append(
                f"Save slots {tied[0]['index']} and {tied[1]['index']} both report "
                f"counter {best} but contain different data. I cannot tell which is "
                f"newer, so I used slot {chosen['index']}. Treat this run's output as "
                "suspect and re-save in game to resolve it."
            )

    invalid = [r["index"] for r in reports if not r["valid"]]
    if invalid:
        warnings.append(
            f"Save slot(s) {invalid} failed block checksum validation and were "
            "ignored. This is normal if the game has only ever written one slot."
        )

    return chosen["index"], reports, reason


# --------------------------------------------------------------------------
# Decoding
# --------------------------------------------------------------------------
def decode_string(raw: bytes, max_chars: int) -> str:
    chars = []
    for i in range(max_chars):
        (c,) = struct.unpack_from("<H", raw, i * 2)
        if c in (0x0000, 0xFFFF):
            break
        chars.append(chr(c))
    return "".join(chars)


def named_stats(values, order) -> dict:
    """Convert a positional stat tuple into named keys at the decode boundary."""
    by_name = dict(zip(order, values))
    return {k: by_name[k] for k in OUTPUT_STAT_ORDER}


def decode_pk5(record: bytes, is_party: bool):
    """Return a raw field dict, or None if the slot is empty / fails checksum."""
    pid, _sanity, checksum = struct.unpack_from("<IHH", record, 0)
    if pid == 0 and checksum == 0:
        return None

    body = unshuffle(lcrng_crypt(record[8:136], checksum), pid)
    if pk5_checksum(body) != checksum:
        return None

    species = struct.unpack_from("<H", body, B_SPECIES)[0]
    if species == 0:
        return None

    iv_field = struct.unpack_from("<I", body, B_IVS)[0]
    fields = {
        "pid": pid,
        "species_id": species,
        "item_id": struct.unpack_from("<H", body, B_ITEM)[0],
        "tid": struct.unpack_from("<H", body, B_TID)[0],
        "sid": struct.unpack_from("<H", body, B_SID)[0],
        "exp": struct.unpack_from("<I", body, B_EXP)[0],
        "friendship": body[B_FRIENDSHIP],
        "ability_id": body[B_ABILITY],
        "nature_id": body[B_NATURE],
        "evs": named_stats(body[B_EVS:B_EVS + 6], SAVE_STAT_ORDER),
        "ivs": named_stats(
            [(iv_field >> (5 * i)) & 0x1F for i in range(6)], SAVE_STAT_ORDER
        ),
        "is_egg": bool((iv_field >> 30) & 1),
        "is_nicknamed": bool((iv_field >> 31) & 1),
        "move_ids": list(struct.unpack_from("<4H", body, B_MOVES)),
        "nickname": decode_string(body[B_NICKNAME:], B_NICKNAME_LEN),
        "ot_name": decode_string(body[B_OT_NAME:], B_OT_NAME_LEN),
        "stored_level": None,
    }

    if is_party and len(record) >= PK5_PARTY_SIZE:
        extra = lcrng_crypt(record[PARTY_EXTRA_OFF:PARTY_EXTRA_OFF + PARTY_EXTRA_LEN], pid)
        fields["stored_level"] = extra[PARTY_LEVEL_OFF]
        fields["current_hp"] = struct.unpack_from("<H", extra, PARTY_CURHP_OFF)[0]
        fields["stored_stats"] = named_stats(
            struct.unpack_from("<6H", extra, PARTY_STATS_OFF), SAVE_STAT_ORDER)

    return fields


def nature_multiplier(nature_id: int, stat: str) -> tuple[int, int]:
    """Return (numerator, denominator) for a nature's effect on one stat."""
    if nature_id >= 25:
        return (10, 10)
    raised = NATURE_STAT_ORDER[nature_id // 5]
    lowered = NATURE_STAT_ORDER[nature_id % 5]
    if raised == lowered:
        return (10, 10)
    if stat == raised:
        return (11, 10)
    if stat == lowered:
        return (9, 10)
    return (10, 10)


def compute_stats(base: dict, ivs: dict, evs: dict, level: int, nature_id: int,
                  species_id: int | None = None) -> dict:
    """Gen 3+ stat formula. All four stat dicts are keyed hp/atk/def/spa/spd/spe."""
    out = {}
    for key in OUTPUT_STAT_ORDER:
        core = ((2 * base[key] + ivs[key] + evs[key] // 4) * level) // 100
        if key == "hp":
            # Shedinja's max HP is hardcoded to 1 by the engine, not by data.
            out[key] = 1 if species_id == 292 else core + level + 10
        else:
            num, den = nature_multiplier(nature_id, key)
            out[key] = ((core + 5) * num) // den
    return out


def present(fields: dict, wiki: Wiki, location: dict, curve_info: dict,
            personal: PersonalData | None = None) -> dict:
    dex = fields["species_id"]
    species = wiki.species_name(dex)
    ability = wiki.ability_name(fields["ability_id"])
    nature_id = fields["nature_id"]
    item_id = fields["item_id"]

    # Annotate each move with the level the ROM says this species learns it,
    # or null when it came from a TM, an egg move or a pre-evolution.
    learnset = personal.learnset(dex) if (personal and personal.loaded) else {}
    moves = []
    for mid in fields["move_ids"]:
        if mid == 0:
            continue
        entry = {"id": mid, "name": move_name(mid)}
        if learnset:
            entry["learned_at_level"] = learnset.get(mid)
        else:
            entry["wiki_lists_for_species"] = wiki.species_knows_move(
                dex, entry["name"])
        moves.append(entry)

    held = None
    if item_id:
        name = item_name(item_id)
        held = {
            "id": item_id,
            "name": name,
            "wiki_known_item": wiki.item_slug_known(name),
        }

    out = {
        **location,
        "species_id": dex,
        "species": species,
        "nickname": fields["nickname"],
        "is_nicknamed": fields["is_nicknamed"],
        "is_egg": fields["is_egg"],
        "level": curve_info["level"],
        "level_source": curve_info["level_source"],
        "level_confidence": curve_info["level_confidence"],
        "exp": fields["exp"],
        "exp_curve": CURVE_NAMES[curve_info["curve"]],
        "exp_curve_source": curve_info["curve_source"],
        "exp_curve_candidates": [CURVE_NAMES[c] for c in curve_info.get("candidates", [])],
        "nature": NATURES[nature_id] if nature_id < len(NATURES) else None,
        "nature_id": nature_id,
        "ability": ability,
        "ability_id": fields["ability_id"],
        "held_item": held,
        "moves": moves,
        "ivs": fields["ivs"],
        "evs": fields["evs"],
    }
    # Party records carry the game's own computed stats. Recomputing them from
    # wiki base stats + decoded IVs/EVs/nature/level and comparing is the only
    # check on this decoder that does not come from the decoder itself: six
    # independent equalities per party member, against numbers the game wrote.
    # Typing comes from the ROM only. The wiki's Types rows are contaminated
    # (22 species are typed Fairy, which does not exist in Gen 5).
    if personal is not None and personal.loaded:
        out["types"] = personal.types(dex)
        out["species_abilities"] = personal.abilities(dex)
        out["hidden_ability"] = personal.hidden_ability(dex)
        out["data_source"] = "rom"
    else:
        out["types"] = None
        out["data_source"] = "wiki-fallback"

    if fields.get("stored_stats") is not None:
        out["stats"] = fields["stored_stats"]
        out["current_hp"] = fields["current_hp"]
        base = None
        if personal is not None and personal.loaded:
            base = personal.base_stats(dex)
            out["base_stats_source"] = "rom"
        if base is None:
            base = wiki.base_stats(dex)
            out["base_stats_source"] = "wiki"
        if base is None:
            out["stats_check"] = "no-base-stats"
        else:
            computed = compute_stats(base, fields["ivs"], fields["evs"],
                                     curve_info["level"], nature_id, dex)
            if computed == fields["stored_stats"]:
                out["stats_check"] = "ok"
            else:
                out["stats_check"] = "MISMATCH"
                out["stats_computed"] = computed
                out["base_stats"] = base

    if curve_info.get("level_range"):
        out["level_range"] = curve_info["level_range"]
    if species is None:
        out["species"] = f"#{dex}"
        out["_species_unresolved"] = True
    return out


# --------------------------------------------------------------------------
# Curve observation store
# --------------------------------------------------------------------------
OBS_PATH = STATE_DIR / "curve_observations.json"


def load_observations(path: Path) -> dict:
    if not path.is_file():
        return {"version": 1, "species": {}}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"version": 1, "species": {}}
    doc.setdefault("species", {})
    return doc


class CurveResolver:
    """Learns real EXP curves from party members, which store level directly."""

    def __init__(self, observations: dict, wiki: Wiki, warnings: list[str],
                 personal: "PersonalData | None" = None):
        self.obs = observations
        self.wiki = wiki
        self.warnings = warnings
        self.personal = personal
        self.corrections: list[dict] = []
        self.dirty = False

    def rom_curve(self, dex: int) -> int | None:
        return self.personal.curve(dex) if self.personal else None

    def observe(self, dex: int, exp: int, level: int, now: str) -> None:
        candidates = curves_consistent_with(exp, level)
        if not candidates:
            self.warnings.append(
                f"{self.wiki.species_name(dex) or f'#{dex}'}: EXP {exp} at level "
                f"{level} matches no known experience curve. Blaze Black may use a "
                "custom curve for this species; level is still read directly from "
                "the party block, so party data is unaffected."
            )
            return

        rom = self.rom_curve(dex)
        if rom is not None:
            # With the ROM's own curve available there is nothing to infer.
            # The observation becomes a consistency check instead: if the
            # game's stored level disagrees with the ROM curve, either the save
            # decode or the ROM extraction is wrong, and both are load-bearing.
            if rom not in candidates:
                self.warnings.append(
                    f"CURVE CONFLICT for {self.wiki.species_name(dex) or f'#{dex}'}: "
                    f"the ROM says {CURVE_NAMES[rom]}, but EXP {exp} at level "
                    f"{level} is only consistent with "
                    f"{', '.join(CURVE_NAMES[c] for c in sorted(candidates))}. "
                    "One of the save decode or the ROM extraction is wrong."
                )
            return

        key = str(dex)
        rec = self.obs["species"].get(key)
        vanilla = VANILLA_CURVE.get(dex)

        if rec is None:
            rec = {
                "name": self.wiki.species_name(dex) or f"#{dex}",
                "candidates": sorted(candidates),
                "vanilla_curve": CURVE_NAMES[vanilla] if vanilla is not None else None,
                "samples": [],
                "first_seen": now,
            }
            self.obs["species"][key] = rec
            self.dirty = True

        previous = set(rec.get("candidates", []))
        merged = (previous & candidates) if previous else candidates
        if not merged:
            # Contradiction between observations; trust the newest and say so.
            self.warnings.append(
                f"{rec['name']}: new observation (EXP {exp} at level {level}) "
                f"contradicts earlier ones. Resetting its curve evidence."
            )
            merged = candidates

        sample = [exp, level]
        if sample not in rec["samples"]:
            rec["samples"].append(sample)
            rec["samples"] = rec["samples"][-20:]
            self.dirty = True
        if sorted(merged) != sorted(previous):
            rec["candidates"] = sorted(merged)
            self.dirty = True
        rec["last_seen"] = now

        # THRESHOLD PINNING.  A Pokemon whose EXP is *exactly* its curve's
        # threshold for its current level has gained no EXP since reaching that
        # level -- the signature of a fresh wild catch that has not battled.
        # Landing on a threshold is far more informative than landing inside a
        # band: if exactly one of the six curves has its threshold at this EXP,
        # that identifies the curve outright.  Deliberate workflow: catch
        # something, do not battle it, run the parser.
        exact = [c for c in range(6) if exp_for_level(c, level) == exp]
        if len(exact) == 1 and exact[0] in merged:
            prior = rec.get("threshold_curve")
            if prior is not None and prior != exact[0]:
                self.warnings.append(
                    f"{rec['name']}: threshold evidence now points at "
                    f"{CURVE_NAMES[exact[0]]} but previously indicated "
                    f"{CURVE_NAMES[prior]}. Using the newer observation."
                )
            if prior != exact[0]:
                rec["threshold_curve"] = exact[0]
                rec["threshold_evidence"] = {"exp": exp, "level": level}
                self.dirty = True

        threshold = rec.get("threshold_curve")
        if threshold is not None and threshold not in merged:
            # Later range evidence contradicts the threshold pin; drop it.
            rec.pop("threshold_curve", None)
            rec.pop("threshold_evidence", None)
            threshold = None
            self.dirty = True

        resolved = self._resolve(rec, vanilla)
        rec["candidate_curves"] = [CURVE_NAMES[c] for c in sorted(merged)]
        rec["resolved_curve"] = CURVE_NAMES[resolved]
        if threshold is not None:
            rec["pinned"], rec["pinned_by"] = True, "threshold"
        elif len(merged) == 1:
            rec["pinned"], rec["pinned_by"] = True, "range"
        else:
            rec["pinned"], rec["pinned_by"] = False, None
        if rec["pinned"]:
            rec.pop("note", None)
        else:
            rec["note"] = (
                "More than one curve still fits. Box levels are only reported as "
                "certain when every candidate agrees on the level. To pin this "
                "species, catch one and run the parser before battling with it."
            )

        if vanilla is not None and vanilla not in merged:
            rec["matches_vanilla"] = False
            self.corrections.append({
                "species_id": dex,
                "species": rec["name"],
                "vanilla_curve": CURVE_NAMES[vanilla],
                "observed_curves": [CURVE_NAMES[c] for c in sorted(merged)],
                "resolved_curve": CURVE_NAMES[resolved],
                "pinned_by": rec["pinned_by"],
                "evidence": {"exp": exp, "level": level},
            })
            if threshold is not None:
                detail = (f"EXP {exp} is exactly {CURVE_NAMES[threshold]}'s "
                          f"level-{level} threshold, so it is "
                          f"{CURVE_NAMES[threshold]}.")
            else:
                detail = (f"EXP {exp} at level {level} rules that out; consistent "
                          f"with {', '.join(CURVE_NAMES[c] for c in sorted(merged))}.")
            self.warnings.append(
                f"EXP CURVE CORRECTION: {rec['name']} (#{dex}) is NOT "
                f"{CURVE_NAMES[vanilla]} in Blaze Black. {detail} "
                "Recorded, and used for box levels from now on."
            )
        else:
            rec["matches_vanilla"] = True

    @staticmethod
    def _resolve(rec: dict, vanilla: int | None) -> int:
        cands = rec.get("candidates") or []
        threshold = rec.get("threshold_curve")
        if threshold is not None and (not cands or threshold in cands):
            return threshold
        if len(cands) == 1:
            return cands[0]
        if vanilla is not None and vanilla in cands:
            return vanilla
        if cands:
            return cands[0]
        return vanilla if vanilla is not None else MEDIUM_FAST

    def for_box(self, dex: int) -> dict:
        """Resolve the curve to use for a box record, with a confidence label."""
        rom = self.rom_curve(dex)
        if rom is not None:
            # The ROM states the curve outright; no inference required.
            return {"curve": rom, "candidates": [rom],
                    "confidence": "exact", "source": "rom"}
        vanilla = VANILLA_CURVE.get(dex, MEDIUM_FAST)
        rec = self.obs["species"].get(str(dex))
        if rec is None:
            return {"curve": vanilla, "candidates": [vanilla],
                    "confidence": "assumed", "source": "vanilla-table"}
        cands = rec.get("candidates") or [vanilla]
        curve = self._resolve(rec, VANILLA_CURVE.get(dex))
        threshold = rec.get("threshold_curve")
        if threshold is not None and threshold in cands:
            # Threshold evidence identifies the curve outright, so there is no
            # spread of candidate levels left to report.
            return {"curve": curve, "candidates": [threshold],
                    "confidence": "pinned", "source": "observed-threshold"}
        return {
            "curve": curve,
            "candidates": sorted(cands),
            "confidence": "pinned" if len(cands) == 1 else "narrowed",
            "source": "observed-unique" if len(cands) == 1 else "observed-narrowed",
        }


# --------------------------------------------------------------------------
# Main parse
# --------------------------------------------------------------------------
def box_names(data: bytes, base: int) -> list[str]:
    names = []
    for n in range(BOX_COUNT):
        off = base + BOXNAME_BLOCK + BOXNAME_FIRST + n * BOXNAME_STRIDE
        names.append(decode_string(data[off:off + BOXNAME_STRIDE], BOXNAME_STRIDE // 2))
    return names


def parse(data: bytes, wiki: Wiki, resolver: CurveResolver, warnings: list[str],
          personal: PersonalData | None = None) -> dict:
    slot_index, reports, reason = choose_slot(data, warnings)
    base = SLOT_OFFSETS[slot_index]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # --- party: level is stored, so these double as curve observations -----
    declared = struct.unpack_from("<I", data, base + PARTY_BLOCK + PARTY_COUNT_OFF)[0]
    party = []
    for i in range(PARTY_SLOTS):
        off = base + PARTY_BLOCK + PARTY_FIRST + i * PK5_PARTY_SIZE
        fields = decode_pk5(data[off:off + PK5_PARTY_SIZE], is_party=True)
        if fields is None:
            continue
        level = fields["stored_level"]
        dex = fields["species_id"]
        if level is not None and 1 <= level <= MAX_LEVEL and not fields["is_egg"]:
            resolver.observe(dex, fields["exp"], level, now)
        curve = resolver.for_box(dex)
        party.append(present(fields, wiki, {"slot": i + 1}, {
            "level": level,
            "level_source": "stored",
            "level_confidence": "exact",
            "curve": curve["curve"],
            "curve_source": curve["source"],
            "candidates": curve["candidates"],
        }, personal))
        mon = party[-1]
        if mon.get("stats_check") == "MISMATCH":
            warnings.append(
                f"STAT MISMATCH for {mon['species']} (slot {mon['slot']}): the game "
                f"stores {mon['stats']} but wiki base stats {mon['base_stats']} with "
                f"the decoded IVs/EVs/nature give {mon['stats_computed']}. Either a "
                "decode offset is wrong or the wiki's base stats are stale. Do not "
                "trust this Pokemon's numbers until it is resolved."
            )
        elif mon.get("stats_check") == "no-base-stats":
            warnings.append(
                f"No base stats for {mon['species']} (#{mon['species_id']}) from the "
                "ROM or the wiki, so its decode could not be cross-checked."
            )

    if declared != len(party):
        warnings.append(
            f"Party header claims {declared} Pokemon but {len(party)} slots decode "
            "cleanly. Reporting the slots that actually validate."
        )

    # --- boxes: level must be derived from EXP ------------------------------
    names = box_names(data, base)
    boxes = []
    for n in range(BOX_COUNT):
        box_off = base + BOX_BASE + n * BOX_STRIDE
        members = []
        for s in range(BOX_SLOTS):
            off = box_off + s * PK5_BOX_SIZE
            fields = decode_pk5(data[off:off + PK5_BOX_SIZE], is_party=False)
            if fields is None:
                continue
            dex = fields["species_id"]
            curve = resolver.for_box(dex)
            # If every still-possible curve yields the same level, the level is
            # certain even when the curve itself is not pinned.
            levels = {level_for_exp(c, fields["exp"]) for c in curve["candidates"]}
            if curve["confidence"] == "assumed":
                confidence = "assumed"
            elif len(levels) == 1:
                confidence = "pinned"
            else:
                confidence = "narrowed"
            info = {
                "level": level_for_exp(curve["curve"], fields["exp"]),
                "level_source": "derived",
                "level_confidence": confidence,
                "curve": curve["curve"],
                "curve_source": curve["source"],
                "candidates": curve["candidates"],
            }
            if len(levels) > 1:
                info["level_range"] = [min(levels), max(levels)]
            members.append(present(fields, wiki, {"slot": s + 1}, info, personal))
        boxes.append({"box": n + 1, "name": names[n], "count": len(members),
                      "pokemon": members})

    return {
        "slot_used": slot_index,
        "slot_selection": reason,
        "slots": reports,
        "party": party,
        "party_count_declared": declared,
        "boxes": boxes,
        "box_total": sum(b["count"] for b in boxes),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--save", type=Path, default=DEFAULT_SAVE, help="path to the .sav")
    ap.add_argument("--out", type=Path, default=STATE_DIR / "party.json")
    ap.add_argument("--observations", type=Path, default=OBS_PATH)
    ap.add_argument("--personal", type=Path, default=STATE_DIR / "personal.json",
                    help="ROM-extracted species table (primary data source)")
    ap.add_argument("--wiki", type=Path, default=WIKI_DOCS)
    ap.add_argument("--min-age", type=float, default=MIN_MTIME_AGE,
                    help="minimum save mtime age in seconds (default 2)")
    ap.add_argument("--no-observations", action="store_true",
                    help="do not update the curve observation store")
    ap.add_argument("--stdout", action="store_true", help="also print the JSON")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    try:
        data, save_meta = read_save(args.save, args.min_age)
    except SaveError as exc:
        print(f"parse_save: {exc}", file=sys.stderr)
        return 1

    warnings: list[str] = []
    wiki = Wiki(args.wiki)
    observations = load_observations(args.observations)
    personal = PersonalData(args.personal)
    if not personal.loaded:
        warnings.append(
            f"No ROM species table at {args.personal}. Falling back to wiki base "
            "stats and the embedded experience-curve table, both of which have "
            "known errors. Run extract_personal.py to fix this."
        )
    resolver = CurveResolver(observations, wiki, warnings, personal)

    try:
        result = parse(data, wiki, resolver, warnings, personal)
    except SaveError as exc:
        print(f"parse_save: {exc}", file=sys.stderr)
        return 1

    if wiki.missing:
        warnings.append(
            "Missing wiki data: " + ", ".join(sorted(set(wiki.missing))[:8])
        )

    doc = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "save": save_meta,
            "slot_used": result.pop("slot_used"),
            "slot_selection": result.pop("slot_selection"),
            "slots": result.pop("slots"),
            "stat_key_order": list(OUTPUT_STAT_ORDER),
            "personal_data": {
                "loaded": personal.loaded,
                "path": str(args.personal),
                "rom": personal.meta.get("rom", {}).get("path") if personal.loaded else None,
                "species_count": personal.meta.get("species_count") if personal.loaded else 0,
            },
            "name_sources": {
                "base_stats/types/abilities/curve": (
                    "state/personal.json (ROM)" if personal.loaded else "wiki (FALLBACK)"),
                "species": "wiki/docs/pokemon/<NNN>.md",
                "ability": "wiki/docs/includes/abilities.md",
                "nature": "embedded table",
                "move": "embedded table (NAMES ONLY - power/accuracy/type from wiki)",
                "item": "embedded table (names only)",
            },
            "curve_corrections": resolver.corrections,
            "warnings": warnings,
            "needs_attention": bool(warnings),
        },
        **result,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")

    if not args.no_observations and resolver.dirty:
        args.observations.parent.mkdir(parents=True, exist_ok=True)
        args.observations.write_text(
            json.dumps(observations, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8")

    if args.stdout:
        print(json.dumps(doc, indent=2, ensure_ascii=False))

    if not args.quiet:
        print(f"parse_save: slot {doc['meta']['slot_used']} "
              f"({doc['meta']['slot_selection']})", file=sys.stderr)
        print(f"parse_save: {len(doc['party'])} in party, "
              f"{doc['box_total']} in boxes -> {args.out}", file=sys.stderr)
        for w in warnings:
            print(f"parse_save: WARNING: {w}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

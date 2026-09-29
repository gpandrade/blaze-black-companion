#!/usr/bin/env python3
"""
build_sheet.py -- regenerate the team-sheet page from the CURRENT save.

Run this after levelling up, evolving, changing an item, or beating a boss:

    python3 build_sheet.py

Everything that can change during play -- level, stats, nature, ability, held
item, moves, shininess -- is read live from the save.  Everything that cannot
be derived from the save -- which team a Pokemon belongs to, its role, the
prose, the swap notes -- lives in the team store (state/teams.json), which the
Team Builder writes.  TEAM_LAYOUT below is the SEED for that store, not a
source of tabs: it is what a fresh checkout adopts on first run.

Reads the save read-only via parse_save.read_save.  Writes exactly one file:
state/team_sheet.html
"""
from __future__ import annotations

import base64, json, re, struct, sys
from datetime import datetime, timezone
from pathlib import Path

import paths

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import parse_save as ps
from extract_personal import NDSRom, parse_narc
from extract_items import decode_text_file

STATE = ROOT / "state"
TEMPLATE = ROOT / "sheet_template.html"
OUT = STATE / "team_sheet.html"
ROM_PATH = paths.ROM

TEXT_NARC = "a/0/0/2"
F_MOVE_DESC, F_ABIL_NAME, F_ABIL_DESC = 202, 182, 183
MOVE_NARC = "a/0/2/1"
BATTLE_BOX = 0x20A00      # checksum table entry 49
AIL = {1: 'paralysis', 2: 'sleep', 3: 'freeze', 4: 'burn', 5: 'poison', 6: 'confusion',
       7: 'infatuation', 8: 'trapped', 9: 'nightmare', 12: 'flinch', 13: 'torment',
       15: 'leech seed', 17: 'badly poisoned'}
STAT_BY_ID = {1: 'Attack', 2: 'Defence', 3: 'Sp. Atk', 4: 'Sp. Def', 5: 'Speed',
              6: 'accuracy', 7: 'evasion'}

# ---------------------------------------------------------------------------
# STAT STAGES, read from the ROM rather than remembered.
#
# The move entry carries them directly, proven against moves whose behaviour is
# not in doubt:
#     byte 20      target -- 0x07 is the user, anything else is the opponent
#     bytes 21,22  stat ids (STAT_BY_ID), 0 = unused
#     bytes 24,25  stage delta as a SIGNED byte (0xfe = -2)
# Swords Dance reads self/Attack/+2, Growl foe/Attack/-1, Screech foe/Defence/-2.
#
# Deriving these instead of hardcoding them means a stat move Drayano rebalanced
# is picked up for free -- the same reason base stats come from personal.json.
STAGE_KEY = {1: 'atk', 2: 'def', 3: 'spa', 4: 'spd', 5: 'spe', 6: 'acc', 7: 'eva'}

# The handful whose stages are baked into an effect id instead of those fields,
# keyed by the u16 at bytes 16-17. Each is checked against the game's own
# description text at build time, so a wrong guess fails the build.
SPECIAL_STAGES = {
    142: ('self', {'atk': 6}),                                    # Belly Drum
    308: ('self', {'atk': 2, 'spa': 2, 'spe': 2, 'def': -1, 'spd': -1}),  # Shell Smash
    109: ('self', {'atk': 1, 'def': 1, 'spe': -1}),               # Curse (non-Ghost)
}


# Damaging moves whose OWN stats fall after use -- guaranteed, not a chance.
# Byte 20 cannot tell these apart: it is the move's target (the foe), while the
# stat drop lands on the user, so Close Combat reads "foe" if taken at face
# value. 204 is the shared "user's Sp. Atk falls 2" effect behind Draco Meteor,
# Overheat, Leaf Storm and Psycho Boost.
SELF_DROP_EFFECTS = {182, 204, 218, 229, 334}


def move_stages(e, category):
    """(target, {stat_key: delta}) for a raw move entry, or (None, {}).

    Only stage changes that are CERTAIN are reported. A damaging move with a
    percentage chance to drop a stat (Crunch, Aurora Beam) is deliberately
    excluded -- it is already flagged in the move detail, and offering it as a
    toggle would state a maybe as a fact.
    """
    eid = e[16] | (e[17] << 8)
    if eid in SPECIAL_STAGES:
        return SPECIAL_STAGES[eid]
    sgn = lambda b: b - 256 if b > 127 else b
    out = {}
    for sid_i, dlt_i in ((21, 24), (22, 25)):
        key = STAGE_KEY.get(e[sid_i])
        d = sgn(e[dlt_i])
        if key and d:
            out[key] = d
    if not out:
        return (None, {})
    if eid in SELF_DROP_EFFECTS:
        return ('self', out)
    if category != 'status':
        return (None, {})
    return ('self' if e[20] == 0x07 else 'foe', out)
HELD_ITEMS_OF_INTEREST = {
    'Life Orb','Leftovers','Choice Band','Choice Specs','Choice Scarf','Focus Sash','Expert Belt',
    'Muscle Band','Wise Glasses','Damp Rock','Heat Rock','Smooth Rock','Icy Rock','Light Clay',
    'Black Sludge','Air Balloon','Eviolite','Rocky Helmet','Shell Bell','Quick Claw',"King's Rock",
    'Razor Claw','Scope Lens','Bright Powder','Sitrus Berry','Lum Berry','Chesto Berry','Toxic Orb',
    'Flame Orb','Metal Coat','Everstone','Oval Stone','Wide Lens','Zoom Lens','Binding Band',
    'Grip Claw','Big Root','Power Herb','White Herb','Mental Herb','Soul Dew'}

# Box-nickname tags, and their LAST remaining job.
#
# These used to disambiguate: a TEAM_LAYOUT slot names only a species, so with
# four Arcanines in the save the one-letter nickname tag said which team meant
# which.  Cores carry a full spec instead, so nothing matches on a tag any more
# -- except the one-time adoption of TEAM_LAYOUT into the store, which still
# needs it to resolve each roster to the right copy.  Exported beside LAYOUT in
# build_static.py for exactly that.  tag_and_dex.py writes them into the save.
TEAM_TAG = {'kaiju': 'K', 'rain': 'R', 'tr': 'T', 'edge': 'E',
            'mewtwo': 'M', 'contrary': 'C', 'sun': 'S', 'uncle': 'N'}


def _bag():
    return json.loads((STATE / "bag.json").read_text())


def here_panel(personal):
    """Wild encounters for wherever he is standing, straight from the wiki.

    Surf rows are marked rather than dropped -- HM03 is not in his bag, so they
    are real encounters he simply cannot reach yet, and saying so is more use
    than hiding them.
    """
    bag = _bag()
    loc = bag.get("position", {}).get("location") or ""
    has_surf = any("HM03" in i.get("name", "") for i in bag["bag"]["tms_hms"])
    has_rod = any("Rod" in i.get("name", "") for i in bag["bag"]["key_items"])
    root = ROOT / "wiki/docs/routes"
    match = None
    if root.is_dir():
        for d in sorted(root.iterdir()):
            if d.is_dir() and d.name.lower().rstrip("s") in loc.lower():
                match = d
                break
        if match is None:
            for d in sorted(root.iterdir()):
                if d.is_dir() and loc.lower() in d.name.lower():
                    match = d
                    break
    rows = []
    f = match / "wild_encounters.md" if match else None
    if f and f.is_file():
        for line in f.read_text(encoding="utf-8").splitlines():
            if "pokemon/" not in line:
                continue
            m = re.match(r"\|\s*!\[([a-z-]+)\]", line.strip())
            method = m.group(1) if m else (rows[-1]["method"] if rows else "?")
            mons = []
            for nm, pct in re.findall(r"\]\(/blaze-black-wiki/pokemon/(\d+)\)[^|]*?(\d+)%", line):
                sid = int(nm)
                sp = next((v for v in personal.values()
                           if v.get("id", 0) == sid or v["name"]), None)
                mons.append(dict(id=sid, pct=int(pct)))
            if mons:
                gated = ("surf" in method and not has_surf) or ("fishing" in method and not has_rod)
                rows.append(dict(method=method, mons=mons, gated=gated))
    return dict(loc=loc, rows=rows, hasSurf=has_surf, hasRod=has_rod)


def bag_tms(personal):
    """Every TM/HM he owns, cross-referenced against who can legally learn it.

    Compatibility comes from the ROM's own tmhm list per species, so this is
    "can actually be taught", not a guess.  Only Pokemon he owns are listed.
    """
    by_name = {v["name"]: v for v in personal.values()}
    owned = boxed_index()
    seen, mons = set(), []
    for m in owned:
        if m["n"] in seen:
            continue
        seen.add(m["n"])
        mons.append(m)
    out = []
    for it in _bag()["bag"]["tms_hms"]:
        m = re.match(r"(TM\d+|HM\d+)\s+(.*)", it.get("name", ""))
        if not m:
            continue
        slot, move = m.group(1), m.group(2)
        # "Who can learn this" is only useful about the six you are running.
        # A full list is 200+ names for something like Hidden Power.
        party = sorted({x["n"] for x in owned if x["b"] == "Party"
                        and slot in (by_name.get(x["n"], {}).get("tmhm") or [])})
        total = sum(1 for x in mons
                    if slot in (by_name.get(x["n"], {}).get("tmhm") or []))
        out.append(dict(slot=slot, move=move, count=it.get("count", 1),
                        party=party, n=total, owned=len(mons)))
    return out


def boxed_index():
    """Flat list of everything in the PC, for the search panel."""
    party = json.loads(need_save_derived("party.json").read_text())
    out = []
    for p in party.get("party", []):
        out.append(dict(n=p["species"], k=p.get("nickname") or "", b="Party",
                        l=p.get("level"), a=p.get("ability"), t=p.get("types", [])))
    for i, box in enumerate(party.get("boxes", [])):
        for p in (box.get("pokemon") or []):
            out.append(dict(n=p["species"], k=p.get("nickname") or "", b=f"Box {i+1}",
                            l=p.get("level"), a=p.get("ability"), t=p.get("types", [])))
    return out


# ===========================================================================
# TEAM LAYOUT -- the SHIPPED ROSTERS, which are seed data.
#
# These eight are hand-authored line-ups that settled long ago.  They used to
# be rendered directly as battle tabs, which made them a second class of team:
# visible everywhere, editable nowhere.  They are adopted into the team store
# as ordinary cores on first run instead (seedBuiltins() in app/js/teams.js),
# after which they can be edited, retired and fielded like anything else.
#
# THEY STILL LIVE HERE because state/teams.json is gitignored -- a fresh
# checkout has no teams, and the writing in these is real work.  Nothing reads
# them at render time; build_static.py exports them as LAYOUT purely to seed.
#
#   Options are ('Species', badge, note) or ('Species', badge, note, rigged).
#   `rigged` is the disclaimer shown for a deliberately-broken Pokemon.
#   A slot names a SPECIES and is resolved against the save at adoption time,
#   so moving Pokemon between boxes never breaks this file.
# ===========================================================================
TEAM_LAYOUT = [
 dict(id='kaiju', name='Kaiju', where='Party', tr=False, mech=['rain'],
  tagline='Six fully-evolved giants, no shared gimmick. Every slot is independently strong.',
  pilot=[('Lead','Slowking — Drizzle sets permanent rain. Scald ×1.5, enemy Fire halved, all battle.'),
         ('Speed','Gengar outruns everything and is immune to Ground, Normal and Fighting. In, kill, out.'),
         ('Win con','Snorlax vs anything slow. Two Curses behind Leftovers and they run out of answers.'),
         ('Setup','Tyranitar Dragon Dances to snowball; Garchomp Swords Dances to kill now.'),
         ('Panic','Scizor. Bullet Punch is priority — anything on a sliver dies regardless of Speed.')],
  warn='<b>Fighting is the hole.</b> Snorlax and Tyranitar both take heavy damage and nothing resists it. '
       'Gengar is immune — send it in. Swapping Dragonite into slot 4 fixes this outright.',
  slots=[
   dict(role='sweeper', why='Four unresisted attack types. Levitate cancels its Ground weakness.',
        options=[('Gengar',None,None),
                 ('Chandelure','glass cannon',
                  '145 base Sp. Atk, the highest on any of your teams, and Ghost/Fire trades Gengar’s Ground immunity for a Fire STAB that melts the Steels walling you.')]),
   dict(role='wall', why='Thick Fat halves Fire and Ice. Curse makes it a win condition, not a sponge.',
        options=[('Snorlax',None,None),
                 ('Slaking','engineered · ×2 Atk',
                  'Same pure-Normal typing as Snorlax, so the team’s resistances and immunities are '
                  '<b>completely unchanged</b> — 35 resists, 6 immunities either way. Straight stat upgrade '
                  'on every axis but Sp. Def: <b>160 Atk vs 110, 100 Speed vs 30.</b> Extreme Speed is +2 '
                  'priority off a doubled Attack; Slack Off keeps the slot’s staying power.',
                  'Slaking’s two real abilities are both <b>drawbacks</b> — Truant (it attacks every '
                  '<i>other</i> turn) and Slow Start. Its save record has been written with <b>Huge Power</b> '
                  'instead, which it cannot legally have. That deletes the drawback and doubles Attack: '
                  '160 base becomes an effective <b>320, the highest in the game</b>. Its moves were written '
                  'in too. Typing is untouched. If it feels like it is trivialising fights — it is, and that '
                  'was the point.'),
                 ('Steelix','armour plating',
                  '200 base Defence and immune to Electric and Poison. Trades Snorlax’s 160 HP and Thick Fat for flat physical immovability.')]),
   dict(role='sweeper', why='Battle Armor over Sand Stream on purpose — auto-sand would chip four of your own six.',
        options=[('Tyranitar',None,None),
                 ('Metagross','no auto-weather',
                  'BST 600 like Tyranitar with 135 Atk and 130 Def, and Steel/Psychic has no Fighting ×4. Meteor Mash can raise Attack; Bullet Punch adds priority.')]),
   dict(role='sweeper', why='Rough Skin, not Sand Veil — no sand here, so passive chip beats dead evasion.',
        options=[('Garchomp',None,None),
                 ('Dragonite','recommended',
                  'Ground-immune and <b>resists Fighting</b> — the team’s one hole. Multiscale halves '
                  'damage at full HP, so it holds Leftovers: Life Orb recoil would switch it off.'),
                 ('Salamence','snowball',
                  'Moxie raises Attack on every KO, so it accelerates instead of just setting up. '
                  'Faster than Garchomp and Dragonite; frailer than either.')]),
   dict(role='pivot', why='Sets the weather, sponges special hits, and Nasty Plot turns it into a real threat.',
        options=[('Slowking',None,None),
                 ('Wobbuffet','engineered · trapper',
                  '<b>They cannot switch, and in three turns they die.</b> Neither half of that reads a stat. '
                  'Closes the team’s Electric hole too — Slowking is Water/Psychic and Electric-weak, pure '
                  'Psychic is not. Costs four resistances and, more importantly, <b>the rain toggle</b>: '
                  'Slowking is your Drizzle setter, so field Slowbro in this slot if you want weather.',
                  '<b>Shadow Tag is genuinely its own</b> — no ability was edited here. The cheat is the '
                  'moveset: Wobbuffet’s entire real movepool is Counter, Mirror Coat, Safeguard, Destiny Bond '
                  'and Mimic, and it has <b>zero TM compatibility</b>. Perish Song, Protect and Encore were '
                  'written into its save record. The loop is: trap them, sing, Protect through the count, and '
                  'if they somehow kill it, Destiny Bond takes the killer with it. It wins fights it has no '
                  'business winning, and its 34 Attack never comes up.'),
                 ('Slowbro','physical wall',
                  'Same Drizzle, same 100 Sp. Atk, but 110 Defence instead of 110 Sp. Def — take this when '
                  'the fight is physical. Slack Off gives it real recovery.')]),
   dict(role='pivot', why='Resists Dark, Ghost and Ice. Bug Bite beats X-Scissor: Technician turns 60 into 90.',
        options=[('Scizor',None,None),
                 ('Bisharp','sharper',
                  'Dark/Steel resists Dark and Ghost at ×0.25 rather than ×0.5, with 125 Atk and Sucker Punch '
                  'for priority. Costs you a ×4 Fighting weakness.')]),
  ]),
 dict(id='rain', name='Rain', where='Box 2', tr=False, mech=['rain'],
  tagline='Drizzle is permanent in Gen 5 — no re-setting, no clock. Water ×1.5, Fire ×0.5, Thunder always hits.',
  pilot=[('Lead','Slowking. If an opponent overwrites the weather, switch it back in to reset rain.'),
         ('Sweep','Swift Swim doubles Speed in rain — Kingdra’s Hydro Pump lands near 180 effective.'),
         ('Thunder','Ampharos carries Thunder AND Thunderbolt: the nuke for rain, the fallback for when it drops.'),
         ('Pivot','Gastrodon. Storm Drain absorbs Water for a Sp. Atk boost; Recover keeps it alive forever.')],
  warn='<b>Do not stack pure Waters.</b> Electric and Grass shred this archetype. Ludicolo is neutral to both, '
       'Gastrodon is Electric-immune, Poliwrath breaks Steels and Darks — that spread is the team.',
  slots=[
   dict(role='setter', why='The engine. Non-shiny on purpose so you can tell it from the party Slowking.',
        options=[('Slowking',None,None),
                 ('Politoed','pure Water',
                  'Drizzle without the Psychic typing, so no Dark, Bug or Ghost weakness — and 70 Speed '
                  'instead of 30. Less bulk, cleaner switch-in.')]),
   dict(role='sweeper', why='Water/Grass is the defensive glue — neutral to both Electric and Grass.',
        options=[('Ludicolo',None,None),
                 ('Floatzel','physical',
                  '115 base Speed doubled by Swift Swim, with Aqua Jet priority. Gives up Ludicolo’s '
                  'Water/Grass neutrality to Electric and Grass, so it is the greedier pick.')]),
   dict(role='sweeper', why='Water/Dragon is resisted by almost nothing. Draco Meteor is your biggest single hit.',
        options=[('Kingdra',None,None),
                 ('Gorebyss','more punch',
                  '114 base Sp. Atk against Kingdra’s 95, and Storm Drain is on its second slot. '
                  'Loses the Water/Dragon typing that almost nothing resists.')]),
   dict(role='wall', why='Water/Ground is immune to Electric — the type that would otherwise dismantle this team.',
        options=[('Gastrodon',None,None),
                 ('Seismitoad','bulkier',
                  'Same Water/Ground Electric immunity with 105 HP and Water Absorb, and it carries '
                  'Rain Dance as a backup if your Drizzle setter faints.')]),
   dict(role='sweeper', why='No Water Pokémon in this hack learns Thunder. This slot exists to carry it.',
        options=[('Ampharos',None,None),
                 ('Zebstrika','fast + Grass-immune',
                  '116 base Speed and <b>Sap Sipper</b> — a flat Grass immunity, which is the type this '
                  'archetype fears most. Costs 35 points of Sp. Atk.')]),
   dict(role='sweeper', why='The physical half. Water/Fighting breaks the Steels and Darks that wall the rest.',
        options=[('Poliwrath',None,None),
                 ('Kabutops','Rock coverage',
                  'Swift Swim with 115 Atk and Stone Edge, so it beats the Flying and Ice types that '
                  'wall Poliwrath. Rock/Water is far frailer on the special side.')]),
  ]),
 dict(id='tr', name='Trick Room', where='Box 3 + 5', tr=True, mech=['tr','sand','sun'],
  tagline='Five turns of inverted Speed. Every member is tuned for it: minus-Speed nature, 0 Speed IV, 0 Speed EV.',
  pilot=[('Turn 1','Dusknoir sets Trick Room. 135/135 defences and immune to Normal and Fighting — it survives.'),
         ('Turns 2–5','Emboar or Conkeldurr swings. Three or four attacks is usually the match.'),
         ('Biggest hit','Emboar. Adaptability doubles STAB — Flare Blitz ≈240 effective, Earthquake ≈200.'),
         ('When it lapses','Sit on Spiritomb or Eelektross. Nothing hits either super-effectively.')],
  warn='<b>Every Trick Room Pokémon has 0 Speed IVs and EVs.</b> Correct for Trick Room, wrong everywhere else — '
       'don’t move one into the Kaiju team without asking me to re-tune it.',
  slots=[
   dict(role='setter', why='The only Trick Room user here. Ghost keeps Normal and Fighting off it while it sets up.',
        options=[('Dusknoir',None,None),
                 ('Bronzong','safer setter',
                  '116/116 defences and <b>Levitate</b>, so Ground cannot touch it while it sets up. '
                  'Gyro Ball at 15 Speed is close to maximum power.')]),
   dict(role='wall', why='Ghost/Dark has zero weaknesses in Gen 5 and is immune to Normal, Fighting and Psychic.',
        options=[('Spiritomb',None,None),
                 ('Cofagrigus','145 Defence',
                  'Ghost/<b>Steel</b> in this hack — a huge resist list plus Mummy, which erases the '
                  'attacker’s ability on contact. Not weakness-free like Spiritomb, but far harder to dent.')]),
   dict(role='sweeper', why='Electric’s only weakness is Ground and Levitate cancels it. A second untouchable body.',
        options=[('Eelektross',None,None),
                 ('Golurk','three immunities',
                  'Immune to Electric, Fighting <b>and</b> Normal, with 124 Atk. <b>No Guard</b> makes '
                  'Dynamic Punch and Stone Edge never miss. Gives up Eelektross’s weakness-free typing.')]),
   dict(role='sweeper', why='Fire/Ground in this hack. Adaptability makes it the hardest hitter on any of your teams.',
        options=[('Emboar',None,None),
                 ('Camerupt','brings the sun',
                  'Same Fire/Ground, but <b>Drought</b> — it turns the sun on by itself, which powers up '
                  'Eruption and flips the sun toggle on this tab into something real.')]),
   dict(role='sweeper', why='140 base Atk wallbreaker. Iron Fist boosts both punches 20%; Drain Punch heals Life Orb back.',
        options=[('Conkeldurr',None,None),
                 ('Machamp','even swap',
                  'Identical team defence. 130 base Atk vs 140 and no healing, but <b>No Guard</b> makes Dynamic '
                  'Punch (always confuses) and Stone Edge hit 100%.'),
                 ('Hariyama','tankier',
                  'Thick Fat halves Ice, <b>deleting one of the team’s three problems</b>. 144 base HP. Costs ~14% Attack.'),
                 ('Ursaring','fewest holes',
                  'Normal is immune to Ghost, patching Dusknoir’s only weakness. But no resistances and a poor attacking type.')]),
   dict(role='pivot', why='Resists Water, Ground, Grass and Electric — covering Emboar’s weaknesses — plus Regenerator.',
        options=[('Tangrowth',None,None),
                 ('Ferrothorn','best defence',
                  'Leaves the team with <b>zero weaknesses</b> — not fewer, none. At 10 Speed it is the best Gyro Ball '
                  'user in the game. Cost: a wall instead of an attacker.'),
                 ('Forretress','softer',
                  '140 base Defence, only one minor Water issue left, another strong Gyro Ball user.'),
                 ('Vileplume','keeps offence',
                  '110 base Sp. Atk keeps the slot threatening and Sleep Powder is a free win button. '
                  'Costs a new <b>Psychic</b> weakness.')]),
  ]),
 dict(id='edge', name='Edgelord', where='Box 5 + 6', tr=False, mech=[],
  tagline='Rayquaza and Mewtwo up front, and four more picked to look the part. Built glitz-first, then made to hold together.',
  pilot=[('Lead','Darkrai. Dark Void puts them to sleep, then <b>Bad Dreams</b> drains ⅛ of their max HP every turn they stay under.'),
         ('Setup','Rayquaza. One Dragon Dance off 150 base Attack and Extreme Speed picks off anything left on a sliver.'),
         ('Win con','Mewtwo. 154 Sp. Atk at 130 Speed — Calm Mind once and Psystrike hits their <i>physical</i> Defence.'),
         ('Wall','Giratina. 150 HP behind Will-O-Wisp, immune to Normal and Fighting. Your switch-in to anything physical.'),
         ('Weather','Rayquaza’s <b>Air Lock</b> shuts off enemy weather while it is on the field — it blanks an opposing Drought or Drizzle for free.')],
  warn='<b>Nothing here touches Water/Ground.</b> Swampert, Seismitoad, Quagsire and Gastrodon take not one '
       'super-effective hit from all six — no Grass, no Water on the team, and their Ground typing voids '
       'Darkrai’s Thunderbolt. Also watch Ice: Rayquaza takes it at <b>×4</b>, so lead Metagross into a suspected Ice Beam.',
  slots=[
   dict(role='sweeper', why='150 Atk and 150 Sp. Atk on one body. Dragon Dance makes it a physical sweeper; Extreme Speed is +2 priority.',
        options=[('Rayquaza',None,None),
                 ('Zekrom','brings Electric',
                  'The one coverage type this team is missing. 150 Atk with <b>Teravolt</b>, which ignores the '
                  'target’s ability, so Levitate and Flash Fire stop mattering. Loses Air Lock and the Ground immunity.')]),
   dict(role='sweeper', why='Psystrike is special but damages their Defence instead of Sp. Def — it goes straight through special walls.',
        options=[('Mewtwo',None,None),
                 ('Hydreigon','the cut legend',
                  'The sixth edgelord that did not make the core. Dark/Dragon with <b>Levitate</b>, immune to '
                  'Ground <i>and</i> Psychic. Costs you the Ice/Dragon stack — that is exactly why it is benched.')]),
   dict(role='wall', why='150 HP / 120 / 120, immune to Normal and Fighting. Will-O-Wisp halves what physical attackers do to the rest of the team.',
        options=[('Giratina-Altered',None,None),
                 ('Dialga','special tank',
                  'Steel/Dragon resists <b>Ice</b>, the type this team most wants gone, and 150 Sp. Atk makes it '
                  'a threat rather than a sponge. Costs Giratina’s Fighting immunity and picks up Fighting ×4.')]),
   dict(role='setter', why='Dark Void sleeps them, Bad Dreams bills them for it. The only sleep engine on any of your teams.',
        options=[('Darkrai',None,None),
                 ('Zoroark','trickster',
                  '<b>Illusion</b> disguises it as your last party member, so the AI targets the wrong thing for a turn. '
                  '105 Sp. Atk and 105 Speed. Loses Dark Void, which is most of what Darkrai is for.')]),
   dict(role='sweeper', why='Flash Fire is the point — it switches into the Fire moves aimed at Metagross and gets +50% Fire for free.',
        options=[('Houndoom',None,None),
                 ('Weavile','priority + trapping',
                  'Ice Shard is priority off 120 Atk, and <b>Technician</b> in this hack lifts it 40 → 60. '
                  'Dark/Ice also answers the Dragons that beat the rest of this team. Costs a ×4 Fighting weakness.'),
                 ('Absol','physical Dark',
                  '130 base Attack with Super Luck, and Sucker Punch gives another priority option. '
                  'Frailer than Houndoom and gives up the Flash Fire switch-in that protects Metagross.')]),
   dict(role='pivot', why='Steel is the only type that resists Ice, Dragon AND Bug at once. Steel/Psychic is the only pairing that also keeps Fighting at ×1.',
        options=[('Metagross',None,None),
                 ('Lucario','widest resists',
                  'Resists Ice, Dragon, Bug, Dark <i>and</i> Rock — the best resist spread available to this slot, '
                  'and Bullet Punch keeps the priority. Costs you Metagross’s neutral Fighting matchup.'),
                 ('Excadrill','breaks Steels',
                  '<b>Mold Breaker</b> ignores abilities and Earthquake off 135 Atk. But Ground/Steel does not '
                  'resist Ice, so it drops the one job this slot exists to do.')]),
  ]),
 dict(id='mewtwo', name='Mewtwo', where='Box 9 + 10', tr=False, mech=[],
  tagline='A balance structure built around one wincon. Mewtwo boosts and sweeps; the other five exist to remove the three things that stop him.',
  pilot=[('Wincon','Mewtwo. Calm Mind, then Psystrike and Aura Sphere. <b>Only other Psychic-types resist both</b> — that is the entire list.'),
         ('Psystrike','Special damage calculated against their <b>physical Defence</b>. Special walls do not wall it.'),
         ('Aura Sphere','Accuracy 101 in the ROM — it <b>cannot miss</b> — and Fighting hits the Dark and Steel that resist Psychic.'),
         ('Trap','Scizor. Pursuit catches the bulky Psychics that <i>do</i> wall Mewtwo as they flee, and Technician makes Bullet Punch ≈90 with STAB.'),
         ('Ability','<b>Unnerve, not Pressure.</b> Drayano’s important-trainer roster mentions Berries 99 times, 34 of them Sitrus. Unnerve switches all of it off.')],
  warn='<b>Two single-answer holes.</b> Heatran is ×4 Ground and Hydreigon’s Levitate is the only answer; '
       'Scizor is ×4 Fire and Heatran’s Flash Fire is the only answer. Lose the answer and the hole is live. '
       'Keep the rule when swapping: <b>slots 2 and 3 must not both give up the Fire answer, and slots 4 and 5 '
       'must not both give up the Ground immunity.</b>',
  slots=[
   dict(role='sweeper', why='154 Sp. Atk at 130 Speed. Only 12 species in the ROM reach 125+ Speed and just four hit it super-effectively.',
        options=[('Mewtwo',None,None)]),
   dict(role='pivot', why='Steel resists Bug, Ghost AND Dark in Gen 5 — all three of Mewtwo’s weaknesses. Bug/Steel gets all three.',
        options=[('Scizor',None,None),
                 ('Bisharp','sharpest trap',
                  'Ghost and Dark at <b>×0.25</b>, the best in the pool, plus Sucker Punch and Defiant. '
                  'But Bug goes to ×1 — it stops covering the weakness Mewtwo most needs — and it is Fighting ×4.'),
                 ('Genesect','same typing, more gun',
                  'BST 600 with 120/120 offences and 99 Speed against Scizor’s 65, and <b>Download</b> picks '
                  'Atk or Sp. Atk off their weaker defence. Costs the priority and the Pursuit trapping.'),
                 ('Excadrill','hazard control',
                  '<b>Mold Breaker ignores Levitate and Flash Fire</b>, so it Earthquakes opposing Heatran, and '
                  'Rapid Spin clears hazards. No priority, no trapping, and its Ground ×2 stacks with Heatran’s ×4.')]),
   dict(role='wall', why='Flash Fire is the point — Steel is weak to Fire and no Steel typing resists it, so the immunity has to come from an ability.',
        options=[('Heatran',None,None),
                 ('Dialga','raw upgrade',
                  'BST 680 and 150 Sp. Atk, and Steel/Dragon still resists all three of Mewtwo’s weaknesses. '
                  'But losing Flash Fire makes Scizor’s <b>×4 Fire</b> live again — swap this and swap slot 2 too.'),
                 ('Magnezone','deletes Mewtwo’s checks',
                  '<b>Magnet Pull traps opposing Steel-types</b> — exactly what resists Mewtwo’s Psychic. '
                  'It removes the walls instead of playing around them. Costs Ground ×4 and the Fire immunity.'),
                 ('Volcarona','second wincon + sun',
                  'Quiver Dance off 135 Sp. Atk, and <b>Drought</b> in this hack for permanent sun. '
                  'But it does not resist Ghost or Dark, so it stops covering Mewtwo, and it is Rock ×4.')]),
   dict(role='sweeper', why='Levitate covers Heatran’s ×4 Ground, Dark STAB removes the bulky Psychics that wall Mewtwo, and it is immune to Psychic.',
        options=[('Hydreigon',None,None),
                 ('Spiritomb','zero weaknesses',
                  'Ghost/Dark takes <b>nothing above ×1 from any type in Gen 5</b>, and both STABs hit Psychic — '
                  'the best Cresselia and Lugia remover there is. Costs the Ground immunity, and it is 35 Speed.'),
                 ('Honchkrow','keeps the immunity',
                  'Dark/Flying, so the Ground immunity comes from the typing instead of Levitate, with Pursuit, '
                  'Nasty Plot and <b>Moxie</b> to snowball. Its 52/52 defences are paper.'),
                 ('Tyranitar','bulk + Stealth Rock',
                  '600 BST and the only Stealth Rock in this slot. Battle Armor on purpose — Sand Stream would '
                  'chip four of your own six. Costs the Ground immunity.')]),
   dict(role='wall', why='140 Defence, Spikes and Roost. Mewtwo forces switches, and hazards tax every one of them.',
        options=[('Skarmory',None,None),
                 ('Ferrothorn','full hazard suite',
                  'The <b>only Pokémon here with Stealth Rock, Spikes and Rapid Spin</b> on one level-up list, '
                  'plus Iron Barbs chip. But Fire ×4 alongside Scizor, and Bug ×1 so it stops covering Mewtwo.'),
                 ('Forretress','covers Mewtwo properly',
                  'Spikes, Toxic Spikes and Rapid Spin, and unlike Ferrothorn it <b>resists all three</b> of '
                  'Mewtwo’s weaknesses. Also ×4 Fire, and no recovery at all.'),
                 ('Gliscor','different axis',
                  'Immune to Ground <b>and</b> Electric with 125 Defence, and Poison Heal on a Toxic Orb heals ⅛ '
                  'a turn — better sustain than Roost. No hazards, and it does not resist Ghost or Dark.')]),
   dict(role='wall', why='Water Absorb and Recover, and as a Ghost it blocks Rapid Spin — which is what keeps Skarmory’s Spikes on the field.',
        options=[('Jellicent',None,None),
                 ('Dusknoir','the real wall',
                  '135/135 defences with Will-O-Wisp, Pursuit, Shadow Sneak and Pain Split — it burns physical '
                  'attackers <i>and</i> traps fleeing Psychics. Only 45 HP, so those defences read better than they play.'),
                 ('Cofagrigus','hack-special',
                  '<b>Ghost/Steel in this hack</b>, giving Bug ×0.25 on 145 Defence, and <b>Mummy</b> erases the '
                  'attacker’s ability on contact. Costs Fire ×2 and Ground ×2 on 58 HP.'),
                 ('Tentacruel','speed + Toxic Spikes',
                  '120 Sp. Def at 100 Speed, resists Fire and Bug, and lays Toxic Spikes. But <b>it is not a Ghost</b>, '
                  'so it stops blocking Rapid Spin — take it only if you drop Skarmory’s Spikes too.')]),
  ]),
 dict(id='contrary', name='Contrary Engine', where='Box 9', tr=False, mech=[],
  tagline='Every member has Contrary, and every member’s main attack lowers its own stats. Contrary inverts that — so attacking IS setup.',
  rigged='<b>Every one of these six is engineered — this is not a legitimate team.</b> Contrary exists on '
         'exactly three lines in the whole game (Shuckle, Spinda, Snivy), so a full roster of it cannot occur; '
         'it was written into all six save records, along with movesets most of them cannot legally learn. '
         'Arcanine’s V-create and Mewtwo’s Psycho Boost belong to Victini and Deoxys. Expect this team to '
         'trivialise anything the game puts in front of it — that was the brief, not an accident.',
  pilot=[('The engine','Contrary flips stat drops into boosts. Every nuke here has a drawback, and every drawback becomes a gain.'),
         ('No setup turns','You never spend a turn boosting. Turn one is already the biggest move you have, and turn two is bigger.'),
         ('Star','Shiny Arcanine. <b>V-create is 180 base power</b>, the strongest attacking move in the game — and its −Def/−Sp.Def/−Speed becomes <b>+1 to all three</b>, every time it fires.'),
         ('Double engines','Mewtwo runs Psycho Boost <i>and</i> Overheat; Gengar runs Overheat <i>and</i> Leaf Storm. Both stats climb twice as fast.'),
         ('Free gifts','Opposing Intimidate, Growl and Leer all <b>raise</b> your stats instead of lowering them.')],
  warn='<b>Never put a stat-raising move on this team.</b> Contrary inverts those too — a Swords Dance here is −2 Attack, '
       'a Dragon Dance is −1/−1. Every boost has to come from an attack. Also note the Life Orbs: none of these have '
       'recovery, so the ramp has a clock on it.',
  slots=[
   dict(role='sweeper', why='V-create, 180 BP, and Contrary turns its triple stat drop into a triple boost. The best interaction available in this game.',
        options=[('Arcanine','engineered · ✦ shiny',
                  'Fires the strongest move in the game and gets <b>faster and bulkier</b> for doing it. '
                  'Close Combat is a second engine on the same body.',
                  'Arcanine’s real abilities are Intimidate and Justified; <b>Contrary</b> was written into its '
                  'save record, and it cannot legally learn <b>V-create</b> either. Contrary exists on only '
                  'three lines in the entire game — Shuckle, Spinda and Snivy — so a whole team of it is not '
                  'something the game can produce. Shiny by request.')]),
   dict(role='sweeper', why='Superpower feeds Attack and Defence; Draco Meteor feeds Sp. Atk. It ramps on both sides at once.',
        options=[('Dragonite','engineered',
                  'Two engines, one physical and one special, so whichever side you attack from is growing.',
                  'Contrary and this moveset were written in. Its real abilities are Multiscale and Marvel Scale.')]),
   dict(role='sweeper', why='154 Sp. Atk with two self-lowering nukes feeding it. Psycho Boost is 140 BP and Overheat another 140.',
        options=[('Mewtwo','engineered',
                  'The fastest ramp on the team — 130 Speed means it usually starts the chain before anything else moves.',
                  'Contrary written in over Pressure/Unnerve. Psycho Boost is Deoxys’ signature move, not Mewtwo’s.')]),
   dict(role='sweeper', why='Superpower off 134 Attack, raising Attack and Defence together — it gets harder to kill as it hits.',
        options=[('Tyranitar','engineered',
                  'The bulkiest engine here. Rock/Dark coverage on top of a Fighting nuke that boosts it.',
                  'Contrary written in over Sand Stream/Battle Armor — which also means no auto-sand chipping your own team.')]),
   dict(role='sweeper', why='160 base Attack, and Contrary quietly solves Truant by replacing it.',
        options=[('Slaking','engineered · no Truant',
                  '<b>Two problems fixed by one ability.</b> It acts every turn, and Superpower makes it stronger '
                  'and tougher each time.',
                  'Slaking’s real abilities are both drawbacks — Truant and Slow Start. Contrary deletes that '
                  '<i>and</i> turns its Fighting nuke into setup. This is a different Slaking from the Huge Power '
                  'one in Box 2; each is claimed separately.')]),
   dict(role='sweeper', why='Overheat and Leaf Storm are both 140 BP and both feed the same stat. 130 Sp. Atk climbing fast.',
        options=[('Gengar','engineered',
                  'Ghost/Poison STAB underneath two Grass and Fire engines — almost nothing resists the whole set.',
                  'Contrary written in over Levitate, so this Gengar <b>loses its Ground immunity</b> — that is a real cost, not a formality.')]),
  ]),
 dict(id='sun', name='Sun King', where='Box 10', tr=False, mech=['sun'],
  tagline='Arcanine holds permanent sun. Every other member carries an ability that only pays out under it.',
  rigged='<b>Every one of these six is engineered — this is not a legitimate team.</b> Five of the six abilities '
         'were written into save records they cannot legally hold: Drought on Arcanine, Chlorophyll on Gengar and '
         'Slaking, Solar Power on Mewtwo, and Flower Gift on Snorlax — a Cherrim-only ability. Normally you cannot '
         'assemble a sun team out of a Fire dog, a ghost, a sloth and a Snorlax at all. If it feels like the weather '
         'is doing far too much work, it is.',
  pilot=[('Turn 1','Nothing. Arcanine’s Drought is already up the moment it switches in, and it does not expire.'),
         ('What sun gives','Fire ×1.5, enemy Water ×0.5, Solar Beam fires <b>instantly</b> with no charge turn, and nothing can be frozen.'),
         ('Speed','Chlorophyll doubles it. Gengar runs at an effective <b>220</b>, Slaking at <b>200</b> — with 160 Attack behind it.'),
         ('Power','Solar Power is Sp. Atk ×1.5. Mewtwo’s Fire Blast takes that <i>and</i> the sun bonus.'),
         ('Snorlax','Flower Gift is the physical payout — <b>Attack and Sp. Def both ×1.5</b> while the sun is up.')],
  warn='<b>The whole team is one Pokémon deep.</b> Every ability here reads "during strong sunlight" — lose Arcanine '
       'and five of six members quietly stop working. Worse, an enemy Drizzle or Sand Stream <b>overwrites your sun</b> '
       'and switches the team off without killing anything. Solar Power also costs Mewtwo and Chandelure ⅛ HP every turn.',
  slots=[
   dict(role='setter', why='Drought sets permanent sun in Gen 5 — no timer, no re-setting. The entire team is built on this one ability.',
        options=[('Arcanine','engineered · ✦ shiny',
                  'Sets the weather and still hits like a truck: Flare Blitz gets the ×1.5, and Close Combat plus '
                  'Extreme Speed cover what Fire cannot.',
                  'Arcanine’s real abilities are Intimidate and Justified. <b>Drought</b> was written in — in this '
                  'hack it belongs to Camerupt, Groudon and Volcarona. Shiny by request; the rest of the team was '
                  'deliberately left normal so this one stands out.')]),
   dict(role='sweeper', why='Solar Power is Sp. Atk ×1.5 on a 154 base. Fire Blast then takes the sun bonus on top.',
        options=[('Mewtwo','engineered',
                  'The single biggest special number on any of your teams. Psystrike still hits their physical Defence.',
                  'Solar Power written in over Pressure/Unnerve. It costs ⅛ max HP every turn the sun is up — real, and it adds up.')]),
   dict(role='sweeper', why='110 Speed doubled to an effective 220, and Solar Beam skips its charge turn entirely in sun.',
        options=[('Gengar','engineered',
                  'A 120 BP Grass nuke with <b>no charge turn</b>, from something that outruns the entire game.',
                  'Chlorophyll written in over Levitate — Grass-types only, normally. Losing Levitate costs it the Ground immunity.')]),
   dict(role='sweeper', why='145 Sp. Atk — the highest on any of your teams — with Solar Power and a Fire STAB in permanent sun.',
        options=[('Chandelure','engineered',
                  'Fire Blast at ×1.5 from Solar Power and ×1.5 from sun, off 145 base. Overheat is the panic button.',
                  'Solar Power written in over Levitate. Same trade as Gengar: it loses the Ground immunity.')]),
   dict(role='sweeper', why='Chlorophyll doubles 100 Speed to 200, and replacing Truant means it actually gets to use it.',
        options=[('Slaking','engineered · no Truant',
                  '160 Attack moving at an effective 200 Speed. Fire Punch picks up the sun bonus.',
                  'Chlorophyll replaces Truant — the drawback ability is simply gone. A third Slaking, separate from the Huge Power and Contrary copies.')]),
   dict(role='wall', why='Flower Gift is the one sun ability that pays a physical attacker: Attack and Sp. Def both ×1.5.',
        options=[('Snorlax','engineered',
                  '160 HP and 110 Attack, with <b>both</b> the Attack and the Sp. Def multiplier while the sun holds. '
                  'The team’s only real bulk.',
                  'Flower Gift belongs to <b>Cherrim alone</b> in the entire game. Written in over Gluttony/Thick Fat — '
                  'so this Snorlax gives up Thick Fat’s Fire and Ice resistance to get it.')]),
  ]),
 dict(id='uncle', name='My Uncle Works at Nintendo', where='Box 16 + 17', tr=False, mech=[],
  tagline='No shared gimmick, on purpose. Six unrelated ways of being unfair, one per slot.',
  rigged='<b>Every one of these six is engineered — this is not a legitimate team.</b> Unlike the Contrary and '
         'Sun teams there is no shared mechanic to point at: each slot got whichever single ability breaks '
         '<i>that</i> Pokémon hardest, and none can legally have it. Wonder Guard belongs to Shedinja alone, '
         'Huge Power to the Marill line, and Adaptability, Speed Boost, Moxie and Contrary all to species '
         'that are not these. Movesets were written in too. There is no counterplay story here — that is the point.',
  pilot=[('Lead','Mewtwo. Adaptability makes STAB ×2, so Psystrike is ~200 effective <i>and</i> hits their physical Defence.'),
         ('Setup','Snorlax. Belly Drum is +6 Attack, Huge Power doubles again — <b>×8 total</b> — and 160 HP pays the cost comfortably.'),
         ('Priority','Four members carry Extreme Speed at +2. Nothing here loses a race it needs to win.'),
         ('Snowball','Tyranitar. One Dragon Dance, then Moxie adds +1 Attack per KO — it accelerates through a roster.'),
         ('The dog','Arcanine. <b>V-create is 180 BP</b> and Contrary turns its −Def/−Sp.Def/−Speed into +1 of each — it snowballs by attacking.')],
  warn='<b>Gengar gave up Levitate for Wonder Guard.</b> It is immune to thirteen types and dies to Earthquake — '
       'lead it into anything <i>except</i> Ground, Dark, Ghost or Psychic. Snorlax is helpless until Belly Drum '
       'resolves, so bring it in on something slow. Nothing here has weather, screens or hazards: this team wins by '
       'overwhelming, and has no plan B if it does not.',
  slots=[
   dict(role='sweeper', why='Ghost/Poison is weak to only four types, so Wonder Guard blanks the other thirteen.',
        options=[('Gengar','engineered · 13 immunities',
                  'Nasty Plot behind near-total immunity — it sets up on almost anything, then removes it. '
                  '<b>Ground, Dark, Ghost and Psychic still hurt</b>, and Earthquake is everywhere.',
                  'Wonder Guard belongs to <b>Shedinja alone</b> in the entire game. Written in over Levitate, '
                  'which is why this Gengar has a Ground weakness its species normally never has.'),
                 ('Slowking','engineered · doubles boosts',
                  '<b>Simple</b> doubles every stat change, so one Calm Mind is +2/+2 and two is +4/+4 — behind '
                  '110 Sp. Def and Slack Off. Trades speed and immunities for something unkillable.',
                  'Simple written in over Regenerator/Drizzle. It cuts both ways: enemy stat drops also hit twice as hard.')]),
   dict(role='wall', why='160 HP makes Belly Drum affordable, and Huge Power doubles the result. ×8 Attack in one turn.',
        options=[('Snorlax','engineered · ×8 Atk',
                  'Belly Drum (+6) into Huge Power (×2), then Extreme Speed fires it at +2 priority so its 30 Speed never matters.',
                  'Huge Power belongs to the Marill and Medicham lines. Written in over Gluttony/Thick Fat, so this '
                  'Snorlax gives up Thick Fat’s Fire and Ice resistance for it.'),
                 ('Ursaring','engineered · Facade',
                  '130 Attack doubled, and <b>Facade doubles again when statused</b> — a burn or poison makes it '
                  '<i>stronger</i>. Swords Dance instead of Belly Drum, so no HP cost.',
                  'Huge Power written in over Guts/Quick Feet.'),
                 ('Slaking','engineered · no Truant',
                  '160 Attack at 100 Speed climbing +1 a turn, and Truant simply gone. A fifth Slaking, and '
                  'deliberately not the Huge Power one — this is the speed build.',
                  'Speed Boost written in over Truant/Slow Start, both of which are drawbacks.')]),
   dict(role='sweeper', why='80 Speed is Dragonite’s only flaw. Speed Boost plus Dragon Dance is +2 Speed and +1 Attack every turn.',
        options=[('Dragonite','engineered · compounding',
                  'It gets faster whether or not you spend the turn setting up, and Extreme Speed covers turn one.',
                  'Speed Boost written in over Multiscale/Marvel Scale — a real trade, since Multiscale halved everything at full HP.'),
                 ('Scizor','engineered · ×2 Atk priority',
                  '130 Attack doubled behind <b>Bullet Punch</b>, so the priority move itself becomes the kill button. '
                  'Swords Dance stacks on top.',
                  'Huge Power written in over Technician — and it is the bigger boost of the two, since doubling the '
                  'stat beats Technician’s +50% on one weak move.')]),
   dict(role='sweeper', why='One Dragon Dance, then Moxie compounds it: +1 Attack for every single KO.',
        options=[('Tyranitar','engineered · snowball',
                  'The only member that gets stronger for winning. Rock, Dark and Ground coverage hits nearly everything neutral.',
                  'Moxie written in over Sand Stream/Battle Armor — which also means no auto-sand chipping your own team.'),
                 ('Magikarp','engineered · executioner',
                  '<b>Four never-missing one-hit KO moves.</b> Its 10 Attack is never read; the move just wins. '
                  'Two hard limits: OHKO moves <b>fail against higher-level targets</b>, and <b>Sturdy blocks them outright</b>.',
                  'No Guard — "ensures all moves used by and against the Pokémon hit" — turns four 30%-accuracy moves '
                  'into certainties. It also means everything hits <i>Magikarp</i>, which has 59 HP. The single most '
                  'shameless thing in this save.')]),
   dict(role='sweeper', why='Adaptability turns STAB from ×1.5 to ×2, and Psystrike already ignores special walls.',
        options=[('Mewtwo','engineered · ×2 STAB',
                  'Psystrike at roughly <b>200 effective power</b> against their <i>physical</i> Defence, off 154 Sp. Atk '
                  'at 130 Speed, with Calm Mind and Recover behind it.',
                  'Adaptability written in over Pressure/Unnerve. Aura Sphere is a level-93 move it would not have yet.'),
                 ('Wobbuffet','engineered · trapper',
                  'Trades the best sweeper in the game for a <b>delete button</b>: they cannot switch, and Perish Song '
                  'kills them in three turns regardless of any stat on either side.',
                  'Shadow Tag is genuinely its own; Perish Song, Protect and Encore are not — its real movepool is five '
                  'moves long with zero TM compatibility. A second copy, separate from the Kaiju one.')]),
   dict(role='sweeper', why='V-create is 180 BP, the strongest attacking move in the game, and Contrary turns its triple stat drop into a triple boost.',
        options=[('Arcanine','engineered · attacking is setup',
                  'Every V-create is <b>+1 Defence, +1 Sp. Def and +1 Speed</b> — it gets faster and bulkier for '
                  'swinging, and Close Combat is a second engine on the same body. Trade for the old Magic Guard '
                  'build: <b>recoil is real again</b>, so Wild Charge’s 25% and Life Orb’s 10% both bite now.',
                  'Contrary written in over Intimidate/Justified, and Arcanine cannot legally learn <b>V-create</b> '
                  'either — that is Victini’s signature. Contrary exists on only three lines in the game. '
                  '<b>Never give this one a stat-raising move</b>: Contrary inverts those, so a Swords Dance here '
                  'would be −2 Attack. Shiny — this is the one that looks like your dog.'),
                 ('Rayquaza','engineered · +2 per hit',
                  'The same engine on a far bigger body. Draco Meteor, Overheat and Leaf Storm each drop Sp. Atk '
                  '<b>two</b> stages, so Contrary makes each one <b>+2</b> — one attack is +2 Sp. Atk, two is +4, '
                  'off a 150 base. It ramps twice as fast as Benny and hits from 680 BST.',
                  'Contrary written in over Air Lock. Three 140-BP moves on one Pokémon is not a legal set either. '
                  'Same standing rule as Benny: <b>no stat-raising moves</b>, ever.'),
                 ('Victini','engineered · three signatures',
                  'Carries the signature move of <b>all three</b> Unova box legendaries — V-create, Bolt Strike '
                  '(Zekrom) and Blue Flare (Reshiram). Those are 95/85/85 accuracy, and <b>Victory Star’s ×1.1 is '
                  'exactly the ability that fixes them.</b>',
                  'Victini is the <i>legitimate</i> owner of V-create and Victory Star is its real ability — the '
                  'cheat here is only Bolt Strike and Blue Flare. Worth knowing: Victory Star reads "for friendly '
                  'Pokémon", so in a single battle it boosts Victini alone; the team-wide payout is a doubles thing.')]),
  ]),
]

NOTES = {
 'Curse':'<b>Two different moves.</b> Used by a non-Ghost like Snorlax: +1 Attack, +1 Defence, −1 Speed — free setup on something that does not want Speed anyway. A <i>Ghost-type</i> user instead halves its own HP to curse the target for ¼ of its max HP every turn.',
 'Gyro Ball':'Power scales <b>inversely with your Speed</b> — the slower you are, the harder it hits, up to 150. Exactly why boxes 3 and 5 run 0 Speed IVs.',
 'Return':'Power scales with friendship. Yours is maxed at 255, so it is a flat <b>102 BP</b> STAB.',
 'Trick Room':'Inverts the Speed order for <b>five turns</b> — slowest moves first. Priority −7, so it always resolves last on the turn you use it.',
 'Bullet Punch':'<b>+1 priority.</b> Technician lifts 40 → 60, STAB takes it to ~90. Your finisher.',
 'Bug Bite':'Technician boosts moves ≤60 BP by 50%, so this is <b>90 before STAB</b> — more than X-Scissor’s 80.',
 'Flare Blitz':'<b>33% recoil.</b> Emboar’s Adaptability doubles STAB, putting this near 240 effective.',
 'Wild Charge':'<b>25% recoil.</b> Fine as coverage, bad as a spam button.',
 'Superpower':'Drops <b>your own</b> Attack and Defence one stage each. Hit once, then switch.',
 'Close Combat':'Drops <b>your own</b> Defence and Sp. Def one stage each.',
 'Hammer Arm':'Lowers <b>your own Speed</b> — a drawback normally, but under Trick Room it makes Emboar move earlier.',
 'Draco Meteor':'Drops <b>your own Sp. Atk two stages</b>. Fire once, then switch.',
 'Focus Blast':'<b>70% accuracy.</b> The move that loses games. Never lead on it when a safer option kills.',
 'Stone Edge':'80% accuracy but a <b>high critical-hit rate</b>. Under No Guard it never misses.',
 'Dynamic Punch':'50% accuracy normally — but on Machamp <b>No Guard makes it never miss</b>, and it confuses <b>100%</b> of the time.',
 'Hydro Pump':'<b>80% accuracy</b> for 120 power. Surf is the safer button for chip.',
 'Muddy Water':'85% accuracy, and it can lower the target’s accuracy.',
 'Sleep Powder':'<b>75% accuracy</b>, but sleep on hit is close to a free win.',
 'Drain Punch':'Heals you for <b>half the damage dealt</b> — pays back Life Orb recoil.',
 'Giga Drain':'Heals you for <b>half the damage dealt</b>.',
 'Recover':'Restores <b>half of max HP</b>.',
 'Leech Seed':'Drains <b>1/8 of the target’s max HP</b> to you each turn. Does not work on Grass types.',
 'Stealth Rock':'Hazard that chips anything the opponent switches in, scaled to its Rock weakness.',
 'Swords Dance':'<b>+2 Attack</b> in one turn.', 'Nasty Plot':'<b>+2 Sp. Atk</b> in one turn.',
 'Dragon Dance':'<b>+1 Attack and +1 Speed.</b> The compounding one.',
 'Bulk Up':'+1 Attack and +1 Defence.', 'Calm Mind':'+1 Sp. Atk and +1 Sp. Def.',
 'Will-O-Wisp':'Burns on hit: <b>halves the target’s physical damage</b> and chips it every turn. 75% accuracy.',
 'Psyshock':'Special move that hits the target’s <b>Defence instead of Sp. Def</b>.',
 'Thunder':'70% accuracy normally, <b>100% in rain</b>. The whole reason Ampharos is on the rain team.'}

# ------------------------------------------------------------- adopted cores
# THE ROSTERS LIVE IN THE TEAM STORE NOW, not in this file.
#
# There used to be a hardcoded TEAM_LAYOUT here: eight rosters the battle
# companion showed as tabs you could not edit, retire or delete, while anything
# you built yourself was a "core" that you could. The distinction bought
# nothing -- a core IS a line-up you adopted, and these were the most adopted
# line-ups in the project -- and it cost a naming convention, because a slot
# that names only a species needs a tag in the nickname to tell four Arcanines
# apart. `tools/adopt_layout.mjs` migrated them; see that file for the history.
#
# state/teams.json is now the single source both this artifact builder and the
# app read, so a core edited in the Team Builder shows up on the published
# sheet at the next refresh.
WEATHER_ABILITY = {'Drizzle': 'rain', 'Drought': 'sun', 'Sand Stream': 'sand',
                   'Snow Warning': 'hail'}
WEATHER_MOVE = {'Rain Dance': 'rain', 'Sunny Day': 'sun', 'Sandstorm': 'sand',
                'Trick Room': 'tr'}


# The same rule app/js/teams.js's inferRole() uses, on the same inputs.
#
# A slot built in the Builder carries no declared role, and the app fills one
# in from what the Pokemon actually does. The sheet passed `role` straight
# through, so an adopted core showed role chips in the app and none on the
# page -- two answers to one question, and the app is the one you read.
PIVOT_MOVES = {"U-turn", "Volt Switch", "Baton Pass"}
SETTER_MOVES = {"Stealth Rock", "Spikes", "Toxic Spikes", "Trick Room",
                "Rain Dance", "Sunny Day", "Sandstorm", "Reflect", "Light Screen"}
_NAT_ORDER = ("atk", "def", "spe", "spa", "spd")
_STAT_KEYS = ("hp", "atk", "def", "spa", "spd", "spe")


def spec_stats(base, level, ivs, evs, nature_id, species_id):
    """specStats() from teams.js, digit for digit -- Shedinja included."""
    raised, lowered = divmod(nature_id or 0, 5)
    out = []
    for k in _STAT_KEYS:
        iv = (ivs or {}).get(k, 31)
        ev = (evs or {}).get(k, 0)
        core = (2 * base[k] + iv + ev // 4) * (level or 50) // 100
        if k == "hp":
            out.append(1 if species_id == 292 else core + (level or 50) + 10)
            continue
        v = core + 5
        if raised != lowered:
            if _NAT_ORDER[raised] == k:
                v = v * 11 // 10
            elif _NAT_ORDER[lowered] == k:
                v = v * 9 // 10
        out.append(v)
    return out


def infer_role(declared, moves, stats):
    if declared:
        return declared
    names = {m for m in (moves or []) if m}
    if names & PIVOT_MOVES:
        return "pivot"
    if names & SETTER_MOVES:
        return "setter"
    hp, atk, dfn, spa, spd, spe = stats
    return "wall" if dfn + spd + hp > atk + spa + spe else "sweeper"


def adopted_cores(personal):
    """Living cores from state/teams.json, in the shape the assembly wants.

    Returns [] when there is no store -- a fresh checkout has no teams, and a
    sheet with only the encounter data is a better answer than a crash.
    """
    path = STATE / "teams.json"
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text()).get("teams", [])
    except (OSError, ValueError):
        return []

    names = {int(k): v["name"] for k, v in personal.items()}
    moves = json.loads((STATE / "moves.json").read_text())["moves"]
    move_names = {int(k): v["name"] for k, v in moves.items()}
    items = json.loads((STATE / "items.json").read_text())["items"]

    # NEWEST FIRST, the order the app shows them in. teams.js's merge() sorts
    # by `updated` descending and the tab strip follows it, so a sheet built
    # from the same store has to sort the same way or the two disagree about
    # which team is first for no reason anyone could see.
    raw = sorted(raw, key=lambda t: t.get("updated") or 0, reverse=True)

    out = []
    for t in raw:
        if t.get("deleted") or t.get("kind") != "core" or not t.get("slots"):
            continue
        note_lines = [l.strip() for l in (t.get("notes") or "").split("\n") if l.strip()]
        slots = []
        for sl in t["slots"]:
            opts = []
            for o in sl.get("options", []):
                sid = o.get("speciesId")
                if not sid or sid not in names:
                    continue
                opts.append(dict(
                    name=names[sid], badge=o.get("badge") or None,
                    note=o.get("note") or None, rigged=o.get("rigged") or None,
                    ab=ABILITY_NAMES.get(o.get("abilityId"), None),
                    nat=ps.NATURES[o["natureId"]] if o.get("natureId") is not None
                        and o["natureId"] < len(ps.NATURES) else None,
                    item=(items.get(str(o.get("itemId")), {}) or {}).get("name")
                         if o.get("itemId") else None,
                    lvl=o.get("level"),
                    # The spread, for take()'s matching only -- nothing on the
                    # page renders it. Without these the sheet compared fewer
                    # fields than the app's diffSlot() and the two chose
                    # different copies of a species you own several of.
                    ivs=o.get("ivs") or None, evs=o.get("evs") or None,
                    moves=[move_names.get(m) for m in (o.get("moveIds") or []) if m]))
            if opts:
                # Inferred from the FIRST option, exactly as the app does: the
                # role describes the slot, and the slot is what option zero is.
                o0 = sl.get("options", [{}])[0]
                sid0 = o0.get("speciesId")
                sp0 = personal.get(str(sid0)) or {}
                nat0 = o0.get("natureId") or 0
                stats0 = (spec_stats(sp0["base_stats"], o0.get("level") or 50,
                                     o0.get("ivs"), o0.get("evs"), nat0, sid0)
                          if sp0.get("base_stats") else [0] * 6)
                slots.append(dict(
                    role=infer_role(sl.get("role"), opts[0].get("moves"), stats0),
                    why=sl.get("why") or "", options=opts))
        if not slots:
            continue
        # DETECTED **AND** DECLARED, the same union app/js/teams.js does. A team
        # built in the Builder never declares anything, so without detection its
        # rain would have no toggle; an adopted roster can declare a condition
        # nothing on it sets, so without the declared list Trick Room loses all
        # three of its.
        mech = set(t.get("mech") or [])
        tr = bool(t.get("tr"))
        for sl in slots:
            o = sl["options"][0]
            w = WEATHER_ABILITY.get(o.get("ab"))
            if w and w != "hail":
                mech.add(w)
            for mv in o.get("moves") or []:
                w = WEATHER_MOVE.get(mv)
                if w == "tr":
                    tr = True
                elif w:
                    mech.add(w)
        mech.discard("tr")

        out.append(dict(
            id=f"core-{t['id']}", name=t.get("name") or "Core",
            tr=tr, mech=sorted(mech),
            tagline=note_lines[0] if note_lines else "Adopted in the Team Builder.",
            warn=t.get("warnNote") or "",
            rigged=None,
            pilot=[dict(k=c.get("k") or "", v=c.get("v") or "")
                   for c in (t.get("pilot") or []) if (c.get("v") or "").strip()],
            slots=slots))
    return out


# ---------------------------------------------------------------- field effects
# The things that change the whole battle rather than one Pokemon.
#
# GEN 5 VALUES, and several of them are not the values people remember: weather
# set by an ABILITY is PERMANENT here (Gen 6 put it on a five-turn clock), and
# that single fact is the reason half the teams on this page exist. Durations,
# fractions and turn counts are written out rather than derived, because the
# ROM's move table carries power/accuracy/PP and nothing about duration.
#
# What IS derived: every move and ability named below is checked against the
# ROM's own tables at build time. A typo, or a move this hack removed, fails
# the build instead of printing a confident lie.
FIELD = [
    ('Rain', 'weather',
     ['Rain Dance'], ['Drizzle'],
     'Water ×1.5 and Fire ×0.5. Thunder and Hurricane never miss; SolarBeam is '
     'halved. Five turns from the move, <b>permanent</b> from Drizzle — in Gen 5 '
     'an ability sets weather until something else changes it. Damp Rock takes '
     'the move to eight.'),
    ('Harsh sunlight', 'weather',
     ['Sunny Day'], ['Drought'],
     'Fire ×1.5 and Water ×0.5. SolarBeam fires the same turn; Thunder and '
     'Hurricane drop to 50% accuracy. Synthesis, Morning Sun and Moonlight heal '
     '⅔ instead of ½. Permanent from Drought; Heat Rock takes the move to eight.'),
    ('Sandstorm', 'weather',
     ['Sandstorm'], ['Sand Stream'],
     'Chips 1/16 of max HP every turn from anything that is not Rock, Ground or '
     'Steel. <b>Rock types get ×1.5 Sp. Def</b>, which is the real reason to set '
     'it. Permanent from Sand Stream; Smooth Rock takes the move to eight.'),
    ('Hail', 'weather',
     ['Hail'], ['Snow Warning'],
     'Chips 1/16 every turn from anything that is not Ice. Blizzard never misses. '
     'Permanent from Snow Warning; Icy Rock takes the move to eight.'),
    ('Trick Room', 'room',
     ['Trick Room'], [],
     '<b>Inverts the Speed order for five turns</b> — the slowest moves first. '
     'Priority −7, so it always resolves last on the turn it is used, and using '
     'it again while it is up cancels it. Priority moves still go first within '
     'their bracket; Trick Room reorders the bracket, it does not switch it off.'),
    ('Tailwind', 'field',
     ['Tailwind'], [],
     'Doubles your side\u2019s Speed for <b>four turns</b> in Gen 5 (three in Gen 4). '
     'It does not raise the Speed stat, so it stacks with Choice Scarf and with '
     'stat stages rather than competing with them.'),
    ('Gravity', 'field',
     ['Gravity'], [],
     'Five turns. Grounds Flying types and Levitate — Earthquake hits them — and '
     'raises the accuracy of every move by about 67%. Jumping and airborne moves '
     '(Fly, Bounce, Hi Jump Kick, Magnet Rise) cannot be used.'),
    ('Reflect / Light Screen', 'screen',
     ['Reflect', 'Light Screen'], [],
     'Halve incoming physical and special damage respectively for <b>five turns</b> '
     '(eight with Light Clay). Singles only halve; in doubles they cut by a third. '
     'Critical hits ignore them, and so does Brick Break, which shatters them.'),
    ('Stealth Rock', 'hazard',
     ['Stealth Rock'], [],
     'Damages anything that switches in, for a fraction scaled by how well ROCK '
     'hits it — 1/32 at ×¼ up to <b>1/2 at ×4</b>. One layer only, and it is why '
     'a Fire/Flying or Ice/Flying sweeper cannot switch in twice.'),
    ('Spikes / Toxic Spikes', 'hazard',
     ['Spikes', 'Toxic Spikes'], [],
     'Ground-based, so anything Flying or with Levitate ignores both. Spikes stack '
     'to three layers for 1/8, 1/6 and 1/4. Toxic Spikes poison at one layer and '
     'badly poison at two — and a grounded <b>Poison</b> type absorbs them on '
     'entry, removing the layers entirely.'),
]


def field_effects(live, moves, abil):
    # `live` may be None: build_static.py has no save, so the app gets the
    # static half and roster.js fills `who` from the loaded save instead.
    """The field effects, checked against the ROM and joined to your team.

    Every move and ability named in FIELD must exist in the ROM's own tables or
    this raises -- a name this hack removed or renamed should stop the build,
    not print a confident lie on a reference page.

    `who` is what makes it more than a wiki page: which of YOUR Pokemon can
    actually set each one, by knowing the move or having the ability.
    """
    out = []
    for name, kind, setters, abilities, text in FIELD:
        for mv in setters:
            if mv not in moves:
                raise SystemExit(f"build_sheet: FIELD names a move the ROM does not have: {mv}")
        for ab in abilities:
            if ab not in abil:
                raise SystemExit(f"build_sheet: FIELD names an ability the ROM does not have: {ab}")
        who = sorted({m['name'] for m in (live or [])
                      if (set(m.get('moves') or []) & set(setters))
                      or (m.get('ab') in abilities)})
        out.append(dict(name=name, kind=kind, setters=setters,
                        abilities=abilities, text=text, who=who))
    return out


STATUS = [
 ['Burn','Halves the damage of the target’s <b>physical</b> moves and chips 1/8 of max HP each turn. Fire types cannot be burned.'],
 ['Paralysis','Cuts Speed to <b>1/4</b> and gives a <b>25%</b> chance of losing the turn entirely. Electric types cannot be paralysed.'],
 ['Poison','Chips 1/8 of max HP each turn. <b>Badly poisoned</b> starts at 1/16 and grows every turn.'],
 ['Sleep','The target cannot act for 1–3 turns.'],
 ['Freeze','The target cannot act until thawed — no fixed timer. Fire-type moves thaw it.'],
 ['Confusion','33% chance each turn to hit itself instead. Wears off after 2–5 turns; switching cures it.'],
 ['Flinch','Skips the turn, but only works if the flincher moves first.']]


# ---------------------------------------------------------------- save side
def read_live():
    """Every Pokemon in the save, as a flat list in reading order.

    This used to be a dict keyed by (location, species), which SILENTLY LOST
    duplicates: two of the same species in one box collided on the key and
    only the later one survived.  That was invisible while every box held one
    of each, and became wrong the moment boxes were reorganised -- box 6 now
    holds five Slakings and box 9 four Slowkings, so the sheet was choosing
    among one copy where the save has five.

    Found by tools/verify_blob.py, which diffs this against the browser port:
    the JS kept every copy and the two stopped agreeing.
    """
    data, info = ps.read_save(ps.DEFAULT_SAVE)
    warnings: list[str] = []
    slot, _slots, _why = ps.choose_slot(data, warnings)
    base = ps.SLOT_OFFSETS[slot]
    personal = json.loads((STATE / "personal.json").read_text())["species"]
    items = json.loads((STATE / "items.json").read_text())["items"]
    bag = json.loads(need_save_derived("bag.json").read_text())
    tid, sid = bag["trainer"]["trainer_id"], bag["trainer"]["secret_id"]

    def item_name(i):
        r = items.get(str(i))
        if not r:
            return None
        return f"{r['tm_hm']} {r['move']}" if 'tm_hm' in r else r['name']

    out = []

    def decode(rec, is_party, where):
        pid, _san, chk = struct.unpack_from('<IHH', rec, 0)
        body = ps.unshuffle(ps.lcrng_crypt(bytes(rec[8:136]), chk), pid)
        if ps.pk5_checksum(body) != chk:
            return
        spec = struct.unpack_from('<H', body, ps.B_SPECIES)[0]
        if not 1 <= spec <= 649:
            return
        sp = personal[str(spec)]
        ivf = struct.unpack_from('<I', body, ps.B_IVS)[0]
        ivs = {k: (ivf >> (5 * i)) & 31 for i, k in enumerate(ps.SAVE_STAT_ORDER)}
        evs = {k: body[ps.B_EVS + i] for i, k in enumerate(ps.SAVE_STAT_ORDER)}
        nat = body[ps.B_NATURE]
        if is_party:
            extra = ps.lcrng_crypt(bytes(rec[136:220]), pid)
            lvl = extra[ps.PARTY_LEVEL_OFF]
        else:
            lvl = ps.level_for_exp(sp['growth_curve_id'],
                                   struct.unpack_from('<I', body, ps.B_EXP)[0])
        st = ps.compute_stats(sp['base_stats'], ivs, evs, lvl, nat, spec)
        held = struct.unpack_from('<H', body, ps.B_ITEM)[0]
        out.append(dict(
            name=sp['name'], lvl=lvl, nat=ps.NATURES[nat],
            ab=ps.Wiki(ps.WIKI_DOCS).ability_name(body[ps.B_ABILITY]) if False else ABILITY_NAMES.get(body[ps.B_ABILITY], f"#{body[ps.B_ABILITY]}"),
            item=item_name(held) if held else None,
            types=sp['types'],
            moves=[ps.move_name(m) for m in struct.unpack_from('<4H', body, ps.B_MOVES) if m],
            shiny=(tid ^ sid ^ (pid >> 16) ^ (pid & 0xFFFF)) < 8,
            nick=ps.decode_string(body[ps.B_NICKNAME:], ps.B_NICKNAME_LEN),
            box=where, stats=[st[k] for k in ('hp', 'atk', 'def', 'spa', 'spd', 'spe')],
            # The spread, for take()'s "which copy does this slot mean". The
            # app's diffSlot() compares IVs and EVs and this did not, so with
            # four Gengars the two implementations picked different ones --
            # the sheet handed the Uncle roster Kaiju's, shifting the whole
            # assignment by one. Leading underscore: these are for matching,
            # not for the page, and nothing renders them.
            _ivs=ivs, _evs=evs))

    # Battle Box -- checksum entry 49 at 0x20A00, six box-format records.
    # Found the hard way: six Pokemon vanished from every box because they had
    # been parked here, which parse_save.py does not read.
    for i in range(6):
        o = base + BATTLE_BOX + i * ps.PK5_BOX_SIZE
        if struct.unpack_from('<I', data, o)[0] == 0:
            continue
        decode(bytes(data[o:o + ps.PK5_BOX_SIZE]), False, 'Battle Box')

    n = struct.unpack_from('<I', data, base + ps.PARTY_BLOCK + ps.PARTY_COUNT_OFF)[0]
    for i in range(n):
        o = base + ps.PARTY_BLOCK + ps.PARTY_FIRST + i * ps.PK5_PARTY_SIZE
        decode(bytes(data[o:o + ps.PK5_PARTY_SIZE]), True, 'Party')
    for bx in range(ps.BOX_COUNT):
        for s in range(ps.BOX_SLOTS):
            o = base + ps.BOX_BASE + bx * ps.BOX_STRIDE + s * ps.PK5_BOX_SIZE
            if struct.unpack_from('<I', data, o)[0] == 0:
                continue
            decode(bytes(data[o:o + ps.PK5_BOX_SIZE]), False, f'Box {bx + 1}')
    return out, info


# ---------------------------------------------------------------- rom side
def rom_tables():
    rom = NDSRom(ROM_PATH)
    tf = parse_narc(rom.file_data(TEXT_NARC))
    raw = parse_narc(rom.file_data(MOVE_NARC))
    mv = json.loads((STATE / "moves.json").read_text())["moves"]
    mdesc = decode_text_file(tf[F_MOVE_DESC])
    anames = decode_text_file(tf[F_ABIL_NAME])
    adescs = decode_text_file(tf[F_ABIL_DESC])
    clean = lambda s: s.replace('￾', ' ').replace('\n', ' ').strip()
    abil = {n.strip(): clean(adescs[i]) for i, n in enumerate(anames)
            if n.strip() and i < len(adescs)}
    abil_by_id = {i: n.strip() for i, n in enumerate(anames) if n.strip()}
    moves = {}
    for mid, m in mv.items():
        e = raw[int(mid)]
        moves[m['name']] = dict(t=m['type'], c=m['category'], p=m['power'], acc=m['accuracy'],
                                pp=m['pp'], pri=m['priority'], ail=AIL.get(e[8]), ch=e[10],
                                stat=STAT_BY_ID.get(e[21]) if e[21] else None,
                                tg=move_stages(e, m['category'])[0],
                                st=move_stages(e, m['category'])[1],
                                d=clean(mdesc[int(mid)]) if int(mid) < len(mdesc) else '')
    return moves, abil, abil_by_id


def sprites():
    sp = {}
    personal = json.loads((STATE / "personal.json").read_text())["species"]
    for dex, v in personal.items():
        p = ROOT / "wiki" / "docs" / "img" / "pokemon" / f"{int(dex):03d}.png"
        if p.exists():
            sp[v['name']] = 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()
    ti = {}
    import gen5
    for t in gen5.TYPES:
        p = ROOT / "wiki" / "docs" / "img" / "types" / f"{t}.png"
        if p.exists():
            ti[t] = 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()
    return sp, ti


# ------------------------------------------------------------- opponents
# The player's starter decides which Striaton leader they face and which
# starter each rival carries.  Oshawott is Water, so the leader whose type
# beats it (Cilan, Grass) is the real fight; Cheren takes the line that beats
# yours, Bianca the line yours beats.
STARTER = 'Oshawott'
# Blaze Black, not Volt White. Drayano documents both Opelucid leaders in one
# file and tags their location "Opelucid Gym, Black" / ", White"; only one of
# them exists in your game. Set this to 'white' for a Volt White run.
VERSION = 'black'
VERSION_TAG = re.compile(r',\s*(black|white)\s*$', re.I)
# THE STARTER LINE AND THE MONKEY LINE ARE NOT THE SAME SET, and lumping them
# together is what made the late rival rosters unfixable. A rival's monkey is
# NOT from the rival's own elemental line -- it is the line their starter
# beats, so a Serperior Cheren carries Simipour and an Emboar Bianca carries
# Simisage. Both are the ROM's answer, and neither is derivable from the doc.
# Keeping one combined list meant two different ROM variants both looked like
# a match, which is why the join returned nothing at all.
STARTER_LINES = {
    'grass': ['Snivy', 'Servine', 'Serperior'],
    'fire':  ['Tepig', 'Pignite', 'Emboar'],
    'water': ['Oshawott', 'Dewott', 'Samurott'],
}
MONKEY_LINES = {
    'grass': ['Pansage', 'Simisage'],
    'fire':  ['Pansear', 'Simisear'],
    'water': ['Panpour', 'Simipour'],
}
STARTER_TYPE = {'Snivy': 'grass', 'Tepig': 'fire', 'Oshawott': 'water'}
BEATS = {'grass': 'fire', 'fire': 'water', 'water': 'grass'}      # X is beaten by BEATS[X]


def gates(version=None, starter=None):
    """The two things that decide which fights exist for YOU, as prose.

    Both are filtered out of this sheet rather than greyed, so every count on
    the page is what you will actually face. That is worth stating once: a
    reader who knows the game will otherwise wonder where Iris went, and a
    reader who does not would never learn these forks exist.

    BOTH FORKS ARE PARAMETERS, not globals. `build_sheet.py` bakes one pair in
    because the published artifact is static; the app passes all six
    combinations through `build_static.py` and picks at render time, so
    switching either one is a click rather than a rebuild.
    """
    version = version or VERSION
    starter = starter or STARTER
    mine = STARTER_TYPE[starter]
    cheren, bianca = BEATS[mine], next(k for k, v in BEATS.items() if v == mine)
    leader = {'grass': 'Cilan', 'fire': 'Chili', 'water': 'Cress'}[BEATS[mine]]
    lead = lambda k: STARTER_LINES[k][-1]
    monkey = lambda k: MONKEY_LINES[next(m for m, v in BEATS.items() if v == k)][-1]
    return [
        (f'You picked {starter}',
         f'The Striaton gym has three leaders and you fight the one whose type beats '
         f'yours, so this sheet shows <b>{leader}</b> and not the other two. '
         f'Your rivals take a line each: <b>Cheren</b> carries {lead(cheren)} '
         f'(with {monkey(cheren)}) and <b>Bianca</b> carries {lead(bianca)} '
         f'(with {monkey(bianca)}). Their rosters come from the ROM\u2019s own trainer '
         f'table, so the levels and the sixth slot are exact rather than a pool.'),
        (f'You are playing {"Blaze Black" if version == "black" else "Volt White"}',
         f'Opelucid has two gym leaders across the pair \u2014 <b>Drayden</b> in Black, '
         f'<b>Iris</b> in White \u2014 and only one exists in your cartridge. '
         f'{"Drayden" if version == "black" else "Iris"} is shown; the other is '
         f'dropped, which is why the gym count is eight rather than nine.'),
        ('Why they are dropped and not greyed',
         'A permanently disabled card is a puzzle to solve rather than a fight to '
         'plan against, and it makes every total on the page wrong by one. '
         'Nothing here is hidden to avoid spoilers \u2014 it is removed because it '
         'is not part of your game. Pick your starter and your cartridge in the '
         'masthead \u2014 both are settings, and every count on this page follows them.'),
    ]


# Which script produces each save-derived file. NOT the ROM tables -- those come
# from ./setup and their absence is a different conversation.
SAVE_DERIVED = {"party.json": "parse_save.py", "bag.json": "parse_bag.py"}


def need_save_derived(name):
    """Return STATE/<name>, generating it from the save if it is not there.

    ./setup STOPS AT THE ROM TABLES. It never runs parse_save.py or
    parse_bag.py, so a fresh clone that ran setup and then
    `python3 build_sheet.py` died on a bare FileNotFoundError for
    state/party.json -- which is "run ./refresh" wearing a stack trace. It cost
    Gab several days of using ./setup as a substitute for a script that does
    something else entirely.

    Generating rather than demanding, because there is nothing to ask for: both
    parsers read the same save this script is about to read, and ./refresh does
    no more than run them in order. If generation fails, the error names the
    file, the producer and ./refresh instead of a traceback.
    """
    import subprocess
    path = STATE / name
    if path.is_file():
        return path
    producer = SAVE_DERIVED[name]
    print(f"build_sheet: state/{name} is missing; running {producer} first")
    r = subprocess.run([sys.executable, str(ROOT / producer)],
                       cwd=ROOT, capture_output=True, text=True)
    if not path.is_file():
        tail = r.stderr.strip().splitlines()[-1] if r.stderr.strip() else ""
        raise SystemExit(
            f"build_sheet: could not build state/{name}.\n"
            f"  It comes from your SAVE, not your ROM, and ./setup does not\n"
            f"  create it. Run ./refresh -- it does parse_save.py, parse_bag.py\n"
            f"  and this script in the right order.\n"
            + (f"  {producer} said: {tail}" if tail else ""))
    return path


def rom_rosters():
    """Rival teams as the ROM stores them: {name: [(top_level, [(species, level)])]}.

    THE DOC CANNOT SETTLE THE LATE RIVAL FIGHTS AND THE ROM CAN.
    docs/Important Trainer Rosters.txt stacks the three per-starter variants
    inside single table cells. The RTF conversion renders those as bare
    newlines, which are indistinguishable from an ordinary cell break -- so a
    block that is really 3 fixed Pokémon plus 3 slots × 3 variants reads as
    nine loose species, and five late-game rival blocks came out at eight.

    Filtering by STARTER_LINES alone does not fix it, and is wrong in a way
    nobody would have noticed: it keeps the monkey from the same elemental
    line as the rival's starter, but the ROM says a Serperior Cheren carries
    SIMIPOUR, not Simisage. The rival's monkey is the one their own starter
    beats, which is not a rule the doc states anywhere.

    So the species come from the ROM, which stores each variant as its own
    trainer entry, and the doc still supplies items, abilities and moves.
    Absent state/trainers.json this returns {} and the caller falls back to
    the old filter -- the sheet must still build without the ROM tables.
    """
    path = STATE / "trainers.json"
    if not path.is_file():
        return {}
    out = {}
    for t in json.loads(path.read_text()).get('trainers', []):
        if not t.get('name') or not t.get('team'):
            continue
        team = [(m['species'], m['level']) for m in t['team']]
        # The raw records ride along beside the (species, level) pairs the
        # matching uses, because the ROM carries MOVES and HELD ITEMS too and
        # the doc does not always. Kept parallel rather than folded into the
        # pairs so the set comprehensions in rom_variant stay readable.
        out.setdefault(t['name'], []).append(
            (max(l for _s, l in team), team, t['team']))
    return out


def levelup_moves(entry, level):
    """The four moves the game itself would give this Pokemon at this level.

    A trainer record whose "custom moves" flag is CLEAR does not store moves at
    all -- the engine builds the set from the species' own level-up learnset,
    keeping the last four it would know by then. That is the case for most
    early rival fights: Cheren 4 and Bianca 4 have no moves in Drayano's doc
    AND none in the ROM, because in game they have none to store.

    So this is the third source, and it is weaker than the other two: it is
    engine behaviour applied to a ROM table rather than a value anybody wrote
    down. It is marked separately in the record (`msrc = 'levelup'`) so the
    page can say which fights are showing a derived set, and never presents
    itself as documented.
    """
    known = [e['move'] for e in (entry.get('learnset') or [])
             if e.get('level', 0) <= level and e.get('move')]
    return known[-4:]


def fill_from_rom(mon, rec):
    """Copy the ROM's moves and held item onto a documented Pokemon.

    ADDITIVE ONLY. Where Drayano documented a moveset it stays, because his
    tables also carry natures and the Full-vs-Clean ability split that the ROM
    does not express, and a half-replaced record would be worse than either
    source alone. This only fills what the doc left blank.

    Blank is common: eighteen story fights on a Snivy run arrive with no moves
    at all, N 4 among them, and a battle board with no moves on one side has
    no columns to solve. That is the whole reason this exists.
    """
    if not mon.get('m') and rec.get('moves'):
        mon['m'] = list(rec['moves'])
        mon['msrc'] = 'rom'
    if not mon.get('i') and rec.get('item'):
        mon['i'] = rec['item']
    # THE ABILITY IS NOT COSMETIC ON THIS PAGE. oppMon() feeds `a` into eff(),
    # and ABS_IMMUNE turns Levitate into a ground immunity -- so a blank here is
    # not a missing label, it is a damage number that is wrong by a factor of
    # infinity. N 4's six Rotom are all Levitate and all arrived blank, so the
    # board offered Earthquake at ~50% against a Pokemon that cannot be hit.
    if not mon.get('a') and rec.get('ability'):
        mon['a'] = rec['ability']
        mon['asrc'] = 'rom'
    # CARRIED SO THE BOARD CAN ADMIT WHAT IT DOES NOT KNOW. A forme'd opponent
    # is typed here as its BASE species, because personal.json stops at 649 and
    # the forme rows (657..661 are Rotom's five) are not extracted yet. For N 4
    # that means Ground is correctly x0 via Levitate but Water against Wash
    # Rotom reads x1 where the real answer is x0.5. Flagged rather than left to
    # look authoritative.
    if rec.get('forme'):
        mon['forme'] = rec['forme']
    return mon


def rom_variant(rosters, who, top, pool, allow=None):
    """The one ROM roster for this fight whose starter is the line he faces.

    Three filters, each of which must leave the answer unique:
      * top level -- separates Cheren's seven fights from each other
      * subset of the doc's own pool -- proves this really is the same fight
        and not another trainer of the same name at a coincidental level
      * intersects `allow` -- picks the variant for the starter he chose

    Returns None rather than guessing whenever that is not unique. A silently
    mismatched roster is worse than the doc's answer, because it would carry
    the ROM's authority while being about a different battle.
    """
    if top is None:
        return None
    cands = [(team, mons) for lv, team, mons in rosters.get(who, [])
             if lv == top and {s for s, _l in team} <= pool]
    if allow is None:
        # NO STARTER FORK TO RESOLVE -- N, the gym leaders, anyone whose fight
        # has one roster. Uniqueness on (name, top level, pool) is the whole
        # test, and it still refuses rather than guessing.
        return cands[0] if len(cands) == 1 else None
    hit = [c for c in cands if {s for s, _l in c[0]} & allow]
    return hit[0] if len(hit) == 1 else None


# --------------------------------------------------------- trainer portraits
# The class -> sprite join lives in extract_trainers.py (arm9 0x9C23C); this
# only has to turn a documented fight into the right portrait number.
#
# The name comes from the TEAM block header ("Cherens Team"), not from the
# section title, because the header is already just the person. Its regex eats
# an optional possessive 's', which is indistinguishable from a name that
# really ends in one -- "Ghetsis Team" comes back as "Ghetsi" -- so the lookup
# tries the recovered 's' as well rather than special-casing one trainer.
CLASS_MARKS = ''.join(chr(c) for c in range(0x2460, 0x24A0))   # the ⒆⒇ ⑭ ⑮ glyphs


def clean_class(name):
    """The game's class names carry text-engine glyphs: the player-name
    placeholder in '⒆⒇ Trainer' and the gender markers in 'Clerk ⑮'. They mean
    nothing outside the game's own text renderer, so they are stripped."""
    return re.sub(r'\s+', ' ', ''.join(c for c in name if c not in CLASS_MARKS)).strip()


def trainer_faces(opponents):
    """Attach a portrait to every documented fight; return the ones used.

    Returns {sprite_id: data URI}. Keyed by SPRITE id, not by trainer, because
    a portrait is shared -- N's two Team Plasma classes reuse his own -- and
    Cheren alone appears in seven fights. Embedding per fight would put the
    same PNG in the file a dozen times.

    Only the portraits actually referenced are embedded: all 95 would be
    ~380 KB of base64 for the twenty this page can ever show.
    """
    path = STATE / "trainers.json"
    faces = {}
    if not path.is_file():
        return faces
    data = json.loads(path.read_text())
    sprite_dir = ROOT / "app" / "img" / "trainers"
    by_name = {}
    for t in data.get('trainers', []):
        if t.get('name'):
            by_name.setdefault(t['name'], t)
    for e in opponents:
        who = e.get('who') or ''
        hit = by_name.get(who) or by_name.get(who + 's')
        if not hit:
            continue
        e['face'] = hit['sprite']
        # The class is only worth printing when it says something the label
        # does not. "LEADER" under "Gym Leader Burgh" is noise, and so is the
        # bare "Trainer" every rival carries -- but Morimoto's class is
        # GAME FREAK, which is the whole joke, so it stays.
        cls = clean_class(hit.get('class_name') or '')
        label = (e.get('leader') or '').lower()
        e['cls'] = '' if (not cls or cls == 'Trainer' or cls.lower() in label) else cls
        png = sprite_dir / f"{hit['sprite']:03d}.png"
        if hit['sprite'] not in faces and png.is_file():
            faces[hit['sprite']] = ('data:image/png;base64,'
                                    + base64.b64encode(png.read_bytes()).decode())
    return faces


HDR = re.compile(r'^(Rival|PKMN Trainer|Elite Four|Champion|Team Plasma|Gym Leader)\b(.*)$')
# The Elite Four write "Shauntals First Team" / "Grimsleys Second Team" where
# gym leaders write "Lenoras Team".  The qualifier in the middle is why the E4
# never parsed and the sheet has been missing four endgame fights.
TEAM_HDR = re.compile(
    r'^\s*([A-Za-z]+?)s?\s+(?:First|Second|Third|Fourth|Fifth|Final|Last)?\s*Team\s*(.*)$')


def _rows(region):
    rows, loose = {}, []
    for ln in region:
        if '\t' not in ln:
            continue
        lab, *cells = ln.split('\t')
        lab = lab.strip()
        key = ('n' if lab.startswith('Species') else 'l' if lab.startswith('Level')
               else 'i' if lab.startswith('Item') else 'a' if lab.startswith('Ability') else None)
        if key is None:
            mm = re.match(r'Move #(\d)', lab)
            key = 'm' + mm.group(1) if mm else None
        if key and key not in rows:
            rows[key] = [c.strip() for c in cells]
        elif not lab:
            loose.append([c.strip() for c in cells])
    return rows, loose


def parse_trainers(version=None, starter=None):
    """One entry per story/gym encounter, in document order (= game order).

    Rematch blocks are identified by 'replaces' in their location and dropped.
    Only the FIRST team block under a header is taken, which stops the next
    trainer's table bleeding into the previous one.
    """
    # DRAYANO'S DOCUMENTATION IS OPTIONAL, and has to be: it is his writing,
    # it ships inside the hack's own download rather than in this repo, and a
    # clean clone therefore does not have it. Without it there are no
    # documented story fights -- the ROM gives rosters but not the order of
    # the game, nor the natures and Full-vs-Clean ability notes -- so the
    # battle tab shows the fights it can and says nothing it cannot support.
    # `Item & Trade Changes.txt` is already treated this way in build_static.
    doc = ROOT / "docs" / "Important Trainer Rosters.txt"
    if not doc.is_file():
        return []
    txt = doc.read_text(encoding='utf-8', errors='replace')
    lines = txt.split('\n')
    personal = json.loads((STATE / "personal.json").read_text())["species"]
    names = {v['name'] for v in personal.values()}
    by_name = {v['name']: v for v in personal.values()}
    ABILITY_SET = {a for v in personal.values()
                   for a in list(v.get('abilities') or []) + [v.get('hidden_ability')] if a}

    starter = starter or STARTER
    mine = STARTER_TYPE[starter]
    cheren_line = BEATS[mine]                    # the line that beats yours
    bianca_line = next(k for k, v in BEATS.items() if v == mine)
    ROSTERS = rom_rosters()

    hdrs = [(i, l.strip()) for i, l in enumerate(lines) if HDR.match(l)]
    blocks = [(i, m.group(1), m.group(2).strip())
              for i, l in enumerate(lines) for m in [TEAM_HDR.match(l)] if m]

    out = []
    for hi, (idx, title) in enumerate(hdrs):
        stop = hdrs[hi + 1][0] if hi + 1 < len(hdrs) else len(lines)
        mine_blocks = [b for b in blocks if idx < b[0] < stop and 'replaces' not in b[2].lower()]
        if not mine_blocks:
            continue
        seen_leaders = set()
        for bi, (bstart, who, where) in enumerate(mine_blocks):
            if who in seen_leaders:
                continue
            seen_leaders.add(who)
            bend = mine_blocks[bi + 1][0] if bi + 1 < len(mine_blocks) else stop
            rows, loose = _rows(lines[bstart:bend])
            approx = False
            cell = lambda seq, c: seq[c].strip() if seq and c < len(seq) else ''
            team, seen = [], set()

            def add(nm, l, it, ab, mv):
                if nm in names and nm not in seen:
                    seen.add(nm)
                    # AN ABILITY THAT IS NOT AN ABILITY IS DISCARDED. The doc's
                    # Full/Clean ability pair wraps across rows in the RTF
                    # conversion, and on five rows the item column lands in the
                    # ability column instead -- Skyla's Archeops reads ability
                    # "Flying Gem", Shauntal's Chandelure "Air Balloon". That is
                    # not a label problem: oppMon() feeds `a` to eff(), so a
                    # bogus value silently means NO ability, and a real Levitate
                    # or Flash Fire goes unapplied. Validated against the ROM's
                    # own ability table, then handed to the ROM fill instead.
                    if ab and ab not in ABILITY_SET:
                        ab = ''
                    team.append(dict(n=nm, l=l, i=it, a=ab, m=[x for x in mv if x]))

            for c in range(len(rows.get('n', []))):
                add(cell(rows['n'], c), cell(rows.get('l'), c), cell(rows.get('i'), c),
                    cell(rows.get('a'), c),
                    [cell(rows.get('m' + str(k)), c) for k in range(1, 5)])
            if len(loose) >= 6 and all(len(x) > 1 for x in loose[:4]):
                for c in range(len(loose[0])):
                    add(cell(loose[0], c), cell(loose[1], c), cell(loose[2], c), cell(loose[3], c),
                        [cell(loose[j], c) for j in range(4, min(8, len(loose)))])
            else:
                nums = sorted({int(x) for x in rows.get('l', []) if x.isdigit()})
                lv = str(nums[0]) if len(nums) == 1 else (f"{nums[0]}–{nums[-1]}" if nums else '')
                approx = True
                # wrapped tables put species anywhere -- bare lines, first cell
                # of a row, or later cells.  Scan every token in the block.
                for ln in lines[bstart:bend]:
                    for tok in ln.split('\t'):
                        tok = tok.strip()
                        if tok in names:
                            add(tok, lv, '', '', [])
            if not team:
                continue

            btype = loc = reward = ''
            for k in range(idx, bstart):
                t = lines[k]
                if t.startswith('Battle Type:'): btype = t.split(':', 1)[1].strip()
                if t.startswith('Location:'):    loc = t.split(':', 1)[1].strip()
                if t.startswith('Reward:'):      reward = t.split(':', 1)[1].strip()
            loc = where or loc

            # --- starter-dependent trimming ---
            note = ''
            label = title if len(mine_blocks) == 1 else f"{who} — {title.split(',')[0].strip()}"
            if 'Gym Leader' in title and 'Striaton' in loc.replace('Striation', 'Striaton'):
                want = {'grass': 'Cilan', 'fire': 'Chili', 'water': 'Cress'}[BEATS[mine]]
                if who != want:
                    continue                       # not the leader an Oshawott player fights
                label = f"Gym Leader {who}"
                note = f"You picked {starter}, so {who} is the leader you face."
            keep = None
            if title.startswith('Rival Cheren'): keep = cheren_line
            elif title.startswith('Rival Bianca'): keep = bianca_line
            fam = {x for d in (STARTER_LINES, MONKEY_LINES)
                   for ln_ in d.values() for x in ln_}
            if keep and ({m['n'] for m in team} & fam):
                # DROP the other starters' variants rather than greying them.
                # Cheren's documented table wraps all three lines into one
                # block, so the roster read as nine Pokémon with three of them
                # shaded -- which is a puzzle to solve rather than a team to
                # plan against. He is only ever going to face one line.
                # The starter line alone identifies the variant; the monkey
                # line is what the rival's starter beats, and is what the old
                # single-list `allow` got wrong.
                starters = set(STARTER_LINES[keep])
                monkey = next(k for k, v in BEATS.items() if v == keep)
                allow = starters | set(MONKEY_LINES[monkey])
                who_r = 'Cheren' if keep == cheren_line else 'Bianca'
                # THE ROM SETTLES IT, THE DOC CANNOT. See rom_rosters(): the
                # late blocks stack all three variants inside single cells, so
                # every Level row in the block has to be read to find the
                # fight's top level -- `rows` keeps only the first. Matching
                # (name, top level) against the ROM's own trainer entries is
                # unique for every rival block in the file, and what it lands
                # on is an exact six with exact per-Pokémon levels.
                doclv = [int(x) for ln_ in lines[bstart:bend]
                         if ln_.startswith('Level')
                         for x in ln_.split('\t')[1:] if x.strip().isdigit()]
                romset = rom_variant(ROSTERS, who_r, max(doclv) if doclv else None,
                                     {m['n'] for m in team}, starters)
                if romset:
                    pairs, recs = romset
                    by = {m['n']: m for m in team}
                    team = []
                    for (sp, lvl), rec in zip(pairs, recs):
                        # COPY, because a roster may hold the same species
                        # more than once and the doc's pool holds one dict per
                        # NAME -- reusing it would append one object six times
                        # and every entry would end up wearing the last one's
                        # moves.
                        m = dict(by[sp])
                        m['l'] = str(lvl)
                        if sp in fam:
                            m['variant'] = 'yes'
                        team.append(fill_from_rom(m, rec))
                    approx = False
                    they = 'his' if who_r == 'Cheren' else 'her'
                    # "exact six" is only true late on -- the first rival
                    # fight is a single Pokémon -- so the sentence has to
                    # carry the real number.
                    what = ('the one Pokémon %s brings' % ('he' if who_r == 'Cheren' else 'she')
                            if len(team) == 1
                            else f"{they} exact roster of {len(team)}")
                    note = (f"You picked {starter}, so {who_r} carries the {keep} line. "
                            f"This is {what}, read from the ROM's own trainer table"
                            + ("." if len(team) == 1
                               else "; the other starters' variants are not shown."))
                else:
                    team = [m for m in team if m['n'] not in fam or m['n'] in allow]
                    for m in team:
                        if m['n'] in fam:
                            m['variant'] = 'yes'
                    note = (f"You picked {starter}, so {who_r} carries the {keep} line. "
                            f"The other starters' variants are not shown.")
            # --- the doc left this fight without a single move -------------
            # The rival branch above only runs for Cheren and Bianca, so every
            # other under-documented fight fell through with an empty board:
            # the matrix game needs moves on BOTH sides, and N 4 arrived as one
            # Rotom with none. Matched the same way and refusing the same way --
            # (name, top level, species pool) must be unique or nothing happens.
            if team and not any(m.get('m') for m in team):
                lv_ = [int(m['l']) for m in team if str(m.get('l', '')).isdigit()]
                got = rom_variant(ROSTERS, who, max(lv_) if lv_ else None,
                                  {m['n'] for m in team})
                if got and any(r.get('moves') for r in got[1]):
                    pairs, recs = got
                    by = {m['n']: m for m in team}
                    team = [fill_from_rom(dict(by[sp]) | {'l': str(lvl)}, rec)
                            for (sp, lvl), rec in zip(pairs, recs)]
                    approx = False
                    note = ("Drayano's table gives this fight's species and levels but no "
                            "movesets, so the moves and held items here are read from the "
                            "ROM's own trainer table.")
            # --- still nothing? derive what the engine itself would use ----
            # Covers every fight the ROM does not store moves for, which is
            # most of the early rival battles. Per Pokemon, not per fight, so a
            # documented team with one blank row gets only that row filled.
            for m in team:
                if not m.get('m') and str(m.get('l', '')).isdigit():
                    lvl_ = int(m['l'])
                    mv = levelup_moves(by_name.get(m['n'], {}), lvl_)
                    if mv:
                        m['m'] = mv
                        m['msrc'] = 'levelup'
            if approx and not note:
                note = ('Drayano documents this table with per-starter variants across wrapped '
                        'rows, so this is the documented pool rather than an exact six.')
            # Categories, so the battle index can be filtered the way the
            # story actually presents these fights.
            low = f"{title} {label}".lower()
            if 'gym leader' in low:
                kind = 'gym'
            elif 'elite four' in low:
                kind = 'elite'
            elif 'rival' in low:
                kind = 'rival'
            elif 'ghetsis' in low or 'plasma' in low:
                kind = 'plasma'
            elif 'trainer n' in low or label.strip().startswith('N '):
                kind = 'n'
            elif any(w in low for w in ('champion', 'cynthia', 'alder', 'morimoto')):
                kind = 'champion'
            else:
                kind = 'story'
            # DROPPED, NOT GREYED -- the same call as the rivals' per-starter
            # variants. Drayden is the Black gym leader and Iris the White
            # one; only one of them is in your game, and a permanently
            # disabled card is a puzzle to solve rather than a fight to plan
            # against. The old test was one-directional ('white' in loc), so
            # it could only ever hide Iris; this reads the tag and compares.
            # `version` None keeps every fight and tags it, which is what the
            # APP wants: it filters at render time so you can flip between
            # Black and White without rebuilding, and so the indices that
            # bb_cleared and AREAINDEX key on never shift underneath you.
            # The published artifact is static, so it bakes one version in.
            vm = VERSION_TAG.search(loc)
            ver = vm.group(1).lower() if vm else None
            if version and ver and ver != version:
                continue
            lv = [int(p['l']) for p in team if str(p.get('l', '')).isdigit()]
            label = re.sub(r'\s+', ' ', label).strip(' -\u2014')
            # The parser builds "<who> \u2014 <title>", which for the E4 and the
            # champions doubles the name: "Shauntal \u2014 Elite Four Shauntal".
            parts = [x.strip() for x in label.split('\u2014')]
            if len(parts) == 2 and parts[1].lower().endswith(parts[0].lower()):
                label = parts[1]
            # A STABLE KEY, so ticking a fight off survives the roster
            # changing shape. bb_cleared used to key on position, which meant
            # dropping one fight silently re-attributed every mark after it.
            key = re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')
            out.append(dict(order=bstart, leader=label, who=who, key=key, ver=ver,
                            loc=loc, type=btype, approx=approx,
                            reward=reward, note=note, team=team, kind=kind,
                            lvmin=min(lv) if lv else None, lvmax=max(lv) if lv else None))
    out.sort(key=lambda e: e['order'])
    for e in out:
        e.pop('order')
    return out


# ------------------------------------------------------------------- main
def build_blob():
    """Assemble the sheet's data blob from the ROM, the save and the team store.

    Split out of main() so the blob can be built without writing HTML -- which
    is what tools/verify_blob.py needs in order to diff this implementation
    against the browser-side port in app/js/roster.js.

    Returns (blob, missing, copies, info).
    """
    global ABILITY_NAMES
    moves, abil, ABILITY_NAMES = rom_tables()
    live, info = read_live()
    sp, ti = sprites()
    import gen5
    PERSONAL_RAW = json.loads((STATE / "personal.json").read_text())
    personal = PERSONAL_RAW["species"]
    items = json.loads((STATE / "items.json").read_text())["items"]

    # species -> every copy in the save.  Slots CLAIM a copy, so if you keep two
    # Slowkings for two different teams they resolve to different records
    # instead of both showing the same one.  Party copies are handed out first.
    from collections import defaultdict
    copies = defaultdict(list)
    for mon in live:
        copies[mon['name']].append(mon)
    for lst in copies.values():
        lst.sort(key=lambda m: 0 if m['box'] == 'Party' else 1)
    claimed = set()

    def take(spec, name):
        """Claim the copy this slot actually means.

        MATCHED ON THE SPEC, NOT ON A NICKNAME. These rosters used to name only
        a species, so telling four Arcanines apart needed a one-letter tag in
        the nickname and a convention you had to keep up by hand. A core's slot
        carries the whole build -- ability, nature, moves, item, level -- so the
        right copy is the one that IS that build, and the tags stopped mattering.

        Scored rather than filtered: a Pokemon you have levelled or re-taught
        since adopting the core should still be recognised as itself, so the
        best match wins and only the species is required.
        """
        lst = copies.get(name)
        if not lst:
            return None
        moves = {m for m in (spec.get('moves') or []) if m}

        # FEWEST DIFFERENCES WINS, and a party copy breaks a tie.
        #
        # This was a WEIGHTED SCORE -- ability 8, nature 4, two per matching
        # move, item 2, level 1 -- and the app's matchSlot() counts differences
        # instead. Two implementations of "which copy does this slot mean",
        # scoring differently, and they disagreed the moment he owned four
        # Gengars: the app gave each tagged one to its own team and this gave
        # the Uncle roster Kaiju's, shifting the whole assignment by one.
        #
        # That shift is the exact failure `notes/teams-and-cores.md` records
        # from the first migration, so the app's rule is the one that is right
        # -- and one rule beats two whatever the rule is.
        #
        # `diffSlot` also compares IVs and EVs, which read_live() does not
        # carry. That only ever makes this coarser, never differently ordered:
        # a tie here is broken the same way, party first.
        def diffs(m):
            n = 0
            if spec.get('ab') and m.get('ab') != spec['ab']:
                n += 1
            if spec.get('nat') and m.get('nat') != spec['nat']:
                n += 1
            if moves and moves != set(x for x in (m.get('moves') or []) if x):
                n += 1
            if spec.get('item') and m.get('item') != spec['item']:
                n += 1
            # EVs and IVs count as ONE difference each, exactly as diffSlot
            # does -- it breaks out of its loop on the first stat that differs.
            if spec.get('evs') and any(spec['evs'].get(k) != (m.get('_evs') or {}).get(k)
                                       for k in spec['evs']):
                n += 1
            if spec.get('ivs') and any(spec['ivs'].get(k) != (m.get('_ivs') or {}).get(k)
                                       for k in spec['ivs']):
                n += 1
            if spec.get('lvl') and m.get('lvl') != spec['lvl']:
                n += 1
            return n

        # TEAMS ARE ALTERNATIVES, NOT A SIMULTANEOUS ARMY.
        #
        # Claiming exists so two teams that each want a Slowking get DIFFERENT
        # Slowkings, and it quietly assumed the teams coexist. They do not --
        # you field one at a time, and five cores each listing the one Gengar
        # you own is completely legitimate.
        #
        # When the copies ran out this used to `return lst[0]`, handing over
        # whichever copy happened to sort first and saying nothing -- so the
        # page showed two teams fielding one Gengar and computed both their
        # damage numbers off it. Returning `missing` instead was no better: it
        # denied a Pokemon that is sitting in the save.
        #
        # So claim a distinct copy while there is one, and when there is not,
        # fall back to the BEST MATCH -- the same ranking, so both sides pick
        # the same copy -- and report that it is shared. matchSlot() does
        # exactly this; tools/verify_blob.py holds the two together.
        free = [m for m in lst if id(m) not in claimed]
        pool = free or lst
        best = min(pool, key=lambda m: (diffs(m), 0 if m.get('box') == 'Party' else 1))
        if free:
            claimed.add(id(best))
        return best, not free
        best = min(free, key=lambda m: (diffs(m), 0 if m.get('box') == 'Party' else 1))
        claimed.add(id(best))
        return best

    missing = []
    teams = []
    for t in adopted_cores(personal):
        slots = []
        for s in t['slots']:
            opts = []
            for opt in s['options']:
                # ('Species', badge, note) or ('Species', badge, note, rigged).
                # `rigged` marks a Pokemon we deliberately broke by writing an
                # ability/moveset it cannot legally have -- it renders as a
                # standing disclaimer so a returning player is never confused
                # about why it is outperforming everything.
                name, badge, note = opt['name'], opt['badge'], opt['note']
                rigged = opt.get('rigged')
                got = take(opt, name)
                mon, shared = got if got else (None, False)
                if mon is None:
                    # Either you own none of this species, or every copy is
                    # already claimed by an earlier team. Both mean this slot
                    # has no live record to render.
                    missing.append(f"{t['name']}: {name}")
                    continue
                if shared:
                    note = ' '.join(filter(None, [
                        note, 'Shared — another team is built on this same copy.']))
                opts.append(dict(mon=mon, badge=badge, note=note, rigged=rigged))
            if opts:
                d = next((i for i, o in enumerate(opts) if o['mon']['box'] == 'Party'), 0)
                slots.append(dict(role=s['role'], why=s['why'], options=opts, defaultIdx=d))
        if len(slots) * 2 < len(t['slots']):
            print(f"build_sheet: team '{t['name']}' SKIPPED -- only {len(slots)}/{len(t['slots'])} "
                  f"of its members are in the save", file=sys.stderr)
            continue
        # Where a team LIVES, from its core six only.  The old version pooled
        # every swap option too, so a team with swaps in three boxes advertised
        # "Box 11, Box 14, Box 15" -- technically true, useless in practice.
        core = [sl['options'][0]['mon']['box'] for sl in slots]
        swaps = sorted({o['mon']['box'] for sl in slots for o in sl['options'][1:]})
        in_party = sum(1 for b in core if b == 'Party')
        boxes = sorted({b for b in core if b != 'Party'},
                       key=lambda b: int(re.sub(r'\D', '', b) or 0))
        if in_party == len(core):
            where, state = 'fielded', 'fielded'
        elif in_party:
            where = f'{in_party}/{len(core)} fielded'
            state = 'partial'
        elif len(boxes) == 1:
            where, state = boxes[0], 'stored'
        else:
            where = ' + '.join(boxes) if len(boxes) <= 2 else f'{len(boxes)} boxes'
            state = 'split'
        teams.append(dict(id=t['id'], name=t['name'], where=where, state=state,
                          tag='', coreBoxes=boxes,
                          inParty=in_party, coreN=len(core), swapBoxes=swaps,
                          tr=t['tr'], mech=t.get('mech', []),
                          tagline=t['tagline'], warn=t['warn'], rigged=t.get('rigged'),
                          pilot=t['pilot'], slots=slots))

    encounters = parse_trainers(VERSION)
    faces = trainer_faces(encounters)
    # THE PARTY'S LEVEL RANGE, not the teams'. It used to be read off the
    # assembled teams, which crashed outright the moment there were none -- a
    # fresh checkout has an empty team store, and the kicker is not the place
    # to discover that. What you are carrying is also the more useful reading.
    lv = sorted({m['lvl'] for m in live if m['box'] == 'Party'}
                or {m['lvl'] for m in live})
    lvtxt = '' if not lv else f"L{lv[0]}" if len(lv) == 1 else f"L{lv[0]}–{lv[-1]}"
    blob = dict(
        TYPES=gen5.TYPES,
        CHART={a: {d: gen5.effectiveness(a, [d]) for d in gen5.TYPES} for a in gen5.TYPES},
        MOVES=moves, ABIL=abil,
        ITEMDESC={v['name']: v['description'] for v in items.values()
                  if v['name'] in HELD_ITEMS_OF_INTEREST and v['description']},
        # Alternate formes, same key and shape as build_static.py's FORME --
        # verify_blob.py diffs the two blobs, and the template reads whichever
        # it is handed. See the note there for why a forme needs its own row.
        FORME={f"{f['of_name']}.{f['forme']}": dict(
            t=f['types'],
            b=[f['base_stats'][k] for k in ('hp','atk','def','spa','spd','spe')],
            bst=f['bst'], of=f['of_name'], n=f['forme'])
            for f in (PERSONAL_RAW.get('formes') or {}).values()},
        DEX={v['name']: dict(
            t=v['types'],
            b=[v['base_stats'][k] for k in ('hp','atk','def','spa','spd','spe')],
            # The abilities this species can actually have -- see build_static.py,
            # which builds the same field for the app. verify_blob.py diffs them.
            a=[x for i, x in enumerate(list(v.get('abilities') or [])
                                       + ([v['hidden_ability']] if v.get('hidden_ability') else []))
               if x and x != '--'
               and x not in (list(v.get('abilities') or [])
                             + ([v['hidden_ability']] if v.get('hidden_ability') else []))[:i]])
             for v in personal.values()},
        SPRITE=sp, TICON=ti, TEAMS=teams, TRFACE=faces,
        OPPONENTS=encounters, STATUS=STATUS, NOTES=NOTES,
        FIELD=field_effects(live, moves, abil),
        GATES=gates(),
        HERE=here_panel(personal), BAGTM=bag_tms(personal), BOXED=boxed_index(),
        SPNAME={v.get('id', i + 1): v['name'] for i, v in enumerate(personal.values())},
        META=dict(kicker=f"Blaze Black 3.1 · OT {json.loads((STATE/'bag.json').read_text())['trainer']['ot_name']} · {lvtxt}",
                  built=f"Built from the save {info['mtime'][:16].replace('T',' ')} UTC · "
                        f"regenerate with  python3 build_sheet.py",
                  footer="<b>Refreshing this.</b> Run <code>python3 build_sheet.py</code> after levelling up, "
                         "evolving, or swapping an item — levels, stats, natures, abilities, held items, moves "
                         "and shininess are all re-read from the save. Team membership, roles and prose come "
                         "from your saved teams and cores in <code>state/teams.json</code>, which the "
                         "<b>Team Builder</b> writes."))

    return blob, missing, copies, info


def main() -> int:
    blob, missing, copies, info = build_blob()
    teams, encounters, sp = blob['TEAMS'], blob['OPPONENTS'], blob['SPRITE']

    html = TEMPLATE.read_text(encoding='utf-8').replace(
        '__DATA__', json.dumps(blob, separators=(',', ':')))
    OUT.write_text(html, encoding='utf-8')
    if missing:
        print("build_sheet: NOT FOUND in save -> " + "; ".join(missing), file=sys.stderr)
    dupes = {n: len(v) for n, v in copies.items() if len(v) > 1}
    if dupes:
        print("build_sheet: multiple copies (each slot claims its own): "
              + ", ".join(f"{n}×{c}" for n, c in sorted(dupes.items())))
    print(f"build_sheet: {sum(len(s['options']) for t in teams for s in t['slots'])} entries, "
          f"{len(encounters)} encounters, {len(sp)} sprites")
    print(f"build_sheet: wrote {OUT} ({OUT.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

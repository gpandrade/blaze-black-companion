/**
 * showdown.js -- a team as a Pokémon Showdown paste. No DOM.
 *
 * =========================================================================
 * WHY THIS EXISTS
 * =========================================================================
 * A team you cannot hand to anybody is a team that stays in one browser. The
 * paste format is the lingua franca: it is what Showdown imports, what every
 * damage calculator accepts, and what people put in a Reddit comment. It is
 * the cheapest thing this app can do to make a team travel.
 *
 * =========================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * =========================================================================
 * It does not translate. This is Gen 5 as the ROM has it, and the hack has
 * moved base stats for 138 species, typings for 18 and abilities for 487 --
 * so a paste of a Blaze Black Arcanine with Contrary is a description of THIS
 * game's Arcanine, and pasting it into a Gen 9 calculator will produce numbers
 * for a different Pokémon. `header()` says so in the paste itself, because the
 * person who receives it has no other way to know.
 *
 * =========================================================================
 * THE FORMAT
 * =========================================================================
 *     Nickname (Species) (M) @ Life Orb
 *     Ability: Contrary
 *     Level: 62
 *     Shiny: Yes
 *     EVs: 252 Atk / 4 Def / 252 Spe
 *     Adamant Nature
 *     IVs: 0 Spe
 *     - V-create
 *     - Close Combat
 *
 * Rules the format actually has, and each one has bitten an implementation
 * somewhere:
 *
 *   - A nickname is in front and the species goes in brackets. With no
 *     nickname the species stands alone and there are NO brackets -- writing
 *     `Arcanine (Arcanine)` is legal-ish but reads as a bug.
 *   - Gender is `(M)` / `(F)` and is OMITTED for a genderless species. It sits
 *     after the species, before the item.
 *   - The EV and IV lines are omitted entirely when there is nothing to say:
 *     an `EVs:` line with no values does not parse.
 *   - IVs list only what is NOT 31, because 31 is the default. A Trick Room
 *     build's whole IV line is `IVs: 0 Spe`.
 *   - `Level: 100` is the default and is left out.
 */

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

/** One Pokémon. `spec` is the Team Builder's option shape. */
export function specToPaste(spec, S, { natureNames = [] } = {}) {
  const sp = S.SPECIES[String(spec.speciesId)];
  const species = sp?.name ?? `#${spec.speciesId}`;
  const nick = (spec.nickname ?? '').trim();

  // Genderless species take no marker at all. `null` means "let the PID
  // decide", which is not a claim about gender and so is also left off.
  const ratio = sp?.ratio;
  const g = ratio === 255 ? null
    : spec.gender === 'male' ? 'M' : spec.gender === 'female' ? 'F' : null;

  const item = spec.itemId ? (S.ITEMS[String(spec.itemId)] ?? null) : null;
  const lines = [];
  lines.push(`${nick ? `${nick} (${species})` : species}`
    + `${g ? ` (${g})` : ''}${item ? ` @ ${item}` : ''}`);

  const ability = spec.abilityId
    ? (S.ABILBYID?.[String(spec.abilityId)] ?? null)
    : (sp?.abilities?.[0] ?? null);
  if (ability && ability !== '--') lines.push(`Ability: ${ability}`);

  if (spec.level && spec.level !== 100) lines.push(`Level: ${spec.level}`);
  if (spec.shiny) lines.push('Shiny: Yes');

  const evs = STAT_KEYS.filter((k) => (spec.evs?.[k] ?? 0) > 0)
    .map((k) => `${spec.evs[k]} ${STAT_LABEL[k]}`);
  if (evs.length) lines.push(`EVs: ${evs.join(' / ')}`);

  const nature = natureNames[spec.natureId];
  if (nature) lines.push(`${nature} Nature`);

  // Only what is NOT perfect: 31 is the default and listing six of them is
  // noise. A Trick Room build's whole line is `IVs: 0 Spe`.
  const ivs = STAT_KEYS.filter((k) => (spec.ivs?.[k] ?? 31) !== 31)
    .map((k) => `${spec.ivs[k]} ${STAT_LABEL[k]}`);
  if (ivs.length) lines.push(`IVs: ${ivs.join(' / ')}`);

  for (const id of spec.moveIds ?? []) {
    if (!id) continue;
    lines.push(`- ${S.MOVEBYID?.[String(id)] ?? `#${id}`}`);
  }
  return lines.join('\n');
}

/**
 * A header naming the game, because a paste has no other way to carry it.
 *
 * This hack changed base stats for 138 species, typings for 18 and abilities
 * for 487. Someone pasting a Blaze Black Arcanine into a modern calculator
 * gets numbers for a different Pokémon entirely, and the only place to warn
 * them is inside the text they are pasting. Comment lines are ignored by
 * Showdown's importer, so this costs the recipient nothing.
 */
export function header(teamName, version = 'black') {
  const game = version === 'white' ? 'Volt White' : 'Blaze Black';
  return `=== ${teamName || 'Team'} ===\n`
    + `# ${game} 3.1 (Full patch) — a Gen 5 ROM hack.\n`
    + '# Base stats, typings and abilities differ from the base game for most\n'
    + '# species, so these sets describe THIS game and will not match a modern\n'
    + '# calculator. Exported from the Blaze Black companion.\n';
}

/**
 * A whole team.
 *
 * Every slot's PRIMARY option, because that is the team: the alternates are a
 * swap tree, and pasting all of them would produce a nineteen-Pokémon team
 * nothing can import.
 */
export function teamToPaste(team, S, { natureNames = [], version = 'black', withHeader = true } = {}) {
  const specs = (team?.slots ?? [])
    .map((sl) => sl.options?.[0])
    .filter(Boolean);
  const body = specs.map((sp) => specToPaste(sp, S, { natureNames })).join('\n\n');
  return (withHeader ? `${header(team?.name, version)}\n` : '') + body + '\n';
}

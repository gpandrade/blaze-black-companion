/**
 * shackle.js -- how a rule you chose looks when it bites.
 *
 * =========================================================================
 * A CLOSED CONTROL STAYS ON SCREEN
 * =========================================================================
 * There are three ways to express "you may not do this" and two of them are
 * wrong:
 *
 *   hide it          you forget the constraint exists, and the app quietly
 *                    becomes a different app. The whole point of configuring a
 *                    nuzlocke is to SEE what you gave up.
 *   grey it out      indistinguishable from "not available yet" or from a bug.
 *                    Every disabled control in this app already means the
 *                    latter, so reusing that styling would be ambiguous
 *                    exactly where ambiguity is worst.
 *   shackle it       the control stays exactly where it was, struck through in
 *                    the danger colour, wearing a lock, and its tooltip names
 *                    the rule that took it.
 *
 * The third is the only one that reads as "I did this to myself".
 *
 * =========================================================================
 * DISABLED IS A COLOUR, NEVER AN OPACITY
 * =========================================================================
 * The standing rule in notes/design-system.md: an opacity over a filled accent
 * composites the whole control toward the page and destroys its contrast --
 * measured at 7.08:1 before and 2.27:1 after. `.shackled` therefore restates
 * background and ink from the measured `--x4` / `--x4b` pair rather than
 * fading whatever was underneath.
 */

/**
 * Close a control, or leave it alone.
 *
 * @param {HTMLElement} node     the button/input the rule governs
 * @param {{ok: boolean, name?: string, why?: string}} verdict  from `gate()`
 * @returns the same node, so it can be used inline
 */
export function shackle(node, verdict) {
  if (!node || !verdict || verdict.ok) return node;
  node.disabled = true;
  node.classList.add('shackled');
  node.setAttribute('aria-disabled', 'true');
  // The rule NAME, not a generic "not allowed". Which shackle bit is the whole
  // information: it tells you where to go to change your mind.
  const why = `Locked by your nuzlocke rule “${verdict.name}”.`
    + (verdict.why ? `\n${verdict.why}` : '')
    + '\nChange it in the Run tab.';
  node.title = why;
  node.setAttribute('aria-label', `${node.textContent || 'Action'} — ${why}`);
  // Clicking says why rather than doing nothing. A dead button is a bug; a
  // button that explains itself is a rule.
  node.onclick = (e) => { e?.preventDefault?.(); e?.stopPropagation?.(); };
  return node;
}

/** True when a verdict closed something — for callers that branch rather than disable. */
export const closed = (verdict) => Boolean(verdict) && verdict.ok === false;

/**
 * A one-line banner naming every shackle in force.
 *
 * Rendered at the top of a tab that has any, so you know before you reach for
 * a button rather than after. Returns null when nothing is closed, so a tab
 * with no shackles gains no furniture at all.
 */
export function shackleBanner(doc, state, actions, nuz) {
  if (!state?.enabled) return null;
  const hit = actions.map((a) => nuz.gate(state, a)).filter(closed);
  if (!hit.length) return null;
  const names = [...new Set(hit.map((v) => v.name))];
  const bar = doc.createElement('p');
  bar.className = 'shackle-bar';
  const lock = doc.createElement('b');
  lock.textContent = '⛓';
  bar.append(lock, ` ${names.join(' · ')}`);
  bar.title = 'Rules you chose in the Run tab. Struck-through controls are locked by them.';
  return bar;
}

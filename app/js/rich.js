/**
 * rich.js -- render the small amount of inline markup our own prose carries.
 *
 * WHY THIS EXISTS
 * `build_sheet.py` writes notes containing <b>...</b> -- "160 Atk vs 110,
 * <b>100 Speed vs 30</b>" -- and the battle sheet renders them with innerHTML,
 * so they come out bold.  The Team Builder and the Adventure tab appended the
 * same strings as TEXT NODES, so they showed the tags literally.  Five of the
 * nine Kaiju swap notes read "<b>completely unchanged</b>" on screen.
 *
 * The fix is NOT innerHTML.  These strings are ours today, but a Builder team
 * carries user-typed notes through the same path, and one <img onerror> would
 * be the whole story.  So: parse the string, keep the four inline tags the
 * prose actually uses, and escape everything else into text.
 *
 * Returns a DocumentFragment, so it drops straight into el(...) children.
 */
const KEEP = new Set(['b', 'strong', 'i', 'em']);

export function rich(text) {
  const frag = document.createDocumentFragment();
  if (text == null) return frag;
  const s = String(text);
  // Tokenise on the tags we allow; anything else -- including a stray "<" --
  // falls through to the text branch and is escaped by createTextNode.
  const re = /<(\/?)(b|strong|i|em)\s*>/gi;
  let at = 0, m;
  const stack = [frag];
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(s)) !== null) {
    if (m.index > at) top().append(document.createTextNode(s.slice(at, m.index)));
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // Only pop for a tag we actually opened; an unmatched </b> is just noise.
      if (stack.length > 1 && top().tagName?.toLowerCase() === tag) stack.pop();
    } else if (KEEP.has(tag)) {
      const n = document.createElement(tag);
      top().append(n);
      stack.push(n);
    }
    at = m.index + m[0].length;
  }
  if (at < s.length) top().append(document.createTextNode(s.slice(at)));
  return frag;
}

export default rich;

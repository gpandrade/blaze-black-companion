/**
 * install.js -- the two ways an edited save leaves this tab.
 *
 * WHY THIS IS NOT IN A TAB
 * Install and Download act on the Factory's working copy, and there is exactly
 * ONE of those, shared by every tab (app.js owns it and passes it in ctx).
 * They were nonetheless rendered three times -- Factory, Team Builder and Bag
 * each drew their own pair in their own header -- which said, wrongly, that
 * each tab had its own pending changes. Nothing told you the three buttons
 * were the same button.
 *
 * So the pair lives in the shell bar next to "Reload save", where the save
 * itself lives, and the logic lives here so there is one copy of the guards
 * and one copy of the wording.
 */

/** Install over the real save file via ./serve. Returns a status string. */
export async function installSave(F, CONFIG) {
  const out = F.output();
  if (!out.ok) throw new Error(`Refusing to install — ${out.problems.join('; ')}`);
  if (!confirm('Install this over your save file?\n\nYour current save is backed up first, '
    + `to ${CONFIG.backups}. melonDS must be closed.`)) return null;

  const res = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: out.bytes,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

  F.dirty = false;
  F.undoStack.length = 0;
  return `Installed. Your previous save was backed up as ${body.backup_name}. `
    + 'Boot with Continue, NOT a savestate — a savestate carries its own copy of '
    + 'cartridge RAM and silently undoes the edit.';
}

/** Hand the bytes to the browser. The user places the file themselves. */
export function downloadSave(F) {
  const out = F.output();
  if (!out.ok) throw new Error(`Refusing to download — ${out.problems.join('; ')}`);
  const name = `pokemon_blaze_black.edited-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.sav`;
  const url = URL.createObjectURL(new Blob([out.bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return `Saved ${name}. Close melonDS first — it rewrites the .sav on exit and will `
    + 'overwrite this — then put the file in place under the original filename and boot '
    + 'with Continue, not a savestate.';
}

/** True when there is something worth installing and it verifies. */
export function stagedAndValid(F) {
  return !!F && F.dirty && F.output().ok;
}

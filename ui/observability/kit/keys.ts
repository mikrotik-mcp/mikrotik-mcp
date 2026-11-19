/**
 * True when a key event is the letter `letter`, on any keyboard layout. With a
 * Persian, Arabic or Russian layout `event.key` is that layout's letter, so a
 * shortcut that reads only `key` never fires. `code` names the physical key.
 */
export function isLetterKey(event: { key: string; code?: string }, letter: string): boolean {
  return (
    event.key.toLowerCase() === letter.toLowerCase() || event.code === `Key${letter.toUpperCase()}`
  );
}

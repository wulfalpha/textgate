// Zettelkasten note IDs: YYYYMMDDHHMM in local time. Rust picks the first
// candidate no note already carries, so a busy minute moves to the next one.
const pad = (value) => String(value).padStart(2, '0');
export function noteId(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}
export function noteIdCandidates(now = new Date(), count = 60) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  const ids = [];
  for (let minute = 0; ids.length < count && minute < count * 2; minute++) {
    const id = noteId(new Date(start.getTime() + minute * 60_000));
    // A clock change can repeat a local minute; skip duplicates.
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

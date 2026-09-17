/** hand a piece of text to the browser as a file, without a round trip */
export function downloadText(
  filename: string,
  text: string,
  type = 'application/json',
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // after the click has been handled, not during it
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** a bridge's name as a file name: nothing a file system or a shell would mind */
export function fileSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'bridge';
}

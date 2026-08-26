/**
 * A first install, shown as the terminal transcript it actually produces.
 * Every line below is the real output of install.sh and the syncle
 * launcher, verbatim — if the scripts change their wording, this should
 * change with them. Output only: it renders directly beneath the copyable
 * install command, which plays the part of the `$` line.
 *
 * Static markup, no animation: it is a quotation, not a demo.
 */

/** `arrow` lines carry the installer's real cyan `==>` prefix */
const LINES: { text: string; arrow?: boolean }[] = [
  { text: 'Installing Syncle v1.0.0', arrow: true },
  { text: 'Generating an encryption key', arrow: true },
  { text: 'Installed launcher at /usr/local/bin/syncle', arrow: true },
  { text: 'Downloading images (first run takes a minute)...' },
  { text: 'Waiting for the web GUI...... ready.' },
  { text: '' },
  { text: 'First run — the setup form is prefilled in your browser.' },
];

export function InstallTranscript() {
  return (
    <div className="rounded-md border bg-muted/40 px-5 py-4 font-mono text-[13px] leading-[1.8]">
      {LINES.map((line, i) => (
        <p key={i} className="text-muted-foreground">
          {line.arrow && <span className="text-cyan-700">{'==> '}</span>}
          {line.text || ' '}
        </p>
      ))}
    </div>
  );
}

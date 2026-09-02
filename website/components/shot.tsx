/**
 * A screenshot or the demo recording, set the way everything else on this
 * site is set: the thing itself, a hairline around it so it does not bleed
 * into the page, and a line of small type saying what you are looking at.
 *
 * Plain <img> rather than next/image — the site is a static export, the
 * files are already sized for the column, and this keeps the markup honest.
 */
export function Shot({
  src,
  alt,
  caption,
  width = 3200,
  height = 2000,
}: {
  src: string;
  alt: string;
  caption: React.ReactNode;
  width?: number;
  height?: number;
}) {
  return (
    <figure className="mt-6">
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        className="w-full rounded border"
      />
      <figcaption className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

/**
 * The walkthrough. Muted and loopable so it can play without asking, with
 * controls for anyone who wants to scrub it, and `playsInline` so phones do
 * not hijack it into fullscreen.
 */
export function DemoVideo({ caption }: { caption: React.ReactNode }) {
  return (
    <figure className="mt-6">
      <video
        src="/media/syncle-demo.mp4"
        poster="/media/demo-poster.png"
        controls
        muted
        loop
        playsInline
        preload="metadata"
        className="w-full rounded border"
      >
        Your browser cannot play this video.{' '}
        <a href="/media/syncle-demo.mp4">Download it instead.</a>
      </video>
      <figcaption className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

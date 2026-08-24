import Image from 'next/image';

/**
 * The real Syncle lockup, straight from the app's assets.
 *
 * Two files rather than one: the artwork is solid black and solid white, so
 * neither survives both themes. They are both rendered and swapped with CSS —
 * the same approach the app itself uses — which keeps it working without
 * JavaScript and avoids a flash on first paint.
 */
export function Logo({
  className = 'h-9 w-auto',
  priority = false,
}: {
  className?: string;
  /** only the header instance is above the fold */
  priority?: boolean;
}) {
  return (
    <>
      <Image
        src="/logo-dark.png"
        alt="Syncle"
        width={747}
        height={412}
        priority={priority}
        className={`${className} dark:hidden`}
      />
      <Image
        src="/logo-white.png"
        alt="Syncle"
        width={747}
        height={412}
        priority={priority}
        className={`${className} hidden dark:block`}
      />
    </>
  );
}

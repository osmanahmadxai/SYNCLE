import Image from 'next/image';

/**
 * The real Syncle lockup, straight from the app's assets.
 *
 * Two files rather than one: the artwork is solid black and solid white, so
 * neither survives both themes. They are both rendered and swapped with CSS —
 * the same approach the app itself uses — which keeps it working without
 * JavaScript and avoids a flash on first paint.
 */
export function Logo({ className = 'h-9 w-auto' }: { className?: string }) {
  return (
    <>
      <Image
        src="/logo-dark.png"
        alt="Syncle"
        width={747}
        height={412}
        priority
        className={`${className} dark:hidden`}
      />
      <Image
        src="/logo-white.png"
        alt="Syncle"
        width={747}
        height={412}
        priority
        className={`${className} hidden dark:block`}
      />
    </>
  );
}

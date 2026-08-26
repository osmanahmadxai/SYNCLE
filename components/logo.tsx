import Image from 'next/image';

/**
 * The real Syncle lockup, straight from the app's assets — the solid black
 * artwork, which is the one that reads on paper.
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
    <Image
      src="/logo-dark.png"
      alt="Syncle"
      width={747}
      height={412}
      priority={priority}
      className={className}
    />
  );
}

/**
 * The site has one measure, and everything sits inside it: the header, the
 * page, the footer. Kept here so the three never drift apart.
 *
 * Written as literal class strings because Tailwind reads the source for
 * them — they cannot be composed at runtime.
 */

/** every page but the docs: one column of text */
export const MEASURE = 'max-w-[56rem]';

/** the docs, which carry a page list beside the article */
export const WIDE_MEASURE = 'max-w-[72rem]';

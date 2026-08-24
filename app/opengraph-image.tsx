import { ImageResponse } from 'next/og';

/**
 * The card that shows when syncle.dev is pasted into Slack, Discord, X or
 * LinkedIn. Generated at build time, so the static export ships a real PNG and
 * there is no runtime to render it on demand.
 *
 * Drawn rather than photographed: greyscale only, matching the site.
 */
// required under `output: 'export'` — renders once at build into a real PNG
export const dynamic = 'force-static';

export const alt =
  'Syncle — keep any databases in sync, live, across engines';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0a0a0a',
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              width: 14,
              height: 14,
              borderRadius: 7,
              background: '#fafafa',
            }}
          />
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              color: '#a1a1a1',
              letterSpacing: 2,
            }}
          >
            SYNCLE
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 82,
              lineHeight: 1.05,
              color: '#fafafa',
              letterSpacing: -2.5,
              maxWidth: 940,
            }}
          >
            Keep any databases in sync, live, across engines
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 30,
              fontSize: 30,
              color: '#a1a1a1',
            }}
          >
            PostgreSQL · MySQL · SQLite · MongoDB · Redis
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            border: '1px solid #2a2a2a',
            borderRadius: 14,
            padding: '20px 26px',
            background: '#111111',
          }}
        >
          <div style={{ display: 'flex', fontSize: 26, color: '#6b6b6b' }}>$</div>
          <div style={{ display: 'flex', fontSize: 26, color: '#e6e6e6' }}>
            curl -fsSL https://syncle.dev/install | sh -s -- up
          </div>
        </div>
      </div>
    ),
    size,
  );
}

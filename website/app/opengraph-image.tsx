import { ImageResponse } from 'next/og';

/**
 * The card that shows when syncle.dev is pasted into Slack, Discord, X or
 * LinkedIn. Generated at build time, so the static export ships a real PNG
 * and there is no runtime to render it on demand.
 *
 * Same palette as the site: white, ink, and the one link blue.
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
          background: '#ffffff',
          padding: '72px 80px',
          fontFamily: 'serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              width: 14,
              height: 14,
              borderRadius: 7,
              background: '#262626',
            }}
          />
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              color: '#6b6b6b',
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
              color: '#262626',
              letterSpacing: -1.5,
              maxWidth: 980,
            }}
          >
            Keep any databases in sync, live, across engines
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 30,
              fontSize: 30,
              color: '#6b6b6b',
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
            border: '1px solid #e5e5e5',
            borderRadius: 10,
            padding: '20px 26px',
            background: '#f6f6f6',
            fontFamily: 'monospace',
          }}
        >
          <div style={{ display: 'flex', fontSize: 26, color: '#9a9a9a' }}>$</div>
          <div style={{ display: 'flex', fontSize: 26, color: '#262626' }}>
            curl -fsSL https://syncle.dev/install | sh -s -- up
          </div>
        </div>
      </div>
    ),
    size,
  );
}

/**
 * Apple App Site Association for the partners iOS app.
 *
 * Served at https://partners.circls.app/.well-known/apple-app-site-association
 * (no extension, JSON body, no redirect). Apple's CDN fetches it when the
 * app is installed; it is the website's half of the two-way handshake behind
 * the app's `com.apple.developer.associated-domains` entitlement:
 *
 * - `webcredentials`: iOS Password AutoFill offers logins saved for this
 *   domain inside the app, and saves new ones from the app for the portal.
 * - `applinks`: universal links. Scoped to invitation links, the one portal
 *   URL the app has a route for (`/invite/:token`); every other portal page
 *   keeps opening in the browser.
 *
 * A route handler rather than a `public/` file because the standalone
 * Docker image does not copy `public/`, and this way the content type is
 * guaranteed. Served as static output: nothing here varies per request.
 */

export const dynamic = 'force-static';

/** Apple Developer Team IDs the app has shipped under. PBAYD5CXP4 (Gibbous
 * Technologies) signs every build since the App Store record was transferred
 * to it (circls-flutter `docs/STORE_RELEASE.md`). AQQHT55AT9, a personal
 * team, signed the earlier TestFlight builds, and those stay installed until
 * testers update — keep it until none do. Apple ignores an entry whose team
 * does not match the installed app, so listing both is harmless; dropping
 * PBAYD5CXP4 would break Password AutoFill and invite links for every
 * current build. */
const TEAM_IDS = ['AQQHT55AT9', 'PBAYD5CXP4'];
const BUNDLE_ID = 'com.circls.circlsPartners';

const appIds = TEAM_IDS.map((team) => `${team}.${BUNDLE_ID}`);

export function GET(): Response {
  const body = {
    applinks: {
      details: [
        {
          appIDs: appIds,
          components: [{ '/': '/invite/*', comment: 'Staff invitation links open in the app' }],
        },
      ],
    },
    webcredentials: { apps: appIds },
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

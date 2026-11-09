import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/invite/accept',
];

const PUBLIC_API_PREFIXES = [
  '/api/auth/login',
  '/api/auth/password/reset/request',
  '/api/auth/password/reset/confirm',
  '/api/invitations',
  '/api/health',
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  if (PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  return false;
}

const SESSION_COOKIE = 'sutura_session';

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  // Treat an empty-string cookie value (e.g. a half-cleared session) as no
  // session so a stale `sutura_session=` doesn't keep slipping past the gate.
  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value;

  // Pass the path down to RSC so requireAuthOrRedirect can build a sane
  // `?next=` redirect target without re-parsing the URL.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', pathname);

  if (isPublic(pathname)) {
    // If already logged in, bounce away from /login.
    if (pathname === '/login' && hasSession) {
      return NextResponse.redirect(new URL('/', req.url));
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (!hasSession) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Note: we deliberately don't validate the cookie against the DB here.
  // Edge middleware can't talk to Postgres; we let the route handler /
  // server component do that. Middleware only enforces "cookie present
  // for protected paths".
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    // Skip Next internals and static assets; enforce on everything else.
    '/((?!_next/static|_next/image|favicon.svg|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)).*)',
  ],
};

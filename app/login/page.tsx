import LoginForm from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; err?: string }>;
}) {
  // Next 15: searchParams is a Promise. Resolve inline for the client form.
  return <LoginPageInner searchParams={searchParams} />;
}

async function LoginPageInner({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; err?: string }>;
}) {
  const sp = await searchParams;
  return <LoginForm next={sp.next ?? '/'} error={sp.err ? decodeURIComponent(sp.err) : null} />;
}

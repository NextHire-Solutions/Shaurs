import { NextRequest, NextResponse } from 'next/server';
import { requireWrite } from '@/lib/route-auth';
import { applyToggle, planToggle, type ToggleAction } from '@/lib/campaign-toggle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Play/Pause all of one client's campaigns.
//
//   GET  ?clientId=…&action=pause|resume   preview: live statuses, what would
//                                          change and what would be skipped.
//                                          Sends nothing to any platform.
//   POST { clientId, action }              apply. Re-plans from live statuses.
//
// Both require a signed-in team member (requireWrite): even the preview
// reveals campaign state, and the read-only machine token must never be able
// to stop or start sending.

function parseAction(v: unknown): ToggleAction | null {
  return v === 'pause' || v === 'resume' ? v : null;
}

export async function GET(req: NextRequest) {
  const denied = await requireWrite(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const action = parseAction(url.searchParams.get('action'));
  if (!clientId || !action) {
    return NextResponse.json({ error: 'clientId and action=pause|resume required' }, { status: 400 });
  }
  try {
    return NextResponse.json({ plan: await planToggle(clientId, action) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireWrite(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { clientId?: string; action?: unknown };
  const action = parseAction(body.action);
  if (!body.clientId || !action) {
    return NextResponse.json({ error: 'clientId and action=pause|resume required' }, { status: 400 });
  }
  try {
    const result = await applyToggle(body.clientId, action, req.headers.get('x-bs-user'));
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}

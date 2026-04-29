// app/api/cron/scout-trigger/route.ts
// Lightweight trigger endpoint for external cron services (cron-job.org, UptimeRobot, etc.)
// Calls the main scout-run endpoint internally.
// Usage: GET /api/cron/scout-trigger?key=YOUR_CRON_SECRET

import { NextResponse } from "next/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  if (!key || key !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Call the main scout-run endpoint
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL 
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  try {
    const res = await fetch(`${baseUrl}/api/cron/scout-run`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const data = await res.json();
    return NextResponse.json({ triggered: true, result: data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

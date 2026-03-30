import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, upsertIntegration, encrypt } from "@agents/db";
import { cookies } from "next/headers";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const storedState = cookieStore.get("google_oauth_state")?.value;
  cookieStore.delete("google_oauth_state");

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(`${origin}/settings?error=google_oauth_failed`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const redirectUri = `${origin}/api/google/callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return NextResponse.redirect(`${origin}/settings?error=google_token_failed`);
  }

  const tokenBlob = JSON.stringify({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
  });

  const encryptedToken = encrypt(tokenBlob);
  const scopes = tokenData.scope
    ? tokenData.scope.split(" ")
    : ["https://www.googleapis.com/auth/gmail.readonly"];

  const db = createServerClient();
  await upsertIntegration(db, user.id, "google", scopes, encryptedToken);

  return NextResponse.redirect(`${origin}/settings?google=connected`);
}

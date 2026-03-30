import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, upsertIntegration, encrypt } from "@agents/db";
import { cookies } from "next/headers";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? "";
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? "";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const storedState = cookieStore.get("github_oauth_state")?.value;
  cookieStore.delete("github_oauth_state");

  if (!code || !state || state !== storedState) {
    return NextResponse.redirect(`${origin}/settings?error=github_oauth_failed`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return NextResponse.redirect(`${origin}/settings?error=github_token_failed`);
  }

  const encryptedToken = encrypt(tokenData.access_token);
  const scopes = tokenData.scope ? tokenData.scope.split(",") : ["repo"];

  const db = createServerClient();
  await upsertIntegration(db, user.id, "github", scopes, encryptedToken);

  return NextResponse.redirect(`${origin}/settings?github=connected`);
}

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const respond = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map((part) => parseInt(part, 16)));
}
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "method_not_allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const encryptionKeyHex = Deno.env.get("ORDER_CREDENTIALS_ENCRYPTION_KEY") || "";
    if (!url || !serviceKey || !/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
      return respond({ success: false, error: "server_not_configured" }, 500);
    }

    const body = await req.json();
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const orderId = typeof body.order_id === "string" ? body.order_id : "";
    const gameNickname = typeof body.game_nickname === "string" ? body.game_nickname.trim().slice(0, 100) : "";
    const loginMethod = typeof body.login_method === "string" ? body.login_method.trim().slice(0, 60) : "";
    const account = typeof body.account === "string" ? body.account.trim().slice(0, 200) : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 500) : "";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

    if (!accessToken || !orderId || !gameNickname || !loginMethod || !account || !password) {
      return respond({ success: false, error: "required_fields_missing" }, 400);
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) return respond({ success: false, error: "line_authentication_failed" }, 401);
    const profile = await profileResponse.json();
    if (typeof profile.userId !== "string" || !profile.userId) {
      return respond({ success: false, error: "line_user_not_found" }, 401);
    }

    const db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: customer, error: customerError } = await db
      .from("customers").select("id").eq("line_user_id", profile.userId).maybeSingle();
    if (customerError) throw customerError;
    if (!customer?.id) return respond({ success: false, error: "member_record_not_found" }, 404);

    const { data: order, error: orderError } = await db
      .from("sk_orders").select("id,customer_id,order_number,payment_status")
      .eq("id", orderId).eq("customer_id", customer.id).maybeSingle();
    if (orderError) throw orderError;
    if (!order) return respond({ success: false, error: "order_not_found_or_not_owned" }, 404);
    // Customers may submit credentials after making payment; admin receipt confirmation remains required before processing.

    const payload = JSON.stringify({ game_nickname: gameNickname, login_method: loginMethod, account, password, note });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", hexToBytes(encryptionKeyHex), { name: "AES-GCM" }, false, ["encrypt"]);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(payload)));
    const { error: saveError } = await db.from("sk_order_credentials").upsert({
      order_id: order.id,
      customer_id: customer.id,
      encrypted_payload: toBase64(encrypted),
      iv: toBase64(iv),
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "order_id" });
    if (saveError) throw saveError;

    return respond({ success: true, data: { order_number: order.order_number, submitted: true } });
  } catch (error) {
    console.error("submit-order-credentials error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

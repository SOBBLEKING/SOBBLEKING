import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const allowedBanks = ["國泰世華（013）", "台新銀行（812）", "郵局（700）", "中國信託（822）"];
const allowedMethods = ["無卡存款", "銀行匯款", "LINE Pay"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return respond({ success: false, error: "server_not_configured" }, 500);

    const body = await req.json();
    if (body.action === "preview_campaigns") {
      const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: campaigns, error: campaignError } = await admin.from("sk_topup_campaigns").select("name,min_amount,bonus_amount,starts_at,ends_at").eq("is_active", true).order("min_amount", { ascending: true });
      if (campaignError) throw campaignError;
      const now = Date.now();
      const active = (campaigns || []).filter((c: any) => (!c.starts_at || new Date(c.starts_at).getTime() <= now) && (!c.ends_at || new Date(c.ends_at).getTime() > now));
      return respond({ success: true, campaigns: active });
    }
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const amount = Number(body.amount);
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method : "";
    const paymentBank = typeof body.payment_bank === "string" ? body.payment_bank : "";
    const clientRequestId = typeof body.client_request_id === "string" ? body.client_request_id : "";

    if (!accessToken || !Number.isSafeInteger(amount) || amount < 500 || amount % 500 !== 0) {
      return respond({ success: false, error: "invalid_topup_amount" }, 400);
    }
    if (!allowedMethods.includes(paymentMethod)) return respond({ success: false, error: "invalid_payment_method" }, 400);
    if (paymentMethod === "無卡存款" && !allowedBanks.includes(paymentBank)) {
      return respond({ success: false, error: "invalid_payment_bank" }, 400);
    }
    if (paymentMethod !== "無卡存款" && paymentBank !== "") {
      return respond({ success: false, error: "unexpected_payment_bank" }, 400);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientRequestId)) {
      return respond({ success: false, error: "invalid_request_id" }, 400);
    }

    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) return respond({ success: false, error: "line_authentication_failed" }, 401);
    const profile = await profileResponse.json();
    if (typeof profile.userId !== "string" || !profile.userId) return respond({ success: false, error: "line_user_not_found" }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: customer, error: customerError } = await admin
      .from("customers").select("id").eq("line_user_id", profile.userId).maybeSingle();
    if (customerError) throw customerError;
    if (!customer?.id) return respond({ success: false, error: "member_record_not_found" }, 404);

    const { data: inserted, error: insertError } = await admin
      .from("sk_wallet_topup_requests")
      .insert({
        customer_id: customer.id,
        amount,
        payment_method: paymentMethod,
        payment_bank: paymentMethod === "無卡存款" ? paymentBank : "",
        client_request_id: clientRequestId,
      })
      .select("id,amount,status,created_at")
      .single();

    if (insertError?.code === "23505") {
      const { data: existing, error: existingError } = await admin
        .from("sk_wallet_topup_requests")
        .select("id,amount,status,created_at,payment_method,payment_bank")
        .eq("customer_id", customer.id)
        .eq("client_request_id", clientRequestId)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing || Number(existing.amount) !== amount || existing.payment_method !== paymentMethod ||
          (existing.payment_bank || "") !== (paymentMethod === "無卡存款" ? paymentBank : "")) {
        return respond({ success: false, error: "request_id_conflict" }, 409);
      }
      return respond({
        success: true, request_id: existing.id, amount: existing.amount,
        status: existing.status, reused: true,
      });
    }
    if (insertError) throw insertError;

    return respond({
      success: true,
      request_id: inserted.id,
      amount: inserted.amount,
      status: inserted.status,
      reused: false,
    });
  } catch (error) {
    console.error("create-topup-request error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ success: false, error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return respond({ success: false, error: "server_not_configured" }, 500);
    }

    const body = await req.json();
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const items = body.items;
    const note = typeof body.note === "string" ? body.note.slice(0, 1000) : null;
    const clientRequestId = typeof body.client_request_id === "string"
      ? body.client_request_id
      : "";
    if (!accessToken || !Array.isArray(items) || items.length === 0 || !clientRequestId) {
      return respond({ success: false, error: "invalid_request" }, 400);
    }

    // Verify the LINE access token with LINE itself; never trust a customer_id sent by the browser.
    const profileResponse = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) {
      return respond({ success: false, error: "line_authentication_failed" }, 401);
    }
    const profile = await profileResponse.json();
    if (typeof profile.userId !== "string" || !profile.userId) {
      return respond({ success: false, error: "line_user_not_found" }, 401);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: customer, error: customerError } = await admin
      .from("customers")
      .select("id")
      .eq("line_user_id", profile.userId)
      .maybeSingle();

    if (customerError) throw customerError;
    if (!customer?.id) {
      return respond({ success: false, error: "member_record_not_found" }, 404);
    }

    const normalizedItems = items.map((item: any) => ({
      product_id: String(item?.product_id ?? ""),
      quantity: Number(item?.quantity),
    }));

    const { data, error } = await admin.rpc("sk_create_order", {
      p_customer_id: customer.id,
      p_items: normalizedItems,
      p_note: note,
      p_client_request_id: clientRequestId,
    });

    if (error) {
      console.error("sk_create_order failed:", error.message);
      return respond({ success: false, error: "order_creation_failed" }, 400);
    }

    const order = data as Record<string, unknown>;
    const orderId = typeof order.order_id === "string" ? order.order_id : "";
    const verificationCode = typeof order.verification_code === "string"
      ? order.verification_code
      : "";

    if (!orderId) return respond({ success: false, error: "order_id_missing" }, 500);

    return respond(order);
  } catch (error) {
    console.error("create-order error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

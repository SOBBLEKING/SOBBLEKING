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
    const orderNumber = typeof body.order_number === "string" ? body.order_number.trim().slice(0, 60) : "";
    if (!accessToken || !orderNumber) {
      return respond({ success: false, error: "missing_access_token_or_order_number" }, 400);
    }

    // Verify the LINE access token directly with LINE. Never trust a customer ID from the browser.
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
    if (!customer?.id) return respond({ success: false, error: "member_record_not_found" }, 404);

    // Match both the order number and verified LINE member. Do not disclose whether another member's order exists.
    const { data: order, error: orderError } = await admin
      .from("sk_orders")
      .select("order_number,total_amount,payment_status,order_status,payment_method,created_at,paid_at,wallet_amount_used,external_due")
      .eq("order_number", orderNumber)
      .eq("customer_id", customer.id)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return respond({ success: false, error: "order_not_found" }, 404);

    const { data: items, error: itemsError } = await admin
      .from("sk_order_items")
      .select("product_name,unit_price,quantity,subtotal")
      .eq("order_id", (await admin.from("sk_orders").select("id").eq("order_number", orderNumber).eq("customer_id", customer.id).single()).data?.id ?? "");
    if (itemsError) throw itemsError;

    return respond({ success: true, order, items: items ?? [] });
  } catch (error) {
    console.error("customer-order-lookup error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});
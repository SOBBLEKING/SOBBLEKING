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
    const customerNote = typeof body.note === "string" ? body.note.slice(0, 900) : "";
    const paymentMethod = typeof body.payment_method === "string" ? body.payment_method : "";
    const paymentBank = typeof body.payment_bank === "string" ? body.payment_bank : "";
    const allowedMethods = ["無卡存款", "銀行匯款", "LINE Pay"];
    if (!allowedMethods.includes(paymentMethod)) {
      return respond({ success: false, error: "invalid_payment_method" }, 400);
    }
    if (paymentMethod === "無卡存款" && !["國泰世華（013）", "台新銀行（812）", "郵局（700）", "中國信託（822）"].includes(paymentBank)) {
      return respond({ success: false, error: "invalid_payment_bank" }, 400);
    }
    const note = [`付款方式：${paymentMethod}`, paymentBank ? `無卡存款銀行：${paymentBank}` : "", customerNote].filter(Boolean).join("\n");
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
      .select("*")
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
      p_payment_method: paymentMethod,
      p_payment_bank: paymentMethod === "無卡存款" ? paymentBank : "",
    });

    if (error) {
      // Return a safe diagnostic code so the storefront can show the actual database failure.
      // Keep raw database details in server logs only.
      console.error("sk_create_order failed:", error.message, error.code, error.details, error.hint);
      const diagnostic = [error.message, error.code, error.details, error.hint]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 1200);
      return respond({
        success: false,
        error: "order_creation_failed",
        diagnostic,
      }, 400);
    }

    const order = data as Record<string, unknown>;
    const orderId = typeof order.order_id === "string" ? order.order_id : "";
    const verificationCode = typeof order.verification_code === "string"
      ? order.verification_code
      : "";

    if (!orderId) return respond({ success: false, error: "order_id_missing" }, 500);

    // Notify the administrator only for a newly created order, never for an idempotent retry.
    const emailEndpoint = Deno.env.get("ADMIN_ORDER_EMAIL_URL");
    const emailToken = Deno.env.get("ADMIN_ORDER_EMAIL_TOKEN");
    if (emailEndpoint && emailToken && order.reused !== true) {
      try {
        const [{ data: savedOrder }, { data: savedItems }] = await Promise.all([
          admin.from("sk_orders")
            .select("order_number,total_amount,created_at,note,customer_id")
            .eq("id", orderId)
            .maybeSingle(),
          admin.from("sk_order_items")
            .select("product_name,unit_price,quantity,subtotal")
            .eq("order_id", orderId),
        ]);

        const customerInfo: Record<string, unknown> = {};
        const customerFields = ["name", "display_name", "line_display_name", "customer_name", "phone", "customer_code", "member_code", "member_number"];
        for (const field of customerFields) {
          const value = customer[field];
          if (typeof value === "string" && value.trim()) customerInfo[field] = value;
        }

        const emailResponse = await fetch(emailEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: emailToken,
            order: savedOrder ?? order,
            items: savedItems ?? [],
            customer: customerInfo,
            paymentMethod,
            paymentBank,
            verificationCode,
          }),
        });
        const emailResult = (await emailResponse.text()).trim();
        if (!emailResponse.ok || emailResult !== "ok") {
          console.error("Admin order email failed:", emailResponse.status, emailResult);
        }
      } catch (emailError) {
        // Email failure must not undo a successfully created order.
        console.error("Admin order email error:", emailError);
      }
    }
    // LINE push notification is independent of email. Configure LINE_CHANNEL_ACCESS_TOKEN
    // and ADMIN_LINE_USER_ID as Supabase secrets. Notification failure never rolls back an order.
    const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
    const adminLineUserId = Deno.env.get("ADMIN_LINE_USER_ID");
    if (lineToken && adminLineUserId && order.reused !== true) {
      try {
        const { data: lineOrder } = await admin.from("sk_orders")
          .select("order_number,total_amount,created_at")
          .eq("id", orderId).maybeSingle();
        const lineText = [
          "🛎️ SOBBLEKING 新訂單成立",
          "訂單編號：" + String(lineOrder?.order_number || order.order_number || orderId),
          "訂單金額：NT$" + Number(lineOrder?.total_amount ?? order.total_amount ?? 0).toLocaleString("zh-TW"),
          "付款方式：" + paymentMethod + (paymentBank ? "（" + paymentBank + "）" : ""),
          "請登入管理後台確認訂單。"
        ].join("\n");
        const lineResponse = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: {"Content-Type":"application/json","Authorization":"Bearer " + lineToken},
          body: JSON.stringify({to:adminLineUserId,messages:[{type:"text",text:lineText}]})
        });
        if (!lineResponse.ok) console.error("Admin LINE push failed:",lineResponse.status,(await lineResponse.text()).slice(0,500));
      } catch (lineError) {
        console.error("Admin LINE push error:",lineError);
      }
    }

    return respond(order);
  } catch (error) {
    console.error("create-order error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

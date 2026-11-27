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
      p_use_wallet: body.use_wallet !== false,
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
    const effectivePaymentMethod = typeof order.payment_method === "string" ? order.payment_method : paymentMethod;
    const walletAmountUsed = Number(order.wallet_amount_used ?? 0);
    const externalDue = Number(order.external_due ?? order.total_amount ?? 0);
    const effectivePaymentBank = effectivePaymentMethod === "無卡存款" ? paymentBank : "";

    if (!orderId) return respond({ success: false, error: "order_id_missing" }, 500);

    // Send a Resend email to the administrator only for a newly created order.
    // Email failure must never undo a successfully created order.
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (resendApiKey && order.reused !== true) {
      try {
        const [{ data: savedOrder }, { data: savedItems }] = await Promise.all([
          admin.from("sk_orders")
            .select("order_number,total_amount,created_at,note")
            .eq("id", orderId)
            .maybeSingle(),
          admin.from("sk_order_items")
            .select("product_name,unit_price,quantity,subtotal")
            .eq("order_id", orderId),
        ]);

        const orderData = savedOrder ?? order;
        const orderNumber = String(orderData.order_number ?? orderId);
        const customerName = String(
          customer.display_name ?? customer.line_display_name ?? customer.name ?? profile.displayName ?? "LINE 會員"
        );
        const escapeHtml = (value: unknown) => String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
        const money = (value: unknown) => `NT$ ${Number(value ?? 0).toLocaleString("zh-TW")}`;
        const itemRows = (savedItems ?? []).map((item: any) =>
          `<tr><td style="padding:8px;border-bottom:1px solid #eee;">${escapeHtml(item.product_name)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${escapeHtml(item.quantity)}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${money(item.subtotal)}</td></tr>`
        ).join("");
        const noteText = String(orderData.note ?? "");
        const html = `
          <div style="font-family:Arial,'Noto Sans TC',sans-serif;color:#222;max-width:640px;margin:auto;">
            <h2 style="color:#245b52;">SOBBLEKING｜收到新訂單</h2>
            <p>網站剛收到一筆新訂單，請登入管理後台確認付款與訂單資料。</p>
            <p><strong>訂單編號：</strong>${escapeHtml(orderNumber)}<br>
            <strong>會員：</strong>${escapeHtml(customerName)}<br>
            <strong>建立時間：</strong>${escapeHtml(orderData.created_at ?? new Date().toISOString())}<br>
            <strong>付款方式：</strong>${escapeHtml(effectivePaymentMethod)}<br>
            ${effectivePaymentBank ? `<strong>存款銀行：</strong>${escapeHtml(effectivePaymentBank)}<br>` : ""}
            <strong>訂單總額：</strong>${money(orderData.total_amount)}<br>
            <strong>會員錢包折抵：</strong>${money(walletAmountUsed)}<br>
            <strong>尚需付款：</strong>${money(externalDue)}</p>
            <h3>商品明細</h3>
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr><th style="text-align:left;padding:8px;">商品</th><th style="padding:8px;">數量</th><th style="text-align:right;padding:8px;">小計</th></tr></thead>
              <tbody>${itemRows || '<tr><td colspan="3" style="padding:8px;">無商品明細</td></tr>'}</tbody>
            </table>
            ${noteText ? `<p><strong>訂單備註：</strong><br>${escapeHtml(noteText).replaceAll("\\n", "<br>")}</p>` : ""}
            <p style="margin-top:24px;"><a href="https://sobbleking-admin.vercel.app/" style="color:#245b52;">開啟 SOBBLEKING 管理後台</a></p>
          </div>`;

        const emailResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "SOBBLEKING <onboarding@resend.dev>",
            to: ["sobblekinggg@gmail.com"],
            subject: `【SOBBLEKING】新訂單通知｜${orderNumber}`,
            html,
          }),
        });
        const emailResult = await emailResponse.text();
        if (!emailResponse.ok) {
          console.error("Resend admin order email failed:", emailResponse.status, emailResult);
        } else {
          console.log("Resend admin order email sent:", emailResult);
        }
      } catch (emailError) {
        console.error("Resend admin order email error:", emailError);
      }
    } else if (!resendApiKey) {
      console.warn("RESEND_API_KEY is not configured; admin order email was skipped.");
    }
    // Routine new-order alerts use email and the admin dashboard; preserve LINE push quota.

    return respond(order);
  } catch (error) {
    console.error("create-order error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

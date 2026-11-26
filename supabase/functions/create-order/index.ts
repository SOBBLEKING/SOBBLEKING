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
    const customerEmail = typeof body.customer_email === "string"
      ? body.customer_email.trim().toLowerCase()
      : "";

    if (!accessToken || !Array.isArray(items) || items.length === 0 || !clientRequestId ||
        !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(customerEmail)) {
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

    const { error: emailSaveError } = await admin
      .from("sk_orders")
      .update({ customer_email: customerEmail })
      .eq("id", orderId);
    if (emailSaveError) {
      console.error("Could not save customer email:", emailSaveError.message);
      return respond({ ...order, email_notifications_sent: false }, 200);
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const sender = Deno.env.get("ORDER_EMAIL_FROM") || "SOBBLEKING <orders@resend.dev>";
    let emailNotificationsSent = false;

    if (resendApiKey && verificationCode) {
      const amount = Number(order.total_amount).toLocaleString("en-US");
      const subject = `SOBBLEKING 訂單成立通知｜${String(order.order_number || "")}`;
      const html = `
        <div style="font-family:Arial,'Noto Sans TC',sans-serif;max-width:600px;margin:auto;padding:28px;color:#315F85;background:#F5FAFE;border-radius:18px">
          <h2 style="margin:0 0 18px">SOBBLEKING 訂單成立通知</h2>
          <p>你的訂單已成功建立，請保存以下資料。</p>
          <div style="background:#fff;padding:20px;border-radius:14px;line-height:2">
            <p><b>訂單編號：</b>${String(order.order_number || "")}</p>
            <p><b>訂單金額：</b>NT${amount}</p>
            <p><b>驗證碼：</b><span style="font-size:24px;font-weight:bold;letter-spacing:3px">${verificationCode}</span></p>
          </div>
          <p>後續請依客服指示完成付款與資料確認。此通知不代表已完成付款。</p>
          <p style="color:#8299AD;font-size:12px">SOBBLE PARADISE｜SOBBLEKING</p>
        </div>`;
      const recipients = [customerEmail, "sobblekinggg@gmail.com"];
      const sendResults = await Promise.all(recipients.map(async (to) => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ from: sender, to: [to], subject, html }),
        });
        if (!response.ok) {
          console.error("Order email failed for recipient:", to, await response.text());
          return false;
        }
        return true;
      }));
      emailNotificationsSent = sendResults.every(Boolean);
    } else {
      console.error("Email not sent: RESEND_API_KEY or verification code is missing.");
    }

    return respond({ ...order, email_notifications_sent: emailNotificationsSent });
  } catch (error) {
    console.error("create-order error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

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
    if (body.action === "lookup_request") {
      const lookupToken = typeof body.access_token === "string" ? body.access_token : "";
      const requestId = typeof body.request_id === "string" ? body.request_id.trim().toUpperCase() : "";
      const isShortCode = /^SKT[0-9A-F]{8}$/.test(requestId);
      const isUuid = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(requestId);
      if (!lookupToken) return respond({ success: false, error: "line_authentication_failed" }, 401);
      if (!isShortCode && !isUuid) return respond({ success: false, error: "invalid_request_id" }, 400);
      const profileResponse = await fetch("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${lookupToken}` } });
      if (!profileResponse.ok) return respond({ success: false, error: "line_authentication_failed" }, 401);
      const profile = await profileResponse.json();
      if (typeof profile.userId !== "string" || !profile.userId) return respond({ success: false, error: "line_user_not_found" }, 401);
      const lookupAdmin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: lookupCustomer, error: lookupCustomerError } = await lookupAdmin.from("customers").select("id,member_code").eq("line_user_id", profile.userId).maybeSingle();
      if (lookupCustomerError) throw lookupCustomerError;
      if (!lookupCustomer?.id) return respond({ success: false, error: "member_record_not_found" }, 404);
      let requestQuery = lookupAdmin.from("sk_wallet_topup_requests")
        .select("id,amount,payment_method,payment_bank,status,created_at,updated_at,confirmed_at")
        .eq("customer_id", lookupCustomer.id);
      requestQuery = isShortCode
        ? requestQuery.filter("id::text", "ilike", `${requestId.slice(3)}%`).limit(2)
        : requestQuery.eq("id", requestId).limit(1);
      const { data: requests, error: requestError } = await requestQuery;
      if (requestError) throw requestError;
      if ((requests || []).length > 1) return respond({ success: false, error: "topup_request_code_ambiguous" }, 409);
      const request = requests?.[0];
      if (!request) return respond({ success: false, error: "topup_request_not_found" }, 404);
      return respond({ success: true, request });
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
      .from("customers")
      .select("id,member_code")
      .eq("line_user_id", profile.userId).maybeSingle();
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

    // Notify the administrator only after a new pending request is committed.
    // Notification failure must never cancel the customer's valid top-up request.
    let adminNotification: Record<string, unknown> = { sent: false, error: "admin_notification_not_configured" };
    const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
    const adminLineUserId = Deno.env.get("ADMIN_LINE_USER_ID") || "";
    if (lineToken && adminLineUserId) {
      const money = (value: unknown) => "NT$" + Number(value || 0).toLocaleString("zh-TW");
      const memberName = String(customer.name || customer.display_name || customer.line_display_name || customer.customer_name || profile.displayName || "未命名會員");
      const message = [
        "🔔 SOBBLEKING｜收到會員卡儲值申請",
        "",
        "會員編號：" + String(customer.member_code || "尚未編號"),
        "會員名稱：" + memberName,
        "申請金額：" + money(inserted.amount),
        "付款方式：" + paymentMethod,
        ...(paymentMethod === "無卡存款" ? ["存款銀行：" + paymentBank] : []),
        "申請時間：" + new Date(inserted.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }),
        "申請單號：" + inserted.id,
        "目前狀態：待管理員確認",
        "",
        "請至 SOBBLEKING 管理後台確認款項；確認前不會增加會員錢包餘額。",
      ].join("\n");
      try {
        const lineResponse = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + lineToken },
          body: JSON.stringify({ to: adminLineUserId, messages: [{ type: "text", text: message }] }),
        });
        if (lineResponse.ok) {
          adminNotification = { sent: true, channel: "LINE" };
        } else {
          const detail = (await lineResponse.text()).slice(0, 500);
          console.error("Admin top-up LINE notification failed:", lineResponse.status, detail);
          adminNotification = { sent: false, channel: "LINE", error: "LINE HTTP " + lineResponse.status };
        }
      } catch (notifyError) {
        console.error("Admin top-up LINE notification error:", notifyError);
        adminNotification = { sent: false, channel: "LINE", error: "notification_failed" };
      }
    } else {
      console.error("Admin top-up notification secrets missing:", {
        lineTokenConfigured: Boolean(lineToken),
        adminLineUserConfigured: Boolean(adminLineUserId),
      });
    }

    // Send an email to the administrator after a new request is committed.
    // Match the working new-order notification: use the same Resend sender and admin recipient.
    const resendKey = Deno.env.get("RESEND_API_KEY") || "";
    const adminEmail = "sobblekinggg@gmail.com";
    const fromEmail = "SOBBLEKING <onboarding@resend.dev>";
    let emailNotification: Record<string, unknown> = {
      sent: false,
      error: "resend_api_key_missing",
    };
    if (resendKey) {
      const money = (value: unknown) => "NT$" + Number(value || 0).toLocaleString("zh-TW");
      const memberName = String(customer.name || customer.display_name || customer.line_display_name || customer.customer_name || profile.displayName || "未命名會員");
      const safe = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[char] || char));
      const createdAt = new Date(inserted.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      const details = [
        ["會員編號", customer.member_code || "尚未編號"],
        ["會員名稱", memberName],
        ["申請金額", money(inserted.amount)],
        ["付款方式", paymentMethod],
        ...(paymentMethod === "無卡存款" ? [["存款銀行", paymentBank]] : []),
        ["申請時間", createdAt],
        ["申請單號", inserted.id],
        ["目前狀態", "待管理員確認"],
      ];
      try {
        const emailResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + resendKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [adminEmail],
            subject: "【SOBBLEKING】收到新的會員卡儲值申請",
            html: "<div style='font-family:Arial,sans-serif;line-height:1.8;color:#253b49'><h2>🔔 收到會員卡儲值申請</h2><table style='border-collapse:collapse'>" +
              details.map(([label, value]) => "<tr><td style='padding:6px 14px 6px 0;color:#667985'>" + safe(label) + "</td><td style='padding:6px 0;font-weight:600'>" + safe(value) + "</td></tr>").join("") +
              "</table><p style='margin-top:20px;color:#b45309'>請至 SOBBLEKING 管理後台確認實際款項。管理員確認前，不會增加會員錢包餘額。</p></div>",
          }),
        });
        if (emailResponse.ok) {
          emailNotification = { sent: true, channel: "Email" };
        } else {
          const detail = (await emailResponse.text()).slice(0, 500);
          console.error("Admin top-up email notification failed:", emailResponse.status, detail);
          emailNotification = { sent: false, channel: "Email", error: "Resend HTTP " + emailResponse.status };
        }
      } catch (notifyError) {
        console.error("Admin top-up email notification error:", notifyError);
        emailNotification = { sent: false, channel: "Email", error: "notification_failed" };
      }
    }

    return respond({
      success: true,
      request_id: inserted.id,
      amount: inserted.amount,
      status: inserted.status,
      reused: false,
      admin_notification: adminNotification,
      email_notification: emailNotification,
    });
  } catch (error) {
    console.error("create-topup-request error:", error);
    return respond({ success: false, error: "internal_server_error" }, 500);
  }
});

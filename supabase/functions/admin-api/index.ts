import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function attachMemberCodes(db: any, rows: any[]) {
  const ids = [...new Set((rows || []).map((row: any) => String(row.customer_id ?? row.id ?? "")).filter(Boolean))];
  if (!ids.length) return (rows || []).map((row: any) => ({ ...row, member_code: null }));
  const { data, error } = await db.from("customers").select("id,member_code").in("id", ids);
  if (error) throw error;
  const codes = new Map((data || []).map((row: any) => [String(row.id), row.member_code]));
  return (rows || []).map((row: any) => ({
    ...row,
    member_code: codes.get(String(row.customer_id ?? row.id ?? "")) ?? null,
  }));
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map((part) => parseInt(part, 16)));
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function sendTopupLineNotification(db: any, queueId: string) {
  const { data: item, error: readError } = await db.from("sk_line_notification_queue")
    .select("*").eq("id", queueId).maybeSingle();
  if (readError) throw readError;
  if (!item) throw new Error("notification_queue_item_not_found");
  if (item.status === "sent") return { sent: true, already_sent: true };
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
  if (!token) {
    await db.from("sk_line_notification_queue").update({
      status: "failed", attempts: Number(item.attempts || 0) + 1,
      last_error: "LINE_CHANNEL_ACCESS_TOKEN_missing",
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", queueId);
    return { sent: false, error: "LINE_CHANNEL_ACCESS_TOKEN_missing" };
  }
  if (!item.line_user_id) {
    await db.from("sk_line_notification_queue").update({
      status: "failed", attempts: Number(item.attempts || 0) + 1,
      last_error: "customer_line_user_id_missing", next_retry_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", queueId);
    return { sent: false, error: "customer_line_user_id_missing" };
  }
  const money = (n: unknown) => "NT$" + Number(n || 0).toLocaleString("zh-TW");
  const message = [
    "✅ SOBBLEKING 儲值成功通知",
    "",
    "儲值單號：" + item.request_id,
    "儲值金額：" + money(item.requested_amount),
    "額外入帳：" + money(Number(item.excess_amount || 0) + Number(item.bonus_amount || 0)),
    "本次入帳：" + money(item.wallet_credit),
    "目前餘額：" + money(item.balance_after),
    "",
    "感謝支持 SOBBLE PARADISE！",
  ].join("\n");
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify({ to: item.line_user_id, messages: [{ type: "text", text: message }] }),
  });
  const attempts = Number(item.attempts || 0) + 1;
  if (response.ok) {
    const { error } = await db.from("sk_line_notification_queue").update({
      status: "sent", attempts, last_error: null, sent_at: new Date().toISOString(),
      next_retry_at: null, updated_at: new Date().toISOString(),
    }).eq("id", queueId).neq("status", "sent");
    if (error) throw error;
    return { sent: true };
  }
  const raw = (await response.text()).slice(0, 1000);
  const monthlyLimitReached = response.status === 429 && raw.includes("You have reached your monthly limit");
  const retryMinutes = [1, 5, 15, 60, 360][Math.min(attempts - 1, 4)];
  await db.from("sk_line_notification_queue").update({
    status: "failed", attempts, last_error: "LINE HTTP " + response.status + ": " + raw,
    // A monthly quota failure cannot be fixed by retrying. Keep the event recorded without retrying until the next billing period.
    next_retry_at: monthlyLimitReached || attempts >= 5 ? null : new Date(Date.now() + retryMinutes * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", queueId).neq("status", "sent");
  return { sent: false, error: monthlyLimitReached ? "LINE monthly message limit reached; retry disabled" : "LINE HTTP " + response.status, attempts };
}

async function decryptOrderCredentials(encryptedPayload: string, ivBase64: string, keyHex: string) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivBase64) },
    key,
    fromBase64(encryptedPayload),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ success: false, error: "method_not_allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!url || !serviceKey || !token || token === authHeader) {
      return reply({ success: false, error: "unauthorized" }, 401);
    }

    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") || "", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    const user = authData?.user;
    if (authError || !user?.email) return reply({ success: false, error: "unauthorized" }, 401);

    const db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const email = user.email.toLowerCase();
    const { data: allowed, error: allowError } = await db
      .from("sk_admin_emails").select("email")
      .eq("email", email).eq("is_active", true).maybeSingle();
    if (allowError || !allowed) return reply({ success: false, error: "admin_not_allowed" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action : "";
    const limit = Math.min(100, Math.max(1, Number.isInteger(body.limit) ? body.limit : 50));

    if (action === "test_line") {
      const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN");
      const adminLineUserId = Deno.env.get("ADMIN_LINE_USER_ID");
      if (!lineToken || !adminLineUserId) {
        return reply({ success: false, error: "line_secrets_missing" }, 400);
      }
      const lineResponse = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + lineToken },
        body: JSON.stringify({
          to: adminLineUserId,
          messages: [{ type: "text", text: "✅ SOBBLEKING LINE 通知測試成功！新訂單成立時，系統會自動通知你。" }]
        })
      });
      if (!lineResponse.ok) {
        const raw = await lineResponse.text();
        let detail = "LINE API rejected the push request";
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.message === "string") detail = parsed.message;
          if (Array.isArray(parsed.details) && parsed.details.length) {
            detail += ": " + parsed.details.map((item: any) => [item.property, item.message].filter(Boolean).join(" ")).join("; ");
          }
        } catch { /* Keep generic message for non-JSON responses. */ }
        console.error("Admin LINE test push failed:", lineResponse.status, raw.slice(0, 500));
        return reply({ success: false, error: "line_push_failed: HTTP " + lineResponse.status + " - " + detail, status: lineResponse.status }, 502);
      }
      return reply({ success: true, data: { sent: true } });
    }


    if (action === "order_credentials") {
      const orderId = typeof body.order_id === "string" ? body.order_id : "";
      if (!orderId) return reply({ success: false, error: "order_id_required" }, 400);
      const encryptionKeyHex = Deno.env.get("ORDER_CREDENTIALS_ENCRYPTION_KEY") || "";
      if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
        return reply({ success: false, error: "credentials_encryption_key_missing" }, 503);
      }
      const { data: order, error: orderError } = await db.from("sk_orders")
        .select("id,order_number,customer_id,total_amount,wallet_amount_used,external_due,payment_method,payment_status,order_status,note,created_at,paid_at,received_amount,excess_amount,excess_wallet_credited")
        .eq("id", orderId).maybeSingle();
      if (orderError) throw orderError;
      if (!order) return reply({ success: false, error: "order_not_found" }, 404);
      const [{ data: credential, error: credentialError }, { data: items, error: itemsError }, { data: walletUse, error: walletUseError }, { data: walletAccount, error: walletAccountError }] = await Promise.all([
        db.from("sk_order_credentials").select("encrypted_payload,iv,submitted_at,updated_at").eq("order_id", orderId).maybeSingle(),
        db.from("sk_order_items").select("product_name,unit_price,quantity,subtotal").eq("order_id", orderId),
        db.from("sk_wallet_transactions").select("balance_before,balance_after,amount").eq("reference_id", orderId).eq("transaction_type", "purchase").maybeSingle(),
        db.from("sk_wallet_accounts").select("balance").eq("customer_id", order.customer_id).maybeSingle(),
      ]);
      if (credentialError) throw credentialError;
      if (itemsError) throw itemsError;
      if (walletUseError) throw walletUseError;
      if (walletAccountError) throw walletAccountError;
      let credentials = null;
      if (credential) {
        credentials = await decryptOrderCredentials(
          credential.encrypted_payload,
          credential.iv,
          encryptionKeyHex,
        );
        credentials.submitted_at = credential.submitted_at;
        credentials.updated_at = credential.updated_at;
        const { error: logError } = await db.from("sk_order_credential_access_logs").insert({
          order_id: orderId,
          admin_email: email,
        });
        if (logError) console.error("Credential access audit log failed:", logError.message);
      }
      const [orderWithMemberCode] = await attachMemberCodes(db, [order]);
      orderWithMemberCode.customer_code = orderWithMemberCode.member_code;
      return reply({ success: true, data: { order: orderWithMemberCode, items: items || [], credentials, wallet_payment: {
        balance_before: walletUse?.balance_before ?? null,
        balance_after: walletUse?.balance_after ?? null,
        current_balance: walletAccount?.balance ?? null,
      } } });
    }

    if (action === "cancel_order") {
      const orderId = typeof body.order_id === "string" ? body.order_id : "";
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      if (!orderId || !reason) return reply({ success: false, error: "order_id_and_reason_required" }, 400);
      const { data: order, error: orderError } = await db.from("sk_orders")
        .select("id,order_number,payment_status,order_status")
        .eq("id", orderId).maybeSingle();
      if (orderError) throw orderError;
      if (!order) return reply({ success: false, error: "order_not_found" }, 404);
      if (order.order_status === "cancelled") return reply({ success: true, data: { already_cancelled: true, order_id: orderId } });
      if (order.payment_status !== "unpaid" || order.order_status !== "pending") {
        return reply({ success: false, error: "only_unpaid_pending_orders_can_be_cancelled" }, 409);
      }
      const now = new Date().toISOString();
      const { data: updated, error: updateError } = await db.from("sk_orders").update({
        order_status: "cancelled", updated_at: now,
      }).eq("id", orderId).eq("payment_status", "unpaid").eq("order_status", "pending")
        .select("id,order_number,payment_status,order_status,updated_at").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return reply({ success: false, error: "order_status_changed_retry" }, 409);
      const { error: auditError } = await db.from("sk_admin_audit_logs").insert({
        admin_email: email, action: "cancel_order", target_type: "order", target_id: orderId,
        details: { order_number: order.order_number, reason, previous_status: "pending", order_status: "cancelled" },
      });
      if (auditError) throw auditError;
      return reply({ success: true, data: updated });
    }

    if (action === "update_order_field") {
      const orderId = typeof body.order_id === "string" ? body.order_id : "";
      const field = body.field === "payment_status" || body.field === "order_status" ? body.field : "";
      const value = typeof body.value === "string" ? body.value : "";
      if (!orderId || !field) return reply({ success: false, error: "invalid_order_update_input" }, 400);
      const { data: order, error: orderError } = await db.from("sk_orders").select("id,order_number,payment_status,order_status").eq("id", orderId).maybeSingle();
      if (orderError) throw orderError;
      if (!order) return reply({ success: false, error: "order_not_found" }, 404);
      const allowed = field === "payment_status" ? ["unpaid", "paid", "refunded"] : ["pending", "processing", "completed", "cancelled"];
      if (!allowed.includes(value)) return reply({ success: false, error: "unsupported_order_status" }, 400);
      if (field === "payment_status") {
        if (value === "paid") return reply({ success: false, error: "use_payment_confirmation_with_received_amount" }, 409);
        if (value === "paid" && order.payment_status !== "unpaid") return reply({ success: false, error: "only_unpaid_orders_can_be_marked_paid" }, 409);
        if (value === "unpaid" && order.payment_status !== "unpaid") return reply({ success: false, error: "paid_or_refunded_orders_cannot_be_reverted_to_unpaid" }, 409);
        if (value === "refunded" && order.payment_status !== "paid") return reply({ success: false, error: "only_paid_orders_can_be_marked_refunded" }, 409);
      }
      if (field === "order_status" && value === "cancelled" && order.payment_status !== "unpaid") return reply({ success: false, error: "paid_orders_cannot_be_cancelled_without_refund" }, 409);
      const now = new Date().toISOString();
      const update: Record<string, unknown> = { [field]: value, updated_at: now };
      if (field === "payment_status" && value === "paid") { update.paid_at = now; if (order.order_status === "pending") update.order_status = "processing"; }
      const { data: updated, error: updateError } = await db.from("sk_orders").update(update).eq("id", orderId).eq(field, order[field]).select("id,order_number,payment_status,order_status,paid_at,updated_at").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return reply({ success: false, error: "order_status_changed_retry" }, 409);
      const { error: auditError } = await db.from("sk_admin_audit_logs").insert({ admin_email: email, action: "update_order_field", target_type: "order", target_id: orderId, details: { order_number: order.order_number, field, previous_value: order[field], new_value: value } });
      if (auditError) console.error("Order status audit log failed:", auditError.message);

      // Notify the customer only when an order first transitions to completed.
      // Never include account credentials or other sensitive order details in LINE messages.
      let customerNotification: Record<string, unknown> | null = null;
      if (field === "order_status" && value === "completed" && order.order_status !== "completed") {
        try {
          const [{ data: fullOrder }, { data: items }] = await Promise.all([
            db.from("sk_orders").select("id,order_number,customer_id").eq("id", orderId).maybeSingle(),
            db.from("sk_order_items").select("product_name,quantity").eq("order_id", orderId),
          ]);
          const { data: customer } = fullOrder?.customer_id
            ? await db.from("customers").select("line_user_id").eq("id", fullOrder.customer_id).maybeSingle()
            : { data: null };
          const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
          if (!lineToken) {
            customerNotification = { sent: false, error: "LINE_CHANNEL_ACCESS_TOKEN_missing" };
          } else if (!customer?.line_user_id) {
            customerNotification = { sent: false, error: "customer_line_user_id_missing" };
          } else {
            const itemLines = (items || []).map((item: any) => `・${String(item.product_name || "商品")} × ${Number(item.quantity || 1)}`);
            const message = [
              "🎉 SOBBLEKING 代儲完成通知",
              "",
              "你的訂單已完成！",
              "訂單編號：" + String(fullOrder?.order_number || order.order_number),
              ...itemLines,
              "",
              "感謝你的支持，祝你遊戲愉快！",
              "SOBBLEKING",
            ].join("\n");
            const lineResponse = await fetch("https://api.line.me/v2/bot/message/push", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": "Bearer " + lineToken },
              body: JSON.stringify({ to: customer.line_user_id, messages: [{ type: "text", text: message }] }),
            });
            if (lineResponse.ok) {
              customerNotification = { sent: true };
            } else {
              const detail = (await lineResponse.text()).slice(0, 500);
              console.error("Customer order completion LINE push failed:", lineResponse.status, detail);
              customerNotification = { sent: false, error: "LINE HTTP " + lineResponse.status };
            }
          }
        } catch (notifyError) {
          console.error("Customer order completion LINE notification error:", notifyError);
          customerNotification = { sent: false, error: "notification_failed" };
        }
      }
      return reply({ success: true, data: updated, customer_notification: customerNotification });
    }

    if (action === "confirm_order_payment") {
      const orderId = typeof body.order_id === "string" ? body.order_id : "";
      const receivedAmount = Number(body.received_amount);
      if (!orderId || !Number.isSafeInteger(receivedAmount) || receivedAmount < 0) return reply({ success: false, error: "invalid_payment_confirmation_input" }, 400);
      const { data, error } = await db.rpc("sk_confirm_order_payment", {
        p_order_id: orderId, p_received_amount: receivedAmount, p_admin_email: email,
      });
      if (error) return reply({ success: false, error: error.message || "order_payment_confirmation_failed" }, 409);
      return reply({ success: true, data });
    }

    if (action === "revenue_history") {
      const fromDate = new Date();
      fromDate.setUTCDate(fromDate.getUTCDate() - 365);
      const { data, error } = await db.from("sk_orders")
        .select("paid_at,total_amount")
        .eq("payment_status", "paid")
        .not("paid_at", "is", null)
        .gte("paid_at", fromDate.toISOString())
        .order("paid_at", { ascending: true })
        .limit(5000);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "overview") {
      const [orders, paid, members, topups, wallet] = await Promise.all([
        db.from("sk_orders").select("id", { count: "exact", head: true }),
        db.from("sk_orders").select("total_amount").eq("payment_status", "paid"),
        db.from("customers").select("id", { count: "exact", head: true }),
        db.from("sk_wallet_topup_requests").select("id", { count: "exact", head: true }).eq("status", "pending"),
        db.from("sk_wallet_accounts").select("balance"),
      ]);
      for (const x of [orders, paid, members, topups, wallet]) if (x.error) throw x.error;
      const revenue = (paid.data || []).reduce((sum: number, row: any) => sum + Number(row.total_amount || 0), 0);
      const walletTotal = (wallet.data || []).reduce((sum: number, row: any) => sum + Number(row.balance || 0), 0);
      return reply({ success: true, data: {
        order_count: orders.count || 0, paid_revenue: revenue,
        member_count: members.count || 0, pending_topups: topups.count || 0,
        wallet_total: walletTotal,
      }});
    }

    if (action === "search_orders") {
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 100) : "";
      if (!query) return reply({ success: false, error: "query_required" }, 400);
      const { data, error } = await db.from("sk_orders")
        .select("id,order_number,customer_id,total_amount,wallet_amount_used,external_due,payment_status,order_status,payment_method,payment_bank,note,created_at,updated_at,paid_at")
        .ilike("order_number", `%${query}%`)
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return reply({ success: true, data: await attachMemberCodes(db, data || []) });
    }

    if (action === "search_members") {
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 100).toLowerCase() : "";
      if (!query) return reply({ success: false, error: "query_required" }, 400);
      // Return only the same safe member fields as the regular members action.
      const { data, error } = await db.from("customers").select("*")
        .order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      const matchesRaw = (data || []).map((row: Record<string, unknown>) => ({
        id: row.id ?? null,
        member_code: row.member_code ?? null,
        line_user_id: row.line_user_id ?? null,
        name: row.name ?? row.display_name ?? row.line_display_name ?? row.customer_name ?? "未命名會員",
        created_at: row.created_at ?? null,
      })).filter((row: Record<string, unknown>) =>
        [row.id, row.member_code, row.line_user_id, row.name].some(value => String(value ?? "").toLowerCase().includes(query))
      ).slice(0, 100);
      const ids = matchesRaw.map((row: Record<string, unknown>) => row.id).filter(Boolean);
      const { data: wallets, error: walletError } = ids.length
        ? await db.from("sk_wallet_accounts").select("customer_id,balance").in("customer_id", ids)
        : { data: [], error: null };
      if (walletError) throw walletError;
      const balances = new Map((wallets || []).map((w: Record<string, unknown>) => [String(w.customer_id), Number(w.balance || 0)]));
      const matches = matchesRaw.map((row: Record<string, unknown>) => ({
        ...row, wallet_balance: balances.get(String(row.id)) ?? 0,
      }));
      return reply({ success: true, data: matches });
    }

    if (action === "orders") {
      const { data, error } = await db.from("sk_orders").select("id,order_number,customer_id,total_amount,wallet_amount_used,external_due,payment_status,order_status,payment_method,note,created_at,updated_at,paid_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: await attachMemberCodes(db, data || []) });
    }

    if (action === "manual_wallet_adjustment") {
      const customerId = typeof body.customer_id === "string" ? body.customer_id.trim() : "";
      const direction = body.direction === "credit" || body.direction === "debit" ? body.direction : "";
      const amount = Number(body.amount);
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      if (!customerId || !direction || !Number.isSafeInteger(amount) || amount <= 0 || !reason) {
        return reply({ success: false, error: "invalid_wallet_adjustment_input" }, 400);
      }
      const { data, error } = await db.rpc("sk_manual_wallet_adjustment", {
        p_customer_id: customerId,
        p_direction: direction,
        p_amount: amount,
        p_reason: reason,
        p_admin_email: email,
      });
      if (error) return reply({ success: false, error: error.message || "manual_wallet_adjustment_failed" }, 409);
      return reply({ success: true, data });
    }

    if (action === "members") {
      const { data, error } = await db.from("customers").select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      const ids = (data || []).map((row: Record<string, unknown>) => row.id).filter(Boolean);
      const { data: wallets, error: walletError } = ids.length
        ? await db.from("sk_wallet_accounts").select("customer_id,balance").in("customer_id", ids)
        : { data: [], error: null };
      if (walletError) throw walletError;
      const balances = new Map((wallets || []).map((w: Record<string, unknown>) => [String(w.customer_id), Number(w.balance || 0)]));
      const safe = (data || []).map((row: Record<string, unknown>) => ({
        id: row.id ?? null,
        member_code: row.member_code ?? null,
        line_user_id: row.line_user_id ?? null,
        name: row.name ?? row.display_name ?? row.line_display_name ?? row.customer_name ?? "未命名會員",
        wallet_balance: balances.get(String(row.id)) ?? 0,
        created_at: row.created_at ?? null,
      }));
      return reply({ success: true, data: safe });
    }

    if (action === "topup_campaigns") {
      const { data, error } = await db.from("sk_topup_campaigns")
        .select("id,name,min_amount,bonus_amount,starts_at,ends_at,is_active,created_at,updated_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "save_topup_campaign") {
      const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
      const minAmount = Number(body.min_amount);
      const bonusAmount = Number(body.bonus_amount);
      const requestedName = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      const name = requestedName || (Number.isSafeInteger(minAmount) && Number.isSafeInteger(bonusAmount)
        ? `儲值滿${minAmount}贈${bonusAmount}`
        : "");
      const startsAt = typeof body.starts_at === "string" && body.starts_at ? body.starts_at : null;
      const endsAt = typeof body.ends_at === "string" && body.ends_at ? body.ends_at : null;
      const isActive = body.is_active === true;
      if (!name || !Number.isSafeInteger(minAmount) || minAmount < 500 || minAmount % 500 !== 0 ||
          !Number.isSafeInteger(bonusAmount) || bonusAmount < 0 || (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt))) {
        return reply({ success: false, error: "invalid_campaign_fields" }, 400);
      }
      const values = { name, min_amount: minAmount, bonus_amount: bonusAmount, starts_at: startsAt, ends_at: endsAt, is_active: isActive, updated_at: new Date().toISOString() };
      const result = campaignId
        ? await db.from("sk_topup_campaigns").update(values).eq("id", campaignId).select("id,name,min_amount,bonus_amount,starts_at,ends_at,is_active").single()
        : await db.from("sk_topup_campaigns").insert(values).select("id,name,min_amount,bonus_amount,starts_at,ends_at,is_active").single();
      if (result.error) throw result.error;
      await db.from("sk_admin_audit_logs").insert({
        admin_email: email, action: campaignId ? "update_topup_campaign" : "create_topup_campaign",
        target_type: "topup_campaign", target_id: result.data.id,
        details: { name, min_amount: minAmount, bonus_amount: bonusAmount, is_active: isActive },
      });
      return reply({ success: true, data: result.data });
    }

    if (action === "toggle_topup_campaign") {
      const campaignId = typeof body.campaign_id === "string" ? body.campaign_id : "";
      if (!campaignId || typeof body.is_active !== "boolean") return reply({ success: false, error: "invalid_campaign_toggle" }, 400);
      const { data, error } = await db.from("sk_topup_campaigns")
        .update({ is_active: body.is_active, updated_at: new Date().toISOString() })
        .eq("id", campaignId).select("id,name,is_active").single();
      if (error) throw error;
      await db.from("sk_admin_audit_logs").insert({
        admin_email: email, action: body.is_active ? "enable_topup_campaign" : "disable_topup_campaign",
        target_type: "topup_campaign", target_id: campaignId, details: { is_active: body.is_active },
      });
      return reply({ success: true, data });
    }

    if (action === "topup_detail") {
      const requestId = typeof body.request_id === "string" ? body.request_id : "";
      if (!requestId) return reply({ success: false, error: "request_id_required" }, 400);
      const { data, error } = await db.from("sk_wallet_topup_requests")
        .select("id,customer_id,amount,payment_method,payment_bank,status,created_at,updated_at,confirmed_at,received_amount,excess_amount,admin_note,reviewed_at,reviewed_by")
        .eq("id", requestId).maybeSingle();
      if (error) throw error;
      if (!data) return reply({ success: false, error: "topup_request_not_found" }, 404);
      const { data: wallet, error: walletError } = await db.from("sk_wallet_accounts")
        .select("balance").eq("customer_id", data.customer_id).maybeSingle();
      if (walletError) throw walletError;
      return reply({ success: true, data: { topup: data, wallet_balance: wallet?.balance ?? 0 } });
    }

    if (action === "confirm_wallet_topup") {
      const requestId = typeof body.request_id === "string" ? body.request_id : "";
      const receivedAmount = Number(body.received_amount);
      if (!requestId || !Number.isSafeInteger(receivedAmount) || receivedAmount < 0) {
        return reply({ success: false, error: "invalid_confirmation_input" }, 400);
      }
      const { data, error } = await db.rpc("sk_confirm_wallet_topup", {
        p_request_id: requestId, p_received_amount: receivedAmount, p_admin_email: email,
      });
      if (error) {
        const known = error.message || "topup_confirmation_failed";
        return reply({ success: false, error: known }, 409);
      }
      const { data: queued, error: queueError } = await db.from("sk_line_notification_queue")
        .select("id,status").eq("request_id", requestId).maybeSingle();
      if (queueError) console.error("Top-up LINE queue lookup failed:", queueError.message);
      let notification = null;
      if (queued?.id) {
        try { notification = await sendTopupLineNotification(db, queued.id); }
        catch (notifyError) { console.error("Top-up LINE notification failed:", notifyError); notification = { sent: false, error: String(notifyError) }; }
      } else {
        notification = { sent: false, error: "notification_queue_item_not_found" };
      }
      return reply({ success: true, data, notification });
    }

    if (action === "retry_line_notifications") {
      const { data: due, error: dueError } = await db.from("sk_line_notification_queue")
        .select("id").eq("status", "failed").not("next_retry_at", "is", null)
        .lte("next_retry_at", new Date().toISOString()).order("created_at", { ascending: true }).limit(20);
      if (dueError) throw dueError;
      const results = [];
      for (const item of due || []) {
        try { results.push({ id: item.id, ...(await sendTopupLineNotification(db, item.id)) }); }
        catch (retryError) { results.push({ id: item.id, sent: false, error: String(retryError) }); }
      }
      return reply({ success: true, data: results });
    }

    if (action === "reject_wallet_topup") {
      const requestId = typeof body.request_id === "string" ? body.request_id : "";
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      if (!requestId || !reason) return reply({ success: false, error: "rejection_reason_required" }, 400);
      const { data, error } = await db.rpc("sk_reject_wallet_topup", {
        p_request_id: requestId, p_admin_email: email, p_reason: reason,
      });
      if (error) return reply({ success: false, error: error.message || "topup_rejection_failed" }, 409);
      return reply({ success: true, data });
    }

    if (action === "search_topups") {
      const query = typeof body.query === "string" ? body.query.trim().toUpperCase() : "";
      const isShortCode = /^SKT[0-9A-F]{8}$/.test(query);
      const isUuid = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(query);
      if (!isShortCode && !isUuid) return reply({ success: false, error: "invalid_topup_request_id" }, 400);
      let searchQuery = db.from("sk_wallet_topup_requests")
        .select("id,customer_id,amount,payment_method,payment_bank,status,created_at,updated_at,confirmed_at,received_amount,excess_amount,admin_note,reviewed_at,reviewed_by");
      searchQuery = isShortCode
        ? searchQuery.filter("id::text", "ilike", `${query.slice(3)}%`).limit(2)
        : searchQuery.eq("id", query).limit(1);
      const { data, error } = await searchQuery;
      if (error) throw error;
      if ((data || []).length > 1) return reply({ success: false, error: "topup_request_code_ambiguous" }, 409);
      return reply({ success: true, data: await attachMemberCodes(db, data || []) });
    }

    if (action === "topups") {
      const { data, error } = await db.from("sk_wallet_topup_requests")
        .select("id,customer_id,amount,payment_method,payment_bank,status,created_at,updated_at,confirmed_at,received_amount,excess_amount,admin_note,reviewed_at,reviewed_by")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: await attachMemberCodes(db, data || []) });
    }

    if (action === "wallet_transactions") {
      const { data, error } = await db.from("sk_wallet_transactions")
        .select("id,wallet_id,customer_id,transaction_type,amount,balance_before,balance_after,reference_id,description,admin_email,created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: await attachMemberCodes(db, data || []) });
    }

    if (action === "audit_logs") {
      const { data, error } = await db.from("sk_admin_audit_logs")
        .select("id,admin_email,action,target_type,target_id,details,created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "products") {
      const { data, error } = await db.from("products")
        .select("id,name,subtitle,price,is_active,sort_order")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "save_product") {
      const productId = typeof body.product_id === "string" ? body.product_id.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      const price = Number(body.price);
      const isActive = body.is_active === true;
      const subtitle = typeof body.subtitle === "string" ? body.subtitle.trim().slice(0, 80) : "";
      if (!name || !Number.isSafeInteger(price) || price < 0 || typeof body.is_active !== "boolean") {
        return reply({ success: false, error: "invalid_product_fields" }, 400);
      }
      let nextSortOrder = 0;
      if (!productId) {
        const { data: lastProduct, error: sortError } = await db.from("products")
          .select("sort_order").order("sort_order", { ascending: false }).limit(1).maybeSingle();
        if (sortError) throw sortError;
        nextSortOrder = Number(lastProduct?.sort_order || 0) + 1;
      }
      const values = { name, subtitle, price, is_active: isActive, ...(!productId ? { sort_order: nextSortOrder } : {}) };
      const result = productId
        ? await db.from("products").update(values).eq("id", productId).select("id,name,subtitle,price,is_active,sort_order").maybeSingle()
        : await db.from("products").insert(values).select("id,name,subtitle,price,is_active,sort_order").single();
      if (result.error) throw result.error;
      if (!result.data) return reply({ success: false, error: "product_not_found" }, 404);
      const { error: auditError } = await db.from("sk_admin_audit_logs").insert({
        admin_email: email,
        action: productId ? "update_product" : "create_product",
        target_type: "product",
        target_id: result.data.id,
        details: { name, price, is_active: isActive },
      });
      if (auditError) console.error("Product audit log failed:", auditError.message);
      return reply({ success: true, data: result.data });
    }

    if (action === "delete_product") {
      const productId = typeof body.product_id === "string" ? body.product_id.trim() : "";
      if (!productId) return reply({ success: false, error: "product_id_required" }, 400);
      const { data: product, error: lookupError } = await db.from("products").select("id,name").eq("id", productId).maybeSingle();
      if (lookupError) throw lookupError;
      if (!product) return reply({ success: false, error: "product_not_found" }, 404);
      const { error } = await db.from("products").delete().eq("id", productId);
      if (error) return reply({ success: false, error: error.message || "product_delete_failed" }, 409);
      const { error: auditError } = await db.from("sk_admin_audit_logs").insert({ admin_email: email, action: "delete_product", target_type: "product", target_id: productId, details: { name: product.name } });
      if (auditError) console.error("Product delete audit log failed:", auditError.message);
      return reply({ success: true });
    }

    if (action === "reorder_products") {
      const productIds = Array.isArray(body.product_ids) ? body.product_ids : [];
      if (!productIds.length || productIds.length > 500 ||
          productIds.some((id: unknown) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
          new Set(productIds).size !== productIds.length) {
        return reply({ success: false, error: "invalid_product_order" }, 400);
      }
      const { data: currentProducts, error: listError } = await db.from("products").select("id");
      if (listError) throw listError;
      const currentIds = (currentProducts || []).map((row: { id: string }) => row.id).sort();
      const requestedIds = [...productIds].sort();
      if (currentIds.length !== requestedIds.length || currentIds.some((id: string, index: number) => id !== requestedIds[index])) {
        return reply({ success: false, error: "product_list_changed_refresh_and_retry" }, 409);
      }
      for (let index = 0; index < productIds.length; index++) {
        const { error } = await db.from("products").update({ sort_order: index + 1 }).eq("id", productIds[index]);
        if (error) throw error;
      }
      const { error: auditError } = await db.from("sk_admin_audit_logs").insert({
        admin_email: email, action: "reorder_products", target_type: "product",
        details: { product_ids: productIds },
      });
      if (auditError) console.error("Product reorder audit log failed:", auditError.message);
      return reply({ success: true });
    }

    if (action === "toggle_product") {
      const productId = typeof body.product_id === "string" ? body.product_id.trim() : "";
      if (!productId || typeof body.is_active !== "boolean") {
        return reply({ success: false, error: "invalid_product_toggle" }, 400);
      }
      const { data, error } = await db.from("products")
        .update({ is_active: body.is_active })
        .eq("id", productId)
        .select("id,name,is_active")
        .maybeSingle();
      if (error) throw error;
      if (!data) return reply({ success: false, error: "product_not_found" }, 404);
      const { error: auditError } = await db.from("sk_admin_audit_logs").insert({
        admin_email: email,
        action: body.is_active ? "publish_product" : "unpublish_product",
        target_type: "product",
        target_id: productId,
        details: { name: data.name, is_active: body.is_active },
      });
      if (auditError) console.error("Product status audit log failed:", auditError.message);
      return reply({ success: true, data });
    }

    return reply({ success: false, error: "unknown_action" }, 400);
  } catch (error) {
    console.error("admin-api error:", error);
    return reply({ success: false, error: "internal_server_error" }, 500);
  }
});

// Deployment trigger: wallet top-up confirmation workflow.

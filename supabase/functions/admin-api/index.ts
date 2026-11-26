import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

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
        .select("id,order_number,customer_id,total_amount,payment_status,order_status,payment_method,note,created_at,updated_at,paid_at")
        .ilike("order_number", `%${query}%`)
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "search_members") {
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 100).toLowerCase() : "";
      if (!query) return reply({ success: false, error: "query_required" }, 400);
      // Return only the same safe member fields as the regular members action.
      const { data, error } = await db.from("customers").select("*")
        .order("created_at", { ascending: false }).limit(1000);
      if (error) throw error;
      const safe = (data || []).map((row: Record<string, unknown>) => ({
        id: row.id ?? null,
        line_user_id: row.line_user_id ?? null,
        name: row.name ?? row.display_name ?? row.line_display_name ?? row.customer_name ?? "未命名會員",
        created_at: row.created_at ?? null,
      }));
      const matches = safe.filter((row: Record<string, unknown>) =>
        [row.id, row.line_user_id, row.name].some(value => String(value ?? "").toLowerCase().includes(query))
      ).slice(0, 100);
      return reply({ success: true, data: matches });
    }

    if (action === "orders") {
      const { data, error } = await db.from("sk_orders").select("id,order_number,customer_id,total_amount,payment_status,order_status,payment_method,note,created_at,updated_at,paid_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "members") {
      const { data, error } = await db.from("customers").select("*").order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      const safe = (data || []).map((row: Record<string, unknown>) => ({
        id: row.id ?? null,
        line_user_id: row.line_user_id ?? null,
        name: row.name ?? row.display_name ?? row.line_display_name ?? row.customer_name ?? "未命名會員",
        created_at: row.created_at ?? null,
      }));
      return reply({ success: true, data: safe });
    }

    if (action === "topups") {
      const { data, error } = await db.from("sk_wallet_topup_requests")
        .select("id,customer_id,amount,payment_method,payment_bank,status,created_at,updated_at,confirmed_at,admin_note")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "wallet_transactions") {
      const { data, error } = await db.from("sk_wallet_transactions")
        .select("id,wallet_id,customer_id,transaction_type,amount,balance_before,balance_after,reference_id,description,admin_email,created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    if (action === "audit_logs") {
      const { data, error } = await db.from("sk_admin_audit_logs")
        .select("id,admin_email,action,target_type,target_id,details,created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return reply({ success: true, data: data || [] });
    }

    return reply({ success: false, error: "unknown_action" }, 400);
  } catch (error) {
    console.error("admin-api error:", error);
    return reply({ success: false, error: "internal_server_error" }, 500);
  }
});

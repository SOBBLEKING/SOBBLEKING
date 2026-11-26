/**
 * SOBBLEKING 管理者訂單通知
 * 貼到 Google Apps Script，並在「專案設定 > 指令碼屬性」新增：
 * ORDER_EMAIL_TOKEN = 與 Supabase Secret 完全相同的長隨機字串
 */
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const expected = PropertiesService.getScriptProperties().getProperty("ORDER_EMAIL_TOKEN");
    if (!expected || payload.token !== expected) {
      return ContentService.createTextOutput("unauthorized");
    }

    const order = payload.order || {};
    const items = Array.isArray(payload.items) ? payload.items : [];
    const customer = payload.customer || {};
    const orderNumber = String(order.order_number || "未提供");
    const amount = Number(order.total_amount || 0).toLocaleString("zh-TW");
    const verificationCode = String(payload.verificationCode || "未提供");
    const payment = String(payload.paymentMethod || "未提供") +
      (payload.paymentBank ? "（" + String(payload.paymentBank) + "）" : "");
    const note = String(order.note || "無");
    const createdAt = order.created_at
      ? Utilities.formatDate(new Date(order.created_at), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss")
      : Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");

    const customerLabels = {
      name: "姓名", display_name: "顯示名稱", line_display_name: "LINE 名稱",
      customer_name: "會員姓名", phone: "電話", customer_code: "會員編號",
      member_code: "會員編號", member_number: "會員編號"
    };
    const customerRows = Object.keys(customerLabels)
      .filter(function(k) { return customer[k]; })
      .map(function(k) {
        return "<tr><th>" + customerLabels[k] + "</th><td>" + esc(customer[k]) + "</td></tr>";
      }).join("");

    const itemRows = items.map(function(item) {
      return "<tr><td>" + esc(item.product_name) + "</td><td>" +
        esc(item.quantity) + "</td><td>NT$" +
        Number(item.subtotal || 0).toLocaleString("zh-TW") + "</td></tr>";
    }).join("");

    const html = '<div style="font-family:Arial,sans-serif;color:#263238;line-height:1.7">' +
      '<h2>🔔 SOBBLEKING 新訂單成立</h2>' +
      '<p><b>訂單編號：</b>' + esc(orderNumber) + '</p>' +
      '<p><b>成立時間：</b>' + esc(createdAt) + '</p>' +
      '<p><b>訂單金額：</b>NT$' + amount + '</p>' +
      '<p><b>付款方式：</b>' + esc(payment) + '</p>' +
      '<p><b>驗證碼：</b>' + esc(verificationCode) + '</p>' +
      '<h3>會員資料</h3><table border="1" cellpadding="7" cellspacing="0">' +
      (customerRows || '<tr><td>會員識別碼：' + esc(order.customer_id || "未提供") + '</td></tr>') +
      '</table><h3>商品明細</h3><table border="1" cellpadding="7" cellspacing="0">' +
      '<tr><th>商品</th><th>數量</th><th>小計</th></tr>' + itemRows +
      '</table><h3>訂單備註</h3><p>' + esc(note).replace(/\n/g, "<br>") + '</p>' +
      '<p>請至 SOBBLEKING 管理後台確認訂單與付款。</p></div>';

    const plain = "SOBBLEKING 新訂單成立\n訂單：" + orderNumber +
      "\n金額：NT$" + amount + "\n付款方式：" + payment +
      "\n驗證碼：" + verificationCode + "\n備註：" + note;

    MailApp.sendEmail({
      to: "sobblekinggg@gmail.com",
      subject: "【SOBBLEKING】新訂單成立｜" + orderNumber,
      body: plain,
      htmlBody: html,
      name: "SOBBLEKING 訂單通知"
    });
    return ContentService.createTextOutput("ok");
  } catch (err) {
    console.error(err);
    return ContentService.createTextOutput("error");
  }
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(ch) {
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
  });
}

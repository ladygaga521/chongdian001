/* 共享充电宝 - 用户扫码端逻辑 */
(function () {
  'use strict';

  var API_BASE = (window.API_BASE || '').replace(/\/+$/, '');
  var API = API_BASE + '/api.php';
  var state = { rules: null, order: null, timer: null };
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 用户标识（微信端用真实 openid，其它端用本地生成） ---------- */
  function uid() {
    if (window.PB_OPENID) {
      localStorage.setItem('pb_uid', window.PB_OPENID);
      return window.PB_OPENID;
    }
    var u = localStorage.getItem('pb_uid');
    if (!u) {
      u = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('pb_uid', u);
    }
    return u;
  }

  /* ---------- 工具 ---------- */
  function fmtDT(ts) {
    var d = new Date(ts * 1000);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtHMS(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(h) + ':' + p(m) + ':' + p(s);
  }
  function money(n) { return '¥' + Number(n).toFixed(2); }
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.display = 'none'; }, ms || 1800);
  }
  function show(id) {
    ['view-rent', 'view-using'].forEach(function (v) {
      $(v).classList.toggle('hidden', v !== id);
    });
  }
  function post(action, data) {
    data.uid = uid();
    return fetch(API + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) { return r.json(); });
  }

  /* ---------- 计费（与服务端一致）：不足1小时按1小时 ---------- */
  function feeOf(startAt, endAt) {
    var r = state.rules;
    var end = endAt || Math.floor(Date.now() / 1000);
    var hours = Math.max(0, (end - startAt) / 3600);
    if (hours <= 0) return 0;
    var fee = Math.ceil(hours) * r.hourly_fee;
    return Math.min(fee, r.cap24, r.cap_total);
  }

  /* ---------- 加载状态 ---------- */
  function loadStatus() {
    return fetch(API + '?action=status&uid=' + encodeURIComponent(uid()))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) { toast(res.msg || '加载失败'); return; }
        state.rules = res.rules;
        state.order = res.order;
        render(res);
      })
      .catch(function () { toast('网络异常，请重试'); });
  }

  function render(res) {
    var r = res.rules;

    // 规则文案无论进入哪个界面都要刷新（否则会停留在 HTML 里的默认值）
    $('capTotal').textContent    = r.cap_total;
    $('depTxt').textContent      = r.deposit;
    $('refHourTxt').textContent  = r.refund_hour;
    $('refHourTxt2').textContent = r.refund_hour;
    $('depTxt2').textContent     = r.deposit;

    if (res.order) {
      fillOrder(res.order);
      startTicker(res.order);
      show('view-using');
      return;
    }

    $('deviceId').textContent    = r.device_id;
    $('storeName').textContent   = r.store;
    $('pillFee').textContent     = r.hourly_fee;
    $('agreeChk').checked = true;
    renderChannel(r);
    show('view-rent');
  }

  /* ---------- 按支付通道微调文案 ---------- */
  function renderChannel(r) {
    var ch = window.PB_CHANNEL || 'demo';
    var btn = $('btnRent'), score = document.querySelector('.pay-score');
    var name = payName(ch);

    if (ch === 'none' || ch === 'none_wechat') {
      btn.textContent  = ch === 'none_wechat' ? '请在微信中打开' : '请使用微信/支付宝扫码';
      btn.disabled     = false; // 仍可点击，弹层会给出说明
      if (score) score.innerHTML = '<i class="wx-icon">&#9889;</i> 请使用微信或支付宝「扫一扫」扫码租借';
      return;
    }

    btn.textContent = ch === 'demo' ? '免押金租借（模拟支付）' : '免押金租借';
    if (score) {
      score.innerHTML = (ch === 'alipay')
        ? '<i class="wx-icon">&#10003;</i> 支付宝担保交易｜租借费用 ' + name + '支付'
        : (ch === 'epay'
            ? '<i class="wx-icon">&#10003;</i> 支持微信/支付宝｜租借费用 ' + name + '支付'
            : '<i class="wx-icon">&#10003;</i> 微信支付分｜550及以上优享');
    }
  }

  /* ---------- 填充订单详情 ---------- */
  function fillOrder(o) {
    $('uOrderNo').textContent = o.order_no;
    $('uStart').textContent   = fmtDT(o.start_at);
    $('uDevice').textContent  = o.device_id;
    $('uStore').textContent   = o.store;
    $('uDeposit').textContent = money(o.deposit) + '（按时归还全额退还）';
  }

  /* ---------- 使用中：正计时（已使用时长），满 12 小时直接判定超时 ---------- */
  function startTicker(order) {
    stopTicker();
    state.order = order;
    var limit = order.limit_at - order.start_at;   // 押金退还时限（秒）

    function tick() {
      var now  = Math.floor(Date.now() / 1000);
      var used = Math.max(0, now - order.start_at);
      var cd = $('countdown'), bar = $('progressBar');

      if (used < limit) {
        // 正计时：显示已使用的时长
        cd.className = 'count-num';
        cd.textContent = fmtHMS(used);
        bar.className = '';
        bar.style.width = Math.min(100, (used / limit) * 100) + '%';
      } else {
        // 满 12 小时直接超时
        cd.className = 'count-num over';
        cd.textContent = '已超时';
        bar.className = 'over';
        bar.style.width = '100%';
      }
      $('uUsed').textContent = fmtHMS(used);
      $('uFee').textContent  = money(feeOf(order.start_at, null));
    }
    tick();
    state.timer = setInterval(tick, 1000);
  }
  function stopTicker() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  /* ---------- 弹层 ---------- */
  function openPay(html) { $('payPanel').innerHTML = html; $('payMask').classList.remove('hidden'); }
  function closePay() { $('payMask').classList.add('hidden'); }

  function confirmBox(title, text) {
    return new Promise(function (resolve) {
      openPay(
        '<div class="pay-body" style="padding:22px 18px 12px">' +
          '<div style="font-size:17px;font-weight:600;text-align:center">' + title + '</div>' +
          '<div style="font-size:13px;color:#888;text-align:center;margin-top:8px">' + text + '</div>' +
          '<button class="pay-btn" id="cfOk">确定</button>' +
          '<button class="pay-cancel" id="cfNo">取消</button>' +
        '</div>'
      );
      $('cfOk').onclick = function () { closePay(); resolve(true); };
      $('cfNo').onclick = function () { closePay(); resolve(false); };
    });
  }

  /* ---------- 租借：按通道走对应支付 ---------- */
  function rent() {
    if (!$('agreeChk').checked) {
      toast('请先勾选同意《用户隐私协议》与《委托扣款授权书》');
      return;
    }
    var ch = window.PB_CHANNEL || 'demo';

    // 非微信/支付宝扫码进入 → 提示
    if (ch === 'none' || ch === 'none_wechat') {
      openPay(
        '<div class="pay-head"><div class="sub">请使用微信或支付宝扫码</div></div>' +
        '<div class="pay-body">' +
          '<div class="pay-line"><span>提示</span><b>' +
          (ch === 'none_wechat' ? '请在微信中打开本页面' : '请使用微信「扫一扫」或支付宝「扫一扫」扫码租借') +
          '</b></div>' +
          '<button class="pay-cancel" id="cancelPay">知道了</button>' +
        '</div>'
      );
      $('cancelPay').onclick = closePay;
      return;
    }

    var r = state.rules;
    openPay(
      '<div class="pay-body">' +
        '<div class="pay-line"><span>支付方式</span><b>' + payName(ch) + '</b></div>' +
        '<div class="pay-line"><span>押金</span><b>' + money(r.deposit) + '（' + r.refund_hour + '小时内归还全额退还）</b></div>' +
        '<div class="pay-line"><span>超时规则</span><b>超过' + r.refund_hour + '小时押金不予退还</b></div>' +
        '<div class="pay-line"><span>商户</span><b>' + r.store + '</b></div>' +
        '<div class="pay-line"><span>设备编号</span><b>' + r.device_id + '</b></div>' +
        '<button class="pay-btn" id="doPay">立即租用</button>' +
        '<button class="pay-cancel" id="cancelPay">取消</button>' +
      '</div>'
    );
    $('doPay').onclick = function () {
      if (ch === 'demo') { demoPay(); return; }
      startRealPay(ch);
    };
    $('cancelPay').onclick = closePay;
  }

  function payName(ch) {
    if (ch === 'wechat') return '微信支付';
    if (ch === 'alipay') return '支付宝支付';
    if (ch === 'epay') return '聚合支付（微信/支付宝）';
    return '模拟支付';
  }

  function switchToUsing(order) {
    closePay();
    toast('支付成功，充电宝已弹出');
    fillOrder(order);
    startTicker(order);
    show('view-using');
  }

  /* ---------- 模拟支付（本地联调） ---------- */
  function demoPay() {
    openPay('<div class="pay-center"><div class="spinner"></div>支付中...</div>');
    setTimeout(function () {
      openPay('<div class="pay-center"><div class="tick">&#10003;</div>支付成功</div>');
      setTimeout(function () {
        post('pay', { agree: 1, channel: 'demo' }).then(function (res) {
          if (res.ok) { switchToUsing(res.order); }
          else { closePay(); toast(res.msg || '下单失败'); loadStatus(); }
        });
      }, 700);
    }, 1300);
  }

  /* ---------- 真实支付：下单 → 唤起收银台 → 轮询结果 ---------- */
  function startRealPay(ch) {
    openPay('<div class="pay-center"><div class="spinner"></div>正在创建订单...</div>');
    post('pay', { agree: 1, channel: ch, openid: window.PB_OPENID || '' }).then(function (res) {
      if (!res.ok) {
        closePay();
        toast(res.msg || '下单失败');
        if (res.code === 'need_openid' || res.code === 'config') { loadStatus(); }
        return;
      }
      state.pendingOrderNo = res.order.order_no;

      if (res.mode === 'wechat_jsapi') {
        weixinPay(res);
      } else if (res.mode === 'alipay_wap') {
        alipayForm(res);
      } else if (res.mode === 'epay_redirect') {
        epayJump(res);
      } else {
        switchToUsing(res.order);
      }
    }).catch(function () {
      closePay();
      toast('网络异常，请重试');
    });
  }

  /* ---------- 微信 JSAPI ---------- */
  function weixinPay(res) {
    if (!window.WeixinJSBridge) {
      closePay();
      toast('请在微信中打开本页面');
      return;
    }
    openPay('<div class="pay-center"><div class="spinner"></div>正在调起微信支付...</div>');
    window.WeixinJSBridge.invoke('getBrandWCPPayRequest', {
      appId:     res.params.appId,
      timeStamp: res.params.timeStamp,
      nonceStr:  res.params.nonceStr,
      package:   res.params.package,
      signType:  res.params.signType,
      paySign:   res.params.paySign
    }, function (r) {
      var msg = r.err_msg;
      if (msg === 'get_brand_wcpay_request:ok') {
        payWaiting(res.order.order_no);
      } else if (msg === 'get_brand_wcpay_request:cancel') {
        closePay();
        toast('已取消支付');
      } else if (msg === 'get_brand_wcpay_request:fail') {
        closePay();
        toast('支付失败，请重试');
      } else {
        payWaiting(res.order.order_no);
      }
    });
  }

  /* ---------- 支付宝手机网站支付：提交表单跳收银台 ---------- */
  function alipayForm(res) {
    var f = document.createElement('form');
    f.method = 'POST';
    f.action = res.action;
    f.target = '_self';
    f.acceptCharset = 'utf-8';
    for (var k in res.fields) {
      if (!Object.prototype.hasOwnProperty.call(res.fields, k)) continue;
      var i = document.createElement('input');
      i.type = 'hidden'; i.name = k; i.value = res.fields[k];
      f.appendChild(i);
    }
    document.body.appendChild(f);
    // 用户从支付宝返回后由 loadStatus / pay_query 结束，不再回调
    f.submit();
  }

  /* ---------- 彩虹易支付：GET 跳转到易支付收银台 ---------- */
  function epayJump(res) {
    openPay('<div class="pay-center"><div class="spinner"></div>正在跳转支付...</div>');
    // 支付完成后由 pay_return.php 回跳，再由 loadStatus / pay_query 收尾
    setTimeout(function () { location.href = res.action; }, 300);
  }

  /* ---------- 支付后轮询结果 ---------- */
  function payWaiting(orderNo) {
    openPay('<div class="pay-center"><div class="spinner"></div>正在确认支付结果...</div>');
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (tries > 20) {
        clearInterval(t);
        closePay();
        toast('支付结果确认超时，请稍后下拉刷新');
        loadStatus();
        return;
      }
      post('pay_query', { order_no: orderNo }).then(function (r) {
        if (r.ok && r.paid) {
          clearInterval(t);
          switchToUsing(r.order);
        }
      }).catch(function () {});
    }, 1500);
  }

  /* ---------- 归还：按钮为禁用提示，实际归还由把充电宝插入机器完成 ---------- */
  function doReturn() {
    toast('如果归还请正确插入机器');
  }

  /* ---------- 绑定 ---------- */
  $('btnRent').addEventListener('click', rent);
  $('btnReturn').addEventListener('click', doReturn);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadStatus(); });

  /* ---------- 读取 URL 中的微信 openid / 错误（OAuth 回调） ---------- */
  (function () {
    var p = new URLSearchParams(location.search);
    if (p.get('wx_openid')) {
      window.PB_OPENID = p.get('wx_openid');
      try { localStorage.setItem('pb_wx_openid', window.PB_OPENID); } catch (e) {}
      p.delete('wx_openid');
      var qs = p.toString();
      var url = location.pathname + (qs ? ('?' + qs) : '') + location.hash;
      history.replaceState(null, '', url);
    } else if (!window.PB_OPENID) {
      try { window.PB_OPENID = localStorage.getItem('pb_wx_openid') || ''; } catch (e) {}
    }
    if (p.get('oauth_err')) {
      window.PB_OAUTH_ERR = p.get('oauth_err');
      p.delete('oauth_err');
    }
  })();

  /* ---------- 拉取后端初始化配置 ---------- */
  fetch(API_BASE + '/bootstrap.php', { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      if (!cfg.ok) { throw new Error(cfg.msg || '初始化失败'); }
      window.PB_RULES = cfg.rules;
      window.PB_CLIENT = cfg.client;
      window.PB_CHANNEL = cfg.channel;
      if (cfg.openid) { window.PB_OPENID = cfg.openid; }
      window.PB_OAUTH_ERR = cfg.oauth_err || window.PB_OAUTH_ERR || '';
      if (cfg.brand_name) {
        window.PB_BRAND = cfg.brand_name;
        var t = document.getElementById('brandTitle');
        if (t) t.textContent = cfg.brand_name;
        document.title = cfg.brand_name;
      }
      // 微信通道且缺少 openid → 走 OAuth
      if (window.PB_CHANNEL === 'wechat' && !window.PB_OPENID && !window.PB_OAUTH_ERR) {
        location.href = API_BASE + '/oauth_start.php?return=' + encodeURIComponent(location.href);
        return;
      }
      loadStatus();
    })
    .catch(function (e) {
      console.error(e);
      window.PB_CHANNEL = window.PB_CHANNEL || 'demo';
      loadStatus();
    });
})();

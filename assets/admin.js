/* 共享充电宝 - 后台逻辑 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var API_BASE = (window.API_BASE || '').replace(/\/+$/, '');
  var API = API_BASE + '/admin_api.php';

  /* ---- Token（跨域部署时不能依赖 Cookie，改用 Token） ---- */
  var TOKEN_KEY = 'pb_admin_token';
  var cur = { filter: 'all', q: '', page: 1, pages: 1, rows: [], refund_hour: 12 };
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function req(action, data) {
    var opt = { method: 'GET', credentials: 'include', headers: {} };
    var tk = getToken();
    if (tk) { opt.headers['X-Admin-Token'] = tk; }
    if (data) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(data);
    }
    return fetch(API + '?action=' + action, opt).then(function (r) {
      if (r.status === 401) { setToken(''); showLogin(); throw new Error('未登录'); }
      return r.json();
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDT(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function hms(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function esc(t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var STATUS = { pending: '待支付', using: '使用中', done: '已归还', timeout: '超时未退押金' };
  var DEP = { held: '已冻结', refunded: '已退还', forfeited: '已扣除·不退还' };
  var CHANNEL = { demo: '模拟', auto: '自动识别', wechat: '微信JSAPI', alipay: '支付宝', epay: '彩虹易支付' };

  /* ---------- 标签页 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (el) {
    el.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (n) { n.classList.remove('active'); });
      el.classList.add('active');
      ['users', 'pay', 'qr', 'set'].forEach(function (t) {
        $('tab-' + t).classList.toggle('hidden', t !== el.dataset.tab);
      });
      if (el.dataset.tab === 'set') loadSettings();
      if (el.dataset.tab === 'pay') loadPaySettings();
    });
  });

  $('logout').addEventListener('click', function () {
    req('logout').then(function () { location.reload(); });
  });

  /* ---------- 统计 ---------- */
  function loadStats() {
    req('stats').then(function (res) {
      if (!res.ok) return;
      if (res.rules && res.rules.refund_hour) { cur.refund_hour = res.rules.refund_hour; }
      var s = res.stats;
      $('stats').innerHTML = [
        ['注册用户数', s.users, ''],
        ['租借订单数', s.orders, ''],
        ['当前使用中', s.using, 'green'],
        ['今日订单', s.today, ''],
        ['已退还押金', '¥' + s.refunded.toFixed(2), ''],
        ['扣除押金', '¥' + s.forfeited.toFixed(2), 'red']
      ].map(function (c) {
        return '<div class="stat"><div class="t">' + c[0] + '</div><div class="n ' + c[2] + '">' + c[1] + '</div></div>';
      }).join('');
    });
  }

  /* ---------- 订单列表 ---------- */
  function loadOrders() {
    var url = API + '?action=orders&filter=' + encodeURIComponent(cur.filter) +
              '&page=' + cur.page + '&q=' + encodeURIComponent(cur.q);
    var hdr = { credentials: 'include' };
    var _tk = getToken();
    if (_tk) { hdr.headers = { 'X-Admin-Token': _tk }; }
    fetch(url, hdr).then(function (r) {
      if (r.status === 401) { setToken(''); showLogin(); return { ok: false }; }
      return r.json();
    }).then(function (res) {
      if (!res.ok) return;
      cur.rows = res.orders; cur.pages = res.pages;
      $('pageInfo').textContent = '第 ' + res.page + ' / ' + res.pages + ' 页，共 ' + res.total + ' 条';
      $('prev').disabled = res.page <= 1;
      $('next').disabled = res.page >= res.pages;
      renderRows();
    });
  }

  function renderRows() {
    var tb = $('tbody');
    if (!cur.rows.length) { tb.innerHTML = '<tr><td colspan="9" class="empty">暂无数据</td></tr>'; return; }
    tb.innerHTML = cur.rows.map(function (o) {
      var depositText = '<b style="font-size:14px">¥' + Number(o.deposit).toFixed(0) + '</b><br>' +
                        '<span class="dep ' + o.deposit_status + '" style="font-size:11.5px">' + DEP[o.deposit_status] + '</span>';
      var isClosed = o.status !== 'using' && o.closed_by === 'admin';
      var statusText = (o.status === 'timeout' && isClosed) ? '已关闭' : STATUS[o.status];
      var statusClass = (o.status === 'timeout' && isClosed) ? 'closed' : o.status;
      var timer = (o.status === 'using')
        ? '<span class="timer" data-limit="' + o.limit_at + '" data-start="' + o.start_at + '"></span>'
        : (o.deposit_status === 'refunded'
            ? '<span style="color:#07c160">按时结束 · 押金已退</span>'
            : (isClosed
                ? '<span style="color:#b26b00">订单关闭 · 押金已扣</span>'
                : '<span style="color:#fa5151">超过' + cur.refund_hour + '小时 · 押金已扣</span>'));
      var feeText = o.status === 'using' ? Number(o.fee_live).toFixed(2) : Number(o.fee).toFixed(2);
      var act = o.status === 'using'
        ? '<button class="btn btn-line" data-return="' + esc(o.order_no) + '">归还</button> ' +
          '<button class="btn btn-danger" data-close="' + esc(o.order_no) + '">关闭</button>'
        : '<span style="color:#b0b6bd">-</span>';
      return '<tr>' +
        '<td class="mono" title="首次使用 ' + fmtDT(o.user_first_at) + '，最近扫码 ' + fmtDT(o.last_scan_at) + '">' + esc(o.uid) + '</td>' +
        '<td class="mono">' + esc(o.order_no) + '</td>' +
        '<td class="mono">' + esc(o.device_id) + '</td>' +
        '<td>' + fmtDT(o.start_at) + '</td>' +
        '<td>' + timer + '</td>' +
        '<td>' + depositText + '</td>' +
        '<td><span class="tag ' + statusClass + '">' + statusText + '</span></td>' +
        '<td>¥' + feeText + '</td>' +
        '<td>' + act + '</td>' +
      '</tr>';
    }).join('');

    Array.prototype.forEach.call(tb.querySelectorAll('[data-return]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.return;
        if (!confirm('确认代用户归还该充电宝？\n\n12小时内：押金退还；超过12小时：押金不予退还。')) return;
        btn.disabled = true; btn.textContent = '处理中...';
        req('return', { id: id }).then(function (res) {
          alert(res.msg || (res.ok ? '已归还' : '操作失败'));
          loadOrders(); loadStats();
        });
      });
    });

    Array.prototype.forEach.call(tb.querySelectorAll('[data-close]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.close;
        if (!confirm('确认关闭该充电宝使用？\n\n关闭即判定为超时，押金不予退还。\n关闭后设备恢复可租借，该用户再次扫码将重新进入租借页面。')) return;
        btn.disabled = true; btn.textContent = '处理中...';
        req('close', { id: id }).then(function (res) {
          alert(res.msg || (res.ok ? '已关闭' : '操作失败'));
          loadOrders(); loadStats();
        });
      });
    });
    tickTimers();
  }

  /* ---------- 押金剩余退还时长倒计时 ---------- */
  function tickTimers() {
    var now = Math.floor(Date.now() / 1000);
    Array.prototype.forEach.call(document.querySelectorAll('.timer'), function (el) {
      var left = Number(el.dataset.limit) - now;
      var start = Number(el.dataset.start);
      if (left > 0) {
        el.className = 'timer';
        el.textContent = '剩 ' + hms(left);
        el.title = '截止 ' + fmtDT(Number(el.dataset.limit)) + ' 前归还可退押金';
      } else {
        el.className = 'timer over';
        el.textContent = '超时 ' + hms(now - Number(el.dataset.limit)) + '（已用 ' + hms(now - start) + '）';
        el.title = '已超过押金退还时限，押金不予退还';
      }
    });
  }
  setInterval(tickTimers, 1000);

  /* ---------- 工具条 ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (c) {
    c.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (n) { n.classList.remove('active'); });
      c.classList.add('active');
      cur.filter = c.dataset.filter; cur.page = 1;
      loadOrders();
    });
  });
  $('btnSearch').addEventListener('click', function () { cur.q = $('q').value.trim(); cur.page = 1; loadOrders(); });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnSearch').click(); });
  $('btnRefresh').addEventListener('click', function () { loadOrders(); loadStats(); });
  $('prev').addEventListener('click', function () { if (cur.page > 1) { cur.page--; loadOrders(); } });
  $('next').addEventListener('click', function () { if (cur.page < cur.pages) { cur.page++; loadOrders(); } });

  /* ---------- 二维码页 ---------- */
  $('copyUrl').addEventListener('click', function () {
    var t = $('qrUrl').textContent;
    if (navigator.clipboard) { navigator.clipboard.writeText(t).then(function () { alert('已复制：' + t); }); }
    else { alert('链接：' + t); }
  });

  /* ---------- 系统设置 ---------- */
  function loadSettings() {
    req('settings').then(function (res) {
      if (!res.ok) return;
      var s = res.settings;
      ['brand_name', 'device_id', 'store', 'deposit', 'refund_hour', 'hourly_fee', 'cap24', 'cap_total'].forEach(function (k) {
        $('f_' + k).value = s[k];
      });
      $('f_admin_pass').value = '';
    });
  }
  $('setForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = {
      brand_name: $('f_brand_name').value,
      device_id: $('f_device_id').value, store: $('f_store').value,
      deposit: $('f_deposit').value, refund_hour: $('f_refund_hour').value,
      hourly_fee: $('f_hourly_fee').value, cap24: $('f_cap24').value,
      cap_total: $('f_cap_total').value, admin_pass: $('f_admin_pass').value
    };
    req('settings_save', body).then(function (res) {
      $('setMsg').textContent = res.ok ? '已保存' : (res.msg || '保存失败');
      $('setMsg').style.color = res.ok ? '#07c160' : '#fa5151';
      setTimeout(function () { $('setMsg').textContent = ''; }, 2500);
    });
  });

  /* ---------- 支付通道 ---------- */
  var PAY_FIELDS = ['pay_base_url', 'wx_appid', 'wx_appsecret', 'wx_mchid', 'wx_serial_no',
                    'wx_apiv3_key', 'wx_private_key', 'wx_platform_pubkey',
                    'ali_appid', 'ali_private_key', 'ali_public_key',
                    'epay_gateway', 'epay_pid', 'epay_key'];

  /** 按所选支付模式显示对应的参数面板 */
  function syncPayBlocks() {
    var mode = $('f_pay_channel').value;
    $('wxBlock').style.display   = (mode === 'auto' || mode === 'wechat') ? '' : 'none';
    $('aliBlock').style.display  = (mode === 'auto' || mode === 'alipay') ? '' : 'none';
    $('epayBlock').style.display = mode === 'epay' ? '' : 'none';
  }
  $('f_pay_channel').addEventListener('change', syncPayBlocks);

  function loadPaySettings() {
    req('pay_settings').then(function (res) {
      if (!res.ok) return;
      var f = res.fields;
      $('f_pay_channel').value = f.pay_channel;
      PAY_FIELDS.forEach(function (k) { $('f_' + k).value = f[k] || ''; });
      if ($('f_epay_type')) $('f_epay_type').value = f.epay_type || 'auto';
      $('cbWechat').textContent  = res.notify.wechat;
      $('cbAlipay').textContent  = res.notify.alipay;
      $('cbEpay').textContent    = res.notify.epay;
      syncPayBlocks();
      renderPayState(res);
    }).catch(function () {});
  }

  function renderPayState(res) {
    var mode = res.fields.pay_channel;
    var c = res.check || {};
    var rows = [];
    rows.push('当前模式：<b>' + (CHANNEL[mode] || mode) + '</b>');

    function line(label, err) {
      var ok = !err;
      rows.push(label + '：' + (ok
        ? '<span style="color:#07c160">✓ 参数齐全</span>'
        : '<span style="color:#fa5151">✗ ' + esc(err) + '</span>'));
    }
    if (mode === 'demo') {
      rows.push('<span style="color:#b26b00">模拟支付不会真实扣款，仅用于演示与联调。</span>');
    } else {
      if (mode === 'wechat' || mode === 'auto') line('微信 JSAPI', c.wechat);
      if (mode === 'alipay' || mode === 'auto')  line('支付宝手机网站支付', c.alipay);
      if (mode === 'epay')                       line('彩虹易支付', c.epay);
    }
    rows.push('回调地址（微信）：<code>' + esc(res.notify.wechat) + '</code>');
    rows.push('回调地址（支付宝）：<code>' + esc(res.notify.alipay) + '</code>');
    rows.push('回调地址（彩虹易支付）：<code>' + esc(res.notify.epay) + '</code>');
    if (mode !== 'demo' && res.base_url.indexOf('https://') !== 0) {
      rows.push('<span style="color:#fa5151">当前地址不是 HTTPS，真实支付回调将无法送达；请部署到 HTTPS 备案域名并填写「对外访问地址」。</span>');
    }
    $('payState').innerHTML = rows.join('<br>');
  }

  /* 彩虹易支付「测试连接」：直接向网关发起查单，把网关原话显示出来 */
  $('btnEpayTest').addEventListener('click', function () {
    var m = $('epayTestMsg');
    m.style.color = '#888';
    m.textContent = '正在连接易支付网关...';
    req('pay_epay_test', {
      epay_gateway: $('f_epay_gateway').value,
      epay_pid: $('f_epay_pid').value,
      epay_key: $('f_epay_key').value
    }).then(function (res) {
      m.style.color = res.ok ? '#07c160' : '#fa5151';
      m.textContent = res.ok ? ('✓ ' + res.msg) : ('✗ ' + res.msg);
    }).catch(function () {
      m.style.color = '#fa5151';
      m.textContent = '✗ 请求失败，请重试';
    });
  });

  $('payForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { pay_channel: $('f_pay_channel').value };
    PAY_FIELDS.forEach(function (k) { body[k] = $('f_' + k).value; });
    if ($('f_epay_type')) body.epay_type = $('f_epay_type').value;
    var msg = $('payMsg');
    msg.style.color = '#888'; msg.textContent = '保存中...';
    req('pay_save', body).then(function (res) {
      if (!res.ok) { msg.style.color = '#fa5151'; msg.textContent = res.msg || '保存失败'; return; }
      msg.style.color = '#07c160';
      msg.textContent = res.warn && res.warn.length ? ('已保存，但有提醒：' + res.warn.join('；')) : '已保存';
      loadPaySettings();
      setTimeout(function () { msg.textContent = ''; }, 6000);
    }).catch(function () { msg.style.color = '#fa5151'; msg.textContent = '保存失败'; });
  });

  /* ---------- 登录 ---------- */
  function showLogin() {
    document.getElementById('loginWrap').classList.remove('hidden');
    document.getElementById('appWrap').classList.add('hidden');
  }
  function showApp() {
    document.getElementById('loginWrap').classList.add('hidden');
    document.getElementById('appWrap').classList.remove('hidden');
  }

  var loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var pass = document.getElementById('loginPass').value;
      fetch(API + '?action=login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pass: pass })
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res.ok) {
          if (res.token) { setToken(res.token); }
          location.reload();
        }
        else { document.getElementById('loginMsg').textContent = res.msg || '登录失败'; }
      }).catch(function () { document.getElementById('loginMsg').textContent = '请求失败'; });
    });
  }

  /* ---------- 设备二维码 ---------- */
  function setupQR() {
    var frontendUrl = location.origin + location.pathname.replace(/admin\.html$/, 'index.html');
    // 若前端部署在 /frontend/ 下，修正
    if (location.pathname.indexOf('/frontend/') !== -1) {
      frontendUrl = location.origin + location.pathname.replace(/\/frontend\/admin\.html$/, '/frontend/index.html');
    }
    var img = document.getElementById('qrImg');
    if (img) img.src = API_BASE + '/qrcode.php?size=8&data=' + encodeURIComponent(frontendUrl);
    var urlbox = document.getElementById('qrUrl');
    if (urlbox) urlbox.textContent = frontendUrl;
    var sub = document.getElementById('brandName');
    // 品牌名从设置加载后更新副标题
  }

  /* ---------- 启动 ---------- */
  (function () {
    var opt = { credentials: 'include', headers: {} };
    var tk = getToken();
    if (tk) { opt.headers['X-Admin-Token'] = tk; }
    fetch(API + '?action=me', opt)
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.login) {
          showApp();
          // 品牌名
          req('settings').then(function (s) {
            if (s && s.ok && s.settings && s.settings.brand_name) {
              var bn = document.getElementById('brandName');
              if (bn) bn.textContent = s.settings.brand_name;
            }
          }).catch(function () {});
          setupQR();
          loadStats();
          loadOrders();
          setInterval(function () { loadStats(); }, 15000);
        } else {
          showLogin();
        }
      })
      .catch(function () { showLogin(); });
  })();
})();

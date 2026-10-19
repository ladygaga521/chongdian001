(function () {
  // 前后端分离：前端通过该地址访问后端接口，可按部署环境修改
  var base = window.API_BASE || localStorage.getItem('pb_api_base');
  if (!base) {
    if (location.pathname.indexOf('/frontend/') !== -1) {
      base = '../backend';
    } else {
      base = '/backend';
    }
  }
  window.API_BASE = String(base).replace(/\/+$/, '');
})();
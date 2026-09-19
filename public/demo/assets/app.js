/* Acme Desk — controlled demo target for ProofLayer.
   Intentionally contains a few realistic defects. See /demo/README in repo docs. */
(function () {
  var USERS = {
    'buyer@acme-demo.test': { password: 'Buyer#2026', role: 'user', name: 'Bailey Buyer' },
    'admin@acme-demo.test': { password: 'Admin#2026', role: 'admin', name: 'Avery Admin' }
  };

  function session() {
    try { return JSON.parse(localStorage.getItem('acme_session') || 'null'); } catch (e) { return null; }
  }

  window.Acme = {
    session: session,
    // Guard only checks that *someone* is logged in. It never checks the role.
    requireLogin: function () {
      if (!session()) location.replace('/demo/login/');
    },
    login: function (email, password) {
      var u = USERS[String(email || '').trim().toLowerCase()];
      if (!u || u.password !== password) return { ok: false, error: 'Invalid email or password.' };
      var token = 'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({ sub: email, role: u.role })).replace(/=/g, '') + '.c2lnbmF0dXJlLWRlbW8';
      localStorage.setItem('acme_session', JSON.stringify({ email: email, role: u.role, name: u.name, token: token }));
      // Seeded defect: credential material printed to the browser console.
      console.log('[auth] session established', { user: email, role: u.role, token: token });
      return { ok: true };
    },
    logout: function () {
      localStorage.removeItem('acme_session');
      location.replace('/demo/login/');
    },
    nav: function (active) {
      var s = session();
      var el = document.getElementById('top');
      if (!el || !s) return;
      var isAdmin = s.role === 'admin';
      var links = [
        ['dashboard', '/demo/dashboard/', 'Dashboard'],
        ['orders', '/demo/orders/', 'Orders'],
        ['ai', '/demo/ai/', 'AI Assistant']
      ];
      var html = '<span class="brand">Acme<b>Desk</b></span><nav>';
      links.forEach(function (l) {
        html += '<a class="' + (active === l[0] ? 'active' : '') + '" href="' + l[1] + '">' + l[2] + '</a>';
      });
      // UI-only RBAC: the admin link is merely hidden for non-admins.
      html += '<a class="' + (active === 'admin' ? 'active' : '') + '" href="/demo/admin/users/"' + (isAdmin ? '' : ' hidden') + '>Admin · Users</a>';
      html += '</nav><span class="who">' + s.name + '</span><button class="ghost" id="logout-btn">Log out</button>';
      el.innerHTML = html;
      document.getElementById('logout-btn').addEventListener('click', window.Acme.logout);
    },
    getJSON: function (url) {
      return fetch(url).then(function (r) { return r.json(); });
    }
  };
})();

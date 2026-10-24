// Amazon.co.jp 注文履歴を商品単位でCSVにする本体。
// popup.js から chrome.scripting.executeScript でページ内に注入して実行する。
// データはすべてブラウザ内で処理し、外部には送信しない。
async function amazonOrderCsvCollect(opts) {
  const { timeFilter, monthFrom, monthTo, delayMs = 800 } = opts; // dryRun: 検証用（ダウンロードせず結果を返す）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parser = new DOMParser();
  const yen = (s) => {
    if (!s) return '';
    const m = String(s).replace(/,/g, '').match(/-?￥?\s*(-?\d+)/);
    return m ? Number(m[1]) * (/-\s*￥|^-|－/.test(String(s).trim()) ? -1 : 1) : '';
  };
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const parseDate = (s) => {
    const m = String(s).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    return m ? `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}` : '';
  };

  // --- 進捗表示 ---
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#232f3e;color:#fff;' +
    'padding:12px 16px;border-radius:8px;font:14px/1.5 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:360px';
  document.body.appendChild(box);
  const status = (msg) => (box.textContent = '注文履歴CSV: ' + msg);

  const fetchDoc = async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const html = await res.text();
    if (/ap\/signin|name="signIn"/.test(res.url + html.slice(0, 5000)) && !/order-card|orderDetailsTitle/.test(html)) {
      throw new Error('ログインが必要です。Amazonにログインしてから再実行してください。');
    }
    return parser.parseFromString(html, 'text/html');
  };

  // 注文一覧ページは中身がスクリプトで描画されるため、fetchでは読めない。
  // 見えないiframeで実際に表示させ、描画が落ち着いてから読み取る。
  const loadListPage = (url, timeout = 30000) =>
    new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0';
      f.src = url;
      document.body.appendChild(f);
      const t0 = Date.now();
      let last = -1, stableSince = 0;
      const done = (fn) => { clearInterval(iv); fn(); setTimeout(() => f.remove(), 0); };
      const iv = setInterval(() => {
        try {
          const d = f.contentDocument;
          if (Date.now() - t0 > timeout) return done(() => reject(new Error('注文一覧の読み込みがタイムアウトしました。')));
          if (!d || d.readyState !== 'complete') return;
          if (/\/ap\/signin/.test(f.contentWindow.location.pathname))
            return done(() => reject(new Error('ログインが必要です。Amazonにログインしてから再実行してください。')));
          const cards = [...d.querySelectorAll('.order-card')];
          const sig = cards.length * 1000 + cards.filter((c) => c.querySelector('.yohtmlc-order-id')).length;
          if (sig !== last) { last = sig; stableSince = Date.now(); return; }
          if (Date.now() - stableSince > 1500) done(() => resolve(cards.map((c) => c.cloneNode(true))));
        } catch (e) {
          done(() => reject(e));
        }
      }, 300);
    });

  try {
    // 1) 注文一覧を全ページ取得（新しい順。開始月より古いページに達したら打ち切る）
    const orders = [];
    const seen = new Set();
    for (let page = 0; page < 50; page++) {
      status(`注文一覧 ${page + 1}ページ目を取得中…`);
      const cards = await loadListPage(`/your-orders/orders?timeFilter=${encodeURIComponent(timeFilter)}&page=${page}`);
      if (!cards.length) break;
      let added = 0, newest = '';
      for (const c of cards) {
        const id = (text(c.querySelector('.yohtmlc-order-id')).match(/[0-9A-Z]{3}-\d{7}-\d{7}/) || [])[0];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        added++;
        const items = c.querySelectorAll('.order-header__header-list-item');
        let date = '', total = '';
        items.forEach((li) => {
          const t = text(li);
          if (t.startsWith('注文日')) date = parseDate(t);
          else if (t.startsWith('合計')) total = yen(t);
        });
        const titles = [...c.querySelectorAll('.yohtmlc-product-title')].map(text);
        orders.push({ id, date, total, titles });
        if (date && date > newest) newest = date;
      }
      if (!added) break;
      if (monthFrom && newest && newest.slice(0, 7).replace('/', '-') < monthFrom) break;
      await sleep(delayMs);
    }

    // 2) 月で絞り込み
    const inRange = (o) => {
      if (!o.date) return true;
      const ym = o.date.slice(0, 7).replace('/', '-');
      return (!monthFrom || ym >= monthFrom) && (!monthTo || ym <= monthTo);
    };
    const targets = orders.filter(inRange);
    if (!targets.length) {
      status('対象期間の注文が見つかりませんでした。');
      setTimeout(() => box.remove(), 6000);
      return { ok: true, orders: 0, rows: 0 };
    }

    // 3) 各注文の詳細ページから商品単位の情報を取得
    const rows = [];
    const sel = (s) => `[data-component="${s}"]`;
    for (let i = 0; i < targets.length; i++) {
      const o = targets[i];
      status(`注文詳細 ${i + 1}/${targets.length} を取得中…`);
      const url = `/your-orders/order-details?orderID=${o.id}`;
      let d;
      try {
        d = await fetchDoc(url);
      } catch (e) {
        d = null;
      }
      // 注文概要（小計・割引・ご請求額など）
      const summary = {};
      const notes = [];
      const cs = d && d.querySelector(sel('chargeSummary'));
      if (cs) {
        cs.querySelectorAll('.a-row, li').forEach((r) => {
          const t = text(r);
          const m = t.match(/^(.+?)[：:]\s*(-?\s*￥\s*-?[\d,]+)/);
          if (!m) return;
          const k = m[1].trim();
          if (summary[k] !== undefined) return;
          summary[k] = yen(m[2]);
          if (!/商品の小計|注文合計|ご請求額|配送料・手数料/.test(k) && summary[k]) notes.push(`${k} ${summary[k]}`);
        });
      }
      const titles = d ? [...d.querySelectorAll(sel('itemTitle'))] : [];
      const base = {
        注文日: o.date || parseDate(text(d && d.querySelector(sel('orderDate')))),
        注文番号: o.id,
        商品の小計: summary['商品の小計'] ?? '',
        配送料: summary['配送料・手数料'] ?? '',
        注文合計: summary['注文合計'] ?? o.total,
        ご請求額: summary['ご請求額'] ?? o.total,
        割引等: notes.join(' / '),
        URL: location.origin + url,
      };
      if (!titles.length) {
        // デジタル注文など、詳細ページの形式が違う場合は一覧の情報だけ出す
        (o.titles.length ? o.titles : ['(商品情報を取得できませんでした)']).forEach((t) =>
          rows.push({ ...base, 商品名: t, 単価: '', 数量: '', 金額: '' })
        );
      } else {
        for (const t of titles) {
          // その商品だけを含む最小のまとまり（単価を含むところ）まで遡る
          let e = t;
          while (
            e.parentElement &&
            !e.querySelector(sel('unitPrice')) &&
            e.parentElement.querySelectorAll(sel('itemTitle')).length === 1
          ) e = e.parentElement;
          const price = yen(text(e.querySelector(`${sel('unitPrice')} .a-offscreen`) || e.querySelector(sel('unitPrice'))));
          // 数量：1個のときは表示されない。画像右下の数字か quantity 欄から取る
          let item = e;
          while (item.parentElement && item.parentElement.querySelectorAll(sel('itemTitle')).length === 1) item = item.parentElement;
          const qtyText =
            text(e.querySelector(sel('quantity'))) ||
            text(item.querySelector('.od-item-view-qty, .product-image__qty'));
          const qty = Number((qtyText.match(/\d+/) || ['1'])[0]);
          rows.push({
            ...base,
            商品名: text(t),
            単価: price,
            数量: qty,
            金額: price === '' ? '' : price * qty,
          });
        }
      }
      if (i < targets.length - 1) await sleep(delayMs);
    }

    // 4) CSV（BOM付きUTF-8）を作ってダウンロード
    const cols = ['注文日', '注文番号', '商品名', '単価', '数量', '金額', '商品の小計', '配送料', '注文合計', 'ご請求額', '割引等', 'URL'];
    const esc = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    rows.sort((a, b) => (a.注文日 < b.注文日 ? -1 : a.注文日 > b.注文日 ? 1 : 0));
    const csv = '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
    if (opts.dryRun) { box.remove(); return { ok: true, orders: targets.length, rows }; }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const label = monthFrom || monthTo ? `${monthFrom || ''}_${monthTo || ''}` : timeFilter;
    a.href = URL.createObjectURL(blob);
    a.download = `amazon_orders_${label}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    status(`完了：${targets.length}件の注文、${rows.length}商品をCSVに出力しました。`);
    setTimeout(() => box.remove(), 8000);
    return { ok: true, orders: targets.length, rows: rows.length };
  } catch (e) {
    status('エラー：' + e.message);
    setTimeout(() => box.remove(), 15000);
    return { ok: false, error: e.message };
  }
}

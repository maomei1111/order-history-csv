// 寄付ページのURL（OFUSE・Buy Me a Coffee など）。空のままならリンクは表示されません。
const DONATE_URL = 'https://ofuse.me/5a63d51c';

const $ = (id) => document.getElementById(id);
const now = new Date();
const thisYear = now.getFullYear();
const thisMonth = now.getMonth() + 1;

for (let y = thisYear; y >= thisYear - 10; y--) $('year').add(new Option(`${y}年`, y));
for (const id of ['from', 'to']) for (let m = 1; m <= 12; m++) $(id).add(new Option(`${m}月`, m));

// 既定：先月〜今月（年をまたぐ場合は前年12月〜12月）
if (thisMonth === 1) {
  $('year').value = thisYear - 1; $('from').value = 12; $('to').value = 12;
} else {
  $('from').value = thisMonth - 1; $('to').value = thisMonth;
}

const msg = (s) => ($('msg').textContent = s);
const ORDER_URL = 'https://www.amazon.co.jp/gp/css/order-history';

$('run').addEventListener('click', async () => {
  const year = Number($('year').value);
  let from = Number($('from').value), to = Number($('to').value);
  if (from > to) [from, to] = [to, from];
  const pad = (m) => String(m).padStart(2, '0');
  const opts = { timeFilter: `year-${year}`, monthFrom: `${year}-${pad(from)}`, monthTo: `${year}-${pad(to)}` };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.amazon\.co\.jp\//.test(tab.url || '')) {
    msg('Amazon.co.jp のタブで実行してください。注文履歴ページを開きます。もう一度このボタンを押してください。');
    if (tab) await chrome.tabs.update(tab.id, { url: ORDER_URL });
    else await chrome.tabs.create({ url: ORDER_URL });
    return;
  }

  $('run').disabled = true;
  msg('取得中です。ページ右下に進捗が出ます。\n（この画面は閉じても処理は続きます）');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['collector.js'], world: 'MAIN' });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (o) => amazonOrderCsvCollect(o),
      args: [opts],
    });
    const r = res && res.result;
    if (r && r.ok) msg(r.orders ? `完了：${r.orders}件の注文・${r.rows}商品を保存しました。` : '対象期間の注文はありませんでした。');
    else msg('エラー：' + ((r && r.error) || '不明なエラー'));
  } catch (e) {
    msg('エラー：' + e.message);
  } finally {
    $('run').disabled = false;
  }
});

if (DONATE_URL) {
  const a = $('donate');
  a.href = DONATE_URL;
  a.hidden = false;
  a.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: DONATE_URL }); });
}

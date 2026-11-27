
(() => {
  'use strict';
  const VERSION = 'v6.1 · iaydinlik';
  if (window.__sagaProd) { try { window.__sagaProd.destroy(); } catch (e) {} }

  /* ================== AYARLAR ================== */
  const CFG = {
    sel: {
      add:       '#toolbarCRUD_Productie > button.sg-type-button.sg-theme--heather.first-item__top.pull--left.buttonOperationAdd_Productie',
      save:      '#toolbarCRUD_Productie > button.sg-type-button.sg-theme--heather.pull--left.buttonOperationSave_Productie',
      code:      '#dropdownAlternateInput_CodArticol_Productie',
      qty:       '#inputBox_CANTITATE_Productie',
      validate:  '#extratoolbarValidez',
      warning:   '#textWarning',
      mainRow:   'tr.rowSelectable_Productie',              // üstteki ana listenin satırları
      detailTbl: '#tableMainDiv_ProductieDetalii',           // alttaki detay tablosu
      mainTbl:   '[id^="tableMainDiv_Productie"]:not([id*="Detalii"])', // üstteki ana liste (Validate All için)
      suggestion:'.ui-autocomplete li, .dropdown-menu li, [role="option"], .tt-suggestion, .autocomplete-suggestion',
    },
    urlRegex: /Productie\/?([?#].*)?$/i,
    ms: {
      afterAdd: 900, typeChar: 25, afterCode: 1200, afterQty: 300,
      afterSave: 1500, saveWait: 5000, validateWait: 5000, validateWaitAfterDelete: 8000, step: 450, afterSelect: 500, afterChoiceWait: 15000,
    },
    maxValidateRounds: 40,   // bir kayıt için en fazla Validate turu
    clearNr: true,            // kayıttan hemen önce Nr. doc alanında bir şey yazıyorsa temizle
    deletePosterior: true,    // "posterioare datei" sorusundaki kalem, Da(toate)'ten sonra da kilit kapanmazsa detaydan silinir
    priceAdjust: false,       // true: PRET'i bölme sonucunun ±3 binde birinde VALOARE'yi en iyi eşitleyecek şekilde seç (varsayılan: düz CONSUMURI / CANTITATE)
    fixPrice: true,           // Validate bitince CONSUMURI nihai değerine ulaşır; VALOARE ≠ CONSUMURI ise: Devalidez -> PRET = CONSUMURI / CANTITATE -> Alt+S -> tekrar Validate
    verifyLock: false,         // Validate sonrası satırın kilidinin kapandığını kontrol et (grid canlı güncellenmiyorsa false yap)
    confirmValidateAll: true, // Validate All başlamadan önce onay sor (false: sormadan başla)
    pauseOnUnknown: true,     // bilinmeyen Da/Nu sorusunda hata verme: loga yaz, elle cevaplanmasını bekle (en çok 10 dk), sonra devam et
    bigJob: 100,              // bu kadar kayıttan fazlası bulunursa başlamadan önce onay sor
    retries: 2,               // geçici hatalarda (satır bulunamadı vb.) kayıt başına yeniden deneme
    scanMs: 180000,           // tek bir tarama için en çok süre (takılmayı önler)
    stopOnError: true,       // bir satır hata verirse tüm işlem dursun
    decimalComma: false,     // true: 2.5 -> "2,5"
    // Uyarıdaki: "...la articolul PRAF DE COPT (90000005) este mai mare..." -> 1. grup ad, 2. grup kod
    warnRegex: /articolul\s+(.+)\s+\(([^()]+)\)/i,
    // Kayıt/validate sırasında çıkabilen Da/Nu onay penceresi (#textChoice). Metin eşleşirse btn tıklanır.
    // Burada olmayan bir soru çıkarsa script cevaplamaz: soruyu loga yazar ve sen elle cevaplayana kadar bekler (pauseOnUnknown).
    confirms: [
      { re: /prestabilit/i, btn: '#buttonChooseYes', label: 'Da (Enter)' },
      { re: /devalid/i, btn: '#buttonChooseYes', label: 'Da' },                    // Devalidez onay sorusu
      { re: /renun/i, btn: '#buttonChooseYes', label: 'Da' },                   // Renunt (vazgeç) onay sorusu
      // Adet değişince kayıtta çıkar: "Cantitatea a fost modificata la produsul X. Doriti actualizarea consumurilor conform retetei?" -> Da
      { re: /actualizarea consumurilor/i, btn: '#buttonChooseYes', label: 'Da (tüketimler reçeteye göre güncellensin)' },
      // "Se incearca descarcarea unei intrari posterioare datei documentului. ... Continuam?" -> Da (toate), yoksa Da
      { re: /posterioare datei/i, btn: ['#buttonChooseYesAll', '#buttonChooseYes'], label: 'Da (toate)', enter: false, collect: true },   // "Sunteti sigur ca nu doriti completarea pretului prestabilit?"
    ],
    storeKey: '__sagaProdList',
  };

  /* ================== YARDIMCILAR ================== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const isProductie = () => CFG.urlRegex.test(location.href);
  const state = { list: [], running: false, stop: false, raw: [], seq: 1 };
  const checkStop = () => { if (state.stop) throw new Error('STOP'); };
  let host;

  // Hata türleri: transient = geçici (yeniden denenebilir), skip = ürün bulunamadı vb. (atlanır, işlem durmaz)
  const terr = msg => { const e = new Error(msg); e.transient = true; return e; };
  const skipErr = msg => { const e = new Error(msg); e.skip = true; return e; };
  const isOnline = () => navigator.onLine !== false;
  async function waitOnline() {
    if (isOnline()) return;
    log('İnternet yok, bağlantı bekleniyor…', 'warn');
    while (!isOnline()) { checkStop(); await sleep(1500); }
    log('Bağlantı geri geldi, devam ediliyor', 'good');
    await sleep(1500);
  }

  async function waitFor(fn, timeout = 8000, step = 100) {
    let t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      checkStop();
      if (!isOnline()) { const p = Date.now(); await waitOnline(); t0 += Date.now() - p; }   // çevrimdışı süre zaman aşımına sayılmaz
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // Ürün adı normalleştirme: büyük harf, aksansız, noktalama yok, "(OTOPENI)" eki yok
  const normName = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[()\[\],.;:\/\\\-+*'"]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(w => w && w !== 'OTOPENI').join(' ');

  // Ad -> kod önbelleği (kalıcı)
  const NAME_KEY = '__sagaProdNames';
  let nameMap = {};
  try { nameMap = JSON.parse(localStorage.getItem(NAME_KEY) || '{}'); } catch (e) {}
  const saveNames = () => { try { localStorage.setItem(NAME_KEY, JSON.stringify(nameMap)); } catch (e) {} };
  function learnName(name, code) {
    const k = normName(name);
    if (k && /^\d{4,}$/.test(String(code || '')) && nameMap[k] !== code) { nameMap[k] = code; saveNames(); }
  }
  // Ana listede görünen satırlardan (kod + denumire) ad -> kod öğren
  function harvestNames() { try { mainRows().forEach(r => learnName(fieldText(r, 'DENUMIRE'), fieldText(r, 'COD'))); } catch (e) {} }

  const KEYS = { Enter: 13, Escape: 27, Delete: 46, Tab: 9, ArrowDown: 40 };
  const PUNCT = { '.': [190, 'Period'], ',': [188, 'Comma'], '-': [189, 'Minus'], '_': [189, 'Minus'], '/': [191, 'Slash'], ' ': [32, 'Space'], ':': [186, 'Semicolon'], ';': [186, 'Semicolon'], '+': [187, 'Equal'], '(': [57, 'Digit9'], ')': [48, 'Digit0'], '*': [56, 'Digit8'], "'": [222, 'Quote'], '"': [222, 'Quote'] };
  function key(k, opt = {}, target) {
    let t = target || document.activeElement || document.body;
    if (t === host || (host && host.contains(t))) t = document.body;
    // Gerçek klavye kodları: '.' = 190 (46 DELETE'tir!), ',' = 188, '-' = 189, '(' = Shift+9 ...
    let kc = 0, code = 'Unidentified';
    if (KEYS[k]) { kc = KEYS[k]; code = k; }
    else if (/^[a-z]$/i.test(k)) { kc = k.toUpperCase().charCodeAt(0); code = 'Key' + k.toUpperCase(); }
    else if (/^[0-9]$/.test(k)) { kc = k.charCodeAt(0); code = 'Digit' + k; }
    else if (PUNCT[k]) { kc = PUNCT[k][0]; code = PUNCT[k][1]; }
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      const ev = new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true, ...opt });
      Object.defineProperty(ev, 'keyCode', { get: () => kc });
      Object.defineProperty(ev, 'which', { get: () => kc });
      t.dispatchEvent(ev);
    });
  }

  function setVal(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function typeInto(el, text) {
    el.focus(); el.select && el.select();
    setVal(el, '');
    let cur = '';
    for (const ch of String(text)) {
      checkStop();
      cur += ch;
      key(ch, {}, el);
      setVal(el, cur);
      await sleep(CFG.ms.typeChar);
    }
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
  }

  function clickEl(el) {
    ['mousedown', 'mouseup', 'click'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
  }

  const toQty = a => {
    let s = String(a ?? '').trim().replace(/\s/g, '');
    if (CFG.decimalComma) s = s.replace('.', ',');
    else if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
    return s;
  };

  // Tarihi gg.aa.yyyy biçimine çevirir (Excel seri numarası, 30.04.2026, 30/04/2026, 2026-04-30). Geçersizse ''.
  function toDate(v) {
    if (v === '' || v == null) return '';
    const pad = n => String(n).padStart(2, '0');
    const fmt = (d, m, y) => (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100) ? `${pad(d)}.${pad(m)}.${y}` : '';
    const t = String(v).trim();
    if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(t)) {
      const n = +v;
      if (!(n > 20000 && n < 80000)) return '';
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return fmt(d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear());
    }
    let m = t.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
    if (m) return fmt(+m[1], +m[2], +m[3]);
    m = t.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (m) return fmt(+m[3], +m[2], +m[1]);
    return '';
  }
  const defaultDate = () => { const v = (q('dd') && q('dd').value) || ''; const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
  function resolveDate(row) {
    const raw = String(row.tarih || '').trim() || defaultDate();
    if (!raw) return '';                                  // boşsa sistemin kendi tarihi kalır
    const d = toDate(raw);
    if (!d) throw new Error('Tarih anlaşılamadı: ' + raw);
    return d;
  }

  /* ================== SAYFA İŞLEMLERİ ================== */
  const cellsOf = r => $$('td, [role="gridcell"]', r).map(c => norm(c.textContent)).filter(Boolean);

  function gridRows(sel) {
    const tbl = $(sel);
    if (!tbl) return [];
    let rows = $$('tbody tr', tbl);
    if (!rows.length) rows = $$('[role="row"]', tbl);
    return rows.filter(visible);
  }
  const detailRows = () => gridRows(CFG.sel.detailTbl);
  const mainRows = () => $$(CFG.sel.mainRow).filter(visible);

  // Da/Nu onay penceresi (#textChoice) açıksa kurala göre cevaplar; cevapladıysa true döner
  let postSeen = [];     // bu Validate denemesinde "posterioare datei" sorusunda adı geçen kalemler
  const choiceVisible = () => { const e = $('#textChoice'); return visible(e) ? e : null; };
  async function handleChoice() {
    const c = choiceVisible();
    if (!c) return false;
    const text = c.textContent.replace(/\s+/g, ' ').trim();
    if (/stergerea inregistrarii/i.test(text)) {          // "Stergere: ... stergerea inregistrarii curente?"
      const box0 = c.closest('.modal-content, .modal, [role="dialog"]') || document;
      const want = state.deleting ? /^\W*sterge\W*$/i : /^\W*(anuleaza|nu)\W*$/i;   // bizim detay silmemiz değilse İPTAL
      const b0 = $$('button, .btn, [role="button"]', box0).find(b => visible(b) && want.test(b.textContent.trim()));
      if (b0) { b0.click(); await waitFor(() => !visible(c), 1500, 100); }
      if (!state.deleting) throw terr('Beklenmeyen silme sorusu İPTAL edildi (kayıt silinmedi)');
      return true;
    }
    const rule = CFG.confirms.find(x => x.re.test(text));
    if (!rule) {
      if (!CFG.pauseOnUnknown) throw new Error('Bilinmeyen onay penceresi, dokunmadım: ' + text.slice(0, 160));
      log('   BİLİNMEYEN SORU (elle cevapla, bekliyorum): ' + text.slice(0, 200), 'err');
      const gone = await waitFor(() => !visible(c), 600000, 300);
      if (!gone) throw new Error('Bilinmeyen onay penceresi 10 dk cevaplanmadı: ' + text.slice(0, 160));
      log('   soru cevaplandı, devam ediliyor', 'good');
      await sleep(500);
      return true;
    }
    const box = c.closest('.modal-content, .modal, [role="dialog"]') || document;
    let btn = null;
    if (rule.btnText) btn = $$('button, .btn, [role="button"]', box).find(b => visible(b) && rule.btnText.test(b.textContent.trim()));
    if (!btn) btn = [].concat(rule.btn || []).map(x => $(x)).find(b => b && visible(b));   // ilk GÖRÜNÜR buton
    if (!btn) throw new Error('Onay butonu bulunamadı: ' + [].concat(rule.btn || []).join(' / ') + (rule.btnText ? ' / ' + rule.btnText : ''));
    log(`   onay: "${text.slice(0, 90)}" -> ${rule.label}`, 'warn');
    if (rule.enter !== false && !rule.btnText) key('Enter', {}, btn);   // önce Enter (Da zaten odakta)
    if (rule.enter === false || rule.btnText || !(await waitFor(() => !visible(c), 800, 100))) {   // kapanmadıysa / Enter istenmiyorsa butona tıkla
      btn.click();
      await waitFor(() => !visible(c), 1500, 100);
    }
    await sleep(400);
    return true;
  }

  const isEnabled = el => !!el && visible(el) && !el.disabled && !el.hasAttribute('disabled') && !/\bdisabled\b/i.test(el.className || '');

  // Alt+S: kayıt gerçekten bitene kadar bekler, çıkan onay pencerelerini cevaplar
  // Kendi detay silmemiz dışında ekranda "Anuleaza" butonlu (silme vb.) bir pencere varsa İPTAL et ve hata ver:
  // script körlemesine devam edip yanlış yere tıklamasın.
  async function handleStray() {
    if (state.deleting) return;
    const b = findDialogButton(/^\W*anuleaza\W*$/i);
    if (!b) return;
    const box = b.closest('.modal-content, .modal, [role="dialog"]');
    const text = box ? box.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
    log('   BEKLENMEYEN pencere iptal ediliyor (Anuleaza): ' + text, 'err');
    b.click();
    await sleep(500);
  }

  async function saveRecord() {
    const b = $(CFG.sel.save);
    if (b) b.click(); else key('s', { altKey: true }, document.body);
    const t0 = Date.now();
    while (Date.now() - t0 < CFG.ms.saveWait) {
      checkStop();
      await handleStray();
      if (await handleChoice()) continue;
      if (warnVisible()) return;                              // kayıt hatası, çağıran işler
      if (!isEnabled($(CFG.sel.save))) {                      // Kaydet pasifleşti = kayıt bitti
        await sleep(500);
        if (!choiceVisible() && !warnVisible()) return;
        continue;
      }
      await sleep(150);
    }
    log('   (kayıt bitti mi doğrulanamadı, devam ediliyor)', 'warn');
  }


  // Kod inputunun hemen altında açılan, kodu içeren en küçük görünür öğeyi bulur
  function findSuggestion(codeEl, code) {
    const ir = codeEl.getBoundingClientRect(), nc = norm(code);
    const skip = [$(CFG.sel.mainTbl), $(CFG.sel.detailTbl), host];
    let best = null, area = Infinity;
    $$('li, tr, div, span, a, td, p, [role="option"]').forEach(el => {
      if (!visible(el) || el === codeEl || el.contains(codeEl) || skip.some(s => s && s.contains(el))) return;
      const r = el.getBoundingClientRect();
      if (r.top < ir.bottom - 5 || r.top > ir.bottom + 450) return;
      if (r.right < ir.left || r.left > ir.right + 400) return;
      const t = norm(el.textContent);
      if (!t.includes(nc) || t.length > 250) return;
      const a = r.width * r.height;
      if (a > 0 && a < area) { area = a; best = el; }
    });
    return best;
  }

  async function pickCode(codeEl, code) {
    const nc = norm(code);
    const sug = await waitFor(() =>
      $$(CFG.sel.suggestion).find(e => visible(e) && norm(e.textContent).includes(nc)) || findSuggestion(codeEl, code), 2500, 150);
    if (sug) {
      log('   öneri seçildi: ' + sug.textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
      clickEl(sug);
      await sleep(400);
      return;
    }
    log('   öneri listesi bulunamadı, klavye ile deneniyor', 'warn');
    codeEl.focus();
    key('ArrowDown', {}, codeEl); await sleep(200);
    key('Enter', {}, codeEl); await sleep(300);
    key('Tab', {}, codeEl);
    codeEl.dispatchEvent(new Event('change', { bubbles: true }));
    codeEl.blur();
  }

  // Açık ekleme/düzenleme formundan vazgeç (Renunt)
  async function cancelEdit() {
    const b = $$('#toolbarCRUD_Productie button').find(x => visible(x) && /renunt/i.test(x.textContent));
    if (!b) return false;
    b.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      if (await handleChoice()) continue;
      if (!isEnabled($(CFG.sel.save))) return true;
      await sleep(150);
    }
    return !isEnabled($(CFG.sel.save));
  }

  // Kod kutusunun altında açılan öneri satırları
  function suggestionRows(codeEl) {
    let list = $$(CFG.sel.suggestion).filter(e => visible(e) && !host.contains(e));
    if (!list.length) {
      const ir = codeEl.getBoundingClientRect();
      list = $$('li, tr, [role="option"]').filter(el => {
        if (!visible(el) || el.contains(codeEl) || el.closest('tr.rowSelectable_Productie, tr.rowSelectable_ProductieDetalii')) return false;
        const r = el.getBoundingClientRect();
        return r.top >= ir.bottom - 5 && r.top <= ir.bottom + 450 && r.right >= ir.left && r.left <= ir.right + 400;
      });
    }
    return list;
  }

  // Öneriler arasında ada en iyi uyan: tam eşit (3) veya ad ile başlayan (2). Daha zayıf eşleşme kabul edilmez.
  function bestSuggestion(codeEl, tn) {
    let best = null, bs = 0;
    for (const el of suggestionRows(codeEl)) {
      const raw = el.textContent.replace(/\s+/g, ' ').trim();
      if (!raw || raw.length > 250) continue;
      const m = raw.match(/\b(\d{4,})\b/), code = m ? m[1] : '';
      const cells = Array.from(el.children).map(c => normName(c.textContent)).filter(Boolean);
      const rest = normName(code ? raw.replace(code, ' ') : raw);
      let sc = 0;
      if (rest === tn || cells.includes(tn)) sc = 3;
      else if (rest.startsWith(tn + ' ')) sc = 2;
      if (!sc) continue;
      if (sc > bs || (sc === bs && /otopeni/i.test(raw) && !/otopeni/i.test(best.raw))) { best = { el, code, raw }; bs = sc; }
    }
    return best;
  }

  // Kod yoksa: adı koda yazıp açılan listeden seç. Bulamazsa '' döner.
  async function pickByName(codeEl, name) {
    const tn = normName(name);
    const clean = String(name).replace(/\s+/g, ' ').trim();
    const words = clean.split(' ');
    const queries = [clean];
    if (words.length >= 3) queries.push(words.slice(0, 2).join(' '));
    for (const qy of queries) {
      await typeInto(codeEl, qy);
      const best = await waitFor(() => bestSuggestion(codeEl, tn), 2500, 200);
      if (!best) continue;
      log('   ada göre öneri seçildi: ' + best.raw.slice(0, 80));
      clickEl(best.el);
      await sleep(400);
      const v = String(codeEl.value || '').trim();
      const code = best.code || (/^\d{4,}$/.test(v) ? v : '');
      if (code) learnName(name, code);
      return code || '*';
    }
    return '';
  }

  // Ekleme formundaki Tarih alanını doldurur (gg.aa.yyyy)
  async function setDateField(tarih) {
    if (!tarih) return;
    const sels = ['#inputBox_DATA_Productie', 'input[id$="_DATA_Productie"]', 'input[id*="DATA" i][id*="Productie"]', 'td.rowCell_DATA input'];
    const el = sels.map(s => $$(s).find(visible)).find(Boolean);
    if (!el) throw new Error('Tarih alanı bulunamadı (ekleme formunda Tarih input ID\'sini bildir)');
    await typeInto(el, tarih);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    await sleep(500);
    const digits = x => String(x || '').replace(/\D/g, '');
    if (digits(el.value) !== digits(tarih)) throw new Error(`Tarih yazılamadı: alan "${el.value}" gösteriyor (${tarih} istenmişti)`);
    log('   tarih: ' + tarih);
  }

  // Nr. doc alanı (td.rowCell_NR) otomatik numara yazmışsa kayıttan önce boşalt
  async function clearNr() {
    if (!CFG.clearNr) return;
    const sels = ['#inputBox_NR_Productie', 'input[id$="_NR_Productie"]', 'td.rowCell_NR input'];
    const el = sels.map(s => $$(s).find(visible)).find(Boolean);
    if (!el) { log('   (Nr. doc giriş alanı bulunamadı, temizleme atlandı)', 'warn'); return; }
    const old = (el.value || '').trim();
    if (!old) return;
    for (let i = 0; i < 2 && (el.value || '').trim(); i++) {
      el.focus(); el.select && el.select();
      if (i === 1) key('Delete', {}, el);
      setVal(el, '');
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
    }
    const left = (el.value || '').trim();
    log(left ? `   Nr. doc temizlenemedi (${left})` : `   Nr. doc temizlendi (${old})`, left ? 'err' : 'warn');
  }

  // Kod seçilince Gestiune otomatik dolmalı; boşsa kaydetmeden dur
  async function checkGestiune() {
    const els = $$('input[id*="estiune" i]').filter(visible);
    if (!els.length) { log('   (Gestiune alanı bulunamadı, kontrol atlandı)', 'warn'); return true; }
    const ok = await waitFor(() => els.some(e => e.value.trim()), 2500, 150);
    log('   Gestiune: ' + els.map(e => `${e.id}=${e.value.trim() || '(boş)'}`).join(' | '), ok ? '' : 'err');
    return !!ok;
  }

  async function addRecord(row) {
    if (!isProductie()) throw new Error('Productie sayfasında değilsin');
    const tarih = resolveDate(row);                       // geçersizse Ekle'ye basmadan hata ver
    if (!row.kod && !row.ad) throw skipErr('Kod ve ad boş');
    harvestNames();
    let code = row.kod || nameMap[normName(row.ad)] || '';
    if (!row.kod && code) log(`   ad -> kod (önbellek): ${row.ad} -> ${code}`);
    if (isEnabled($(CFG.sel.save))) {                     // önceki işlemden açık form kalmışsa kapat
      log('   açık düzenleme formu kapatılıyor (Renunt)', 'warn');
      await cancelEdit(); await sleep(400);
    }
    const addBtn = await waitFor(() => $(CFG.sel.add), 6000);
    if (!addBtn) throw terr('Ekle butonu bulunamadı');
    addBtn.click();
    await sleep(CFG.ms.afterAdd);

    const codeEl = await waitFor(() => { const x = $(CFG.sel.code); return visible(x) ? x : null; }, 8000);
    if (!codeEl) throw terr('Kod alanı açılmadı');
    await setDateField(tarih);                            // önce tarih, sonra kod (fiyat/stok tarihe göre gelir)
    if (code) {
      await typeInto(codeEl, code);
      await pickCode(codeEl, code);
    } else {
      const got = await pickByName(codeEl, row.ad);
      if (!got) { await cancelEdit(); throw skipErr(`Ürün bulunamadı: ${row.ad}`); }
      code = got;
    }
    await sleep(CFG.ms.afterCode);
    if (!(await checkGestiune())) { await cancelEdit(); throw skipErr('Ürün seçilemedi (Gestiune dolmadı): ' + (row.kod || row.ad)); }

    const qtyEl = await waitFor(() => { const x = $(CFG.sel.qty); return visible(x) ? x : null; }, 5000);
    if (!qtyEl) throw terr('Adet alanı bulunamadı');
    qtyEl.focus(); qtyEl.select && qtyEl.select();
    setVal(qtyEl, toQty(row.adet));
    qtyEl.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(CFG.ms.afterQty);
    await clearNr();                                       // en son Nr. doc'a bak, doluysa sil
    await saveRecord();                                    // her eklemeden sonra Alt+S
    const sw = await waitFor(warnVisible, 1200, 100);
    if (sw) {
      const t = (sw.innerText || sw.textContent || '').replace(/\s+/g, ' ').trim();
      await dismissModal(sw);
      if (/gestiun/i.test(t)) { await cancelEdit(); throw skipErr('Kayıt yapılamadı (gestiune dolmadı): ' + (row.kod || row.ad)); }
      throw new Error('Kayıt başarısız: ' + t);
    }
  }

  /* ---- Validate + hata modalları ---- */
  const warnVisible = () => { const e = $(CFG.sel.warning); return visible(e) && e.textContent.trim() ? e : null; };

  async function runValidate(wait = CFG.ms.validateWait, okFn = null) {
    await handleChoice();
    const btn = $(CFG.sel.validate);
    if (btn) btn.click(); else key('v', { altKey: true }, document.body);   // Alt+V
    let t0 = Date.now();
    while (Date.now() - t0 < wait) {
      checkStop();
      await handleStray();
      const w = warnVisible();
      if (w) return w;                                      // önce silinecek (stok) uyarısı varsa o işlensin
      if (await handleChoice()) { t0 = Date.now(); wait = Math.max(wait, CFG.ms.afterChoiceWait); continue; }   // sonra Da (toate)
      if (okFn && okFn()) return true;                      // satır kilitlendi = Validate başarılı, bekleme yok
      await sleep(150);
    }
    return null;
  }

  function parseWarn(text) {
    const raw = String(text).replace(/\s+/g, ' ').trim();
    const m = String(text).match(CFG.warnRegex);
    return { code: m ? m[2].trim() : '', name: m ? m[1].trim() : '', raw };
  }

  async function dismissModal(w) {
    const prev = norm(w.textContent);
    const closed = () => !visible(w) || norm(w.textContent) !== prev;   // aynı pencere yeni metinle açıldıysa da kapandı say
    const box = w.closest('.modal, [role="dialog"], .sg-modal') || w;
    key('Enter', {}, box);
    if (await waitFor(closed, 900, 100)) return;
    const btns = $$('button', box.parentElement || document).filter(visible);
    const ok = btns.find(b => /\bok\b/i.test(b.textContent)) || btns[0];
    if (ok) ok.click();
    await waitFor(closed, 1500, 100);
  }

  // Ardışık çıkan tüm uyarılara OK der, hepsinin bilgisini toplar
  async function collectWarnings(first) {
    const items = [];
    let w = first;
    while (w && items.length < 100) {
      const text = w.innerText || w.textContent || '';
      const p = parseWarn(text);
      log('   uyarı: ' + p.raw.slice(0, 150), 'warn');
      items.push(p);
      await dismissModal(w);
      const prev = norm(text);
      w = await waitFor(() => { const e = warnVisible(); return e && norm(e.textContent) !== prev ? e : null; }, 1000, 100);
    }
    return items;
  }

  function fuzzyMatch(rawText) {
    const w = norm(rawText);
    const data = detailRows().map(row => ({ row, cells: cellsOf(row) }));
    const freq = {};
    data.forEach(d => d.cells.forEach(c => { freq[c] = (freq[c] || 0) + 1; }));
    return data.find(d => d.cells.some(c =>
      c.length >= 3 && !(data.length > 1 && freq[c] > 1) && !(/^[\d.,:\/\-\s]+$/.test(c) && c.length < 5) && w.includes(c)));
  }

  function matchRow(item) {
    const data = detailRows().map(row => ({ row, cells: cellsOf(row) }));
    const c = norm(item.code), n = norm(item.name);
    let hit = c && data.find(d => d.cells.includes(c));
    if (!hit && n) hit = data.find(d => d.cells.includes(n));
    if (!hit && n) hit = data.find(d => d.cells.some(x => x.length >= 4 && (x.includes(n) || n.includes(x))));
    if (!hit && !c && !n) hit = fuzzyMatch(item.raw);
    return hit;
  }

  const findDialogButton = rx => $$('button, .btn, [role="button"]').find(b => visible(b) && !host.contains(b) && rx.test(b.textContent.trim()));

  async function deleteDetailRow(hit) {
    if (isEnabled($(CFG.sel.save))) {                      // ana kayıt düzenleme modundayken Delete tuşu ANA kaydı silme sorusu açar
      await cancelEdit();
      if (isEnabled($(CFG.sel.save))) throw terr('Ana kayıt düzenleme modunda: silme yapılmadı');
    }
    const before = detailRows().length;
    const cell = $$('td, [role="gridcell"]', hit.row)[2] || $('td, [role="gridcell"]', hit.row) || hit.row;
    state.deleting = true;
    try {
      clickEl(cell);
      await sleep(300);
      key('Delete', {}, cell);
      await sleep(CFG.ms.step);
      // silme onayı: "Stergere - Sunteti sigur ca doriti stergerea inregistrarii curente?" -> Sterge (Anuleaza değil)
      const dlg = await waitFor(() => findDialogButton(/^\W*sterge\W*$/i), 2500, 100);
      if (dlg) { dlg.click(); await sleep(300); }
      else key('Enter', {}, document.body);
      const done = await waitFor(() => detailRows().length < before, 2500, 100);
      if (!done) throw new Error('Silme çalışmadı (satır sayısı azalmadı)');
    } finally { state.deleting = false; }
  }

  async function findInDetail(item) {
    let hit = matchRow(item);
    if (hit) return hit;
    const sp = scrollParent($(CFG.sel.detailTbl));
    if (!sp) return null;
    const max = sp.scrollHeight - sp.clientHeight;
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {          // satırlar ekranda yoksa kaydırarak ara
      sp.scrollTop = max * f;
      await sleep(250);
      hit = matchRow(item);
      if (hit) return hit;
    }
    return null;
  }

  async function removeMissing(items) {
    let removed = 0;
    const seen = new Set();
    for (const it of items) {
      const k = (it.code || it.name || it.raw);
      if (seen.has(k)) continue;
      seen.add(k);
      const hit = await findInDetail(it);
      if (!hit) { log('   tabloda bulunamadı: ' + (it.name || it.code || it.raw.slice(0, 50)), 'warn'); continue; }
      if (detailRows().length <= 1) throw new Error('Son kalem silinecekti, durdum: ' + (it.name || it.code));
      const label = hit.row.innerText.replace(/\s+/g, ' ').trim().slice(0, 60);
      await deleteDetailRow(hit);
      removed++;
      log('   silindi: ' + label, 'warn');
    }
    if (!removed) throw new Error('Eksik kalem tabloda bulunamadı: ' + items.map(i => i.name || i.code).join(', '));
    return removed;
  }

  // Temiz olana kadar: Validate -> OK'lar -> Esc -> sil -> Alt+S -> tekrar
  async function validateCycle(ctx = null) {
    const okFn = ctx ? () => rowLocked(ctx) : null;
    let wait = CFG.ms.validateWait;
    for (let n = 1; n <= CFG.maxValidateRounds; n++) {
      checkStop();
      postSeen = [];
      const w = await runValidate(wait, okFn);
      if (w === true) return n;
      if (!w) {
        if (!okFn) return n;                                // satır izlenemiyorsa (ekleme, satır bulunamadı) eski davranış
        const md = $$('.modal, [role="dialog"]').filter(visible).map(x => x.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)[0];
        log('   Validate kilitlemedi ve uyarı vermedi' + (md ? '; ekranda pencere var: ' + md.slice(0, 120) : ''), 'warn');
        if (CFG.deletePosterior && postSeen.length) {
          log('   Onay sorusundaki kalem(ler) detaydan siliniyor: ' + postSeen.map(x => x.name || x.code || '?').join(', '), 'warn');
          const removed = await removeMissing(postSeen.map(x => ({ ...x })));
          log(`   tur ${n}: ${removed} kalem silindi, ${detailRows().length} kaldı`);
          await saveRecord();
          wait = CFG.ms.validateWaitAfterDelete;
          continue;
        }
        return n;
      }
      const items = await collectWarnings(w);
      log(`   tur ${n}: ${items.length} uyarı, tabloda ${detailRows().length} kalem`);
      const other = items.find(i => !i.code && !i.name);   // "articolul ... (kod)" formatında değil
      if (other) throw new Error('Beklenmeyen uyarı, hiçbir şey silinmedi: ' + other.raw.slice(0, 150));
      key('Escape', {}, document.body);
      await sleep(CFG.ms.step);
      const removed = await removeMissing(items);
      log(`   tur ${n}: ${removed} kalem silindi, ${detailRows().length} kaldı`);
      await saveRecord();
      wait = CFG.ms.validateWaitAfterDelete;   // silmeden sonra Validate daha geç cevap verebilir
    }
    throw new Error(`${CFG.maxValidateRounds} turda Validate temizlenmedi`);
  }

  /* ---- Üstteki ana listede kaydı seçme (Validate All) ---- */
  function scrollParent(el) {
    let hidden = null;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (p.scrollHeight <= p.clientHeight + 5) continue;
      const oy = getComputedStyle(p).overflowY;
      if (/(auto|scroll)/.test(oy)) return p;
      if (oy === 'hidden' && !hidden) hidden = p;        // özel kaydırma çubuğu kullanan listeler
    }
    return hidden;
  }
  async function selectRecord(kod) {
    const nk = norm(kod);
    const find = () => {
      const rows = mainRows();
      for (let i = rows.length - 1; i >= 0; i--) if (cellsOf(rows[i]).includes(nk)) return rows[i];   // en sondaki eşleşme
      return null;
    };
    let row = find();
    if (!row) {
      const first = $(CFG.sel.mainRow);
      const sp = first && scrollParent(first);
      if (sp) { sp.scrollTop = sp.scrollHeight; await sleep(700); row = find(); }
    }
    if (!row) throw new Error(`Ana listede ${kod} kodlu kayıt bulunamadı`);
    clickEl($('td, [role="gridcell"]', row) || row);
    await sleep(CFG.ms.afterSelect);
    return row;
  }

  /* ---- Validate All: ana listede kilidi açık (validate edilmemiş) kayıtlar ---- */
  const rowSig = r => r.dataset.rowid || cellsOf(r).join('|');
  const fieldText = (r, f) => { const e = r.querySelector('.rowFieldText_' + f); return e ? e.textContent.trim() : ''; };
  const rowLabel = r => ['DATA', 'COD', 'DENUMIRE', 'CANTITATE'].map(f => fieldText(r, f)).filter(Boolean).join(' / ');

  // Kilidi AÇIK = VALIDAT hücresinde fa-unlock-alt var ve fa-lock yok. Kilitli (validate edilmiş) satırlara dokunulmaz.
  function isUnlocked(r) {
    const cell = r.querySelector('td.rowCell_VALIDAT');
    return !!cell && !!cell.querySelector('i.fa-unlock-alt') && !cell.querySelector('i.fa-lock');
  }

  const ymdOf = t => { const m = String(t).match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? +(m[3] + m[2] + m[1]) : 0; };
  const ymdInput = v => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? +(m[1] + m[2] + m[3]) : 0; };
  const showDate = v => v ? v.split('-').reverse().join('.') : '';
  function getFilter() {
    const mode = (root.querySelector('input[name="vm"]:checked') || {}).value || 'all';
    const v1 = q('v1').value, v2 = q('v2').value, v3 = q('v3').value;
    if (mode === 'one') {
      if (!v1) throw new Error('Tek tarih seçilmedi');
      return { mode, from: ymdInput(v1), to: ymdInput(v1), text: showDate(v1) + ' tarihli' };
    }
    if (mode === 'range') {
      if (!v2 && !v3) throw new Error('Tarih aralığı seçilmedi');
      return { mode, from: ymdInput(v2), to: ymdInput(v3), text: `${showDate(v2) || '…'} – ${showDate(v3) || '…'} arası` };
    }
    return { mode: 'all', from: 0, to: 0, text: 'tüm tarihler' };
  }
  const rowYmd = r => ymdOf(toDate(fieldText(r, 'DATA')));
  const inFilter = (r, f) => {
    if (f.mode === 'all') return true;
    const d = rowYmd(r);
    return !!d && (!f.from || d >= f.from) && (!f.to || d <= f.to);
  };
  function listStats(f) {
    const rows = mainRows(), un = rows.filter(isUnlocked);
    const locked = rows.filter(r => r.querySelector('td.rowCell_VALIDAT') && !isUnlocked(r));
    return { rows, un, locked, match: un.filter(r => inFilter(r, f)) };
  }

  // Satıra tıklar ve gerçekten seçildiğini doğrular (Validate seçili kayda uygulanır!)
  const SELECT_CLS = /select|active|current|focus|highlight|marked/i;
  async function selectMainRow(row) {
    const id = rowSig(row);
    const find = () => mainRows().find(r => rowSig(r) === id) || row;
    for (let i = 0; i < 3; i++) {
      const r = find();
      try { r.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      clickEl(r.querySelector('td.rowCell_DENUMIRE') || r.querySelector('td.rowCell_COD') || r);
      await sleep(CFG.ms.afterSelect);
      const sels = mainRows().filter(x => SELECT_CLS.test(x.className.replace(/rowSelectable_Productie/g, '')));
      if (!sels.length) {
        if (i === 0) log('   (seçili satır sınıfı tanınmadı, doğrulanamadı: class="' + find().className + '")', 'warn');
        return;
      }
      if (sels.some(x => rowSig(x) === id)) return;
      log('   satır seçilemedi, tekrar deneniyor', 'warn');
    }
    throw terr('Satır seçilemedi, yanlış kayda Validate basılmaması için durdum');
  }

  // Ana listedeki bir satırı izlemek için: data-rowid varsa onunla, yoksa eleman referansıyla
  const ctxOf = r => ({ id: r.dataset.rowid || '', el: r });
  const getRow = c => c.id ? mainRows().find(x => x.dataset.rowid === c.id) : (c.el && c.el.isConnected && visible(c.el) ? c.el : null);

  async function verifyLocked(ctx) {
    if (!CFG.verifyLock) return;
    let r = null;
    const ok = await waitFor(() => { r = getRow(ctx); return !r || !isUnlocked(r); }, 8000, 200);
    if (!ok) throw terr('Validate bitti ama satırın kilidi kapanmadı (grid canlı güncellenmiyorsa CFG.verifyLock=false yap)');
    if (!r) log('   (satır ekranda değil, kilit kontrol edilemedi)', 'warn');
  }

  /* ---- Kilitlemeden önce: VALOARE ≠ CONSUMURI ise PRET = CONSUMURI / CANTITATE ---- */
  const parseNum = t => {
    let x = String(t).replace(/\s/g, '');
    if (!x) return NaN;
    if (x.includes(',') && x.includes('.')) x = x.replace(/,/g, '');
    else if (x.includes(',')) x = x.replace(',', '.');
    return parseFloat(x);
  };

  async function setPriceField(price) {
    const editBtn = $$('#toolbarCRUD_Productie button').find(b => visible(b) && /modific/i.test(b.textContent));
    if (!editBtn) throw new Error('Modific butonu bulunamadı');
    if (!isEnabled(editBtn)) throw new Error('Modific pasif (kayıt kilitli)');
    editBtn.click();
    const sels = ['#inputBox_PRET_Productie', 'input[id$="_PRET_Productie"]', 'input[id*="PRET" i][id*="Productie"]', 'td.rowCell_PRET input'];
    const el = await waitFor(() => sels.map(x => $$(x).find(i => visible(i) && i.type !== 'hidden')).find(Boolean), 6000);
    if (!el) throw new Error('Pret prestabilit alanı bulunamadı (düzenleme modunda bu input\'un ID\'sini bildir)');
    if (el.readOnly || el.disabled) throw new Error('Pret prestabilit alanı salt okunur (' + (el.id || 'id yok') + ')');
    await sleep(400);
    await typeInto(el, CFG.decimalComma ? price.replace('.', ',') : price);   // tuş tuş yaz (maskeli alanlar için)
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(CFG.ms.afterQty);
    const got = parseNum(el.value);                          // alan (maske vb.) girileni değiştirdiyse yanlış fiyat kaydetme
    if (Number.isNaN(got) || Math.abs(got - Number(price)) > 0.00015)
      throw new Error(`Fiyat alanı girilen değeri değiştirdi: istenen ${price}, alanda "${el.value}" (kaydedilmedi)`);
    await saveRecord();
    const sw = await waitFor(warnVisible, 1200, 100);
    if (sw) {
      const t = (sw.innerText || sw.textContent || '').replace(/\s+/g, ' ').trim();
      await dismissModal(sw);
      throw terr('Fiyat kaydedilemedi: ' + t);
    }
  }

  // PRET 4 ondalıklı olduğu için CONSUMURI / CANTITATE tam tutmayabilir: ±3 binde bir adım içinde VALOARE'yi
  // CONSUMURI'ye (2 ondalık) en yakın yapan fiyatı seçer. Eşitlikte bölme sonucuna en yakın olanı alır.
  function bestPrice(cons, qty) {
    const r2 = x => Math.round(x * 100) / 100;
    const base = Math.round(cons / qty * 10000);
    let best = base, bestErr = Infinity;
    for (let k = base - 3; k <= base + 3; k++) {
      if (k < 0) continue;
      const err = Math.abs(r2(qty * k / 10000) - r2(cons));
      if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) < 1e-9 && Math.abs(k - base) < Math.abs(best - base))) { best = k; bestErr = err; }
    }
    return { price: (best / 10000).toFixed(4), err: bestErr };
  }

  const findDevalidate = () => $('#extratoolbarDevalidez')
    || $$('[id^="extratoolbar"], button, a').find(el => visible(el) && el.textContent.trim().length < 30 && /devalidez/i.test(el.textContent));

  // Devalidez: kilidi açar (onay sorusu çıkarsa handleChoice cevaplar)
  async function devalidate(ctx) {
    const btn = findDevalidate();
    if (!btn) throw new Error('Devalidez butonu bulunamadı (butonun ID\'sini bildir)');
    btn.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      checkStop();
      if (await handleChoice()) continue;
      const w = warnVisible();
      if (w) {
        const t = (w.innerText || w.textContent || '').replace(/\s+/g, ' ').trim();
        await dismissModal(w);
        throw new Error('Devalidare uyarı verdi: ' + t);
      }
      const r = getRow(ctx);
      if (r && isUnlocked(r)) return;
      await sleep(150);
    }
    throw terr('Devalidare olmadı (kilit açılmadı)');
  }

  // Validate bittikten sonra CONSUMURI nihai değerine ulaşır. VALOARE ≠ CONSUMURI ise:
  // nihai CONSUMURI'yi al -> Devalidez -> PRET = CONSUMURI / CANTITATE -> Alt+S -> tekrar Validate
  async function finalizePrice(ctx) {
    if (!CFG.fixPrice || !ctx) return;
    const read = () => {
      const row = getRow(ctx);
      if (!row) return null;
      const n = f => parseNum(fieldText(row, f));
      return { row, cons: n('CONSUMURI'), val: n('VALOARE'), qty: n('CANTITATE'), pret: fieldText(row, 'PRET') };
    };
    // değerler en az ~1 sn boyunca değişmeyene kadar bekle (CONSUMURI nihai hâle gelsin)
    const settle = async () => {
      let d = null, prev = '', same = 0;
      for (let i = 0; i < 16; i++) {
        d = read();
        const k = d ? [d.cons, d.val, d.qty, d.pret].join('|') : '';
        same = (d && k === prev) ? same + 1 : 0;
        if (same >= 2) break;
        prev = k;
        await sleep(500);
      }
      return d;
    };
    const d = await settle();
    if (!d) return log('   (satır ekranda yok, fiyat kontrolü atlandı)', 'warn');
    if ([d.cons, d.val, d.qty].some(Number.isNaN)) return log('   (CONSUMURI/VALOARE/CANTITATE okunamadı, fiyat kontrolü atlandı)', 'warn');
    if (Math.abs(d.cons - d.val) < 0.005) return log(`   fiyat tamam: VALOARE ${d.val} = CONSUMURI ${d.cons}`, 'good');
    if (!d.qty) return log('   CANTITATE 0, fiyat hesaplanamadı', 'warn');
    const price = CFG.priceAdjust ? bestPrice(d.cons, d.qty).price : (d.cons / d.qty).toFixed(4);   // düz CONSUMURI / CANTITATE
    log(`   Validate sonrası nihai: VALOARE ${d.val} ≠ CONSUMURI ${d.cons} -> devalide edilip PRET ${d.pret} -> ${d.cons} / ${d.qty} = ${price}`, 'warn');
    log(`   ham: CANT="${fieldText(d.row, 'CANTITATE')}" CONS="${fieldText(d.row, 'CONSUMURI')}" VAL="${fieldText(d.row, 'VALOARE')}" PRET="${fieldText(d.row, 'PRET')}"`);
    await selectMainRow(d.row);
    await devalidate(ctx);
    log('   devalide edildi');
    await selectMainRow(getRow(ctx) || d.row);
    await setPriceField(price);
    log(`   PRET ${price} yazıldı ve kaydedildi, tekrar validate ediliyor`);
    await validateCycle(ctx);
    await verifyLocked(ctx);
    const d2 = await settle();
    if (d2) log(`   sonuç: PRET ${d2.pret}, VALOARE ${d2.val}, CONSUMURI ${d2.cons}`, Math.abs(d2.cons - d2.val) < 0.005 ? 'good' : 'warn');
  }

  // Ekleme sonrası yeni kaydın ana listedeki satırını bulur (kod + adet eşleşen, kilidi açık, en yeni)
  async function locateAddedRow(r, timeout = 4000) {
    const code = r.kod || nameMap[normName(r.ad)] || '';
    if (!code) return null;
    const kod = norm(code), qty = parseNum(r.adet);
    const rid = x => x.dataset.rowid ? +x.dataset.rowid : Infinity;     // rowid'si olmayan = istemcide yeni eklenmiş
    const found = await waitFor(() => {
      const c = mainRows().filter(x => norm(fieldText(x, 'COD')) === kod && isUnlocked(x)
        && (Number.isNaN(qty) || Math.abs(parseNum(fieldText(x, 'CANTITATE')) - qty) < 0.0005));
      c.sort((x, y) => rid(y) - rid(x));
      return c[0] || null;
    }, timeout, 200);
    if (!found) return null;
    await sleep(600);                                                    // tutarların oturması için
    return ctxOf(found);
  }

  // "6.000" -> "7.000" (ondalık basamak ve ayraç korunur)
  function bumpQty(str, step) {
    const m = String(str).trim().match(/^(\d+)(?:([.,])(\d+))?$/);
    if (!m) throw new Error('Adet okunamadı: "' + str + '"');
    const dec = m[3] ? m[3].length : 0;
    const out = (parseFloat(m[1] + '.' + (m[3] || '0')) + step).toFixed(dec);
    return m[2] === ',' ? out.replace('.', ',') : out;
  }

  // Her kaydın adedi yalnızca BİR kez artırılsın (hata sonrası tekrar çalıştırmada üst üste eklenmesin)
  const BUMP_KEY = '__sagaProdBumped';
  const loadBumped = () => { try { return new Set(JSON.parse(localStorage.getItem(BUMP_KEY) || '[]')); } catch (e) { return new Set(); } };
  const saveBumped = set => { try { localStorage.setItem(BUMP_KEY, JSON.stringify([...set])); } catch (e) {} };

  // Seçili ana liste kaydını Modific ile açar, Adet'i artırır, Alt+S ile kaydeder
  async function bumpQuantity(step) {
    const editBtn = $$('#toolbarCRUD_Productie button').find(b => visible(b) && /modific/i.test(b.textContent));
    if (!editBtn) throw new Error('Modific butonu bulunamadı');
    if (!isEnabled(editBtn)) throw new Error('Modific pasif (kayıt kilitli)');
    editBtn.click();
    const qtyEl = await waitFor(() => { const x = $(CFG.sel.qty); return visible(x) ? x : null; }, 6000);
    if (!qtyEl) throw terr('Düzenleme açılmadı (Adet alanı görünmedi; kayıt kilitli olabilir)');
    await sleep(400);
    const old = String(qtyEl.value).trim();
    const nu = bumpQty(old, step);
    qtyEl.focus(); qtyEl.select && qtyEl.select();
    setVal(qtyEl, nu);
    qtyEl.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(CFG.ms.afterQty);
    log(`   adet ${old} -> ${nu}`);
    await saveRecord();
    const sw = await waitFor(warnVisible, 1200, 100);
    if (sw) {
      const t = (sw.innerText || sw.textContent || '').replace(/\s+/g, ' ').trim();
      await dismissModal(sw);
      throw terr('Adet kaydedilemedi: ' + t);
    }
  }

  const rowLocked = c => { const r = getRow(c); return !!r && !!r.querySelector('td.rowCell_VALIDAT') && !isUnlocked(r); };
  const sigOfList = () => { const r = mainRows(); return r.length ? r.length + '|' + rowSig(r[0]) + '|' + rowSig(r[r.length - 1]) : '0'; };

  // Son görünen satırı en üste getirir: yeni satırlar yüklenir/render edilir, hiçbir satır atlanmaz.
  // patient=true: liste sonu kararını vermeden önce daha uzun bekler (geç yüklenen satırları kaçırmamak için)
  async function scrollDown(patient = false) {
    const rows = mainRows();
    if (!rows.length) return false;
    const before = sigOfList();
    for (let k = 0; k < (patient ? 2 : 1); k++) {
      rows[rows.length - 1].scrollIntoView({ block: 'start' });
      if (await waitFor(() => sigOfList() !== before, patient ? 2000 : 1200, 60)) return true;
      const sp = scrollParent(rows[0]);
      if (sp && sp.scrollTop + sp.clientHeight < sp.scrollHeight - 2) {
        sp.scrollTop += Math.max(60, sp.clientHeight * 0.5);
        if (await waitFor(() => sigOfList() !== before, 1500, 60)) return true;
      }
    }
    return false;
  }

  // Liste tarihe göre artan sıralıysa hedef tarihe ikili aramayla atlar (baştan kaydırmaz).
  // Aralığın başı/sonu zaten listenin başında/sonundaysa aramaz. Süre sınırı vardır (takılmayı önler).
  async function seekDate(f, budget = 30000) {
    if (f.mode === 'all' || !f.from) return;
    const t0 = Date.now(), over = () => Date.now() - t0 > budget;
    const first = mainRows()[0];
    const sp = first && scrollParent(first);
    if (!sp) return;
    const settle = async () => { const b = sigOfList(); await sleep(60); await waitFor(() => sigOfList() !== b, 450, 40); };
    const span = () => { const ds = mainRows().map(rowYmd).filter(Boolean); return ds.length ? [Math.min(...ds), Math.max(...ds)] : null; };
    log('   tarihe gidiliyor…');
    sp.scrollTop = 0; await settle();
    const top = span();
    if (!top) return;
    if (f.to && top[0] > f.to) { log('   aralık listenin başından önce kalıyor: kayıt yok', 'warn'); return; }
    if (top[0] >= f.from) { log('   aralığın başı listenin başında, baştan taranıyor'); return; }          // en baş zaten aralıkta/içinde
    sp.scrollTop = sp.scrollHeight; await settle();
    const bottom = span();
    if (!bottom || top[0] > bottom[1]) { sp.scrollTop = 0; await settle(); log('   (liste tarihe göre artan görünmüyor, baştan taranacak)', 'warn'); return; }
    if (bottom[1] < f.from) { log('   aralık yüklü listenin sonunda/ötesinde, aşağı taranıyor'); return; }  // en son zaten orada, tarama aşağı devam eder
    let lo = 0, hi = sp.scrollHeight, straddled = false;
    for (let i = 0; i < 16 && hi - lo > 4 && !over(); i++) {
      checkStop();
      const mid = Math.floor((lo + hi) / 2);
      sp.scrollTop = mid; await settle();
      const s2 = span();
      if (!s2) break;
      if (s2[1] < f.from) lo = mid;                      // pencere tamamen hedeften önce
      else if (s2[0] >= f.from) hi = mid;                // pencere hedefte/sonrasında, yukarıda da olabilir
      else { straddled = true; break; }                  // hedef başlangıcı pencerede
    }
    if (!straddled) { sp.scrollTop = lo; await settle(); }   // lo: penceresi tamamen aralıktan önce olan son konum
    log(`   tarihe gidildi (${Math.round((Date.now() - t0) / 1000)} sn)` + (over() ? ' - süre sınırına takıldı, güvenli konumdan taranıyor' : ''));
  }

  // Kilitli (validate edilmiş) satır: VALIDAT hücresi var ve açık kilit ikonu yok
  const isLockedRow = r => { const c = r.querySelector('td.rowCell_VALIDAT'); return !!c && !c.querySelector('i.fa-unlock-alt'); };

  // 1. AŞAMA: aralıktaki (kilidi açık / kilitli) tüm satırları sırayla TOPLAR (işlem yapmaz).
  // Her satır için görüldüğü kaydırma konumunu da saklar, sonra doğrudan oraya dönülür.
  async function collectRows(f, locked = false) {
    const t0 = Date.now();
    if (f.mode === 'all') {
      const first = mainRows()[0], sp0 = first && scrollParent(first);
      if (sp0) { sp0.scrollTop = 0; await sleep(300); }
    } else {
      await seekDate(f);
    }
    const items = [], seen = new Set();
    for (let step = 0; step < 6000; step++) {
      checkStop();
      if (Date.now() - t0 > CFG.scanMs) { log('   tarama süre sınırına ulaştı, o ana kadar bulunanlarla devam ediliyor', 'warn'); break; }
      const rows = mainRows();
      const sp = rows[0] && scrollParent(rows[0]);
      const pos = sp ? sp.scrollTop : 0;
      let minD = Infinity, maxD = 0;
      for (const r of rows) {
        const id = rowSig(r), d = rowYmd(r);
        if (d) { minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
        if (seen.has(id)) continue;
        seen.add(id);
        learnName(fieldText(r, 'DENUMIRE'), fieldText(r, 'COD'));
        if ((locked ? isLockedRow(r) : isUnlocked(r)) && inFilter(r, f)) items.push({ id, label: rowLabel(r), pos });
      }
      if (step && step % 15 === 0) log(`   taranıyor… ${seen.size} satır görüldü, ${items.length} uygun, son tarih ${maxD ? String(maxD).replace(/^(\d{4})(\d{2})(\d{2})$/, '$3.$2.$1') : '?'}`);
      if (f.mode !== 'all' && f.to && minD !== Infinity && minD > f.to) break;   // artan listede aralık bitti
      if (!(await scrollDown(true))) break;                                      // liste sonu
    }
    return items;
  }

  // Toplanan satırı tekrar ekrana getirir (kayıtlı kaydırma konumu, olmazsa yakın çevre, olmazsa baştan tarama)
  async function locateRow(it) {
    const find = () => mainRows().find(r => rowSig(r) === it.id);
    let row = find();
    if (row) return row;
    const first = mainRows()[0], sp = first && scrollParent(first);
    if (!sp) return null;
    for (const d of [0, -0.5, 0.5, -1, 1, -2, 2]) {
      sp.scrollTop = Math.max(0, it.pos + d * sp.clientHeight);
      row = await waitFor(find, 900, 60);
      if (row) return row;
    }
    sp.scrollTop = 0; await sleep(400);
    for (let i = 0; i < 400; i++) {
      row = find();
      if (row) return row;
      if (!(await scrollDown(true))) break;
    }
    return find() || null;
  }

  /* ---- Yarım kalan işi kaydet / devam et (internet gitse, sayfa yenilense, hata olsa) ---- */
  const JOB_KEY = '__sagaProdJob';
  const loadJob = () => { try { return JSON.parse(localStorage.getItem(JOB_KEY) || 'null'); } catch (e) { return null; } };
  const saveJob = j => { try { localStorage.setItem(JOB_KEY, JSON.stringify(j)); } catch (e) {} };
  const clearJob = () => { try { localStorage.removeItem(JOB_KEY); } catch (e) {} };

  // Toplu iş: tara -> sırayla işle. Her biten kayıt kalıcı olarak işaretlenir; yarım kalırsa kaldığı yerden devam eder.
  async function batchRun({ kind, fkey, f, locked, title, processItem }) {
    await recover().catch(() => {});
    let job = loadJob(), resumeList = null;
    if (job && job.fkey === fkey) {
      const remain = job.items.filter(it => !job.done.includes(it.id));
      if (remain.length && confirm(`Yarım kalan iş var (${f.text}): ${job.done.length}/${job.items.length} tamamlanmış.\nKaldığı yerden devam edilsin mi?\n\n(İptal = baştan tara)`)) {
        resumeList = remain;
        log(`Kaldığı yerden devam: ${remain.length} kayıt kaldı (${job.done.length} tamamlanmıştı)`, 'good');
      }
    }
    if (!resumeList) job = { fkey, kind, items: [], done: [], at: Date.now() };
    const failed = new Set();
    let ok = 0, fail = 0;
    outer:
    for (let round = 1; round <= 2; round++) {
      let list;
      if (round === 1 && resumeList) list = resumeList;
      else {
        log(round === 1 ? 'Kayıtlar taranıyor…' : 'Kalan var mı diye tekrar taranıyor…');
        list = (await collectRows(f, locked)).filter(it => !failed.has(it.id) && !job.done.includes(it.id));
        const known = new Set(job.items.map(it => it.id));
        list.forEach(it => { if (!known.has(it.id)) job.items.push(it); });
        saveJob(job);
      }
      if (!list.length) { log(round === 1 ? 'Filtreye uyan kayıt yok' : 'Kalan kayıt yok', 'good'); break; }
      if (round === 1 && !resumeList && list.length > CFG.bigJob && !confirm(`${list.length} kayıt bulundu.\nHepsi işlenecek (uzun sürebilir; yarım kalırsa kaldığı yerden devam edilebilir).\nDevam edilsin mi?`)) { log('İptal edildi (tarama kaydedildi)', 'warn'); return; }
      log(`${list.length} kayıt bulundu, bu sırayla işlenecek:`, 'good');
      list.slice(0, 40).forEach((it, i) => log(`   ${i + 1}. ${it.label}`));
      if (list.length > 40) log(`   … ve ${list.length - 40} kayıt daha`);
      for (let i = 0; i < list.length; i++) {
        checkStop();
        q('pb').style.width = (i / list.length * 100) + '%';
        const it = list[i];
        log(`> [${i + 1}/${list.length}] ${it.label}`);
        try {
          await waitOnline();
          const res = await withRetry(() => processItem(it, i, list.length));
          if (res !== 'skip') ok++;
          job.done.push(it.id); saveJob(job);                   // bu kayıt bitti: kalıcı işaretle
        } catch (err) {
          if (err.message === 'STOP') throw err;
          fail++; failed.add(it.id);
          log(`[HATA] [${i + 1}/${list.length}] ${it.label}: ${err.message}`, 'err');
          try { await recover(); } catch (e2) {}               // sayfayı temiz duruma getir (açık form / pencere)
          if (CFG.stopOnError) break outer;
        }
      }
    }
    q('pb').style.width = '100%';
    if (!fail) clearJob(); else log('Hatalı kayıtlar var: işi tekrar başlatırsan kaldığı yerden devam teklif edilir.', 'warn');
    log(`${title} bitti: ${ok} başarılı, ${fail} hatalı`, fail ? 'warn' : 'good');
  }

  // Seçili tarihteki / aralıktaki KİLİTLİ tüm kayıtların kilidini açar (Devalidez)
  async function unlockAllPage() {
    let f;
    try { f = getFilter(); } catch (e) { return log('[HATA] ' + e.message, 'err'); }
    if (f.mode === 'all') return log('[HATA] Kilit açmak için tek tarih veya tarih aralığı seç (tüm kayıtların kilidi açılmasın)', 'err');
    if (!mainRows().length) return log('Ana listede satır bulunamadı (' + CFG.sel.mainRow + ')', 'err');
    if (!confirm(`${f.text} KİLİTLİ tüm kayıtların kilidi açılacak (Devalidez).\nBaşlatılsın mı?`)) return;
    log(`Kilit açma başladı (${f.text})`);
    await batchRun({
      kind: 'unlock', fkey: 'unlock|' + f.text, f, locked: true, title: 'Kilit açma',
      processItem: async (it, i, total) => {
        const t0 = Date.now();
        const row = await locateRow(it);
        if (!row) throw terr('Satır ekranda bulunamadı (liste yeniden yüklenmiş olabilir)');
        if (isUnlocked(row)) { log('   zaten açık, atlandı', 'warn'); return 'skip'; }
        await selectMainRow(row);
        await devalidate(ctxOf(getRow(ctxOf(row)) || row));
        log(`[OK] [${i + 1}/${total}] kilit açıldı (${Math.round((Date.now() - t0) / 1000)} sn)`, 'good');
      },
    });
  }

  async function validateAllPage() {
    let f;
    try { f = getFilter(); } catch (e) { return log('[HATA] ' + e.message, 'err'); }
    if (!mainRows().length) return log('Ana listede satır bulunamadı (' + CFG.sel.mainRow + ')', 'err');
    const bumpOn = q('vbump').checked;
    const bump = bumpOn ? parseFloat(String(q('vstep').value).replace(',', '.')) : 0;
    if (bumpOn && !bump) return log('[HATA] Artış miktarı geçersiz', 'err');
    if (bumpOn && f.mode === 'all') return log('[HATA] Adet artırmak için tek tarih veya tarih aralığı seç (tüm kayıtlara uygulanmasın)', 'err');
    const bumped = loadBumped();
    const sure = bumpOn
      ? `${f.text} kilidi açık kayıtların ADEDİ ${bump > 0 ? '+' : ''}${bump} değiştirilip kaydedilecek, sonra validate edilecek.\nKayıtlı adetler değişir. Başlatılsın mı?`
      : `Ana listede kilidi açık kayıtlar validate edilecek (${f.text}).\nStok hatası veren kalemler kayıttan silinip kaydedilecek.\nBaşlatılsın mı?`;
    if (CFG.confirmValidateAll && !confirm(sure)) return;
    log(`Validate All başladı (${f.text})`);
    await batchRun({
      kind: 'validate', fkey: `validate|${f.text}|b${bump}`, f, locked: false, title: 'Validate All',
      processItem: async (it, i, total) => {
        const t0 = Date.now();
        const row = await locateRow(it);
        if (!row) throw terr('Satır ekranda bulunamadı (liste yeniden yüklenmiş olabilir)');
        if (!isUnlocked(row)) { log('   zaten kilitli, atlandı', 'warn'); return 'skip'; }
        await selectMainRow(row);
        if (!isUnlocked(getRow(ctxOf(row)) || row)) { log('   kilitli, düzenleme ve validate atlandı', 'warn'); return 'skip'; }
        if (bump) {
          if (bumped.has(it.id)) log('   adet daha önce artırılmış, sadece validate', 'warn');
          else {
            const cur = parseNum(fieldText(getRow(ctxOf(row)) || row, 'CANTITATE'));
            if (it.bumpFrom === undefined) it.bumpFrom = cur;          // ilk denemedeki adet
            if (Math.abs(cur - (it.bumpFrom + bump)) < 1e-6) log('   adet zaten artırılmış görünüyor (önceki deneme kaydetmiş), tekrar artırılmıyor', 'warn');
            else await bumpQuantity(bump);
            bumped.add(it.id); saveBumped(bumped);
          }
        }
        const ctx = ctxOf(getRow(ctxOf(row)) || row);
        const t = await validateCycle(ctx);
        await verifyLocked(ctx);
        await finalizePrice(ctx);
        log(`[OK] [${i + 1}/${total}] doğrulandı (${t} tur, ${Math.round((Date.now() - t0) / 1000)} sn)`, 'good');
      },
    });
  }

  /* ================== SATIR İŞ AKIŞLARI ================== */
  async function addOne(r) {
    let added = false;
    r.saved = false;
    setState(r, 'calisiyor');
    try {
      let ctx = null;
      if (r.resume) {                                   // yarım kalmış işlemden devam: kayıt zaten oluşmuş olabilir
        r.resume = false;
        ctx = await locateAddedRow(r, 1500);
        if (ctx) log('   önceki yarım işlemden kayıt zaten var, tekrar eklenmiyor', 'warn');
      }
      if (!ctx) await addRecord(r);
      added = true; r.saved = true;
      setState(r, 'eklendi');
      if (!ctx) ctx = await locateAddedRow(r);
      if (!ctx) log('   (eklenen satır ana listede bulunamadı: fiyat ve kilit kontrolü atlanıyor)', 'warn');
      const t = await validateCycle(ctx);
      if (ctx) { await verifyLocked(ctx); await finalizePrice(ctx); }
      setState(r, 'dogrulandi', `${t}. turda temiz`);
      log(`[OK] ${r.kod || r.ad} x ${r.adet} doğrulandı (${t} tur)`, 'good');
    } catch (err) {
      if (err.skip) setState(r, 'atlandi', err.message);
      else setState(r, added ? 'eklendi' : 'hata', err.message === 'STOP' ? 'durduruldu' : err.message);
      throw err;
    }
  }

  async function validateOne(r) {
    const prev = r.state;
    setState(r, 'calisiyor');
    try {
      const code = r.kod || nameMap[normName(r.ad)];
      if (!code) throw new Error('Kod bilinmiyor (ad önbellekte yok; önce ana listede bu ürün görünmeli)');
      const row = await selectRecord(code);
      if (!isUnlocked(row)) { log(`   ${code}: kayıt kilitli, atlandı`, 'warn'); setState(r, prev, 'kilitli, atlandı'); return; }
      const ctx = ctxOf(row);
      const t = await validateCycle(ctx);
      await verifyLocked(ctx);
      await finalizePrice(ctx);
      setState(r, 'dogrulandi', `${t}. turda temiz`);
      log(`[OK] ${code} doğrulandı (${t} tur)`, 'good');
    } catch (err) {
      setState(r, prev, err.message === 'STOP' ? 'durduruldu' : err.message);
      throw err;
    }
  }

  async function guarded(fn) {
    if (state.running) return;
    if (!isProductie()) return log('Productie sayfasında değilsin', 'err');
    if (root.activeElement) root.activeElement.blur();
    state.running = true; state.stop = false; updateButtons();
    try { await fn(); } finally { state.running = false; updateButtons(); }
  }

  // Geçici hata sonrası sayfayı sakin bir duruma getir (açık form varsa kapat, internet bekle)
  async function recover() {
    await waitOnline();
    try { await handleStray(); } catch (e) {}              // beklenmeyen silme penceresi varsa iptal et
    try { const w = warnVisible(); if (w) await dismissModal(w); } catch (e) {}
    try { if (isEnabled($(CFG.sel.save))) await cancelEdit(); } catch (e) {}
    await sleep(1000);
  }

  // Geçici hatalarda (err.transient) yeniden dener; canRetry() false ise (örn. kayıt oluşmuşsa) denemez
  async function withRetry(fn, canRetry = () => true) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (err) {
        if (err.message === 'STOP' || !err.transient || !canRetry() || attempt >= CFG.retries) throw err;
        log(`   geçici hata (${err.message}); ${attempt + 1}. yeniden deneme…`, 'warn');
        await recover();
      }
    }
  }

  async function loop(todo, fn, title) {
    if (!todo.length) return log('İşlenecek satır yok', 'warn');
    log(`${title}: ${todo.length} satır`);
    let ok = 0, skipped = 0;
    harvestNames();
    for (let i = 0; i < todo.length; i++) {
      q('pb').style.width = (i / todo.length * 100) + '%';
      const r = todo[i], lab = r.kod || r.ad;
      try {
        await waitOnline();
        await withRetry(() => fn(r), () => !(fn === addOne && r.saved));
        ok++;
      } catch (err) {
        if (err.message === 'STOP') { log('Durduruldu', 'warn'); break; }
        if (err.skip) { skipped++; log(`[ATLANDI] ${lab}: ${err.message}`, 'warn'); continue; }
        log(`[HATA] ${lab}: ${err.message}`, 'err');
        if (CFG.stopOnError) break;
      }
    }
    q('pb').style.width = '100%';
    log(`Bitti: ${ok}/${todo.length} başarılı` + (skipped ? `, ${skipped} atlandı` : ''), ok + skipped === todo.length ? 'good' : 'warn');
  }

  /* ================== VERİ / TABLO ================== */
  const LABEL = { bekliyor: 'Bekliyor', calisiyor: 'Çalışıyor…', eklendi: 'Eklendi', dogrulandi: 'Doğrulandı', hata: 'Hata', atlandi: 'Atlandı' };
  const newRow = (kod, adet, tarih = '', ad = '') => ({ id: state.seq++, kod, ad, adet, tarih, state: 'bekliyor', note: '', sel: false, saved: false });

  function persist() {
    try {
      localStorage.setItem(CFG.storeKey, JSON.stringify(state.list.map(({ id, kod, ad, adet, tarih, state: s, note, saved }) => ({ id, kod, ad, adet, tarih, state: s, note, saved }))));
    } catch (e) {}
  }
  function restore() {
    try {
      const d = JSON.parse(localStorage.getItem(CFG.storeKey) || '[]');
      state.list = d.map(x => {
        const r = { ad: '', saved: false, ...x, sel: false };
        if (x.state === 'calisiyor') {                      // yarım kalmış işlem: kaydedilmişse Validate'e, değilse yeniden ekleme
          if (x.saved) { r.state = 'eklendi'; r.note = 'yarım kalmıştı'; }
          else { r.state = 'bekliyor'; r.note = 'yarım kalmıştı, yeniden denenecek'; r.resume = true; }
        }
        return r;
      });
      state.seq = Math.max(0, ...state.list.map(x => x.id)) + 1;
    } catch (e) {}
  }

  function setState(r, st, note = '') {
    r.state = st; r.note = note;
    const tr = root.querySelector(`tr[data-id="${r.id}"]`);
    if (tr) paintRow(tr, r);
    persist(); updateCounts(); updateButtons();
  }
  function paintRow(tr, r) {
    tr.className = 'st-' + r.state;
    const c = tr.querySelector('.stc');
    c.textContent = LABEL[r.state];
    c.title = r.note || '';
    tr.querySelector('.nt').textContent = r.note && (r.state === 'hata' || r.state === 'atlandi') ? '(!)' : '';
  }

  function buildRow(r, idx) {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    tr.innerHTML = `<td><input type="checkbox" class="ck"></td><td class="ix">${idx + 1}</td>
      <td><input class="k" spellcheck="false"></td><td><input class="a2" spellcheck="false"></td><td><input class="n" spellcheck="false"></td><td><input class="t" spellcheck="false"></td>
      <td><span class="stc"></span><span class="nt"></span></td>
      <td class="act"><button class="run" title="Bu satırı ekle + kaydet + validate">Ekle</button><button class="val" title="Sadece Validate (ana listede bulup)">Validate</button><button class="del" title="Satırı sil">Sil</button></td>`;
    const k = tr.querySelector('.k'), a2 = tr.querySelector('.a2'), n = tr.querySelector('.n'), t = tr.querySelector('.t'), ck = tr.querySelector('.ck');
    k.value = r.kod; a2.value = r.ad || ''; n.value = r.adet; t.value = r.tarih || ''; ck.checked = r.sel;
    t.placeholder = defaultDate() || 'sistem';
    t.oninput = () => { r.tarih = t.value.trim(); persist(); };
    k.oninput = () => { r.kod = k.value.trim(); persist(); updateButtons(); };
    a2.oninput = () => { r.ad = a2.value.trim(); persist(); updateButtons(); };
    n.oninput = () => { r.adet = n.value.trim(); persist(); updateButtons(); };
    ck.onchange = () => { r.sel = ck.checked; };
    tr.querySelector('.del').onclick = () => { if (state.running) return; state.list = state.list.filter(x => x !== r); renderTable(); };
    tr.querySelector('.run').onclick = () => guarded(async () => {
      if (r.state === 'eklendi' || r.state === 'dogrulandi') {
        if (!confirm(`${r.kod || r.ad} zaten eklenmiş görünüyor. Yine de yeniden eklensin mi?`)) return;
      }
      await loop([r], addOne, 'Tek satır ekleme').catch(() => {});
    });
    tr.querySelector('.val').onclick = () => guarded(() => loop([r], validateOne, 'Tek satır validate'));
    paintRow(tr, r);
    return tr;
  }

  function renderTable() {
    const tb = q('tb');
    tb.innerHTML = '';
    state.list.forEach((r, i) => tb.appendChild(buildRow(r, i)));
    persist(); updateCounts(); updateButtons();
  }

  function updateCounts() {
    const c = s => state.list.filter(r => r.state === s).length;
    q('cnt').textContent = `Toplam ${state.list.length} · Bekleyen ${c('bekliyor')} · Eklendi ${c('eklendi')} · Doğrulandı ${c('dogrulandi')} · Hata ${c('hata')} · Atlandı ${c('atlandi')}`;
  }
  function updateStatus() {
    const ok = isProductie(), s = q('st');
    s.className = 'st ' + (ok ? 'ok' : 'no');
    s.textContent = ok ? 'Productie sayfasında' : 'Productie sayfasında değil';
    updateButtons();
  }
  function updateButtons() {
    const on = isProductie() && !state.running;
    q('go').disabled = !on || !state.list.some(r => r.state === 'bekliyor' && (r.kod || r.ad) && r.adet);
    q('vall').disabled = !on;
    q('vunlock').disabled = !on;
    q('stop').disabled = !state.running;
    root.querySelectorAll('.run,.val,.del,#addrow,#delsel,#clr,#clrdone,#imp').forEach(b => { b.disabled = state.running; });
  }

  /* ================== DOSYA OKUMA ================== */
  function loadXLSX() {
    const urls = ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'];
    const tryLoad = u => new Promise((res, rej) => {
      const el = document.createElement('script');
      el.src = u;
      el.onload = () => window.XLSX ? res() : rej(new Error('XLSX yok'));
      el.onerror = () => rej(new Error('SheetJS yüklenemedi'));
      document.head.appendChild(el);
    });
    return (async () => {
      if (window.XLSX) return;
      let last = null;
      for (const u of urls) { try { await tryLoad(u); return; } catch (e) { last = e; } }
      throw last || new Error('SheetJS yüklenemedi');
    })();
  }
  function parseText(txt) {
    const lines = txt.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const cnt = ch => lines.reduce((n, l) => n + (l.includes(ch) ? 1 : 0), 0);
    const d = cnt('\t') ? '\t' : ((cnt(';') && cnt(';') >= cnt(',')) ? ';' : ',');
    return lines.map(l => l.split(d).map(c => c.trim().replace(/^"|"$/g, '')));
  }

  // "Vanzari pe perioada" satış raporu: başlıkta "Denumire produs" + "Cantitate", üstte "De la: ... pana la ..."
  function detectReport(rows) {
    const low = x => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const cells = rows[i].map(low);
      const nameCol = cells.indexOf('denumire produs'), qtyCol = cells.indexOf('cantitate');
      if (nameCol < 0 || qtyCol < 0) continue;
      let from = '', to = '';
      for (let j = 0; j < i; j++) {
        const m = rows[j].join(' ').match(/de la\W*(\d{1,2}[./]\d{1,2}[./]\d{4})\W+pana la\W*(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
        if (m) { from = toDate(m[1]); to = toDate(m[2]); break; }
      }
      const data = rows.slice(i + 1).filter(r => String(r[nameCol] ?? '').trim() && parseNum(r[qtyCol]) > 0);
      return { rows: data, nameCol, qtyCol, from, to };
    }
    return null;
  }

  /* ================== ARAYÜZ ================== */
  host = document.createElement('div');
  host.id = '__saga_prod_host';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  ['keydown', 'keypress', 'keyup'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const opts = sel => letters.map((l, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${l}</option>`).join('');

  root.innerHTML = `
  <style>
    *{box-sizing:border-box;font-family:"Segoe UI",Tahoma,Arial,sans-serif}
    .p{width:660px;background:#efefef;color:#1a1a1a;border:1px solid #5a5a5a;box-shadow:3px 3px 0 rgba(0,0,0,.28);font-size:12px}
    .h{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#2f3b45;color:#fff;font-weight:600;font-size:12.5px;letter-spacing:.2px;cursor:move;user-select:none}
    .h span{flex:1}.h button{background:none;border:0;color:#fff;font-size:15px;line-height:1;cursor:pointer;padding:0 5px}
    .h button:hover{background:#455563}
    .b{padding:8px 10px;display:flex;flex-direction:column;gap:7px;max-height:calc(100vh - 90px);overflow:auto}
    .st{padding:4px 8px;border:1px solid #b0b0b0;border-left-width:4px;background:#fafafa;font-weight:600}
    .ok{border-left-color:#2e6b3a}.no{border-left-color:#a12622;background:#f7ecec}
    details{border:1px solid #b0b0b0;background:#f7f7f7;padding:5px 8px}summary{cursor:pointer;font-weight:600}
    .row{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.row>.g{flex:1}
    label{display:flex;align-items:center;gap:4px}
    select,textarea,input[type=file],input[type=date]{font-size:12px;border:1px solid #9a9a9a;background:#fff;border-radius:0}
    textarea{width:100%;height:48px;resize:vertical;margin-top:5px;padding:3px 5px}
    button.a,button.s{border:1px solid #7d7d7d;border-radius:0;background:#e3e3e3;color:#1a1a1a;cursor:pointer;font-size:12px}
    button.a:hover,button.s:hover{background:#d4d4d4}
    button.a:active,button.s:active{background:#c8c8c8;box-shadow:inset 1px 1px 2px rgba(0,0,0,.25)}
    button.a{padding:5px 14px;font-weight:600}
    button.s{padding:2px 8px}
    #go{background:#2e6b3a;border-color:#1f4a28;color:#fff}#go:hover{background:#265a31}
    #vall{background:#1f4e79;border-color:#16385a;color:#fff}#vall:hover{background:#1a4268}
    #vunlock{background:#7a4a00;border-color:#523100;color:#fff}#vunlock:hover{background:#663d00}
    #stop{background:#a12622;border-color:#741a17;color:#fff}#stop:hover{background:#8a201d}
    button:disabled{opacity:.45;cursor:not-allowed}
    .tw{max-height:250px;overflow:auto;border:1px solid #8f8f8f;background:#fff}
    table{border-collapse:collapse;width:100%;font-size:12px}
    th{position:sticky;top:0;background:#d9d9d9;text-align:left;padding:3px 5px;border:1px solid #a8a8a8;font-weight:600;z-index:1}
    td{border:1px solid #d0d0d0;padding:1px 3px}
    td input.k,td input.a2,td input.n,td input.t{width:100%;border:1px solid transparent;background:transparent;border-radius:0;padding:2px 4px;font-size:12px;font-family:Consolas,"Courier New",monospace}
    td input.k:hover,td input.a2:hover,td input.n:hover,td input.t:hover{border-color:#b0b0b0}
    td input.k:focus,td input.a2:focus,td input.n:focus,td input.t:focus{outline:0;border-color:#1f4e79;background:#fff}
    th.tt{width:92px}
    td.ix{color:#7a7a7a;width:26px;text-align:right}td.act{white-space:nowrap;width:1%}
    td.act button{border:0;background:none;cursor:pointer;font-size:11.5px;padding:1px 5px;color:#1f4e79;text-decoration:underline}
    td.act button.del{color:#a12622}
    td.act button:hover{background:#e4ecf4}td.act button:disabled{color:#999}
    .stc{font-size:11.5px;font-weight:600;color:#666}
    tr.st-calisiyor{background:#fff6d6}tr.st-calisiyor .stc{color:#8a5a00}
    tr.st-eklendi .stc{color:#1f4e79}tr.st-dogrulandi .stc{color:#2e6b3a}
    tr.st-atlandi .stc{color:#7a7a7a;text-decoration:line-through}tr.st-atlandi td:first-child{border-left-color:#9a9a9a}
    tr.st-hata{background:#f8eeee}tr.st-hata .stc{color:#a12622}
    tr td:first-child{border-left:3px solid transparent}
    tr.st-calisiyor td:first-child{border-left-color:#d49a00}tr.st-eklendi td:first-child{border-left-color:#1f4e79}
    tr.st-dogrulandi td:first-child{border-left-color:#2e6b3a}tr.st-hata td:first-child{border-left-color:#a12622}
    .nt{margin-left:4px;color:#a12622;font-weight:700}
    .cnt{color:#505050;font-size:11.5px}
    .bar{height:6px;background:#c9c9c9}.bar i{display:block;height:100%;width:0;background:#2e6b3a}
    #log{height:130px;overflow:auto;background:#1e1e1e;color:#d4d4d4;padding:5px 7px;border:1px solid #555;font:11px/1.5 Consolas,"Courier New",monospace}
    .err{color:#f48771}.warn{color:#e5c07b}.good{color:#8fd18f}
    .tabs{display:flex;border-bottom:1px solid #8f8f8f}
    .tab{padding:5px 18px;border:1px solid #8f8f8f;border-bottom:0;border-radius:0;background:#dcdcdc;cursor:pointer;font-size:12px;margin-bottom:-1px;margin-right:2px}
    .tab:hover{background:#e6e6e6}.tab.on{background:#efefef;font-weight:600;border-bottom:1px solid #efefef}
    .pane{display:flex;flex-direction:column;gap:7px}.off{display:none!important}
    .fs{border:1px solid #b0b0b0;background:#f7f7f7;padding:7px 9px;display:flex;flex-direction:column;gap:7px}
    .min .b{display:none}
  </style>
  <div class="p" id="p">
    <div class="h" id="dragbar"><span>SAGA Productie  /  Otomasyon  <small style="font-weight:400;opacity:.7">${VERSION}</small></span><button id="mn" title="Küçült">–</button><button id="cl" title="Kapat">×</button></div>
    <div class="b">
      <div class="st" id="st"></div>
      <div class="tabs"><button class="tab on" id="tabA">Ekle</button><button class="tab" id="tabV">Validate</button></div>
      <div class="pane" id="paneA">
      <details open><summary>1) Veri yükle</summary>
        <div class="row" style="margin-top:6px"><input type="file" id="f" accept=".xlsx,.xls,.csv,.txt" class="g"></div>
        <textarea id="paste" placeholder="veya Excel'den (Kod/Ad + Adet) ya da Satış raporunu (Vanzari pe perioada) kopyalayıp buraya yapıştır"></textarea>
        <div class="row" style="margin-top:6px">
          <label>Kod <select id="cc"><option value="-1">yok</option>${opts(0)}</select></label>
          <label>Ad <select id="nc"><option value="-1" selected>yok</option>${opts(-1)}</select></label>
          <label>Adet <select id="ac">${opts(1)}</select></label>
          <label>Tarih <select id="dc"><option value="-1">yok</option>${opts(2)}</select></label>
          <button class="s" id="swap" type="button">Yer değiştir</button>
          <label><input type="checkbox" id="hdr" checked> İlk satır başlık</label>
          <span class="g"></span>
          <button class="s" id="imp" type="button"><b>Tabloya aktar</b></button>
        </div>
        <div class="row" style="margin-top:5px"><label>Varsayılan tarih <input type="date" id="dd"></label><span class="cnt">Satırda tarih yoksa bu kullanılır; ikisi de boşsa sistemin tarihi kalır.</span></div>
        <div class="cnt" id="rawinfo"></div>
        <div class="row" style="margin-top:4px"><button class="s" id="nameclr" type="button">Ad önbelleğini temizle</button><span class="cnt" id="nameinfo"></span></div>
      </details>
      <div class="row">
        <b>2) Tablo</b><span class="g"></span>
        <button class="s" id="addrow">Satır ekle</button>
        <button class="s" id="delsel">Seçilileri sil</button>
        <button class="s" id="clrdone">Doğrulananları temizle</button>
        <button class="s" id="clr">Tümünü temizle</button>
      </div>
      <div class="tw"><table><thead><tr><th><input type="checkbox" id="all"></th><th>#</th><th>Kod</th><th>Ad</th><th>Adet</th><th class="tt">Tarih</th><th>Durum</th><th></th></tr></thead><tbody id="tb"></tbody></table></div>
      <div class="cnt" id="cnt"></div>
      <div class="row"><button class="a" id="go" title="Bekleyen satırları ekler, Alt+S ile kaydeder, Validate eder">Başlat</button></div>
      </div>
      <div class="pane off" id="paneV">
        <div class="fs">
          <b>Hangi kayıtlar validate edilsin?</b>
          <label><input type="radio" name="vm" value="all" checked> Kilidi açık tümü</label>
          <label><input type="radio" name="vm" value="one"> Tek tarih <input type="date" id="v1"></label>
          <label><input type="radio" name="vm" value="range"> Tarih aralığı <input type="date" id="v2"> <span>–</span> <input type="date" id="v3"></label>
          <label><input type="checkbox" id="vbump"> Önce Adet'i artır: <input type="number" id="vstep" value="1" step="any" style="width:56px"> (Modific, Alt+S, sonra Validate)</label>
          <span class="cnt">Adet artırma sadece tek tarih / tarih aralığında çalışır; her kayıt yalnızca bir kez artırılır. <button class="s" id="vbumpclr" type="button">Artış kaydını sıfırla</button> <button class="s" id="vjobclr" type="button">Yarım işi sıfırla</button></span>
          <span class="cnt">Sadece ana listede kilidi açık kayıtlar işlenir; kilitli (validate edilmiş) olanlara dokunulmaz. Tarih, ana listedeki Data sütunundan okunur.</span>
        </div>
        <div class="row">
          <button class="a" id="vall" title="Ana listede kilidi açık kayıtları sırayla validate eder">Validate All</button>
          <button class="s" id="vcount" title="Filtreye uyan kilidi açık kayıtları say">Say</button>
          <button class="a" id="vunlock" title="Seçili tarih / aralıktaki KİLİTLİ tüm kayıtların kilidini açar (Devalidez)">Kilitleri aç</button>
        </div>
        <div class="cnt" id="vinfo"></div>
      </div>
      <div class="bar"><i id="pb"></i></div>
      <div class="row">
        <button class="a" id="stop" disabled>Durdur</button>
        <span class="g"></span><button class="s" id="clog">Logu temizle</button>
      </div>
      <div id="log"></div>
    </div>
  </div>`;
  document.body.appendChild(host);
  const q = id => root.getElementById(id);
  const logBox = q('log');

  function log(m, c = '') {
    const d = document.createElement('div');
    if (c) d.className = c;
    d.textContent = new Date().toLocaleTimeString('tr-TR') + '  ' + m;
    logBox.appendChild(d); logBox.scrollTop = logBox.scrollHeight;
    console.log('[SAGA]', m);
  }

  // Okunan ham veriyi işle: satış raporu ise sütunları/tarihi otomatik ayarla
  function applyRaw() {
    const rep = detectReport(state.raw);
    if (!rep) { q('rawinfo').textContent = state.raw.length ? `${state.raw.length} ham satır hazır` : ''; return; }
    state.raw = rep.rows;
    q('cc').value = '-1'; q('nc').value = String(rep.nameCol); q('ac').value = String(rep.qtyCol); q('dc').value = '-1';
    q('hdr').checked = false;
    const single = rep.from && rep.from === rep.to;
    if (single) { const [d, m, y] = rep.from.split('.'); q('dd').value = `${y}-${m}-${d}`; q('dd').onchange && q('dd').onchange(); }
    const when = !rep.from ? 'tarih bulunamadı' : (single ? rep.from : `${rep.from} - ${rep.to}`);
    q('rawinfo').textContent = `Satış raporu algılandı: ${rep.rows.length} ürün, ${when}`;
    log(`Satış raporu algılandı: ${rep.rows.length} ürün, tarih ${when}. Kontrol edip "Tabloya aktar"a bas.`, 'good');
    if (rep.from && !single) log('Rapor birden fazla günü kapsıyor: varsayılan tarihi kendin seç (yoksa sistem tarihi kullanılır).', 'warn');
  }

  async function readFile(file) {
    try {
      if (/\.(csv|txt)$/i.test(file.name)) state.raw = parseText(await file.text());
      else {
        await loadXLSX();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        state.raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      }
      log(`${file.name} okundu: ${state.raw.length} satır`, 'good');
      applyRaw();
    } catch (err) {
      log('Dosya okunamadı: ' + err.message + " (sayfa güvenliği SheetJS'i engelliyor olabilir: Excel'den hücreleri kopyalayıp yapıştırma kutusuna yapıştır)", 'err');
    }
  }

  q('f').addEventListener('change', e => e.target.files[0] && readFile(e.target.files[0]));
  q('paste').addEventListener('input', () => { state.raw = parseText(q('paste').value); applyRaw(); });
  q('swap').onclick = () => { const a = q('cc').value; q('cc').value = q('ac').value; q('ac').value = a; };
  q('imp').onclick = () => {
    const ci = +q('cc').value, ni = +q('nc').value, ai = +q('ac').value, di = +q('dc').value;
    if (ci < 0 && ni < 0) return log('[HATA] Kod veya Ad sütunlarından en az biri seçilmeli', 'err');
    if (ai < 0) return log('[HATA] Adet sütunu seçilmeli', 'err');
    let n = 0, bad = 0, skip = 0;
    state.raw.slice(q('hdr').checked ? 1 : 0).forEach(r => {
      const kod = ci >= 0 ? String(r[ci] ?? '').trim() : '';
      const ad = ni >= 0 ? String(r[ni] ?? '').replace(/\s+/g, ' ').trim() : '';
      let a = r[ai];
      if (typeof a === 'number') a = String(Math.round(a * 10000) / 10000);
      a = String(a ?? '').trim();
      if (!(kod || ad) || !(parseNum(a) > 0)) { skip++; return; }
      let t = '';
      if (di >= 0 && r[di] !== '' && r[di] != null) {
        t = toDate(r[di]);
        if (!t) { bad++; t = String(r[di]).trim(); }       // anlaşılmayanı olduğu gibi göster, kullanıcı düzeltsin
      }
      state.list.push(newRow(kod, a, t, ad)); n++;
    });
    renderTable();
    log(`${n} satır tabloya eklendi` + (skip ? ` (${skip} boş/sıfır satır atlandı)` : ''), 'good');
    if (bad) log(`${bad} satırda tarih anlaşılamadı (tabloda düzeltebilirsin; boş bırakırsan varsayılan/sistem tarihi kullanılır)`, 'warn');
  };
  const refreshNameInfo = () => { q('nameinfo').textContent = `Önbellekte ${Object.keys(nameMap).length} ürün adı`; };
  q('nameclr').onclick = () => { nameMap = {}; saveNames(); refreshNameInfo(); log('Ad önbelleği temizlendi', 'warn'); };

  q('addrow').onclick = () => { state.list.push(newRow('', '')); renderTable(); const ks = root.querySelectorAll('.k'); ks[ks.length - 1] && ks[ks.length - 1].focus(); };
  q('delsel').onclick = () => { state.list = state.list.filter(r => !r.sel); renderTable(); };
  q('clrdone').onclick = () => { state.list = state.list.filter(r => r.state !== 'dogrulandi'); renderTable(); };
  q('clr').onclick = () => { if (!state.list.length || confirm('Tüm tablo silinsin mi?')) { state.list = []; renderTable(); } };
  q('all').onchange = e => { state.list.forEach(r => { r.sel = e.target.checked; }); root.querySelectorAll('.ck').forEach(c => { c.checked = e.target.checked; }); };
  q('clog').onclick = () => { logBox.innerHTML = ''; };
  q('dd').onchange = () => root.querySelectorAll('.t').forEach(x => { x.placeholder = defaultDate() || 'sistem'; });
  const showTab = t => {
    q('paneA').classList.toggle('off', t !== 'A'); q('paneV').classList.toggle('off', t !== 'V');
    q('tabA').classList.toggle('on', t === 'A'); q('tabV').classList.toggle('on', t === 'V');
  };
  q('tabA').onclick = () => showTab('A');
  q('tabV').onclick = () => showTab('V');
  const pickMode = v => { root.querySelector(`input[name="vm"][value="${v}"]`).checked = true; };
  q('v1').onchange = () => pickMode('one');
  q('v2').onchange = q('v3').onchange = () => pickMode('range');
  q('vunlock').onclick = () => guarded(() => unlockAllPage().catch(e => {
    if (e.message === 'STOP') log('Durduruldu', 'warn'); else log('[HATA] ' + e.message, 'err');
  }));
  q('vcount').onclick = () => {
    try {
      const f = getFilter(), st = listStats(f);
      q('vinfo').textContent = `Görünen ${st.rows.length} satır · kilidi açık ${st.un.length} · kilitli ${st.locked.length} · filtreye uyan ${st.match.length} (liste kaydırıldıkça daha fazlası yüklenebilir)`;
      const ex = st.locked[0] && st.locked[0].querySelector('td.rowCell_VALIDAT i');
      if (ex) log(`   kilitli satır ikonu: class="${ex.className}" data-value="${ex.dataset.value}"`);
    } catch (e) { q('vinfo').textContent = e.message; }
  };
  q('vjobclr').onclick = () => { clearJob(); log('Yarım kalan iş kaydı silindi', 'warn'); };
  q('vbumpclr').onclick = () => { try { localStorage.removeItem(BUMP_KEY); } catch (e) {} log('Artış kaydı sıfırlandı', 'warn'); };
  q('mn').onclick = () => q('p').classList.toggle('min');
  q('stop').onclick = () => { state.stop = true; log('Durdurma istendi…', 'warn'); };
  q('go').onclick = () => guarded(() => loop(state.list.filter(r => r.state === 'bekliyor' && (r.kod || r.ad) && r.adet), addOne, 'Ekleme'));
  q('vall').onclick = () => guarded(() => validateAllPage().catch(e => {
    if (e.message === 'STOP') log('Durduruldu', 'warn'); else log('[HATA] ' + e.message, 'err');
  }));

  // Başlıktan sürükleme
  q('dragbar').onmousedown = e => {
    if (e.target.tagName === 'BUTTON') return;
    const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    host.style.right = 'auto'; host.style.bottom = 'auto'; host.style.left = r.left + 'px'; host.style.top = r.top + 'px';
    const mv = ev => { host.style.left = Math.max(0, ev.clientX - dx) + 'px'; host.style.top = Math.max(0, ev.clientY - dy) + 'px'; };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };

  const timer = setInterval(updateStatus, 1000);
  function destroy() { clearInterval(timer); state.stop = true; host.remove(); delete window.__sagaProd; }
  q('cl').onclick = destroy;
  window.__sagaProd = { destroy, CFG, state };

  restore(); renderTable(); updateStatus(); refreshNameInfo();
  log('Sürüm ' + VERSION + ' yüklendi. Üstte Ekle / Validate sekmeleri var.', 'good');
  log('Hazır. Veriyi yükle → Tabloya aktar → Başlat. Daha önce eklenenler için Validate All.');
})();

/**
 * Flight search — collect trip inputs (origin / destination / date / pax),
 * then hand off directly to AirAsia's live booking search in a new tab.
 * AirLabs timetable data was removed because the upstream feed was often stale.
 */

const POPULAR_ROUTES = [
  { from: 'SIN', to: 'KUL', label: 'SIN→KUL' },
  { from: 'BKK', to: 'KUL', label: 'BKK→KUL' },
  { from: 'DPS', to: 'KUL', label: 'DPS→KUL' },
  { from: 'CGK', to: 'KUL', label: 'CGK→KUL' },
  { from: 'PEN', to: 'KUL', label: 'PEN→KUL' },
  { from: 'BKI', to: 'KUL', label: 'BKI→KUL' },
];

/** Default origin IATA from ISO country code (rough hub). */
const COUNTRY_TO_FROM_IATA = {
  MY: 'KUL',
  SG: 'SIN',
  TH: 'BKK',
  ID: 'CGK',
  VN: 'SGN',
  PH: 'MNL',
  KH: 'PNH',
  LA: 'VTE',
  BN: 'BWN',
  AU: 'SYD',
  IN: 'DEL',
  JP: 'NRT',
  KR: 'ICN',
  CN: 'CAN',
  TW: 'TPE',
  HK: 'HKG',
};

function todayMalaysiaISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** AirAsia expects departDate as DD/MM/YYYY (not ISO). Path /flights/search/ is the live booking flow. */
function isoDateToDdMmYyyy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function buildAirAsiaSearchUrl(from, to, dateIso, passengers = 1) {
  const depart = isoDateToDdMmYyyy(dateIso) || isoDateToDdMmYyyy(todayMalaysiaISO());
  const adult = Math.min(9, Math.max(1, Number(passengers) || 1));
  const p = new URLSearchParams();
  p.set('origin', String(from).toUpperCase());
  p.set('destination', String(to).toUpperCase());
  p.set('departDate', depart);
  p.set('tripType', 'O');
  p.set('adult', String(adult));
  p.set('child', '0');
  p.set('infant', '0');
  p.set('locale', 'en-gb');
  p.set('currency', 'MYR');
  p.set('cabinClass', 'economy');
  return `https://www.airasia.com/flights/search/?${p.toString()}`;
}

function airAsiaSearchUrl(from, to, date, passengers = 1) {
  return buildAirAsiaSearchUrl(from, to, date, passengers);
}

function $(id) {
  return document.getElementById(id);
}

function showFsAlert(msg) {
  const el = $('fs-alert');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

function openFsModal() {
  const m = $('fs-modal');
  if (!m) return;
  m.classList.add('is-open');
  m.setAttribute('aria-hidden', 'false');
  document.body.classList.add('fs-modal-open');
}

function closeFsModal() {
  const m = $('fs-modal');
  if (!m) return;
  m.classList.remove('is-open');
  m.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('fs-modal-open');
}

async function reverseGeocode(lat, lng) {
  const res = await fetch(
    `/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`,
  );
  if (!res.ok) throw new Error('Could not resolve location');
  return res.json();
}

function guessFromIataFromNominatim(data) {
  const cc = (data.address && data.address.country_code) || '';
  const upper = String(cc).toUpperCase();
  return COUNTRY_TO_FROM_IATA[upper] || 'KUL';
}

function renderChips() {
  const host = $('fs-chips');
  if (!host) return;
  host.innerHTML = POPULAR_ROUTES.map(
    (r) =>
      `<button type="button" class="fs-chip" data-from="${escapeHtml(r.from)}" data-to="${escapeHtml(r.to)}">${escapeHtml(r.label)}</button>`,
  ).join('');
}

function onSearch() {
  showFsAlert('');
  const fromEl = $('fs-from');
  const toEl = $('fs-to');
  const dateEl = $('fs-date');
  const paxEl = $('fs-pax');
  const loading = $('fs-loading');
  const results = $('fs-results');
  if (!fromEl || !toEl || !dateEl || !paxEl) return;

  const from = String(fromEl.value || '')
    .trim()
    .toUpperCase();
  const to = String(toEl.value || '')
    .trim()
    .toUpperCase();
  const date = dateEl.value || todayMalaysiaISO();
  const pax = Math.min(9, Math.max(1, Number(paxEl.value) || 1));

  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    showFsAlert('Enter valid 3-letter IATA codes for From and To.');
    return;
  }
  if (from === to) {
    showFsAlert('From and To must be different.');
    return;
  }

  if (loading) {
    loading.hidden = true;
    loading.setAttribute('hidden', '');
  }
  if (results) results.innerHTML = '';

  const deep = airAsiaSearchUrl(from, to, date, pax);

  /** Popup blockers can silence window.open; surface a manual link if that happens. */
  const win = window.open(deep, '_blank', 'noopener');
  if (!win && results) {
    results.innerHTML =
      '<div class="fs-empty">' +
      '<p>Your browser blocked the new tab. Open AirAsia for live flights + prices:</p>' +
      '<a class="fs-deep-link" href="' +
      escapeHtml(deep) +
      '" target="_blank" rel="noopener noreferrer">Open AirAsia search</a>' +
      '</div>';
    return;
  }

  closeFsModal();
}

function onDetectLocation() {
  showFsAlert('');
  const hint = $('fs-detect-hint');
  const fromEl = $('fs-from');
  if (!navigator.geolocation) {
    showFsAlert('Geolocation is not supported in this browser.');
    return;
  }
  if (hint) {
    hint.textContent = 'Locating…';
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const data = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
        const guess = guessFromIataFromNominatim(data);
        if (fromEl) fromEl.value = guess;
        const disp =
          data.display_name ||
          [data.address?.city, data.address?.country].filter(Boolean).join(', ');
        if (hint) {
          hint.textContent = disp ? `Near: ${disp} — set From to ${guess}` : `Set From to ${guess}`;
        }
      } catch (e) {
        if (hint) hint.textContent = '';
        showFsAlert(e.message || 'Reverse geocoding failed.');
      }
    },
    () => {
      if (hint) hint.textContent = '';
      showFsAlert('Could not read your location (permission denied or unavailable).');
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
  );
}

function init() {
  renderChips();
  const dateEl = $('fs-date');
  const minD = todayMalaysiaISO();
  if (dateEl) {
    dateEl.min = minD;
    if (!dateEl.value) dateEl.value = minD;
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('#itin-flight-search-open')) {
      e.preventDefault();
      openFsModal();
    }
  });

  const chipsHost = $('fs-chips');
  if (chipsHost) {
    chipsHost.addEventListener('click', (e) => {
      const btn = e.target.closest('.fs-chip');
      if (!btn) return;
      const from = btn.getAttribute('data-from');
      const to = btn.getAttribute('data-to');
      const fe = $('fs-from');
      const te = $('fs-to');
      if (fe && from) fe.value = from;
      if (te && to) te.value = to;
    });
  }

  $('fs-modal-close')?.addEventListener('click', closeFsModal);
  $('fs-modal-backdrop')?.addEventListener('click', closeFsModal);
  $('fs-search')?.addEventListener('click', () => {
    void onSearch();
  });
  $('fs-detect')?.addEventListener('click', () => {
    onDetectLocation();
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      const m = $('fs-modal');
      if (m && m.classList.contains('is-open')) {
        e.stopPropagation();
        closeFsModal();
      }
    },
    true,
  );
}

init();
